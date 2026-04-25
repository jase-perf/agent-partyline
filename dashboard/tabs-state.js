// @ts-check
/**
 * tabs-state.js
 *
 * Pure helpers for the dashboard's multi-tab session strip:
 *
 *   - loadDismissed / saveDismissed    — localStorage persistence of the
 *                                        set of session names the user has
 *                                        explicitly X'd out.
 *   - pickLruEvictionVictim            — returns the name of the
 *                                        least-recently-focused tab whose
 *                                        DOM should be destroyed when the
 *                                        soft cap is exceeded, or null.
 *   - filterStripSessions              — derives the visible strip from
 *                                        the live ccpl session list +
 *                                        the dismissal set.
 *   - shouldBumpUnread                 — classifies an inbound event as
 *                                        "user attention required" (Stop /
 *                                        Notification / api-error) vs
 *                                        not (envelopes, lifecycle, etc.).
 *
 * No DOM access — all consumers live in dashboard.js.
 */

const STORAGE_KEY = 'partyLine.tabs.dismissed'

/** Soft cap of mounted tab DOMs before LRU eviction kicks in. */
export const TAB_DOM_LRU_CAP = 8

/**
 * Load the set of dismissed session names from localStorage.
 * Tolerates missing / malformed / shape-mismatched payloads — returns
 * an empty Set rather than throwing.
 *
 * @returns {Set<string>}
 */
export function loadDismissed() {
  let raw
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return new Set()
  }
  if (raw === null) return new Set()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Set()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set()
  const list = parsed.dismissed
  if (!Array.isArray(list)) return new Set()
  /** @type {Set<string>} */
  const out = new Set()
  for (const name of list) {
    if (typeof name === 'string') out.add(name)
  }
  return out
}

/**
 * Persist the dismissal Set to localStorage.
 *
 * @param {Set<string>} dismissed
 */
export function saveDismissed(dismissed) {
  const payload = JSON.stringify({ dismissed: [...dismissed] })
  try {
    localStorage.setItem(STORAGE_KEY, payload)
  } catch {
    // Quota / private mode — silently swallow; dismissal won't persist
    // across reload. The tab UI keeps working in-memory either way.
  }
}

/**
 * @typedef {{ lastViewedAt: number }} TabLruEntry
 */

/**
 * Pick the name of the tab whose DOM should be evicted (oldest
 * lastViewedAt) when the registry size exceeds the cap. Returns null if
 * we're under cap, or if no tab has been focused yet (every entry has
 * lastViewedAt === 0 — picking arbitrarily would feel random; better
 * to wait for an actual focus event).
 *
 * @template {TabLruEntry} T
 * @param {Map<string, T>} tabs
 * @param {number} cap
 * @returns {string | null}
 */
export function pickLruEvictionVictim(tabs, cap) {
  if (tabs.size <= cap) return null
  /** @type {string | null} */
  let victim = null
  let min = Infinity
  for (const [name, t] of tabs) {
    if (t.lastViewedAt > 0 && t.lastViewedAt < min) {
      min = t.lastViewedAt
      victim = name
    }
  }
  return victim
}

/**
 * @typedef {{ name: string, online: boolean }} SessionForStrip
 */

/**
 * Filter a list of ccpl sessions down to the ones that should appear
 * in the strip: online AND not in the dismissal set. Preserves input
 * order so the strip respects stable insertion order.
 *
 * @template {SessionForStrip} S
 * @param {S[]} sessions
 * @param {Set<string>} dismissed
 * @returns {S[]}
 */
export function filterStripSessions(sessions, dismissed) {
  const out = []
  for (const s of sessions) {
    if (s.online && !dismissed.has(s.name)) out.push(s)
  }
  return out
}

/**
 * @typedef {{ kind: 'hook-event', hookEvent: string }
 *         | { kind: 'api-error' }
 *         | { kind: 'envelope' }} BumpClassification
 */

/**
 * True when the event represents "the agent needs the user" — finished
 * a turn (Stop), is blocked waiting for input/permission (Notification),
 * or hit a hard API failure (api-error). Everything else (party-line
 * inter-agent envelopes, lifecycle hooks, per-tool events) does not
 * bump the unread counter.
 *
 * @param {BumpClassification} ev
 * @returns {boolean}
 */
export function shouldBumpUnread(ev) {
  if (ev.kind === 'api-error') return true
  if (ev.kind === 'hook-event') {
    return ev.hookEvent === 'Stop' || ev.hookEvent === 'Notification'
  }
  return false
}
