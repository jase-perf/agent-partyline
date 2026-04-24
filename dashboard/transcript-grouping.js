// @ts-check
/**
 * transcript-grouping.js
 *
 * Pure helpers for folding sequential `tool-use` transcript entries into
 * collapsible groups. Used by the session-detail view to keep the visual
 * signal-to-noise ratio high when a session does dozens of back-to-back
 * Bash/Read/Edit calls.
 *
 * "Sequential" = two or more `tool-use` entries appearing back-to-back
 * with no `user`, `assistant-text`, `subagent-spawn`, `party-line-send`,
 * or `party-line-receive` entries between them. A run of exactly 1 tool
 * call is left alone (no value in wrapping a single entry).
 *
 * No DOM access here — DOM construction lives in dashboard.js. This module
 * is pure so it can be unit-tested under bun:test without a browser.
 */

/**
 * @typedef {{ type: string, [key: string]: unknown }} TranscriptEntryLike
 */

/**
 * @typedef {{ kind: 'entry', entry: TranscriptEntryLike }
 *         | { kind: 'tool-group', entries: TranscriptEntryLike[] }} GroupedItem
 */

/** Minimum run length to wrap in a tool-group (inclusive). */
export const TOOL_GROUP_MIN_RUN = 2

/**
 * Group sequential tool-use entries.
 * Pure — does not mutate input.
 *
 * @param {TranscriptEntryLike[]} entries
 * @returns {GroupedItem[]}
 */
export function groupSequentialToolCalls(entries) {
  /** @type {GroupedItem[]} */
  const out = []
  if (!Array.isArray(entries) || entries.length === 0) return out

  /** @type {TranscriptEntryLike[]} */
  let run = []
  const flushRun = () => {
    if (run.length === 0) return
    if (run.length >= TOOL_GROUP_MIN_RUN) {
      out.push({ kind: 'tool-group', entries: run })
    } else {
      // Singleton run — emit as a plain entry, no wrapper.
      for (const e of run) out.push({ kind: 'entry', entry: e })
    }
    run = []
  }

  for (const e of entries) {
    if (e && e.type === 'tool-use') {
      run.push(e)
    } else {
      flushRun()
      out.push({ kind: 'entry', entry: e })
    }
  }
  flushRun()
  return out
}

/**
 * Build a short summary like "Bash, Read, Edit, Read, Bash" from a run of
 * tool-use entries. Capped at `maxNames` distinct positions to avoid
 * runaway summary length on huge runs.
 *
 * @param {TranscriptEntryLike[]} entries
 * @param {number} [maxNames]
 * @returns {string}
 */
export function summarizeToolGroup(entries, maxNames = 8) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const names = entries.map((e) => {
    const n = /** @type {{ tool_name?: unknown }} */ (e).tool_name
    return typeof n === 'string' && n.length > 0 ? n : '?'
  })
  if (names.length <= maxNames) return names.join(', ')
  return names.slice(0, maxNames).join(', ') + ', …'
}

/**
 * Decide whether a new tool-use entry should extend the previous tail.
 * Returns true if the tail entry is also a tool-use with no other entry
 * between them. Used by the incremental-append path to decide whether to
 * promote the tail into a tool-group container.
 *
 * @param {TranscriptEntryLike | null | undefined} tailEntry
 * @param {TranscriptEntryLike} newEntry
 * @returns {boolean}
 */
export function shouldExtendToolRun(tailEntry, newEntry) {
  if (!tailEntry || !newEntry) return false
  return tailEntry.type === 'tool-use' && newEntry.type === 'tool-use'
}
