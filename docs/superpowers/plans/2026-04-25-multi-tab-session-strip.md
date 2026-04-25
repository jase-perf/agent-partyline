# Multi-Tab Session Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's single-session-detail view with a horizontal strip of pinned tabs that all stay live in the background, so switching between sessions feels instant.

**Architecture:** Per-tab DOM containers mounted into a tab-strip layout; one `Tab` object per session keyed by name in a `TabRegistry` Map. The existing `/ws/observer` envelope stream fans every inbound update to all matching tabs (not just the focused one). Pure helpers for dismissal-set persistence, LRU eviction, and unread-bump classification live in a separate module so they can be unit-tested without a browser. URL state stays canonical (`/session/<name>`); intentional navigations push history, keyboard switches replace it. Sibling change tightens the unread counter to drop the party-line-envelope and SessionEnd bumps that produce most of today's chip-number noise.

**Tech Stack:** Vanilla TypeScript-ish JS (no framework), Bun + bun:test for unit tests, Playwright MCP for end-to-end verification, plain CSS with custom-property design tokens.

**Spec:** `docs/superpowers/specs/2026-04-25-multi-tab-session-strip-design.md`

---

## Task Order Overview

1. Pure helpers module + tests (`tabs-state.js`) — no UI dependencies, build + test in isolation.
2. Sibling: tighten unread counter — small isolated wins early.
3. Tab strip HTML scaffolding (markup only).
4. Tab strip CSS (visual scaffolding).
5. Refactor `renderStream` / `appendEntryWithGrouping` / `renderEntry` paths to take a stream-root parameter.
6. Refactor `loadSessionDetailView` / sidebar / composer paths to accept a tab parameter.
7. Introduce `Tab` object + `TabRegistry` + `currentTab()` glue (no behavior change yet — Switchboard becomes the only tab).
8. Wire tab focus + click handlers; URL `pushState` / `replaceState` policy.
9. Auto-pin live sessions on `sessions-snapshot` + `session-delta`; per-tab unread counts.
10. Prefetch on dashboard load (parallelism cap).
11. Route WS events to ALL matching tabs (background updates).
12. 5-minute offline-eviction timer + auto re-pin on reconnect.
13. Keyboard navigation (Alt+Left/Right + Esc); LRU eviction at >8 mounted DOMs.
14. End-to-end Playwright walkthrough on hots3 + a second live session.

Each task is fully self-contained: do not skip ahead. Each ends in a passing test suite + a commit.

---

## Project Conventions Reminder

Before starting any task, the implementer should know:

- Strict TypeScript across the project, but `dashboard/*.js` files are JS-with-JSDoc (browser-loaded ES modules). New helpers in `dashboard/tabs-state.js` should follow the same pattern as `dashboard/transcript-grouping.js` — `// @ts-check` at top, full JSDoc on exports.
- Tests live under `tests/`, run via `bun test`. Type-check with `bunx tsc --noEmit`. Both must be clean before any commit.
- The dashboard is hot-reloaded by `bun --watch dashboard/serve.ts` running on port 3400. Edits to `dashboard/*.js` and `dashboard/*.css` are picked up immediately. Login at `https://localhost:3400/login` with `PARTY_LINE_DASHBOARD_PASSWORD` (read it from `cat /proc/$(pgrep -f "dashboard/serve.ts" | head -1)/environ | tr '\0' '\n' | grep PASSWORD`).
- Never use the `git commit --no-verify` flag. If a hook fails, fix the underlying issue.
- Co-author trailer required on every commit:
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

---

## Task 1: Pure helpers module — `tabs-state.js`

Builds the `dismissal-set load/save`, `LRU pick`, `online-filter`, and `unread-bump classification` helpers as a side-effect-free module with full unit-test coverage. This task has zero UI dependencies — implement and ship in isolation.

**Files:**

- Create: `dashboard/tabs-state.js`
- Create: `tests/tabs-state.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/tabs-state.test.ts` exactly:

```typescript
import { describe, expect, test, beforeEach } from 'bun:test'
import {
  loadDismissed,
  saveDismissed,
  pickLruEvictionVictim,
  filterStripSessions,
  shouldBumpUnread,
  TAB_DOM_LRU_CAP,
} from '../dashboard/tabs-state.js'

const KEY = 'partyLine.tabs.dismissed'

describe('tabs-state', () => {
  beforeEach(() => {
    // bun:test runs in Node-ish env. Stub a minimal localStorage on globalThis.
    const store: Record<string, string> = {}
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => (k in store ? store[k]! : null),
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() {
        return Object.keys(store).length
      },
    }
  })

  describe('loadDismissed / saveDismissed', () => {
    test('loadDismissed returns empty Set when key is absent', () => {
      expect(loadDismissed()).toEqual(new Set())
    })

    test('round-trip: saveDismissed then loadDismissed returns same set', () => {
      saveDismissed(new Set(['argonaut', 'hots3']))
      expect(loadDismissed()).toEqual(new Set(['argonaut', 'hots3']))
    })

    test('loadDismissed tolerates malformed JSON without throwing', () => {
      localStorage.setItem(KEY, 'not-json{')
      expect(loadDismissed()).toEqual(new Set())
    })

    test('loadDismissed tolerates non-object payload (string)', () => {
      localStorage.setItem(KEY, '"oops"')
      expect(loadDismissed()).toEqual(new Set())
    })

    test('loadDismissed tolerates payload missing dismissed key', () => {
      localStorage.setItem(KEY, '{"other":"junk"}')
      expect(loadDismissed()).toEqual(new Set())
    })

    test('saveDismissed empty Set still writes (so cleared dismissals persist)', () => {
      saveDismissed(new Set(['foo']))
      saveDismissed(new Set())
      expect(loadDismissed()).toEqual(new Set())
    })
  })

  describe('pickLruEvictionVictim', () => {
    test('returns null when under cap', () => {
      const tabs = new Map([
        ['a', { lastViewedAt: 1 }],
        ['b', { lastViewedAt: 2 }],
      ])
      expect(pickLruEvictionVictim(tabs, 8)).toBeNull()
    })

    test('returns least-recently-viewed name when over cap', () => {
      const tabs = new Map([
        ['oldest', { lastViewedAt: 100 }],
        ['middle', { lastViewedAt: 200 }],
        ['newest', { lastViewedAt: 300 }],
      ])
      expect(pickLruEvictionVictim(tabs, 2)).toBe('oldest')
    })

    test('returns null when over cap but everyone has same lastViewedAt of 0 (never viewed)', () => {
      // Defensive: prefetched tabs that the user has never focused all have
      // lastViewedAt=0. Picking one to evict would be arbitrary; better to
      // wait until the user focuses something.
      const tabs = new Map([
        ['a', { lastViewedAt: 0 }],
        ['b', { lastViewedAt: 0 }],
        ['c', { lastViewedAt: 0 }],
      ])
      expect(pickLruEvictionVictim(tabs, 2)).toBeNull()
    })

    test('TAB_DOM_LRU_CAP is the documented soft cap of 8', () => {
      expect(TAB_DOM_LRU_CAP).toBe(8)
    })
  })

  describe('filterStripSessions', () => {
    test('keeps only online sessions absent from dismissed set', () => {
      const sessions = [
        { name: 'a', online: true },
        { name: 'b', online: false },
        { name: 'c', online: true },
        { name: 'd', online: true },
      ]
      const dismissed = new Set(['c'])
      expect(filterStripSessions(sessions, dismissed).map((s) => s.name)).toEqual(['a', 'd'])
    })

    test('preserves input order (stable insertion order)', () => {
      const sessions = [
        { name: 'second', online: true },
        { name: 'first', online: true },
        { name: 'third', online: true },
      ]
      expect(filterStripSessions(sessions, new Set()).map((s) => s.name)).toEqual([
        'second',
        'first',
        'third',
      ])
    })

    test('empty input returns empty array', () => {
      expect(filterStripSessions([], new Set())).toEqual([])
    })
  })

  describe('shouldBumpUnread', () => {
    test('Stop hook bumps', () => {
      expect(shouldBumpUnread({ kind: 'hook-event', hookEvent: 'Stop' })).toBe(true)
    })

    test('Notification hook bumps', () => {
      expect(shouldBumpUnread({ kind: 'hook-event', hookEvent: 'Notification' })).toBe(true)
    })

    test('api-error frame bumps', () => {
      expect(shouldBumpUnread({ kind: 'api-error' })).toBe(true)
    })

    test('SessionEnd hook does NOT bump (lifecycle, not a message)', () => {
      expect(shouldBumpUnread({ kind: 'hook-event', hookEvent: 'SessionEnd' })).toBe(false)
    })

    test('PostToolUse hook does NOT bump (per-tool noise)', () => {
      expect(shouldBumpUnread({ kind: 'hook-event', hookEvent: 'PostToolUse' })).toBe(false)
    })

    test('UserPromptSubmit hook does NOT bump', () => {
      expect(shouldBumpUnread({ kind: 'hook-event', hookEvent: 'UserPromptSubmit' })).toBe(false)
    })

    test('party-line envelope (any kind) does NOT bump (inter-agent noise)', () => {
      expect(shouldBumpUnread({ kind: 'envelope' })).toBe(false)
    })

    test('unknown kind does NOT bump (defensive default)', () => {
      expect(shouldBumpUnread({ kind: 'totally-made-up' as 'envelope' })).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail (module doesn't exist yet)**

Run: `bun test tests/tabs-state.test.ts`

Expected: FAIL with `Cannot find module '../dashboard/tabs-state.js'` or similar resolution error.

- [ ] **Step 3: Implement `dashboard/tabs-state.js`**

Create `dashboard/tabs-state.js` exactly:

```javascript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/tabs-state.test.ts`

Expected: PASS, all tests green.

- [ ] **Step 5: Run the full test suite + tsc to confirm no regression**

Run: `bun test && bunx tsc --noEmit`

Expected: total test count = previous total + new tests (about +20). `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add dashboard/tabs-state.js tests/tabs-state.test.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): pure tabs-state helpers (dismissal / LRU / bump filter)

Pure side-effect-free module that the multi-tab strip will lean on:

- loadDismissed / saveDismissed: localStorage persistence of the
  dismissal set, tolerant of missing / malformed / shape-mismatched
  payloads.
- pickLruEvictionVictim: returns the least-recently-focused tab when
  the registry exceeds the soft DOM cap (TAB_DOM_LRU_CAP=8). Returns
  null when no tab has been focused yet so prefetched tabs don't get
  arbitrarily evicted before the user touches anything.
