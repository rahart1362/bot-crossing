/**
 * Harness adapter: Antigravity CLI (Google).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, jsonLines, listDirs, readHead, readTail, findExecutable } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const ANTIGRAVITY_HOME =
  process.env.BOT_CROSSING_ANTIGRAVITY_HOME ||
  process.env.ANTIGRAVITY_HOME ||
  path.join(HOME, '.gemini', 'antigravity')
const BRAIN_DIR = path.join(ANTIGRAVITY_HOME, 'brain')

const HEAD_BYTES = 96 * 1024
const TAIL_BYTES = 32 * 1024
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SPAWN_TOOL = /^(invoke_?subagent|browser_?subagent|spawn_?agent|start_?subagent|task)$/i
const PARENT_KEYS = ['parent_session_id', 'parentSessionId', 'parent_id']
const PREVIEW_MAX = 240
const ERROR_MSG_MAX = 200
const SUBAGENT_KIND_CAP = 8

const ID = (raw) => `antigravity:${raw}`
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (typeof p === 'string' ? p : p?.text || p?.input_text || ''))
    .filter(Boolean)
    .join('\n')
}

function userText(record) {
  const raw = contentText(record?.content || record?.message?.content || '')
  const query = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw)
  const text = query ? query[1] : raw.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/gi, ' ')
  return clean(text)
}

function extractCwd(text) {
  const m = /active workspaces, each defined by a URI[\s\S]*?\[(.*?)\]\s*->/i.exec(text)
  if (m && path.isAbsolute(m[1])) return m[1]
  return ''
}

/**
 * Where each conversation ran. A transcript usually does not say, so most sessions arrived with
 * no folder at all and shared one zone called "unknown". The CLI's prompt history beside `brain/`
 * does: every prompt typed is a line of `{ display, timestamp, workspace, conversationId }`. Older
 * lines carry no conversation id, so not every session is covered — those stay unknown rather
 * than being guessed from whichever files the session happened to read.
 *
 * The folder a conversation started in wins. Re-read only when the file changes.
 */
const HISTORY = path.join(ANTIGRAVITY_HOME, 'history.jsonl')
let history = { mtime: -1, workspaces: new Map() }
async function workspaces() {
  const st = await fsp.stat(HISTORY).catch(() => null)
  if (!st) return new Map()
  if (st.mtimeMs === history.mtime) return history.workspaces
  const out = new Map()
  try {
    for (const r of jsonLines(await fsp.readFile(HISTORY, 'utf8'))) {
      const id = r?.conversationId
      const dir = r?.workspace
      if (typeof id === 'string' && typeof dir === 'string' && path.isAbsolute(dir) && !out.has(id)) out.set(id, dir)
    }
  } catch {
    /* mid-write, or gone */
  }
  history = { mtime: st.mtimeMs, workspaces: out }
  return out
}

const isAssistant = (r) =>
  r?.role === 'assistant' ||
  r?.role === 'model' ||
  r?.source === 'MODEL' ||
  /^(PLANNER_RESPONSE|MODEL_RESPONSE|ASSISTANT)/i.test(r?.type || '')

function toolCallsOf(r) {
  const calls = []
  const push = (c) => {
    const name = c?.name || c?.tool_name || c?.function?.name || ''
    if (name) calls.push({ id: c?.id || c?.call_id || '', name, args: c?.args || c?.input || c?.arguments || {} })
  }
  for (const c of r?.tool_calls || r?.toolCalls || []) push(c)
  const parts = r?.content || r?.message?.content
  if (Array.isArray(parts)) {
    for (const p of parts) if (p?.type === 'tool_use' || p?.type === 'function_call') push(p)
  }
  if (/TOOL_CALL|FUNCTION_CALL/i.test(r?.type || '')) push(r)
  return calls
}

const assistantText = (r) =>
  clean(contentText(r?.content || r?.message?.content || '') || r?.text || '').replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/gi, ' ')

const errorMessage = (r) => {
  const e = r?.error
  const msg = typeof e === 'string' ? e : e?.message || (r?.status === 'ERROR' ? r?.message : '')
  return clean(msg).slice(0, ERROR_MSG_MAX)
}

function absorb(records, value, seen) {
  for (const r of records) {
    if (!value.model && typeof r?.model === 'string') value.model = r.model
    if (!value.parentId) {
      const k = PARENT_KEYS.find((key) => typeof r?.[key] === 'string' && r[key])
      if (k) value.parentId = r[k]
    }
    if (!value.agentName) value.agentName = clean(r?.agent_name || r?.agent_role || r?.agentName)

    for (const c of toolCallsOf(r)) {
      if (!SPAWN_TOOL.test(c.name)) continue
      if (c.id) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
      }
      value.subagents.count += 1
      const kind = clean(c.args?.subagent_type || c.args?.agent || c.args?.role || c.args?.TypeName || c.name)
      if (kind && !value.subagents.kinds.includes(kind) && value.subagents.kinds.length < SUBAGENT_KIND_CAP) {
        value.subagents.kinds.push(kind)
      }
    }
  }
}

async function findTranscriptFile(sessionDir) {
  const candidates = [
    path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(sessionDir, 'transcript.jsonl'),
  ]
  for (const c of candidates) {
    if (await exists(c)) return c
  }
  return null
}

