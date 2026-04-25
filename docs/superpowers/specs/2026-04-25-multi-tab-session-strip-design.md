# Multi-Tab Session Strip Design

> Frontend-only redesign of the dashboard's session-detail surface. Replaces "current session" with a persistent strip of pinned tabs that all stay live in the background, so switching between sessions feels instant — like switching tmux windows.

**Status:** Approved 2026-04-25.
**Scope:** `dashboard/` only. No server APIs, no schema changes, no MCP plugin changes.

---

## Motivation

Today the dashboard's session-detail view renders a single session at a time. Switching costs a full network round-trip to refetch the transcript, leaving stale content under the new header for seconds on slow links. With multiple Claude Code sessions running in parallel, the user goes back to the switchboard, picks the next session, and waits — every time.

This change introduces a horizontal strip of tabs across the top of the dashboard, one per active session. All pinned tab DOMs are mounted and kept up-to-date in the background by the existing `/ws/observer` envelope stream. Switching is then a CSS visibility flip; the receiving tab is already populated.

Tab DOMs **start loading as soon as the dashboard opens**, in parallel with whatever view is active. By the time the user clicks a tab, its transcript is already rendered. The Switchboard view stays live while the user is in a session tab (already does).

---

## Tab Strip UX

A single horizontal strip across the top of the dashboard, replacing today's `Switchboard / Session Detail / Machines / History` row.

**Layout, left to right:**

- **Always-leftmost:** `Switchboard` tab (special permanent entry — its body is the existing switchboard view).
- **Middle:** one tab per live ccpl session, in **stable insertion order** (first-seen-first). New sessions append to the right; existing tabs never reorder.
- **Rightmost:** an overflow `⋯` menu containing `Machines` and `History` (low-traffic admin views).

**Per-tab affordances:**

- Session name.
- State dot (idle / working / offline) — same colors as today's switchboard cards.
- Numeric unread badge when the count is > 0 (see Unread Counter Tightening below).
- Close `X` — visible on hover on desktop, always-visible on touch viewports.

**Mobile:** the strip is horizontally scrollable (`overflow-x: auto`). The `Switchboard` tab is sticky-left so it's always reachable.

### Auto-pin / disappearance rules

**"Online" defined:** the ccpl session is currently WS-connected to the switchboard — same `online: true` flag the switchboard cards already display. Going offline = the WS dropped; coming back online = a fresh hello frame arrives. State (idle/working/ended) is independent of online — an idle session is still online.

- A live session that the user hasn't dismissed gets a tab automatically on its first online signal.
- Going offline turns the tab grey and starts a **5-minute eviction timer**.
- Reconnecting within 5 minutes cancels the timer.
- Timer expiry removes the tab from the strip but **does not** add the session to the dismissal set — so it auto-pins again the next time it's online.
- Clicking an offline session's card in the Switchboard view **pins it unconditionally** and clears its dismissal flag (offline tabs render greyed; the 5-minute eviction timer applies if it stays offline).
- Clicking `X` on a tab adds the session to the dismissal set; it stays off the strip even while online until the user re-pins it from the Switchboard.

---

## Keyboard + Interaction

| Input                               | Action                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Alt+Left` / `Alt+Right`            | Switch focus to previous / next tab in strip order. **Hard intercept** — preventDefault even when the composer textarea has focus, overriding macOS's default word-jump. Wraps at strip boundaries. Switchboard counts as the leftmost position. |
| `Esc`                               | Focus the Switchboard tab.                                                                                                                                                                                                                       |
| Click on tab                        | Focus that tab.                                                                                                                                                                                                                                  |
| Click `X` on tab                    | Dismiss + advance focus to the tab on the right (or left if it was the rightmost).                                                                                                                                                               |
| Click a session card in Switchboard | Pin (if not already in strip) + clear dismissal + focus.                                                                                                                                                                                         |

Mobile relies on tap. No swipe gestures (avoids fighting iOS/Android edge-back).

---

## Per-Tab State Model

Today the dashboard has a single set of module-level vars (`selectedSessionId`, `currentSessionSubagents`, `renderedEntryKeys`, `lastRenderedUuid`, etc.) and one `#detail-stream` element. This change moves both into a **per-tab map** keyed by session name.