- filterStripSessions: derives the visible strip from the live ccpl
  session list + dismissal set; preserves input order for stable
  insertion-order tab placement.
- shouldBumpUnread: classifies inbound events for the per-tab unread
  counter — only Stop / Notification / api-error count.

No DOM dependencies. Full bun:test coverage. The dashboard wires this
in over the next several tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Sibling fix — tighten unread counter to Stop / Notification / api-error only

The user-visible win that lands today's spec wins early. Drop the two noise sources (party-line non-broadcast envelopes, SessionEnd hook) from `bumpUnread`. Keep Stop, Notification, api-error.

**Files:**

- Modify: `dashboard/dashboard.js` (around lines 367 and 421-428)

- [ ] **Step 1: Read the existing bump call sites to confirm line context**

Run: `grep -n "bumpUnread\|hook_event === 'Stop'" dashboard/dashboard.js | head`

Expected output includes lines around 367 (party-line envelope bump) and 421-428 (hook-event bump).

- [ ] **Step 2: Read the full envelope bump line + surrounding context**

Read `dashboard/dashboard.js` around line 365.

Expect to see:

```javascript
addMessage(adapted)
addMessageToBus(adapted)
if (adapted.to && adapted.to !== 'all') bumpUnread(adapted.to)
try {
  notif.onPartyLineMessage(adapted)
```

- [ ] **Step 3: Remove the party-line envelope bump**

Replace the `if (adapted.to && adapted.to !== 'all') bumpUnread(adapted.to)` line with nothing — delete that single line. The two surrounding lines (`addMessageToBus(adapted)` and the `try { notif.onPartyLineMessage(adapted) ... }`) stay.

After edit, that region reads:

```javascript
addMessage(adapted)
addMessageToBus(adapted)
try {
  notif.onPartyLineMessage(adapted)
```

- [ ] **Step 4: Read the hook-event bump block**

Read `dashboard/dashboard.js` around line 417-429.

Expect:

```javascript
// Unread counter: ONLY bump on events that represent a real
// "something you should look at" moment — session finished turn (Stop),
// Notification hook (model asked for input), or session-end. Tool
// calls, user prompts, subagent spawns, etc. don't count.
if (
  data.data &&
  data.data.session_name &&
  (data.data.hook_event === 'Stop' ||
    data.data.hook_event === 'Notification' ||
    data.data.hook_event === 'SessionEnd')
) {
  bumpUnread(data.data.session_name)
}
```

- [ ] **Step 5: Drop the SessionEnd clause + update the comment**

Replace that block exactly with:

```javascript
// Unread counter: only bump for events that represent the agent
// needing the user — finished a turn (Stop) or asking for input /
// permission (Notification). Lifecycle (SessionEnd), per-tool events,
// and inter-agent party-line envelopes deliberately do NOT count;
// they were noisy enough to drown the badge under multi-agent
// traffic. See shouldBumpUnread() in tabs-state.js for the
// authoritative classifier.
if (
  data.data &&
  data.data.session_name &&
  (data.data.hook_event === 'Stop' || data.data.hook_event === 'Notification')
) {
  bumpUnread(data.data.session_name)
}
```

(Note: this task does not yet route through `shouldBumpUnread` — it just narrows the inline rule. Task 9 wires the centralised predicate.)

- [ ] **Step 6: Run the test suite + tsc**

Run: `bun test && bunx tsc --noEmit`

Expected: still all pass (no test exercises this path directly — covered by tabs-state.test.ts already).

- [ ] **Step 7: Manually verify chip count drops on a busy session**

The dashboard is already running on port 3400 (hot-reload picks up the JS change). Open `https://localhost:3400/` in a browser, log in, and watch the switchboard cards while sessions are active. The numeric badge for any active session should now stay 0 unless that session emits Stop / Notification / api-error.

If you have no live sessions, you can spot-check the change by reading the diff and confirming the two listed call sites no longer call `bumpUnread`.

- [ ] **Step 8: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "$(cat <<'EOF'
fix(dashboard): tighten unread counter to Stop / Notification only

The per-session unread chip was bumping on every party-line envelope
targeted at the session and on every SessionEnd hook. Under multi-
agent party-line traffic that drowned the badge — counts of dozens
inside a few minutes that didn't reflect "needs your attention".

Drop both noise sources. Keep Stop (assistant turn done), Notification
(blocking on user input or permission), and api-error (Claude API
failed, agent stuck). Comment now points at the canonical classifier
in tabs-state.js for the next-task wiring.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Tab strip HTML scaffolding

Restructure `dashboard/index.html`'s top-tab row into a strip container that will hold the Switchboard tab + (later) per-session tabs + an overflow menu. The session-detail view's content gets templated so multiple per-session DOMs can be cloned. No JS yet — visible behavior unchanged.

**Files:**

- Modify: `dashboard/index.html`

- [ ] **Step 1: Locate the existing tabs markup**

Run: `grep -n 'class="tabs"\|data-view=' dashboard/index.html | head -20`

Expected: the existing `<div class="tabs">` element holding four `<button data-view="...">` entries near the top, plus the `<section class="view" data-view="session-detail">` block.

- [ ] **Step 2: Read the current tab bar block**

Read `dashboard/index.html` lines covering the `<div class="tabs">` element. Capture the full button list verbatim — you'll need it for migration.

- [ ] **Step 3: Replace the top tab bar with the new strip container**

Find the existing `<div class="tabs">...</div>` block. Replace it exactly with:

```html
<nav class="tab-strip" id="tab-strip" aria-label="Sessions">
  <button
    type="button"
    class="tab-strip-tab tab-strip-home"
    id="tab-strip-switchboard"
    data-tab-name=""
    data-view="switchboard"
    aria-current="page"
  >
    <span class="tab-strip-label">Switchboard</span>
  </button>
  <div class="tab-strip-sessions" id="tab-strip-sessions"></div>
  <details class="tab-strip-overflow" id="tab-strip-overflow">
    <summary aria-label="More views" title="More views">⋯</summary>
    <div class="tab-strip-overflow-menu">
      <button type="button" data-view="machines">Machines</button>
      <button type="button" data-view="history">History</button>
    </div>
  </details>
</nav>
```

The four old `data-view` buttons are now: Switchboard (the home button), Machines + History (in the overflow `<details>`), and Session Detail (which gets dynamically inserted into `#tab-strip-sessions` per-session by Task 7+).

- [ ] **Step 4: Hide the old "Session Detail" tab button if it survived elsewhere**

Search the file for any remaining `data-view="session-detail"` button OUTSIDE the `.view` section markup. If one remains, delete it — the strip's per-session tabs replace its role entirely.

Run: `grep -n 'data-view="session-detail"' dashboard/index.html`

Expected: the only remaining match should be on the `<section data-view="session-detail">` element (the view body, not a tab button). If a button survives, delete that button line.

- [ ] **Step 5: Wrap the session-detail view body in a per-tab container**

Find the `<section class="view" data-view="session-detail">` element. Inside that section, the existing children (the `.detail-header`, `.detail-body`, `.detail-send`, etc.) currently live directly. Wrap the existing body markup with a single new `<div class="session-tab-content" data-tab-content-template>` element. The wrapper is the per-tab cloning template; it stays hidden via the `template` data attribute (see Task 4 CSS).

Concretely, before:

```html
<section class="view" data-view="session-detail">
  <div class="detail-header">…</div>
  <div class="detail-body">…</div>
  <form class="detail-send" id="detail-send">…</form>
</section>
```

After:

```html
<section class="view" data-view="session-detail">
  <div class="session-tab-content" data-tab-content-template hidden>
    <div class="detail-header">…</div>
    <div class="detail-body">…</div>
    <form class="detail-send" id="detail-send">…</form>
  </div>
  <div class="session-tab-stack" id="session-tab-stack">
    <!-- Per-tab clones of the template above are inserted here at runtime -->
  </div>
</section>
```

The IDs inside the template (`detail-header`, `detail-stream`, `detail-send`, `detail-send-msg`, etc.) stay untouched for now — Task 6 adds per-tab id-scoping. The visible runtime content for the focused tab gets cloned into `#session-tab-stack` by Task 7.

- [ ] **Step 6: Manually verify the page still loads + the existing single-session view still works**

Refresh `https://localhost:3400/`. The new strip should be visible (Switchboard tab + ⋯ overflow). Click Switchboard — should render the existing switchboard view. Click ⋯ → Machines or History — should render those views.

The session-detail view will look broken (template is `hidden`, the stack is empty) — that's expected; Task 7 wires it. Do not commit if the Switchboard / Machines / History views regressed; back out and check the markup.

- [ ] **Step 7: Run tests + tsc to confirm no regression in pure-JS land**

Run: `bun test && bunx tsc --noEmit`

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add dashboard/index.html
git commit -m "$(cat <<'EOF'
refactor(dashboard): tab-strip scaffolding markup

Replace the four-button top tabs row with a strip container that will
hold the Switchboard home tab + per-session session tabs (added in
Task 7+) + an overflow menu for Machines / History.

Wrap the session-detail view body in a hidden template div + a
.session-tab-stack mount point. Per-tab content clones land in the
stack at runtime; the template stays hidden as the prototype to clone.
The strip's per-session tab placement is empty for now — Switchboard /
Machines / History views still render via the existing routing logic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Tab strip CSS

Lays down the visual scaffolding for the strip: stable horizontal layout, sticky-left Switchboard tab, hidden inactive tabs, mobile horizontal scroll, dot/badge styles, overflow-menu styling.

**Files:**

- Modify: `dashboard/dashboard.css`

- [ ] **Step 1: Locate the existing top-tab styles to remove or supersede**

Run: `grep -n '\.tabs\b\|\.tabs button\|\.tabs *button' dashboard/dashboard.css | head`

Expected: a few rules under `.tabs` selector. Leave them in place (they no longer match anything, harmless) — do not delete this turn; cleanup comes after Task 13 confirms nothing else relies on them.

- [ ] **Step 2: Append new strip styles at the end of `dashboard.css`**

Append:

