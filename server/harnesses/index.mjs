/**
 * The harness registry.
 */
import antigravity from './antigravity.mjs'
import claudeCode from './claude-code.mjs'
import codex from './codex.mjs'
import cursor from './cursor.mjs'
import hermes from './hermes.mjs'
import kilocode from './kilocode.mjs'
import opencode from './opencode.mjs'
import * as infrastructure from './infrastructure.mjs'

export const HARNESSES = [claudeCode, codex, cursor, antigravity, hermes, kilocode, opencode, infrastructure]

export const harnessById = (id) => HARNESSES.find((h) => h.id === id) || null

export async function detectedHarnesses() {
  const flags = await Promise.all(
    HARNESSES.map(async (h) => {
      try {
        return await h.detect()
      } catch {
        return false
      }
    })
  )
  return HARNESSES.filter((_, i) => flags[i])
}