**Each tab owns:**

- A mounted `.session-tab-content` DOM container with the transcript stream, sidebar agent tree, sidebar history rows, and composer form. Inactive tabs have `[hidden]`; the focused one is shown.
- Stream cursor: `renderedEntryKeys` Set, `lastRenderedUuid`, scroll position.
- Sidebar selection: `selectedAgentId`, `selectedArchiveUuid`.
- Composer state: textarea value, pending attachment chips, upload-in-flight markers.
- `currentSessionSubagents` snapshot.
- Unread count + last-viewed timestamp.
- `online` boolean + the 5-minute offline-eviction timer handle (when applicable).

**Background updates:**
The `/ws/observer` handler routes every inbound envelope, jsonl-update, hook-event, and session-update to the matching tab's DOM — not just the focused one. The existing `appendEntryWithGrouping` + `renderEntry` + agent-tree-render paths are refactored to take the stream root (or tab object) as a parameter rather than reading `document.getElementById('detail-stream')`.

**Prefetch on dashboard load:**
After the first `sessions-snapshot` arrives, kick off `loadTabContent(name)` for every non-dismissed online session in parallel, capped at **4 concurrent fetches** to be polite to the server. Tabs render hidden into the strip while the user is on the Switchboard view.

**Memory cap (LRU eviction):**
Soft cap of **8 mounted tab DOMs**. When a 9th tab is focused, evict the least-recently-focused — destroy its DOM + state, but leave its strip entry. Re-focusing an evicted tab triggers a fresh `loadTabContent` (loading spinner briefly, then live again).

---

## Persistence

A single localStorage key:

```json
// partyLine.tabs.dismissed
{ "dismissed": ["argonaut", "old-experiment"] }
```

On dashboard load, the live tab strip = `(currently online sessions) MINUS dismissed`. Re-pinning a session via Switchboard click removes it from the dismissal set.

**Not persisted:** focused tab, scroll positions, draft text, attachment chips. Reload feels like a fresh terminal — not a restored browser session. Keeps the design simple and avoids stale-state edge cases (session ended between reloads, cwd moved, etc.).

---

## URL + Browser History

URL shapes unchanged. Same routes as today:

- `/` — Switchboard
- `/session/<name>` — that session's tab
- `/session/<name>/archive/<uuid>` — that session's archived transcript
- `/machines`, `/history`

Deep links keep working.

**History push policy:**

- **`pushState`** on intentional navigations: clicking a session card in Switchboard, clicking a tab in the strip, address-bar load, opening an archive from the History sidebar.
- **`replaceState`** on Alt+arrow / Esc keyboard switches. URL still updates (so each tab remains bookmarkable + shareable) but the back button doesn't walk tab-by-tab through dozens of keyboard switches — it returns to the last intentional navigation.

**popstate handler** routes the new URL through `focusTab(name)`, auto-pinning if the tab isn't in the strip + clearing its dismissal — same semantics as a Switchboard click.

**Deep link on reload:** wait for the first `sessions-snapshot`, then auto-pin + focus the URL's session even if it's currently offline. Refreshing must not kick the user out of a session they were viewing.

---

## Sibling Change: Unread Counter Tightening

Today's per-session unread counter bumps too aggressively, causing high numeric badges that don't reflect "needs attention":