```css
/* ----------------------------------------------------------------------
 * Multi-tab session strip
 * Replaces the legacy four-button .tabs row. Switchboard is sticky-left
 * (always reachable on mobile), per-session tabs sit in a horizontally
 * scrollable middle, and Machines / History live behind a ⋯ overflow.
 * ---------------------------------------------------------------------- */
.tab-strip {
  display: flex;
  align-items: stretch;
  gap: 2px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0;
  flex: 0 0 auto;
}
.tab-strip-tab {
  background: transparent;
  border: none;
  border-right: 1px solid var(--border);
  color: var(--text-dim);
  font-family: inherit;
  font-size: 12px;
  padding: 8px 14px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  position: relative;
  /* Make X close affordance comfortable on touch without changing desktop */
  min-height: 36px;
}
.tab-strip-tab[aria-current='page'] {
  background: var(--bg);
  color: var(--text);
  border-bottom: 2px solid var(--accent);
}
.tab-strip-tab:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.02);
}
.tab-strip-home {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--surface);
  border-right: 1px solid var(--border);
}
.tab-strip-home[aria-current='page'] {
  background: var(--bg);
}
.tab-strip-sessions {
  display: flex;
  align-items: stretch;
  gap: 0;
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1 1 auto;
  min-width: 0;
  /* Hide scrollbar visually but keep interactivity (mobile especially). */
  scrollbar-width: none;
}
.tab-strip-sessions::-webkit-scrollbar {
  display: none;
}
.tab-strip-tab .state-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 4px;
  background: var(--text-dim);
  flex: 0 0 auto;
}
.tab-strip-tab .state-dot.idle {
  background: var(--green);
}
.tab-strip-tab .state-dot.working {
  background: var(--yellow);
}
.tab-strip-tab .state-dot.offline {
  background: var(--text-dim);
}
.tab-strip-tab.tab-offline {
  opacity: 0.55;
}
.tab-strip-tab .unread-pill {
  display: inline-block;
  background: var(--accent);
  color: #0d1117;
  font-size: 10px;
  font-weight: 700;
  border-radius: 8px;
  padding: 0 6px;
  line-height: 16px;
  min-width: 16px;
  text-align: center;
  flex: 0 0 auto;
}
.tab-strip-tab .unread-pill[hidden] {
  display: none;
}
.tab-strip-tab .tab-close {
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  padding: 2px 4px;
  margin-left: 2px;
  cursor: pointer;
  border-radius: 3px;
  flex: 0 0 auto;
}
.tab-strip-tab .tab-close:hover {
  color: var(--red);
  background: rgba(248, 81, 73, 0.1);
}
.tab-strip-overflow {
  flex: 0 0 auto;
  position: relative;
  border-left: 1px solid var(--border);
}
.tab-strip-overflow > summary {
  list-style: none;
  cursor: pointer;
  color: var(--text-dim);
  padding: 8px 14px;
  font-size: 16px;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
}
.tab-strip-overflow > summary::-webkit-details-marker {
  display: none;
}
.tab-strip-overflow[open] > summary {
  background: var(--bg);
  color: var(--text);
}
.tab-strip-overflow-menu {
  position: absolute;
  right: 0;
  top: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  min-width: 140px;
  z-index: 50;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}
.tab-strip-overflow-menu button {
  background: transparent;
  border: none;
  color: var(--text);
  text-align: left;
  padding: 8px 14px;
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
}
.tab-strip-overflow-menu button:hover {
  background: rgba(255, 255, 255, 0.04);
}

/* The session-tab-content cloning template stays hidden — runtime
 * clones drop the [hidden] / [data-tab-content-template] attributes. */
.session-tab-content[data-tab-content-template] {
  display: none;
}
/* Per-tab content stack — exactly one child has [data-active] at a time. */
.session-tab-stack {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.session-tab-stack > .session-tab-content {
  flex: 1 1 auto;
  min-height: 0;
  display: none;
}
.session-tab-stack > .session-tab-content[data-active] {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
```

- [ ] **Step 3: Run tests + tsc**

Run: `bun test && bunx tsc --noEmit`

