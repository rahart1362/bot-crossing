import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const id = 'infrastructure'
export const name = 'System Infrastructure'
export const theme = { primary: '#00D1FF' }

// Prometheus runs with network_mode: host, so it is reachable directly from the
// host where this server runs. The previous implementation shelled into a
// container named "prometheus" — which does not exist (it is root-owned and
// named netmon-prometheus-1), so every query silently returned [] and the
// hardware node permanently displayed "Unknown".
const PROM = process.env.BC_PROM_URL || 'http://127.0.0.1:9191'
const MM_URL = process.env.BC_MM_URL || 'http://192.168.1.199:8065'

export async function detect() {
  try {
    await execAsync('podman --version')
    return true
  } catch {
    return false
  }
}

async function sh(cmd, timeout = 15000) {
  try {
    const { stdout } = await execAsync(cmd, { timeout, maxBuffer: 8 * 1024 * 1024 })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function queryPrometheus(query) {
  try {
    const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const parsed = await res.json()
    return parsed?.data?.result || []
  } catch {
    return []
  }
}

const scalar = (rows) => (rows.length ? parseFloat(rows[0].value[1]) : null)

/** Both podman scopes: rootless containers and root-owned ones. */
async function listContainers() {
  const out = []
  const fmt = '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}'
  for (const [scope, cmd] of [
    ['rootless', `podman ps -a --format "${fmt}"`],
    ['root', `sudo -n podman ps -a --format "${fmt}"`],
  ]) {
    const raw = await sh(cmd)
    for (const line of raw.split('\n').filter(Boolean)) {
      const [name, state, status, image] = line.split('\t')
      if (name) out.push({ name, state, status, image, scope })
    }
  }
  return out
}

async function containerDetail(name, scope) {
  const p = scope === 'root' ? 'sudo -n podman' : 'podman'
  const raw = await sh(
    `${p} inspect ${name} --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.HostConfig.RestartPolicy.Name}}'`
  )
  const [status, health, restarts, startedAt, policy] = raw.split('|')
  return {
    status,
    health: health || 'none',
    restarts: parseInt(restarts, 10) || 0,
    startedAt,
    policy,
  }
}

async function n8nWorkflows() {
  // Per-workflow rollup. The old harness only reported stack-wide totals, which
  // hid the fact that individual workflows were failing 100% of the time.
  const raw = await sh(
    `podman exec postgresql psql -U wuzzyfuzzy -d n8n -t -A -F'|' -c "` +
      `SELECT w.name, w.active, ` +
      `COUNT(e.id) FILTER (WHERE e.status='success'), ` +
      `COUNT(e.id) FILTER (WHERE e.status IN ('error','crashed')), ` +
      `COALESCE(MAX(EXTRACT(EPOCH FROM e.\\"startedAt\\"))::bigint, 0) ` +
      `FROM workflow_entity w LEFT JOIN execution_entity e ON e.\\"workflowId\\"=w.id ` +
      `GROUP BY w.id, w.name, w.active ORDER BY w.name;"`
  )
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, active, ok, err, last] = line.split('|')
      return {
        name,
        active: active === 't',
        ok: parseInt(ok, 10) || 0,
        err: parseInt(err, 10) || 0,
        lastRun: (parseInt(last, 10) || 0) * 1000,
      }
    })
}