| Trigger                                      | Current | New                                                                                                                                  |
| -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Stop` hook                                  | bump    | **bump (keep)**                                                                                                                      |
| `Notification` hook                          | bump    | **bump (keep)** — confirmed blocking; fires for "Claude is waiting for your input" or "Claude needs your permission to use \<Tool\>" |
| `api-error` JSONL frame                      | bump    | **bump (keep)** — Claude API failed (rate-limit / overloaded), session stuck waiting, agent halted until user nudges                 |
| Party-line non-broadcast envelope (line 367) | bump    | **drop** — main noise source; inter-agent traffic, not assistant→user                                                                |
| `SessionEnd` hook                            | bump    | **drop** — lifecycle, not a message                                                                                                  |

Net effect: the chip numbers should drop dramatically while still flagging every "agent has something to say or needs you" moment.

---

## Implementation Outline

Files touched (all in `dashboard/` unless noted):

- **`index.html`** — replace top tab bar markup with the new strip container. Restructure session-detail markup so each tab gets its own `.session-tab-content` template; Switchboard / Machines / History views stay structurally where they are today.
- **`dashboard.js`** — biggest change. New `tabs` module section (or extracted file) that owns:
  - `Tab` object: `{ name, contentEl, streamKeys: Set, lastRenderedUuid, scrollTop, agentId, archiveUuid, composerDraft, subagents, lastViewedAt, online }`
  - `TabRegistry` (Map keyed by name) + `dismissedSet`.
  - `focusTab(name)`, `pinTab(name, opts)`, `dismissTab(name)`, `evictTab(name)` (LRU body destroy, strip entry kept), `unpinTab(name)` (full removal).
  - `prefetchAllOnlineTabs()` — invoked once after first `sessions-snapshot`, parallelism cap = 4.
  - `routeWsEventToTabs(envelope)` — fans every inbound update to the matching tab's DOM; existing `appendEntryWithGrouping` etc. refactored to take a stream-root parameter.
  - Keyboard handler for Alt+Left/Right + Esc.
  - `applyRoute` + `loadSessionDetailView` rewritten in terms of tabs.
  - URL `pushState` / `replaceState` per the policy above.
- **`dashboard.css`** — strip styles, hidden-tab content, mobile horizontal-scroll, eviction-stale visual (greyed tab + offline dot).
- **`tabs-state.js`** (new pure module) — load/save dismissal set to localStorage; LRU eviction policy; the `Stop`+`Notification`+`api-error` unread classification predicate. Pure → unit-testable under `bun:test`.
- **`tests/tabs-state.test.ts`** (new) — covers dismissal persistence + load round-trip; LRU pick correctness; online-filter logic; bump-classification predicate (positive + negative cases).

**No server changes required.** Existing `/api/transcript`, `/api/session`, `/api/archives`, and `/ws/observer` endpoints already cover everything the strip needs.

**Refactor risk:** the bulk of `dashboard.js` (~3,700 lines) currently assumes one active session. Most existing functions read `selectedSessionId` / `selectedAgentId` / `selectedArchiveUuid` directly. The cleanest path is to introduce `currentTab()` helpers that return the focused tab object and route per-tab access through it — touches a lot of call sites, but each touch is mechanical and reviewer-friendly.

**Verification:**

1. Unit tests for the pure `tabs-state` module.
2. Playwright walkthrough on a real dashboard with `hots3` + at least one other live session: tab switching, prefetch on load, dismissal + persistence across reload, X close + re-pin from switchboard, Alt+Left/Right + Esc on hardware keyboard, browser back button after click vs. keyboard switch, deep link on reload to an offline session, LRU eviction by opening a 9th tab.
3. Mobile spot-check (iPad Safari) for horizontal-scroll on the strip and tap-to-switch behavior.

---

## Out of Scope

- Server-side push of strip state / cross-device sync.
- Drag-to-reorder.
- Tab grouping / nested tabs.
- Lower prefetch limit for background tabs (held; revisit if mobile memory bites).
- DOM sliding window inside a single tab's transcript.
- Virtual scrolling.
- Mobile swipe gestures.
- Replacing the on-page Notifications API surface (only the in-strip badge changes).
