# Switchboard Redesign — Design Spec

**Date:** 2026-04-20
**Status:** Approved design; awaiting implementation plan
**Scope:** Plan 1 of 2 in the follow-up program (see "Out of scope" for Plan 2)

## Goal

Reshape the Mission Control dashboard so the primary daily use is:

1. **Switchboard** — glance at all sessions, see which need attention, spot cross-session calls as they happen
2. **Session Detail** — drill into any one session to read what it said (markdown), see its subagents in a tree, and send it a message

…without having to hunt through mixed log feeds.

Also rename Overview → Switchboard (keeps the party-line metaphor) and demote the bus chat from a top-level tab to a sub-tab of History.

## Non-goals

- **Notification preferences and delivery** — per-session "All updates / Input needed / Only at stop" settings and browser/Discord/email delivery live in Plan 2.
- **Persistent agent-traffic graph** — Plan 1 shows transient arrows only. A toggle to see history of N minutes is explicitly deferred.
- **Stdin injection** into non-party-line sessions — remains a Claude Code limitation; ccpl is the supported launch path.

## Architecture summary

```
browser
  ├── Switchboard view (card grid, unread badges, transient arrows)
  ├── Session Detail view (tree sidebar + markdown stream + send box)
  └── History view (Events tab + Bus tab)
           ▲
           │ WS (existing + new cross-call broadcast)
           │ REST (existing + new /api/transcript)
           │
dashboard/serve.ts
  ├── existing: monitor, aggregator, jsonlObserver, geminiObserver,
  │             handleIngest, /api/session, /api/events, /api/machines
  ├── new: /api/transcript (reads JSONL, enriched for rendering)
  ├── new: cross-call WS broadcast (from monitor.onMessage when to!=all and from!=to)
  └── existing: /api/send (unchanged — send box reuses it)
```

All data already flows. The changes are: one new REST endpoint, one new WS message type, and a significant UI rebuild.

## Information architecture

Three top-level tabs (desktop tab bar, horizontal-scroll on mobile):

1. **Switchboard** — default landing view
2. **Session** — enabled only when a session is selected
3. **History** — Events sub-tab (default) + Bus sub-tab

Removed: Overview (renamed), Machines (replaced by per-session machine label).

## Switchboard view

### Layout

Card grid. Responsive breakpoints:
- `>=1024px` — 3 columns
- `640–1023px` — 2 columns
- `<640px` — 1 column

Grid is full-width inside the view. No left sidebar.

### Card contents

```
┌──────────────────────────────────────┐
│ [WORKING] discord      [3]   [mbp]   │  ← state pill, name, unread, host*
│                                      │
│ running Bash                         │  ← current tool line
│ "fixing the auth middleware..."      │  ← last assistant/user text preview
│                                      │
│ ctx 45k · 2 subagents                │  ← meta
│ ▁▂▅▃▁▄▁▂▅▄▃▁ (sparkline)             │  ← tool calls/hour, last 24h
└──────────────────────────────────────┘
```

`[mbp]` = host label; shown only when the session's `machine_id` differs from the dashboard's local machine_id. Badge color distinguishes different remote hosts.

Unread badge shows:
- a count `[3]`, `[12]`, etc. for unread events since the user last viewed that session's detail
- a dot `[•]` when count is `>99` (for sanity)
- nothing when count is 0

"Unread" definition for Plan 1: anything-but-heartbeats. Precise filtering (Input-needed-only, etc.) lands in Plan 2.

### Transient cross-call arrows

When a party-line envelope travels between two sessions (e.g. `discord → research`), the monitor broadcasts a `cross-call` WS event. The Switchboard overlays an SVG arrow from the sender card to the receiver card.

- Fades to transparent over 5 seconds, then removed from the DOM.
- Color: `message` = accent blue, `request` = yellow, `response` = green.
- Arrowhead at the receiver end.
- If either card is off-screen (scrolled), the arrow renders an edge-anchored indicator instead of a visible line (e.g., a left-edge colored pip on the visible card).
- Arrows do not accumulate into a graph — this is Plan 2 or later work.

### Interactions