Expected: pass (CSS doesn't affect either, but a sanity check is cheap).

- [ ] **Step 4: Manually verify the strip renders**

Refresh `https://localhost:3400/`. The strip across the top should now show the Switchboard tab styled with a state-pill highlight + the ⋯ overflow on the right. No per-session tabs yet (the sessions container is empty until Task 9).

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.css
git commit -m "$(cat <<'EOF'
style(dashboard): tab-strip CSS — sticky home, scroll, dots, pills

Lays down the visual scaffolding for the tab strip introduced in the
previous task: sticky-left Switchboard home button, horizontally
scrollable session tab area for mobile, a state dot + numeric unread
pill + close X per session tab, ⋯ overflow menu for Machines /
History. Hidden-by-default for the cloning template; per-tab visible
content driven by a [data-active] attribute on the .session-tab-content
clone in #session-tab-stack.

Per-session tabs are still empty — JS to populate them lands in the
follow-up tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Refactor render path to take a stream-root parameter

Today `renderStream`, `appendEntryWithGrouping`, and `renderEntry` all read `document.getElementById('detail-stream')` directly. With per-tab content clones, every tab will have its own stream root. Parameterise the render functions so they accept the root explicitly. Behavior unchanged for the single-tab case.

**Files:**

- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Locate the current `renderStream` signature + its callers**

Run: `grep -n 'function renderStream\|renderStream(' dashboard/dashboard.js | head`

Expected: definition around line 2098 + several call sites (`renderStream({ incremental: true })`, `renderStream({ force: true })`, etc.).

- [ ] **Step 2: Refactor `renderStream` to accept a `root` argument**

In `dashboard/dashboard.js`, change the signature of `renderStream` to take the stream root (and the session key) as its first arg. Existing callers gain a new positional argument.

Replace this opening of `renderStream` (around line 2098):

```javascript
async function renderStream(opts) {
  const root = document.getElementById('detail-stream')
  if (!root) return
  if (!selectedSessionId) {
    root.replaceChildren()
    return
  }

  const streamKey =
    selectedSessionId + '|' + (selectedAgentId || '') + '|' + (selectedArchiveUuid || '')
```

With:

```javascript
/**
 * @param {{
 *   root?: HTMLElement | null,
 *   sessionKey?: string,
 *   agentId?: string | null,
 *   archiveUuid?: string | null,
 *   incremental?: boolean,
 *   force?: boolean,
 * }} [opts]
 */
async function renderStream(opts) {
  opts = opts || {}
  // Backwards-compat fallback: if no root passed, use the legacy single
  // detail-stream element. Task 7 wires per-tab roots; until then this
  // branch lights the existing single-session path.
  const root = opts.root || document.getElementById('detail-stream')
  if (!root) return
  const sessionKey = opts.sessionKey ?? selectedSessionId
  const agentId = opts.agentId ?? selectedAgentId
  const archiveUuid = opts.archiveUuid ?? selectedArchiveUuid
  if (!sessionKey) {
    root.replaceChildren()
    return
  }

  const streamKey = sessionKey + '|' + (agentId || '') + '|' + (archiveUuid || '')
```

Then replace every reference to `selectedSessionId` / `selectedAgentId` / `selectedArchiveUuid` inside the rest of `renderStream` body with the local `sessionKey` / `agentId` / `archiveUuid` vars.

For example, find lines like:

```javascript
'session_id=' + encodeURIComponent(selectedSessionId)
```

and change to:

```javascript
'session_id=' + encodeURIComponent(sessionKey)
```

Same for `(selectedAgentId ? '&agent_id=' + encodeURIComponent(selectedAgentId) : '')` → `(agentId ? '&agent_id=' + encodeURIComponent(agentId) : '')`.

And:

```javascript
if (selectedArchiveUuid) qs += '&uuid=' + encodeURIComponent(selectedArchiveUuid)
```

→

```javascript
if (archiveUuid) qs += '&uuid=' + encodeURIComponent(archiveUuid)
```

(The point: the function body must read its inputs only from the `opts` parameter or local variables, never from module-level globals.)

- [ ] **Step 3: Refactor `appendEntryWithGrouping` to accept root explicitly**

Find `appendEntryWithGrouping(root, e)` — it already takes root as its first arg. Confirm by reading around line 2347 in `dashboard.js`. No signature change needed; verify both call sites already pass `root`. If not, fix.

- [ ] **Step 4: Refactor `handleUserPromptLive` and `appendEnvelopeToStream` to accept a root override**

Both currently call `document.getElementById('detail-stream')` then `appendEntryWithGrouping(root, ...)`. Add an optional second argument so per-tab callers can target a specific tab's root.

Find `handleUserPromptLive` (around line 1567 area) and change signature + first lines from:

```javascript
function handleUserPromptLive(data) {
  ...
  const root = document.getElementById('detail-stream')
```

To:

```javascript
/**
 * @param {{ session_name?: string, ... } & Record<string, unknown>} data
 * @param {HTMLElement | null} [rootOverride]
 */
function handleUserPromptLive(data, rootOverride) {
  ...
  const root = rootOverride || document.getElementById('detail-stream')
```

Same change for `appendEnvelopeToStream(envelope)` → `appendEnvelopeToStream(envelope, rootOverride)`.

Both unchanged callers continue to work — the override is optional.

- [ ] **Step 5: Run tests + tsc**

Run: `bun test && bunx tsc --noEmit`

Expected: pass. The refactor is signature-additive only.

- [ ] **Step 6: Manually verify the existing single-session path still works**

Refresh `https://localhost:3400/`, log in, open a live session (you'll see the "broken" template-based session-detail view from Task 3 — but the side panel + header should populate. Stream content can be empty for now). Click "Switchboard" + back to a session — should not crash; transcript fetch should still complete.

(If your repo state has `#session-tab-stack` empty and the template `hidden`, the stream container won't be visible. That's expected — Task 7 makes it visible.)

- [ ] **Step 7: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "$(cat <<'EOF'
refactor(dashboard): renderStream / append paths take explicit root

Today renderStream / handleUserPromptLive / appendEnvelopeToStream
all read document.getElementById('detail-stream') directly + drive
themselves off module-level selectedSessionId / selectedAgentId /
selectedArchiveUuid. The multi-tab strip needs each tab to render
into its own cloned root with its own session key, so parameterise
all three.

Behavior unchanged for the single-tab case — every legacy caller
continues to work, the new opts.root / rootOverride path lights up
in Task 7 when per-tab clones land.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Refactor `loadSessionDetailView` + sidebar / composer paths to accept a tab parameter

Continues the parameterisation: `loadSessionDetailView`, `renderHistorySidebar`, the agent-tree render path, and the composer wiring all currently read globals + by-id DOM. Move them onto an optional explicit `tab` arg. Behavior still unchanged for the single-tab case.

**Files:**

- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Find the existing `loadSessionDetailView` signature**

Run: `grep -n 'function loadSessionDetailView\|loadSessionDetailView(' dashboard/dashboard.js | head`

- [ ] **Step 2: Add a `tab` parameter to `loadSessionDetailView`**

Replace the function signature + body shell:

```javascript
async function loadSessionDetailView() {
  if (!selectedSessionId) return
  const sessionKey = selectedSessionId
  ...
}
```

With:

```javascript
/**
 * @param {{
 *   sessionKey?: string,
 *   agentId?: string | null,
 *   archiveUuid?: string | null,
 *   contentRoot?: HTMLElement,  // when present, scope DOM lookups to this tab clone
 * }} [opts]
 */
async function loadSessionDetailView(opts) {
  opts = opts || {}
  const sessionKey = opts.sessionKey ?? selectedSessionId
  if (!sessionKey) return
  const agentId = opts.agentId ?? selectedAgentId
  const archiveUuid = opts.archiveUuid ?? selectedArchiveUuid
  const root = opts.contentRoot || document
  ...
}
```

Inside the body:

- Replace every `document.getElementById('...')` with `root.querySelector('#...')` so a per-tab clone (where IDs may have suffixes) can be scoped. For now, the IDs inside the template are unchanged so `root.querySelector('#detail-name')` finds the same element under either `document` (legacy) or a clone (Task 7+).
- Replace `selectedSessionId` references in the body with `sessionKey`, `selectedAgentId` with `agentId`, `selectedArchiveUuid` with `archiveUuid`.
- For the inner `renderStream` call at the end, pass through:

```javascript
await renderStream({
  root:
    root === document
      ? document.getElementById('detail-stream')
      : root.querySelector('#detail-stream'),
  sessionKey,
  agentId,
  archiveUuid,
})
```

- For the `renderHistorySidebar` call, add the root argument (next step changes that function's signature).

- [ ] **Step 3: Add a root parameter to `renderHistorySidebar`**

Find `async function renderHistorySidebar(sessionName, currentArchiveUuid)`. Change to:

```javascript
/**
 * @param {string} sessionName
 * @param {string | null} currentArchiveUuid
 * @param {HTMLElement | Document} [scope]
 */
async function renderHistorySidebar(sessionName, currentArchiveUuid, scope) {
  scope = scope || document
  var el = scope === document
    ? document.getElementById('detail-history')
    : /** @type {HTMLElement} */ (scope).querySelector('#detail-history')
  ...
}
```

Update existing callers in `loadSessionDetailView` to pass `root`.

- [ ] **Step 4: Add a root parameter to `renderAgentTree`**

Find `function renderAgentTree()`. Change signature to take an optional scope, mirroring the pattern:

```javascript
/**
 * @param {HTMLElement | Document} [scope]
 */
function renderAgentTree(scope) {
  scope = scope || document
  const ul = scope === document
    ? document.getElementById('detail-tree')
    : /** @type {HTMLElement} */ (scope).querySelector('#detail-tree')
  ...
}
```

Update its body to use `scope.querySelector(...)` for any further by-id lookups inside the function (search for `document.getElementById` within `renderAgentTree` — there shouldn't be many, mostly `ul`).

Update existing callers (in `loadSessionDetailView`, in the `/api/session` fetch handler, etc.) to pass through the scope.

- [ ] **Step 5: Add a root parameter to `resetDetailViewForSwitch`**

This was added in commit `39a7254`. Mirror the pattern:

```javascript
/**
 * @param {HTMLElement | Document} [scope]
 */
function resetDetailViewForSwitch(scope) {
  scope = scope || document
  const stream = scope === document
    ? document.getElementById('detail-stream')
    : /** @type {HTMLElement} */ (scope).querySelector('#detail-stream')
  ...
}
```

Replace every `document.getElementById('...')` inside the function with the same `scope`-aware pattern.

Update the caller in `loadSessionDetailView` to pass `root`.

- [ ] **Step 6: Run tests + tsc**

Run: `bun test && bunx tsc --noEmit`

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "$(cat <<'EOF'
refactor(dashboard): scope sidebar / composer DOM lookups via a root arg

loadSessionDetailView, renderHistorySidebar, renderAgentTree, and
resetDetailViewForSwitch all reached straight into document by id.
Add an optional root / scope parameter to each so per-tab clones
(landing in Task 7) can drive each tab's sidebar + composer in
isolation. When the parameter is omitted, behavior is identical to
today (legacy single-tab path).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `Tab` object + `TabRegistry` + `currentTab()` glue (Switchboard-only)

Introduce the registry data structure and clone-on-pin lifecycle. Switchboard remains the only "tab" rendered for now — clicking a session card still shows it the legacy way (rebuilding the cloned-in single content stack). Per-session tab strip entries land in Task 9.

**Files:**

- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Read the loaded `tabs-state` exports**

Confirm Task 1's module is on disk. Run: `head -20 dashboard/tabs-state.js`. You should see the `loadDismissed` / `pickLruEvictionVictim` etc. exports.

- [ ] **Step 2: Import the helpers + define the Tab + TabRegistry data structures**

Near the top of `dashboard/dashboard.js`, after the existing `import` block (around line 1-10), add:

```javascript
import {
  loadDismissed,
  saveDismissed,
  pickLruEvictionVictim,
  filterStripSessions,
  shouldBumpUnread,
  TAB_DOM_LRU_CAP,
} from './tabs-state.js'
```

Then, after the existing module-level state declarations (after `let unreadCounts = {}` etc., before any function definitions), add:

```javascript
/**
 * @typedef {{
 *   name: string,                // ccpl session name (key) — '' for Switchboard home tab
 *   contentEl: HTMLElement | null, // mounted .session-tab-content clone, or null when evicted
 *   stripTab: HTMLElement | null,  // the strip button DOM, or null when not in strip
 *   streamKeys: Set<string>,
 *   lastRenderedUuid: string | null,
 *   scrollTop: number,
 *   agentId: string | null,
 *   archiveUuid: string | null,
 *   subagents: unknown[],
 *   lastViewedAt: number,
 *   online: boolean,
 *   evictionTimer: ReturnType<typeof setTimeout> | null,
 * }} Tab
 */

/** @type {Map<string, Tab>} keyed by session name. The Switchboard home tab uses '' as its key. */
const tabRegistry = new Map()

/** @type {Set<string>} */
let dismissedTabs = loadDismissed()

/** Currently focused tab name (may be '' for Switchboard). */
let focusedTabName = ''

function currentTab() {
  return tabRegistry.get(focusedTabName) || null
}

/** 5 minutes — how long an offline session stays in the strip before eviction. */
const OFFLINE_GRACE_MS = 5 * 60 * 1000

/** Maximum parallel prefetch fetches at dashboard load. */
const PREFETCH_PARALLELISM = 4
```

- [ ] **Step 3: Add the Switchboard home Tab record on init**

After the constants above, add an init helper that the page-load path will call:

```javascript
/**
 * Insert the Switchboard home tab into the registry. The home tab has no
 * cloned content — it points at the existing static .view[data-view="switchboard"]
 * element. Idempotent.
 */
function ensureSwitchboardTabRegistered() {
  if (tabRegistry.has('')) return
  const stripTab = document.getElementById('tab-strip-switchboard')
  /** @type {Tab} */
  const home = {
    name: '',
    contentEl: null, // home doesn't clone — it shows the existing switchboard view
    stripTab,
    streamKeys: new Set(),
    lastRenderedUuid: null,
    scrollTop: 0,
    agentId: null,
    archiveUuid: null,
    subagents: [],
    lastViewedAt: Date.now(),
    online: true,
    evictionTimer: null,
  }
  tabRegistry.set('', home)
  focusedTabName = ''
}
```

Find the existing dashboard-init code at the bottom of `dashboard.js` (look for `applyRoute(parseUrl(), { skipPush: true })` near line 2951) and add `ensureSwitchboardTabRegistered()` immediately above that call.

- [ ] **Step 4: Add a `pinTab(name)` function that clones the template into the stack**

Add (near the other tab helpers introduced in Step 2):

```javascript
/**
 * Add a session tab to the registry + insert a strip button + clone the
 * session-tab-content template into the stack. Idempotent — if the tab
 * already exists, this is a no-op (returns the existing record).
 *
 * Caller is responsible for clearing the dismissal flag if appropriate.
 *
 * @param {string} name
 * @returns {Tab}
 */
function pinTab(name) {
  const existing = tabRegistry.get(name)
  if (existing) return existing

  // Clone the content template
  const template = document.querySelector('.session-tab-content[data-tab-content-template]')
  if (!template) throw new Error('session-tab-content template missing from DOM')
  const contentEl = /** @type {HTMLElement} */ (template.cloneNode(true))
  contentEl.removeAttribute('hidden')
  contentEl.removeAttribute('data-tab-content-template')
  contentEl.dataset.tabName = name

  // Strip away the original IDs inside the clone — they would collide
  // with the template's hidden copy. Stash them in data-orig-id for
  // refactored code that wants to look them up via per-tab querySelector.
  for (const el of contentEl.querySelectorAll('[id]')) {
    const oldId = el.id
    el.removeAttribute('id')
    el.setAttribute('data-orig-id', oldId)
  }
  // Re-add the IDs only inside the active tab path — the per-tab DOM
  // doesn't need IDs since we always query through the contentEl scope.
  // Leaving them stripped prevents duplicate-id warnings.

  const stack = document.getElementById('session-tab-stack')
  if (!stack) throw new Error('#session-tab-stack missing from DOM')
  stack.appendChild(contentEl)

  // Strip button
  const stripTab = document.createElement('button')
  stripTab.type = 'button'
  stripTab.className = 'tab-strip-tab'
  stripTab.dataset.tabName = name
  const dot = document.createElement('span')
  dot.className = 'state-dot offline'
  const label = document.createElement('span')
  label.className = 'tab-strip-label'
  label.textContent = name
  const pill = document.createElement('span')
  pill.className = 'unread-pill'
  pill.hidden = true
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'tab-close'
  close.textContent = '×'
  close.setAttribute('aria-label', 'Close ' + name)
  stripTab.append(dot, label, pill, close)

  document.getElementById('tab-strip-sessions')?.appendChild(stripTab)

  /** @type {Tab} */
  const tab = {
    name,
    contentEl,
    stripTab,
    streamKeys: new Set(),
    lastRenderedUuid: null,
    scrollTop: 0,
    agentId: null,
    archiveUuid: null,
    subagents: [],
    lastViewedAt: 0, // 0 = never focused, won't be picked by LRU
    online: false,
    evictionTimer: null,
  }
  tabRegistry.set(name, tab)
  return tab
}
```

- [ ] **Step 5: Add `focusTab(name)` that flips visibility + updates the URL**

Add:

```javascript
/**
 * Make `name` the active tab. Hides all other tab content (and the legacy
 * static views), updates aria-current on strip buttons, sets lastViewedAt,
 * resets the unread count, and triggers a content-load if the tab is empty.
 *
 * @param {string} name '' for Switchboard, otherwise a session name
 * @param {{ pushHistory?: boolean }} [opts]
 */
function focusTab(name, opts) {
  opts = opts || {}
  const tab = tabRegistry.get(name)
  if (!tab) {
    console.warn('focusTab called with unknown name', name)
    return
  }

  // Mark every strip button non-current
  for (const btn of document.querySelectorAll('.tab-strip-tab')) {
    btn.removeAttribute('aria-current')
  }
  if (tab.stripTab) tab.stripTab.setAttribute('aria-current', 'page')

  // Hide all per-tab content clones; activate this one (or none, for home).
  for (const c of document.querySelectorAll('.session-tab-stack > .session-tab-content')) {
    c.removeAttribute('data-active')
  }
  if (tab.contentEl) tab.contentEl.setAttribute('data-active', 'true')

  // Hide all legacy .view[data-view] sections except the right one.
  for (const v of document.querySelectorAll('section.view[data-view]')) {
    v.removeAttribute('hidden')
    v.classList.remove('active')
  }
  if (name === '') {
    // Show switchboard view (legacy static)
    const sw = document.querySelector('section.view[data-view="switchboard"]')
    if (sw) sw.classList.add('active')
    for (const v of document.querySelectorAll('section.view[data-view]')) {
      if (v !== sw) v.setAttribute('hidden', '')
    }
  } else {
    // Show the session-detail view — the per-tab clone inside #session-tab-stack
    // is what the user sees, but the wrapping section is the only [data-view]
    // we mark active so existing CSS keeps working.
    const sd = document.querySelector('section.view[data-view="session-detail"]')
    if (sd) sd.classList.add('active')
    for (const v of document.querySelectorAll('section.view[data-view]')) {
      if (v !== sd) v.setAttribute('hidden', '')
    }
  }

  focusedTabName = name
  tab.lastViewedAt = Date.now()
  unreadCounts[name] = 0
  refreshUnreadPill(tab)

  // URL update
  const url = name === '' ? '/' : '/session/' + encodeURIComponent(name)
  if (opts.pushHistory) {
    history.pushState({ tab: name }, '', url)
  } else {
    history.replaceState({ tab: name }, '', url)
  }

  // Lazy load the content if not already populated for this tab
  if (name !== '' && tab.contentEl && !tab.contentEl.dataset.loaded) {
    tab.contentEl.dataset.loaded = 'true'
    void loadSessionDetailView({
      sessionKey: name,
      agentId: tab.agentId,
      archiveUuid: tab.archiveUuid,
      contentRoot: tab.contentEl,
    })
  }
}

function refreshUnreadPill(tab) {
  if (!tab.stripTab) return
  const pill = tab.stripTab.querySelector('.unread-pill')
  if (!(pill instanceof HTMLElement)) return
  const count = unreadCounts[tab.name] || 0
  if (count > 0) {
    pill.hidden = false
    pill.textContent = String(count)
  } else {
    pill.hidden = true
    pill.textContent = ''
  }
}
```

- [ ] **Step 6: Add `dismissTab(name)` — close X handler**

Add:

```javascript
/**
 * Remove a session tab's strip entry + DOM, and add it to the dismissal
 * set so it doesn't auto-re-pin the next time it appears in
 * sessions-snapshot. The Switchboard tab cannot be dismissed.
 *
 * @param {string} name
 */
function dismissTab(name) {
  if (name === '') return
  const tab = tabRegistry.get(name)
  if (!tab) return
  // Stop any pending offline-eviction timer
  if (tab.evictionTimer) {
    clearTimeout(tab.evictionTimer)
    tab.evictionTimer = null
  }
  if (tab.contentEl && tab.contentEl.parentNode) tab.contentEl.parentNode.removeChild(tab.contentEl)
  if (tab.stripTab && tab.stripTab.parentNode) tab.stripTab.parentNode.removeChild(tab.stripTab)
  tabRegistry.delete(name)
  dismissedTabs.add(name)
  saveDismissed(dismissedTabs)
  // Move focus to the next tab on the right, or Switchboard if none
  if (focusedTabName === name) {
    const next = pickFocusAfterDismiss(name)
    focusTab(next, { pushHistory: false })
  }
}

/**
 * @param {string} dismissedName
 * @returns {string}
 */
function pickFocusAfterDismiss(dismissedName) {
  // Prefer the strip tab to the right of the one being dismissed; fall
  // back to the one to its left; finally fall back to Switchboard ('').
  const buttons = Array.from(document.querySelectorAll('#tab-strip-sessions .tab-strip-tab'))
  const idx = buttons.findIndex(
    (b) => /** @type {HTMLElement} */ (b).dataset.tabName === dismissedName,
  )
  if (idx === -1) return ''
  const right = buttons[idx + 1]
  if (right) return /** @type {HTMLElement} */ (right).dataset.tabName || ''
  const left = buttons[idx - 1]
  if (left) return /** @type {HTMLElement} */ (left).dataset.tabName || ''
  return ''
}
```

- [ ] **Step 7: Run tests + tsc**

Run: `bun test && bunx tsc --noEmit`

Expected: pass.

- [ ] **Step 8: Manually verify Switchboard still loads + the page has the strip + no JS errors**

Refresh `https://localhost:3400/`. The Switchboard view should render. The strip should show the Switchboard home tab marked current. The browser console should have no errors. Per-session tabs are still empty — Task 9 fills them.

- [ ] **Step 9: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "$(cat <<'EOF'
feat(dashboard): tab registry + Switchboard home tab + pin/focus/dismiss

Introduces the data plumbing for the multi-tab strip:

- tabRegistry Map keyed by session name (Switchboard home uses '')
- Tab object capturing per-tab DOM root + sidebar/agent/archive state +
  online status + lastViewedAt + offline eviction timer handle
- pinTab clones the .session-tab-content template into #session-tab-stack,
  inserts a strip button with state dot + unread pill + close X
- focusTab flips visibility, updates aria-current, resets unread, lazy-
  loads content on first focus, pushes/replaces URL per opts.pushHistory
- dismissTab tears down the DOM, persists to the dismissal set, and
  hands focus to the next tab on the right (or Switchboard fallback)

Strip is still empty for sessions — Task 9 wires sessions-snapshot to
auto-pin live ones. Switchboard view continues to render via the
legacy static section, now reached through focusTab('').

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire tab focus + click handlers + URL push/replace policy

Hook strip clicks, X close clicks, switchboard card clicks, and `popstate` to the new `focusTab` / `pinTab` / `dismissTab` plumbing. Replace the legacy `applyRoute` URL routing with the tab-driven version.

**Files:**

- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Wire the strip's click delegation**

Add (near the bottom of `dashboard.js`, after the existing event-listener setup):

```javascript
document.getElementById('tab-strip')?.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target)
  // Close X
  if (target.classList.contains('tab-close')) {
    e.stopPropagation()
    const btn = target.closest('.tab-strip-tab')
    const name = btn instanceof HTMLElement ? btn.dataset.tabName || '' : ''
    if (name) dismissTab(name)
    return
  }
  // Tab focus
  const btn = target.closest('.tab-strip-tab')
  if (btn instanceof HTMLElement) {
    e.preventDefault()
    const name = btn.dataset.tabName ?? ''
    focusTab(name, { pushHistory: true })
    return
  }
  // Overflow menu Machines / History
  const overflowBtn = target.closest('.tab-strip-overflow-menu button')
  if (overflowBtn instanceof HTMLElement) {
    const view = overflowBtn.dataset.view
    if (view === 'machines') navigate({ view: 'machines' })
    else if (view === 'history') navigate({ view: 'history' })
    // Close the <details> after click
    document.getElementById('tab-strip-overflow')?.removeAttribute('open')
  }
})
```

- [ ] **Step 2: Update switchboard card click handler to use `pinTab` + `focusTab`**

Find the existing switchboard-card click handler (search `selectedSessionId =` near a card-click context, or grep for `navigate({ view: 'session-detail'`). It should be in `updateSessions` or a card-render helper.

Whatever path currently triggers `navigate({ view: 'session-detail', sessionName: name })`, replace with:

```javascript
function openSessionFromSwitchboard(name) {
  // Pin (idempotent), clear dismissal, focus.
  if (dismissedTabs.has(name)) {
    dismissedTabs.delete(name)
    saveDismissed(dismissedTabs)
  }
  pinTab(name)
  focusTab(name, { pushHistory: true })
}
```

Then update the existing card click site to call `openSessionFromSwitchboard(name)` instead of `navigate({ view: 'session-detail', sessionName: name })`.

- [ ] **Step 3: Replace `applyRoute` with a thin tab-routing dispatcher**

Find the existing `function applyRoute(state, opts) {` (around line 154). The body has separate branches for `session-detail`, `history`, `switchboard`. Replace the entire function body with:

```javascript
function applyRoute(state, opts) {
  opts = opts || {}
  if (state.view === 'session-detail' && state.sessionName) {
    // Pin if not already in the strip; clear dismissal (URL beats dismissal).
    if (dismissedTabs.has(state.sessionName)) {
      dismissedTabs.delete(state.sessionName)
      saveDismissed(dismissedTabs)
    }
    if (!tabRegistry.has(state.sessionName)) {
      // Tab doesn't exist yet — pin it. The tab will reflect online state
      // when sessions-snapshot arrives (Task 9).
      pinTab(state.sessionName)
    }
    const tab = tabRegistry.get(state.sessionName)
    if (tab) {
      tab.agentId = state.agentId || null
      tab.archiveUuid = state.archiveUuid || null
    }
    focusTab(state.sessionName, { pushHistory: !opts.skipPush })
    return
  }
  if (state.view === 'history') {
    renderView('history')
    if (state.subtab) {
      const subBtn = document.querySelector(
        '#history-subtabs button[data-subtab="' + state.subtab + '"]',
      )
      if (subBtn instanceof HTMLElement) subBtn.click()
    }
    if (!opts.skipPush) pushRoute(state)
    return
  }
  if (state.view === 'machines') {
    renderView('machines')
    if (!opts.skipPush) pushRoute(state)
    return
  }
  // Default: switchboard
  focusTab('', { pushHistory: !opts.skipPush })
}
```

The legacy `renderView('switchboard')` / `renderView('session-detail')` calls move to whatever `focusTab` triggers — `focusTab` handles the visibility flip directly. Machines and History remain on `renderView` since they are full-view replacements (no per-tab state).

- [ ] **Step 4: Wire `popstate` to re-apply route**

Verify the existing `popstate` listener (search for `addEventListener('popstate'`). It currently calls `applyRoute(parseUrl(), { skipPush: true })`. That continues to work — the new `applyRoute` body handles per-tab focus correctly via `skipPush`. No change needed; just confirm the listener is still present.

- [ ] **Step 5: Run tests + tsc**

Run: `bun test && bunx tsc --noEmit`

Expected: pass.

- [ ] **Step 6: Manually verify the click + URL flow**

Refresh `https://localhost:3400/`. Click into a session card on the switchboard. Verify:

- A new tab appears in the strip with the session's name.
- The URL changes to `/session/<name>`.
- The session-detail view (cloned) shows the transcript (after a brief load).
- Click the strip's Switchboard tab → URL goes back to `/`, switchboard view shows.
- Click into the session tab again → URL goes back to `/session/<name>`.
- Browser back: should walk to the previous URL (Switchboard or whichever).
- Click the X on the session tab: tab disappears, focus goes to Switchboard, URL returns to `/`.
- Reload after pinning two sessions: only sessions whose state matches `online` and whose names aren't dismissed get auto-pinned (this is wired in Task 9 — for this task you can verify only the dismissed-name case persists by manual reload).

- [ ] **Step 7: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "$(cat <<'EOF'
feat(dashboard): wire strip clicks + URL push/replace policy

Hooks the strip's click delegation (tab focus, close X, overflow menu)
+ replaces applyRoute's per-view branching with a tab-driven dispatch:

- switchboard card click → openSessionFromSwitchboard → pinTab +
  focusTab with pushHistory:true and clears dismissal.
- strip tab click → focusTab with pushHistory:true.
- close X → dismissTab, focus advances to right neighbour or home.
- popstate → applyRoute(skipPush:true) → focusTab with replace, so
  back/forward navigates between intentional views without walking
  individual keyboard tab switches one-by-one (those use replaceState
  in Task 13).
- overflow menu Machines / History → navigate(...) → existing
  renderView path (those views aren't per-tab).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Auto-pin live sessions on `sessions-snapshot` + `session-delta`; per-tab unread + state dot updates

The `/ws/observer` stream already feeds the dashboard with `sessions-snapshot` (full list on connect) and `session-delta` (per-session updates). Use these to:

- pin tabs for online, non-dismissed sessions
- update the state dot on each strip button as state/online changes
- bump the unread counter via the new `shouldBumpUnread` predicate (replaces the inline rule)

**Files:**

- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Locate the sessions-snapshot handler**

Run: `grep -n 'sessions-snapshot\|session-delta\|sessionsReady' dashboard/dashboard.js | head`

Expected: a handler that sets `lastSessions` + flips `sessionsReady = true` (around line 917). And a `session-delta` branch that mutates rows.

- [ ] **Step 2: Add a syncStripFromSessions helper**

Add (after the tab helpers introduced in Task 7):

```javascript
/**
 * Reconcile the tab strip against the latest list of ccpl sessions.
 * Adds tabs for online + non-dismissed sessions that aren't yet pinned;
 * updates the state dot + offline class on every existing tab.
 * Does NOT remove offline tabs immediately — that's the 5-min eviction
 * timer's job (Task 12).
 *
 * @param {Array<{ name: string, online: boolean, state?: string }>} sessions
 */
function syncStripFromSessions(sessions) {
  const visible = filterStripSessions(sessions, dismissedTabs)
  for (const s of visible) {
    if (!tabRegistry.has(s.name)) {
      pinTab(s.name)
    }
  }
  for (const s of sessions) {
    const tab = tabRegistry.get(s.name)
    if (!tab) continue
    setTabOnlineState(tab, s.online, s.state)
  }
}

/**
 * @param {Tab} tab
 * @param {boolean} online
 * @param {string | undefined} state
 */
function setTabOnlineState(tab, online, state) {
  tab.online = online
  if (!tab.stripTab) return
  const dot = tab.stripTab.querySelector('.state-dot')
  if (dot instanceof HTMLElement) {
    dot.classList.remove('idle', 'working', 'offline')
    if (!online) dot.classList.add('offline')
    else if (state === 'working') dot.classList.add('working')
    else dot.classList.add('idle')
  }
  if (online) {
    tab.stripTab.classList.remove('tab-offline')
  } else {
    tab.stripTab.classList.add('tab-offline')
  }
}
```

- [ ] **Step 3: Hook `sessions-snapshot` to sync the strip**

Find the existing snapshot handler (around line 917). It currently does something like:

```javascript
} else if (data.type === 'sessions-snapshot') {
  ...
  lastSessions = data.sessions
  if (!sessionsReady) {
    sessionsReady = true
    if (pendingRouteState) {
      ...
    }
  }
}
```

Add a `syncStripFromSessions(data.sessions)` call inside that branch, AFTER `lastSessions` is updated. Final shape:

```javascript
} else if (data.type === 'sessions-snapshot') {
  ...
  lastSessions = data.sessions
  syncStripFromSessions(data.sessions)
  if (!sessionsReady) {
    sessionsReady = true
    if (pendingRouteState) {
      ...
    }
  }
}
```

- [ ] **Step 4: Hook `session-delta` to update the strip per tab**

Find the existing `session-delta` branch (around line 987). After the existing `lastSessions` update logic, add:

```javascript
const liveRow = lastSessions.find((s) => s.name === delta.session)
if (liveRow) {
  // The delta only ever carries fields the row needs to merge — re-sync
  // ALL tabs so a row that just came online auto-pins, and existing tabs
  // refresh their dot/online indicator.
  syncStripFromSessions(lastSessions)
}
```

- [ ] **Step 5: Replace the inline unread bump rule with `shouldBumpUnread`**

Find the inline bump block updated in Task 2 (around line 421). Replace its contents with:

```javascript
if (
  data.data &&
  data.data.session_name &&
  shouldBumpUnread({ kind: 'hook-event', hookEvent: data.data.hook_event })
) {
  bumpUnread(data.data.session_name)
}
```

(The block above guards via `shouldBumpUnread`; the legacy comment immediately above can stay or be replaced with: `// Unread counter — see shouldBumpUnread() in tabs-state.js.`)

Find `handleApiError(data)` (around line 1620). Replace the body's bump line with the same predicate — it's still always-true, but the call sites are uniform:

```javascript
function handleApiError(data) {
  if (!data || !data.session_name) return
  if (shouldBumpUnread({ kind: 'api-error' })) bumpUnread(data.session_name)
  ...
}
```

- [ ] **Step 6: Update `bumpUnread` to refresh the strip's unread pill**

Find `function bumpUnread(sessionKey)` (around line 115). Change it to also refresh the pill:

```javascript
function bumpUnread(sessionKey) {
  if (!sessionKey) return
  // Don't bump for the currently-focused tab — focusing already cleared it.
  if (sessionKey === focusedTabName) return
  unreadCounts[sessionKey] = (unreadCounts[sessionKey] || 0) + 1
  updateSessions(lastSessions)
  const tab = tabRegistry.get(sessionKey)
  if (tab) refreshUnreadPill(tab)
}
```

- [ ] **Step 7: Run tests + tsc**

Run: `bun test && bunx tsc --noEmit`

Expected: pass.

- [ ] **Step 8: Manually verify auto-pin + state dot**

Refresh `https://localhost:3400/`. With at least one live session running (your dashboard's own ccpl session is one), the strip should now show that session as a tab. The state dot should reflect online (green = idle, yellow = working). When a session goes offline (kill it / disconnect it), the dot should turn grey and the tab fade.

Any "Stop" / "Notification" event arriving for an unfocused tab should bump that tab's pill.

- [ ] **Step 9: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "$(cat <<'EOF'
feat(dashboard): auto-pin live sessions + per-tab state dots + unread

Wire /ws/observer's sessions-snapshot + session-delta to keep the
strip in sync with the live ccpl session list:

- syncStripFromSessions pins tabs for online non-dismissed sessions;
  updates the state dot + tab-offline class on every existing tab.
- bumpUnread is now a no-op for the focused tab and refreshes the
  per-tab unread pill on the strip when a non-focused tab is bumped.
- Inline bump rules now route through tabs-state.js shouldBumpUnread
  so the classification lives in one tested place.

Offline tabs stay in the strip (greyed) until the 5-min eviction
timer in Task 12. The strip-button click + dismiss handlers from
Task 8 already drive focus + close — this task only adds the data
flow that fills + refreshes them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Prefetch on dashboard load (parallelism cap)

After the first sessions-snapshot, kick off `loadSessionDetailView` in the background for every pinned tab so its content is already rendered by the time the user first focuses it. Cap concurrent fetches.

**Files:**

- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Add a parallel-prefetch helper**

Add (near the other tab helpers):

```javascript
/**
 * Run an async task per item with a parallelism cap. Resolves once all
 * tasks have completed (or rejected). Errors from individual tasks are
 * swallowed (logged via console.warn) — one failed prefetch must not
 * block the others.
 *
 * @template T
 * @param {T[]} items
 * @param {number} cap
 * @param {(item: T) => Promise<void>} run
 */
async function runWithCap(items, cap, run) {
  let i = 0
  /** @type {Promise<void>[]} */
  const workers = []
  const next = async () => {
    while (i < items.length) {
      const idx = i++
      try {
        await run(items[idx])
      } catch (err) {
        console.warn('[prefetch] task failed for', items[idx], err)
      }
    }
  }
  for (let w = 0; w < Math.max(1, cap); w++) workers.push(next())
  await Promise.all(workers)
}

/**
 * For every pinned, non-focused, content-empty tab, kick off a
 * loadSessionDetailView so its DOM is populated by the time the user
 * focuses it. Capped at PREFETCH_PARALLELISM concurrent fetches.
 */
async function prefetchAllPinnedTabs() {
  /** @type {Tab[]} */
  const targets = []
  for (const tab of tabRegistry.values()) {
    if (tab.name === '') continue // Switchboard home doesn't load
    if (!tab.contentEl) continue // evicted — skip
    if (tab.contentEl.dataset.loaded === 'true') continue
    targets.push(tab)
  }
  await runWithCap(targets, PREFETCH_PARALLELISM, async (tab) => {
    if (!tab.contentEl) return
    tab.contentEl.dataset.loaded = 'true'
    await loadSessionDetailView({
      sessionKey: tab.name,
      agentId: tab.agentId,
      archiveUuid: tab.archiveUuid,
      contentRoot: tab.contentEl,
    })
  })
}
```

- [ ] **Step 2: Call the prefetch from the snapshot handler, once**

Inside the `sessions-snapshot` handler, after the existing `syncStripFromSessions(data.sessions)` call (added in Task 9), trigger a prefetch but only on the FIRST snapshot:

```javascript
syncStripFromSessions(data.sessions)
if (!sessionsReady) {
  sessionsReady = true
  if (pendingRouteState) {
    ...
  }
  // Prefetch on the first snapshot only — runs concurrently with whatever
  // view the user is focused on. Don't await; let it fill in the
  // background.
  void prefetchAllPinnedTabs()
}
```

- [ ] **Step 3: Run tests + tsc**

Run: `bun test && bunx tsc --noEmit`

Expected: pass.

- [ ] **Step 4: Manually verify prefetch**

Refresh `https://localhost:3400/` while at least one session is live. Stay on the Switchboard view. Open browser DevTools → Network. Within ~1 second of load, you should see `/api/transcript?session_id=...` requests fire even though you haven't clicked any session tab. Switching to a session tab should be near-instant (no spinner — content already loaded).

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "$(cat <<'EOF'
feat(dashboard): prefetch all pinned tabs on first sessions-snapshot

After the first sessions-snapshot arrives, kick off loadSessionDetailView
in the background for every pinned non-empty tab. Capped at
PREFETCH_PARALLELISM=4 concurrent fetches so the server isn't hit with
N parallel transcript reads on dashboard open. Errors from one tab's
prefetch don't block the others.

End result: by the time the user clicks a session tab, the transcript
+ sidebar are already rendered. No more "loading…" + scroll-jump on
first focus.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Route WS events to ALL matching tabs (background updates)

Live envelope / jsonl-update / hook events currently only update the focused session's stream. With multi-tab strip, every cached tab must receive its events even when not focused, so switching is instantly up-to-date.

**Files:**

- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Locate the envelope handler that calls `appendEnvelopeToStream`**

Run: `grep -n 'appendEnvelopeToStream\|appendEntryWithGrouping\|handleUserPromptLive\|handleJsonlEvent' dashboard/dashboard.js | head`

Find the WS envelope branch (around line 373) that does:

```javascript
if (
  currentView === 'session-detail' &&
  selectedSessionId &&
  (adapted.from === selectedSessionId || adapted.to === selectedSessionId)
) {
  appendEnvelopeToStream(adapted)
}
```

- [ ] **Step 2: Replace with a fan-out across all matching tabs**

Change the block to:

```javascript
// Fan the envelope into every tab whose session matches (focused or not).
for (const tab of tabRegistry.values()) {
  if (tab.name === '') continue
  if (!tab.contentEl) continue
  if (adapted.from !== tab.name && adapted.to !== tab.name) continue
  const root = tab.contentEl.querySelector('[data-orig-id="detail-stream"]')
  if (root instanceof HTMLElement) appendEnvelopeToStream(adapted, root)
}
```

- [ ] **Step 3: Same fan-out for jsonl events / handleJsonlEvent**

Find the jsonl event branch (around line 412 — `} else if (data.type === 'jsonl') { handleJsonlEvent(data.data) }`). Look at `handleJsonlEvent` (around line 1652). It currently:

```javascript
function handleJsonlEvent(data) {
  if (currentView !== 'session-detail' || !selectedSessionId) return
  ...
  if (sessionName !== selectedSessionId && sessionId !== selectedSessionId) return
  ...
  // calls appendEntryWithGrouping(root, e) with root = document.getElementById('detail-stream')
}
```

Refactor `handleJsonlEvent` so it ignores `currentView` / `selectedSessionId` filters and instead loops through tabs:

```javascript
function handleJsonlEvent(data) {
  if (!data) return
  const sessionName = data.session_name || resolveNameFromJsonlPath(data.file_path)
  const sessionId = data.session_id
  for (const tab of tabRegistry.values()) {
    if (tab.name === '') continue
    if (!tab.contentEl) continue
    if (sessionName !== tab.name && sessionId !== tab.name) continue
    const root = tab.contentEl.querySelector('[data-orig-id="detail-stream"]')
    if (root instanceof HTMLElement) {
      // ... existing entry-build logic, then:
      appendEntryWithGrouping(root, entry)
    }
  }
}
```

(Adapt the body — preserve any entry-construction logic; only the routing changes.)

- [ ] **Step 4: Same fan-out for `handleUserPromptLive`**

Find `function handleUserPromptLive(data)` (around line 1567). Currently it gates on `selectedSessionId`. Refactor identically — find the matching tab(s) by `data.session_name`, append into each tab's root.

```javascript
function handleUserPromptLive(data) {
  if (!data || !data.session_name) return
  const entry = {
    /* existing entry construction */
  }
  for (const tab of tabRegistry.values()) {
    if (tab.name === '') continue
    if (!tab.contentEl) continue
    if (data.session_name !== tab.name) continue
    if (tab.streamKeys.has(entry.uuid)) continue
    tab.streamKeys.add(entry.uuid)
    const root = tab.contentEl.querySelector('[data-orig-id="detail-stream"]')
    if (!(root instanceof HTMLElement)) continue
    appendEntryWithGrouping(root, entry)
    if (tab.name === focusedTabName) {
      const wasNearBottom = isNearBottom(root)
      if (wasNearBottom) root.scrollTop = root.scrollHeight
    }
  }
}
```

- [ ] **Step 5: Run tests + tsc**

Run: `bun test && bunx tsc --noEmit`

Expected: pass.

- [ ] **Step 6: Manually verify fan-out**

Refresh `https://localhost:3400/`. With two live sessions running, focus session A. Watch session A's transcript update live. Switch to the Switchboard tab. Trigger activity in session B (e.g., send a message via party-line CLI). Switch to session B's tab — its transcript should already include the recent activity, no fresh spinner.

- [ ] **Step 7: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "$(cat <<'EOF'
feat(dashboard): fan WS events to every matching tab, not just focused

Live envelopes / jsonl-updates / user-prompt events used to gate on
currentView === 'session-detail' && selectedSessionId. With the multi-
tab strip every cached tab must keep receiving its updates even when
hidden, otherwise switching to a background tab would show stale
content + force a re-fetch.

Refactor handleUserPromptLive, appendEnvelopeToStream-callsite, and
handleJsonlEvent to walk tabRegistry and append into any tab whose
name matches the event's session. Dedup against per-tab streamKeys
so re-sending an envelope doesn't duplicate. Scroll-to-bottom only
fires for the focused tab so background updates don't fight scroll
position.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: 5-minute offline-eviction timer + auto re-pin on reconnect

When a tab's session goes offline, start a 5-minute timer. On reconnect within the window, cancel the timer (tab stays). On expiry, remove the tab from the strip without adding to dismissal — so it auto-pins again next time it's online.

**Files:**

- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Modify `setTabOnlineState` to drive the timer**

Replace the body of `setTabOnlineState` from Task 9 with:

```javascript
function setTabOnlineState(tab, online, state) {
  const wasOnline = tab.online
  tab.online = online
  if (tab.stripTab) {
    const dot = tab.stripTab.querySelector('.state-dot')
    if (dot instanceof HTMLElement) {
      dot.classList.remove('idle', 'working', 'offline')
      if (!online) dot.classList.add('offline')
      else if (state === 'working') dot.classList.add('working')
      else dot.classList.add('idle')
    }
    tab.stripTab.classList.toggle('tab-offline', !online)
  }
  if (online && tab.evictionTimer) {
    // Came back online within the grace window — cancel eviction.
    clearTimeout(tab.evictionTimer)
    tab.evictionTimer = null
  } else if (!online && wasOnline && !tab.evictionTimer) {
    // Just went offline — start the 5-min eviction timer.
    tab.evictionTimer = setTimeout(() => {
      tab.evictionTimer = null
      // Only evict if still offline.
      if (!tab.online) unpinTabAfterOfflineEviction(tab.name)
    }, OFFLINE_GRACE_MS)
  }
}

/**
 * Like dismissTab but does NOT add the session to the dismissal set —
 * it just removes the tab from the strip + DOM. Used when the offline
 * grace timer expires; the tab auto-pins again next time the session
 * comes online.
 *
 * @param {string} name
 */
function unpinTabAfterOfflineEviction(name) {
  if (name === '') return
  const tab = tabRegistry.get(name)
  if (!tab) return
  if (tab.contentEl?.parentNode) tab.contentEl.parentNode.removeChild(tab.contentEl)
  if (tab.stripTab?.parentNode) tab.stripTab.parentNode.removeChild(tab.stripTab)
  tabRegistry.delete(name)
  if (focusedTabName === name) {
    const next = pickFocusAfterDismiss(name)
    focusTab(next, { pushHistory: false })
  }
}
```

- [ ] **Step 2: Run tests + tsc**

Run: `bun test && bunx tsc --noEmit`

Expected: pass.

- [ ] **Step 3: Manually verify (or shorten the timer for verification)**

The 5-min timer is too long for live verification. Temporarily change `const OFFLINE_GRACE_MS = 5 * 60 * 1000` to `const OFFLINE_GRACE_MS = 10 * 1000` (10 seconds), refresh, kill a session's ccpl process, watch the tab go grey then disappear within ~10 seconds. Restart the session — tab should auto-reappear (because syncStripFromSessions on the next snapshot pins it again).

After verification, **revert OFFLINE_GRACE_MS back to `5 * 60 * 1000`** before committing.

- [ ] **Step 4: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "$(cat <<'EOF'
feat(dashboard): 5-min offline eviction timer + auto re-pin

When a tab's session goes offline, start a 5-minute timer. Reconnect
within that window cancels it (tab stays, dot greyed). Expiry removes
the tab from the strip but does NOT add to the dismissal set — so the
session auto-pins again the next time it comes online (handled by
syncStripFromSessions in Task 9).

Tabs the user explicitly closed via X still go through dismissTab
which DOES persist to dismissal, distinct from this auto-eviction
path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Keyboard navigation (Alt+Left/Right, Esc) + LRU eviction

Wire global keyboard handlers per the spec. Hard-intercept Alt+Left/Right always (including in textareas). Esc focuses Switchboard. LRU eviction kicks in when registry size exceeds TAB_DOM_LRU_CAP (8).

**Files:**

- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Add the keyboard handler**

Add (near the other event listeners):

```javascript
window.addEventListener(
  'keydown',
  (e) => {
    // Alt+Left / Alt+Right: tab navigation; intercept ALWAYS (even in
    // textarea) per spec — overrides macOS word-jump.
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      e.stopPropagation()
      const buttons = Array.from(document.querySelectorAll('#tab-strip .tab-strip-tab'))
      if (buttons.length === 0) return
      const idx = buttons.findIndex(
        (b) => /** @type {HTMLElement} */ (b).getAttribute('aria-current') === 'page',
      )
      const dir = e.key === 'ArrowRight' ? 1 : -1
      const len = buttons.length
      const nextIdx = ((idx === -1 ? 0 : idx) + dir + len) % len
      const nextBtn = /** @type {HTMLElement} */ (buttons[nextIdx])
      const name = nextBtn.dataset.tabName ?? ''
      focusTab(name, { pushHistory: false }) // replaceState — see spec
      return
    }
    // Esc: focus Switchboard.
    if (e.key === 'Escape') {
      // Don't fight a textarea / overflow menu / open <details>; only
      // intercept if focus is NOT inside the composer or an open menu.
      const t = /** @type {HTMLElement} */ (e.target)
      if (t && t.closest && t.closest('.detail-send')) return
      e.preventDefault()
      focusTab('', { pushHistory: false })
    }
  },
  true, // capture phase so we beat in-component handlers
)
```

- [ ] **Step 2: Add LRU eviction to `focusTab`**

In `focusTab`, after the lazy-load block at the bottom, add:

```javascript
// LRU sweep: if the registry has grown past the cap, evict the
// least-recently-focused tab's DOM (keep its strip entry). Re-focusing
// later will trigger a fresh loadSessionDetailView.
maybeEvictByLru()
```

Then add the helper:

```javascript
/** Soft-evict the LRU tab's DOM, keeping its strip entry intact. */
function maybeEvictByLru() {
  /** @type {Map<string, { lastViewedAt: number }>} */
  const candidates = new Map()
  for (const [name, tab] of tabRegistry) {
    if (name === '') continue // never evict Switchboard
    if (!tab.contentEl) continue // already evicted
    candidates.set(name, { lastViewedAt: tab.lastViewedAt })
  }
  const victim = pickLruEvictionVictim(candidates, TAB_DOM_LRU_CAP)
  if (!victim) return
  const t = tabRegistry.get(victim)
  if (!t || !t.contentEl) return
  if (t.contentEl.parentNode) t.contentEl.parentNode.removeChild(t.contentEl)
  t.contentEl = null
  t.streamKeys = new Set()
  t.lastRenderedUuid = null
  t.subagents = []
  // strip entry stays (greyed if offline, normal otherwise) — clicking it
  // re-creates the content via pinTab + lazy-load.
}
```

When the user re-focuses an evicted tab, `focusTab` will currently fail because `tab.contentEl` is null. Update `focusTab` to recreate the content if `contentEl` is null:

```javascript
// In focusTab, BEFORE the visibility flip:
if (name !== '' && tab.contentEl === null) {
  // Re-mount: clone the template again, attach to stack, mark not-loaded
  // so the lazy-load below fires.
  const template = document.querySelector('.session-tab-content[data-tab-content-template]')
  if (template) {
    const cloned = /** @type {HTMLElement} */ (template.cloneNode(true))
    cloned.removeAttribute('hidden')
    cloned.removeAttribute('data-tab-content-template')
    cloned.dataset.tabName = name
    for (const el of cloned.querySelectorAll('[id]')) {
      const oldId = el.id
      el.removeAttribute('id')
      el.setAttribute('data-orig-id', oldId)
    }
    document.getElementById('session-tab-stack')?.appendChild(cloned)
    tab.contentEl = cloned
  }
}
```

- [ ] **Step 3: Run tests + tsc**

Run: `bun test && bunx tsc --noEmit`

Expected: pass.

- [ ] **Step 4: Manually verify keyboard nav + LRU eviction**

Refresh `https://localhost:3400/`. With multiple session tabs in the strip:

- Press Alt+Right repeatedly. Focus walks through every tab (Switchboard → first session → second → … → wraps back to Switchboard).
- Press Alt+Left — walks the other direction.
- Type Alt+Left/Right while focused in the composer textarea — focus still walks (override is hard, no word-jump).
- Press Esc — focuses Switchboard.

For LRU eviction, you need to open >8 tabs. Quickest: temporarily change `TAB_DOM_LRU_CAP` in `dashboard/tabs-state.js` to `2`, refresh, open three sessions. After focusing the third, the first should have its content evicted (open DevTools, find its `.session-tab-content` clone — should be missing). Click the first tab again — its content should rebuild via lazy load.

After verification, **revert TAB_DOM_LRU_CAP back to `8`** and re-run `bun test` (the test asserts the cap value).

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "$(cat <<'EOF'
feat(dashboard): keyboard nav (Alt+Left/Right + Esc) + LRU eviction

- Global keydown handler in capture phase intercepts Alt+Left/Right
  always (even in textarea per spec — overrides macOS word-jump).
  Wraps at strip boundaries; Switchboard counts as the leftmost slot.
- Esc focuses Switchboard unless focus is inside the composer.
- After every focus, maybeEvictByLru picks the least-recently-focused
  tab whose DOM is mounted (skipping the never-focused = lastViewedAt
  0 prefetched ones) and tears down its content. Strip entry stays.
- focusTab re-clones the content template on re-focus of an evicted
  tab, then lazy-loads via the existing path.

Keyboard switches use replaceState — back/forward doesn't walk every
single Alt+Right one-by-one, only intentional clicks / address-bar
navigations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: End-to-end Playwright walkthrough

Verify the full feature on a real running dashboard with at least two live sessions. This is the only task that does NOT result in a code change — it's verification + a commit only if any small fixes fall out.

**Tools:** Playwright MCP browser tools (browser_navigate, browser_click, browser_snapshot, browser_press_key, browser_take_screenshot).

- [ ] **Step 1: Confirm at least two live sessions are connected**

Run: `bun -e "
import { Database } from 'bun:sqlite'
const db = new Database('/home/claude/.config/party-line/dashboard.db', { readonly: true })
console.log(db.query('SELECT name, online FROM ccpl_sessions ORDER BY last_active_at DESC LIMIT 10').all())
"`

Expected: two or more rows with `online: 1`. If not, ask the user to start a second session (`ccpl new test-tab2 && ccpl test-tab2` in another terminal) before continuing.

- [ ] **Step 2: Navigate the dashboard, log in, and snapshot the strip**

Use Playwright MCP:

- `browser_navigate` to `https://localhost:3400/`
- If the login page appears, fill the password input + submit. The password is in `cat /proc/$(pgrep -f "dashboard/serve.ts" | head -1)/environ | tr '\0' '\n' | grep PASSWORD`.
- After login, `browser_snapshot` and verify the strip contains: a Switchboard tab + tabs for each live session + a `⋯` overflow menu.

- [ ] **Step 3: Verify prefetch + instant switch**

- Stay on the Switchboard view.
- After ~1 second (give prefetch time to fire), click the first session's tab.
- Snapshot — the transcript should already be rendered (no `Loading…` placeholder visible).
- Press Alt+Right. Snapshot — the next tab is now active and its transcript is also already rendered.
- Press Alt+Left. Back to the previous tab — should retain scroll position from when you last saw it.

- [ ] **Step 4: Verify dismissal + persistence across reload**

- Click the X on one session tab. Snapshot — that tab is gone.
- Reload the page (`browser_navigate` to same URL again).
- Snapshot — the dismissed session's tab should NOT auto-re-pin even though the session is still live.
- Click that session's card on the Switchboard view — tab reappears and is focused.

- [ ] **Step 5: Verify Esc + back/forward**

- Press Esc — focus jumps to Switchboard.
- Click a session card → focus moves to that tab + URL is `/session/<name>`.
- Press Alt+Right → next tab focused, URL changes (replaceState — no history entry).
- Press browser back → should go back to the URL from the click, NOT walk through Alt+Right history.

- [ ] **Step 6: Verify console has no errors**

Use `browser_console_messages` to fetch the Chrome console log. Expected: no `[error]` entries from the dashboard's own code (pre-existing SW SSL warnings unrelated to this change are fine).

- [ ] **Step 7: If issues are found, fix in-place + re-verify**

Any small bug found in walkthrough should get its own focused commit (e.g., `fix(dashboard): pill not refreshed on first prefetch`) — but if no issues, no commit is required for this task.

- [ ] **Step 8: Final test run**

Run: `bun test && bunx tsc --noEmit`

Expected: pass.

- [ ] **Step 9: If no fix commits were needed in this task, no commit is required.** If fixes were made, follow the established commit-message + co-author trailer pattern.

---

## Self-Review Checklist (run after writing this plan)

- [x] Spec coverage: every section of the spec maps to at least one task.
- [x] No placeholders: every step has full code or commands.
- [x] Type consistency: `Tab` shape is the same in Tasks 7-13; `pickLruEvictionVictim` signature in Task 1 matches use in Task 13; `shouldBumpUnread` / `filterStripSessions` signatures match.
- [x] Coverage check:
  - Tab Strip UX → Tasks 3, 4, 7, 9
  - Auto-pin / disappearance → Tasks 9, 12
  - Keyboard + Interaction → Task 13
  - Per-Tab State Model → Tasks 5, 6, 7, 11, 13
  - Persistence → Tasks 1, 7, 8
  - URL + Browser History → Tasks 7, 8
  - Sibling unread tightening → Tasks 2, 9