export async function scanThreads() {
  const threads = []
  const now = Date.now()

  // ── 1. Host hardware ───────────────────────────────────────────────────────
  const [memAvail, memTotal, temps, load1, cpuIdle, rootAvail, rootSize, uptime] =
    await Promise.all([
      queryPrometheus('node_memory_MemAvailable_bytes'),
      queryPrometheus('node_memory_MemTotal_bytes'),
      queryPrometheus('node_hwmon_temp_celsius'),
      queryPrometheus('node_load1'),
      queryPrometheus('avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))'),
      queryPrometheus('node_filesystem_avail_bytes{mountpoint="/"}'),
      queryPrometheus('node_filesystem_size_bytes{mountpoint="/"}'),
      queryPrometheus('time() - node_boot_time_seconds'),
    ])

  const avail = scalar(memAvail)
  const total = scalar(memTotal)
  const memPct = avail && total ? Math.round(((total - avail) / total) * 100) : null
  const tempVal = temps.length
    ? parseFloat((temps.find((x) => x.metric.chip?.includes('pci')) || temps[0]).value[1])
    : null
  const loadVal = scalar(load1)
  const idle = scalar(cpuIdle)
  const cpuPct = idle === null ? null : Math.round((1 - idle) * 100)
  const dAvail = scalar(rootAvail)
  const dSize = scalar(rootSize)
  const diskPct = dAvail && dSize ? Math.round(((dSize - dAvail) / dSize) * 100) : null
  const upDays = scalar(uptime) ? Math.floor(scalar(uptime) / 86400) : null

  const bits = [
    memPct === null ? 'Mem: n/a' : `Mem ${memPct}%`,
    cpuPct === null ? 'CPU: n/a' : `CPU ${cpuPct}%`,
    diskPct === null ? 'Disk: n/a' : `Disk ${diskPct}%`,
    loadVal === null ? 'Load: n/a' : `Load ${loadVal.toFixed(2)}`,
    tempVal === null ? '' : `${tempVal.toFixed(1)}°C`,
  ].filter(Boolean)

  threads.push({
    id: 'infra:system-node',
    title: 'WuzzyFuzzy Hardware',
    preview: `${bits.join(' | ')}${upDays !== null ? ` | up ${upDays}d` : ''}`,
    project: 'System Health',
    projectPath: '/var/log/syslog',
    agentRole: 'infrastructure',
    model: 'hardware',
    createdAt: now - 86400000,
    lastActivityAt: now,
    running: true,
    hasError: (tempVal ?? 0) > 80 || (memPct ?? 0) > 90 || (diskPct ?? 0) > 90,
    sizeBytes: 150000,
    canOpen: true,
    ref: { target: 'system-node' },
  })

  // ── 2. One node per container ─────────────────────────────────────────────
  const containers = await listContainers()
  const details = await Promise.all(containers.map((c) => containerDetail(c.name, c.scope)))

  containers.forEach((c, i) => {
    const d = details[i]
    const running = d.status === 'running'
    const unhealthy = d.health === 'unhealthy'
    const churning = d.restarts > 20
    const parts = [d.status]
    if (d.health !== 'none') parts.push(d.health)
    if (d.restarts) parts.push(`${d.restarts} restarts`)
    parts.push(c.scope)

    threads.push({
      id: `infra:container:${c.scope}:${c.name}`,
      title: c.name,
      preview: parts.join(' · '),
      project: c.scope === 'root' ? 'Podman (root)' : 'Podman (rootless)',
      projectPath: `/containers/${c.name}`,
      agentRole: 'container',
      model: (c.image || '').split('/').pop()?.split(':')[0] || 'container',
      createdAt: Date.parse(d.startedAt) || now - 3600000,
      lastActivityAt: now,
      running,
      hasError: !running || unhealthy || churning,
      sizeBytes: Math.max(20000, d.restarts * 1000 + 20000),
      canOpen: true,
      ref: { target: 'container', name: c.name, scope: c.scope },
    })
  })

  // ── 3. One node per n8n workflow ──────────────────────────────────────────
  const workflows = await n8nWorkflows()
  for (const w of workflows) {
    const runs = w.ok + w.err
    const allFailing = runs > 0 && w.ok === 0
    const preview = runs === 0
      ? `${w.active ? 'active' : 'inactive'} · never executed`
      : `${w.ok} ok · ${w.err} failed${allFailing ? ' · ALWAYS FAILING' : ''}`

    threads.push({
      id: `infra:n8n:${w.name}`,
      title: w.name,
      preview,
      project: 'n8n Workflows',
      projectPath: '/home/rahart1362/agent-infra/n8n',
      agentRole: 'workflow',
      model: 'n8n',
      createdAt: now - 86400000,
      lastActivityAt: w.lastRun || now - 86400000,
      running: w.active,
      hasError: w.err > 0,
      sizeBytes: Math.max(20000, runs * 500),
      canOpen: true,
      ref: { target: 'n8n-workflow', name: w.name },
    })
  }

  return threads
}

export async function newSession() {
  // Every harness must implement this, but infrastructure nodes are discovered
  // from the running system — there is no folder you can open to create a new
  // container or workflow. Refuse rather than hand back a link that does nothing.
  return {
    ok: false,
    error: 'Infrastructure nodes are discovered from the running system; there is no new session to start.',
  }
}

export async function openThread(ref) {
  // Deep-link per node type so a click lands somewhere useful rather than always
  // dumping the user in the same Mattermost channel.
  if (ref?.target === 'container' && ref.name) {
    return { ok: true, url: `http://192.168.1.199:3000/d/spog-001?var-container=${encodeURIComponent(ref.name)}` }
  }
  if (ref?.target === 'n8n-workflow') {
    return { ok: true, url: 'http://192.168.1.199:5678/home/workflows' }
  }
  if (ref?.target === 'system-node') {
    return { ok: true, url: 'http://192.168.1.199:3000/d/spog-001' }
  }
  return { ok: true, url: `${MM_URL}/wuzzyfuzzy/channels/agent-escalations` }
}