- Click a card → Session Detail opens for that session; "Session" tab becomes active.
- Any card with an unread badge loses the badge when the detail view for that session is opened.
- No send UI on the Switchboard card — send happens from Session Detail's send box, or from the History/Bus tab's global send bar.

## Session Detail view

### Desktop layout (`>=1024px`)

```
┌─────────────────────────────────────────────────────────────┐
│ Session header: [WORKING] discord · /home/x · sonnet · ctx%│
├────────────┬────────────────────────────────────────────────┤
│            │                                                │
│  AGENTS    │   MAIN STREAM                                  │
│            │                                                │
│  ▸ main  ● │   you: find the auth bug                       │
│  └ Explore │   I'll investigate. Let me dispatch a          │
│            │   researcher.                                  │
│            │   ▸ Read src/auth.ts                           │
│            │   ┌─ → spawned Explore: "find middleware" ──┐  │
│            │   │  (click to view this agent) ●           │  │
│            │   └────────────────────────────────────────┘   │
│            │   The bug is in src/middleware.ts:42.          │
│            │   [copy raw]  [copy as markdown]               │
│            │                                                │
├────────────┴────────────────────────────────────────────────┤
│ Send:  [to: discord ▾] [message ▾] [___________________]  [→]│
└─────────────────────────────────────────────────────────────┘
```

### Tablet (`640–1023px`)

Sidebar collapses to a single-line agent strip at top that expands on tap. Main stream + send bar stack below.

### Mobile (`<640px`)

- Session header becomes a single compact line with an `(i)` button that expands details.
- Agent tree becomes a drawer that slides in from the left on demand (hamburger icon next to the header).
- Main stream fills the viewport; send bar sticks to the bottom.
- Subagent "spawn marker" blocks inline remain clickable and switch the main stream to the subagent's transcript; the drawer selection updates accordingly.

### Agent tree (sidebar/drawer)

- `main` always on top, always selectable.
- Subagents listed under the agent that spawned them. Indent by 1 level per nesting depth.
- Each row: arrow glyph + agent name (type if present) + status dot.
  - yellow = running
  - green = completed
  - grey = never-seen-exit (may still be running — treat as running)
  - red = errored (explicit failure signal from payload, if we can detect it)
- Clicking a row sets `selectedAgentId` and re-renders the main stream from that agent's JSONL.

### Main stream rendering

The stream is a vertical list of entries read from the selected agent's JSONL (or the parent's JSONL for `main`). Each entry is one of:

| JSONL source | Display |
|---|---|
| `message.role === "user"` | "you: …" text block; markdown-rendered. No "copy raw" button (user text is typically prose). |
| `message.content[].type === "text"` | Markdown-rendered assistant block. Code fences, lists, headings preserved. Copy buttons: `[copy raw]` (original markdown source) and `[copy as markdown]` (same, but kept explicit for clarity). |
| `message.content[].type === "tool_use"` | Compact one-liner: `▸ <tool_name>: <one-line summary of input>`. Click to expand a `<details>` showing full input JSON + the matched tool_result when available. |
| `message.content[].type === "tool_result"` | Folded inside the matching tool_use row. Not rendered as its own entry. |
| party-line envelopes sent/received | (see "Agent-to-agent call treatment" below) |
| subagent-spawn markers | Click-through highlighted block. Clicking == selecting that agent in the tree. Rendered at the parent's timeline position where the agent was spawned. |

### Subagent spawn markers

Rendered as styled callout blocks distinct from plain text:

```
┌────────────────────────────────────────┐
│ → spawned Explore                      │
│   "find all auth middleware"           │
│   status: running  ● | Click to view  │
└────────────────────────────────────────┘
```

Clicking the block:
1. Sets `selectedAgentId = agent_id`
2. Re-renders the main stream to that agent's transcript
3. Highlights the agent row in the tree sidebar
4. Pushes a browser history entry so back-button returns to parent

When the subagent completes, the marker's status updates to green in real time.

### Agent-to-agent call treatment

When a party-line envelope involves the current session (either as sender or receiver), a distinct entry appears in the timeline:

- **Outbound:** `→ sent <type> to <other-session> [cb:abc123]` — highlighted block, color by type (message/request/response). Clicking navigates to the other session's detail view with the timeline scrolled to the matched entry (best-effort — matched on `message_id`).
- **Inbound:** `← received <type> from <other-session> [cb:abc123]`.
- Callback IDs visible so the user can trace request/response pairs by eye.

Envelopes are sourced from the existing multicast monitor's history ring buffer plus live WS `message` events. No change to the protocol; just a dedicated entry renderer.

### Send box

Always visible at the bottom of Session Detail (sticky). Fields:

- `to` — defaults to the current session's name. Editable so the user can retarget. Dropdown of known sessions (aliases + "all").
- `type` — dropdown: `message` (default) / `request`. Status is omitted from the UI (rarely used).
- Message input — single-line, grows to max ~5 rows. Enter submits, Shift-Enter newline.
- `[→]` Send button.

Sending uses the existing WS `send` action; no backend changes. If `type=request`, a callback_id is generated client-side (matches existing monitor behavior), and the UI shows a "pending response" marker in the timeline that resolves when a matching response envelope arrives.

### Copy safety

Every assistant text block and every code fence within a block gets a `[copy]` button that calls `navigator.clipboard.writeText(sourceText)` with the ORIGINAL markdown string or code content, not the rendered HTML.

- Assistant text block → `[copy raw]` writes the unrendered markdown source.
- Code fence → its own `[copy]` button above-right of the fence; writes the exact fence body (no surrounding markdown).
- User prompts, tool-call rows: no copy button unless the user expands the row — then it becomes available.

This avoids smart quotes, bullet glyphs, non-breaking spaces, or any rendering artifact being pasted into a terminal.

## Markdown rendering

Library: **marked** (MIT-licensed, ~100KB minified) plus **DOMPurify** (also MIT) for HTML sanitization before insertion.

Both vendored into `dashboard/vendor/`. No runtime npm install. Rationale:
- Pure JavaScript, single-file distributions.
- Full CommonMark + GFM support (tables, task lists, strikethrough, code blocks with language hints).
- DOMPurify strips any `<script>`, inline event handlers, or unsafe URLs before the HTML reaches the DOM.

Rendering pipeline:
```
sourceMarkdown → marked.parse(source) → DOMPurify.sanitize(html) → innerHTML
```

Code blocks with a language hint get a lightweight syntax-highlight pass — NOT a full highlight.js dependency; instead a regex-based 2-3 language subset (bash, json, ts) or just a monospace block with the language label visible. Decision: ship with no highlighting in Plan 1, add later if desired.

## History view

Two inner tabs:

- **Events** (default) — the existing hook-event feed with text and hook-event filters. Unchanged behavior; just scoped to a tab.
- **Bus** — the old multicast message feed (what the current History view shows as a collapsible "Bus" section). Shows all party-line envelopes (messages, requests, responses, heartbeats if filter allows) with from/to fields and callback linking.

The existing global send form (not the per-session one in Session Detail) moves into the Bus tab. This is the "I want to broadcast to all sessions" or "I want to poke a session I haven't opened" affordance.

## Backend additions

### 1. `/api/transcript` endpoint

```
GET /api/transcript?session_id=<key>&agent_id=<optional>&limit=<N>
```

Returns an array of entries shaped for UI rendering:

```typescript
interface TranscriptEntry {
  uuid: string            // from JSONL entry.uuid
  ts: string
  type: 'user' | 'assistant-text' | 'tool-use' | 'subagent-spawn' |
        'party-line-send' | 'party-line-receive'
  // type-specific fields:
  text?: string           // markdown source for user / assistant-text
  tool_name?: string      // tool-use
  tool_input?: unknown    // tool-use
  tool_response?: unknown // tool-use (matched from subsequent tool_result)
  agent_id?: string       // subagent-spawn (target agent)
  agent_type?: string     // subagent-spawn
  description?: string    // subagent-spawn
  envelope_id?: string    // party-line-send/receive (message_id for cross-nav)
  other_session?: string  // party-line-send/receive
  body?: string           // party-line-send/receive (message body)
  callback_id?: string    // party-line-send/receive (for request/response)
  envelope_type?: 'message' | 'request' | 'response'
}
```