async function scanTranscripts() {
  const out = []
  for (const sessionDir of await listDirs(BRAIN_DIR)) {
    const id = path.basename(sessionDir)
    if (!UUID.test(id)) continue
    const file = await findTranscriptFile(sessionDir)
    if (!file) continue
    try {
      const st = await fsp.stat(file)
      if (!st.size) continue
      out.push({
        id,
        file,
        sessionDir,
        size: st.size,
        mtime: st.mtimeMs,
        born: st.birthtimeMs,
      })
    } catch {
    }
  }
  return out
}

const parseCache = new Map()
async function facts(entry) {
  const hit = parseCache.get(entry.id)
  if (hit && hit.mtime === entry.mtime && hit.size === entry.size) return hit.value

  const value = {
    prompt: '',
    cwd: '',
    startedAt: 0,
    closed: true,
    errored: false,
    model: '',
    agentName: '',
    parentId: '',
    lastAssistant: '',
    lastError: '',
    errorCount: 0,
    subagents: { count: 0, kinds: [], sampled: false },
  }
  try {
    const whole = entry.size <= HEAD_BYTES
    const head = jsonLines(await readHead(entry.file, HEAD_BYTES))
    const tail = whole ? head : jsonLines(await readTail(entry.file, TAIL_BYTES))
    const seen = new Set()
    value.subagents.sampled = !whole

    for (const r of head) {
      if (r?.type === 'USER_INPUT' || r?.role === 'user' || r?.source === 'USER_EXPLICIT') {
        const text = userText(r)
        if (!value.prompt && text) value.prompt = text
        if (!value.cwd) value.cwd = r?.cwd || extractCwd(String(r?.content || '')) || ''
        if (!value.startedAt && r?.created_at) {
          const t = Date.parse(r.created_at)
          if (!Number.isNaN(t)) value.startedAt = t
        }
      }
    }
    absorb(head, value, seen)
    if (!whole) absorb(tail, value, seen)

    if (tail.length > 0) {
      const last = tail[tail.length - 1]
      value.errored = last?.status === 'ERROR' || Boolean(last?.error)
      value.closed = last?.status === 'DONE' || last?.status === 'COMPLETED' || last?.type === 'DONE'

      for (const r of tail) {
        if (r?.status === 'ERROR' || r?.error) {
          value.errorCount += 1
          value.lastError = errorMessage(r) || value.lastError
        }
      }
      for (let i = tail.length - 1; i >= 0; i--) {
        if (!isAssistant(tail[i])) continue
        const t = assistantText(tail[i])
        if (t) {
          value.lastAssistant = t
          break
        }
      }
    }
  } catch {
  }

  parseCache.set(entry.id, { mtime: entry.mtime, size: entry.size, value })
  return value
}

async function scanThreads() {
  const [entries, where] = await Promise.all([scanTranscripts(), workspaces()])
  const now = Date.now()
  const threads = []

  for (const entry of entries) {
    const f = await facts(entry)
    const cwd = f.cwd || where.get(entry.id) || ''
    const projectPath = cwd
    const project = cwd ? path.basename(cwd) : 'unknown'
    const prompt = f.prompt
    const running = !f.closed && now - entry.mtime < ACTIVE_WINDOW_MS
    const role = f.parentId ? 'subagent' : f.agentName || (f.subagents.count > 0 ? 'orchestrator' : 'primary')

    threads.push({
      id: ID(entry.id),
      title: (prompt || 'Untitled thread').slice(0, 120),
      preview: ((running && f.lastAssistant) || prompt).slice(0, PREVIEW_MAX),
      project,
      projectPath,
      worktree: '',
      cwd,
      gitBranch: '',
      model: f.model || 'antigravity',
      effort: '',
      createdAt: f.startedAt || entry.born || entry.mtime,
      lastActivityAt: entry.mtime,
      lastFocusedAt: 0,
      unread: false,
      running,
      hasError: f.errored,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: entry.size,
      source: 'cli',
      canOpen: true,
      ref: { sessionId: entry.id, cwd },
      agentRole: role,
      parentThreadId: f.parentId ? ID(f.parentId) : '',
      subagentCount: f.subagents.count,
      subagentKinds: f.subagents.kinds,
      subagentCountIsLowerBound: f.subagents.sampled,
      lastError: f.lastError,
      recentErrorCount: f.errorCount,
    })
  }
  return threads
}

async function openThread(ref) {
  const id = ref?.sessionId
  if (typeof id !== 'string' || !UUID.test(id)) {
    return { ok: false, error: 'No openable session id on that thread' }
  }
  const cwd = typeof ref?.cwd === 'string' ? ref.cwd : ''
  const bin = (await findExecutable('antigravity')) || (await findExecutable('antigravity-cli'))
  const url = `antigravity://resume?session=${id}`
  let command
  if (bin) {
    command = { argv: [bin, '--resume', id], cwd }
  }
  return { ok: true, url, command }
}

async function newSession(dir) {
  const abs = String(dir || '').replace(/\\/g, '/')
  if (!abs.startsWith('/')) return { ok: false, error: 'That folder is not somewhere Antigravity can open' }
  const bin = (await findExecutable('antigravity')) || (await findExecutable('antigravity-cli'))
  const url = `antigravity://new?${new URLSearchParams({ path: abs })}`
  let command
  if (bin) {
    command = { argv: [bin], cwd: abs }
  }
  return { ok: true, url, command }
}

const detect = () => exists(BRAIN_DIR)

export default {
  id: 'antigravity',
  name: 'Antigravity CLI',
  detect,
  scanThreads,
  openThread,
  newSession,
  paths: { ANTIGRAVITY_HOME, BRAIN_DIR },
}