Implementation reads the target JSONL file directly (`~/.claude/projects/<cwd-slug>/<session-id>.jsonl` or `<session-id>/subagents/agent-<agent_id>.jsonl`), merges tool_use with its matching tool_result, interleaves party-line envelopes from the monitor's history, and returns in chronological order newest-last.

Accepts either the UUID session_id OR the session name (same dual-lookup pattern as `/api/events`).

### 2. `cross-call` WS broadcast

The existing `monitor.onMessage` callback in `dashboard/serve.ts` is extended: when an envelope's `type` is `message`/`request`/`response` and `from !== to` and both are session names we've seen, emit:

```json
{ "type": "cross-call", "data": {
  "from": "discord",
  "to": "research",
  "envelope_type": "request",
  "message_id": "...",
  "ts": "..."
}}
```

Browsers use this to animate the Switchboard arrow.

### 3. No schema changes

No new tables or columns. All additions are read-side.

## Client-side additions

### Local state (localStorage)

- `lastViewedAt` — map of `session_key → ISO timestamp`. Updated when Session Detail opens for a session. Used to compute unread count (`count of events with ts > lastViewedAt for that session`).
- `selectedAgentId` — persisted per session so reopening preserves the selection.

Both plain objects under a single localStorage key `partyLine.ui.state`.

## Error handling

- **Transcript file missing** (`/api/transcript` called for an unknown session) → 404.
- **Markdown parse failure** → render the raw source in a `<pre>`, log a console warning.
- **WS disconnect during Switchboard view** → existing reconnect logic applies; arrows drop silently (no retry for in-flight animations).
- **Send box retarget to unknown session** → the send goes through anyway (multicast is best-effort). The UI shows a soft warning if no session with that name is in the known list.

## Testing

### Backend

- `tests/transcript.test.ts` — feeds a synthetic JSONL fixture to the endpoint logic and verifies entry shape: assistant text with markdown preserved, tool_use + tool_result merged, subagent-spawn markers detected, party-line envelopes interleaved in timestamp order.
- `tests/cross-call-broadcast.test.ts` — injects envelopes into a monitor stub and verifies only non-self, non-broadcast envelopes emit cross-call.

### Frontend

- No automated tests (dashboard has no existing test harness for JS). Manual checklist in the plan:
  - Switchboard renders correctly with 0, 1, 6, 12 sessions; badge math correct; arrow appears and fades.
  - Session Detail: tree renders main + nested subagents; clicking spawn marker == clicking tree; code fence copy preserves exact bytes; markdown renders tables + code + lists; subagent status updates live; send works for message and request.
  - History/Bus tabs behave like before.
  - Mobile viewport: layout reflows, drawer works, send box sticky.

### Library vetting

- `marked` and `DOMPurify` vendored copies tested with a sample malicious markdown string (e.g. `<script>alert(1)</script>`, `[click](javascript:alert(1))`, broken HTML) — output must be safe.

## Out of scope (Plan 2)

- Per-session notification preferences (All / Input-needed / Stop-only).
- Delivery channels (browser Notification API, Discord webhook, email).
- Persistent cross-call traffic graph with toggle.
- Read/unread sync across browsers/devices.
- Syntax highlighting in code blocks (if we want more than language labels).
- Any change to the MCP protocol, party-line envelope format, or hook ingest.

## Open questions (deferred to Plan 2)

- Exact definition of "input needed" for the unread-filtering in Plan 2 — is it the `Notification` hook with `permission_prompt` notification_type? Idle for N minutes with no user turn? Deferred to Plan 2.
- How to identify the "current" party-line transport session so unread counts on the Switchboard don't double-count the same envelope on both sender and receiver cards.

## Confirmed decisions

- Incoming party-line messages and requests **do** bump the target card's unread badge (part of Plan 1's "anything-but-heartbeats" rule).
- No syntax highlighting in code blocks for Plan 1 — language label only.
- No automated frontend tests in Plan 1 — manual checklist in the implementation plan.
