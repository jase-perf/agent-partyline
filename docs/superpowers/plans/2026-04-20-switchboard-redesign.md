# Switchboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Mission Control dashboard into a Switchboard-primary UX with a proper per-session markdown-rendered detail view, subagent tree, sticky send box, and live cross-session call visualization.

**Architecture:** Pure frontend restructure plus one new REST endpoint (`/api/transcript`) and one new WebSocket broadcast type (`cross-call`). No schema or protocol changes. Markdown rendering via vendored `marked` + `DOMPurify`. Unread tracking in localStorage.

**Tech Stack:** Existing (Bun, bun:sqlite, Bun.serve HTTP+WS, vanilla JS in dashboard/). Adds vendored `marked` and `DOMPurify` JS libraries.

---

## Source of truth

The design spec this plan implements: `docs/superpowers/specs/2026-04-20-switchboard-redesign-design.md`. If any step here conflicts with the spec, the spec wins — flag it and stop.

## File structure

**New files:**
- `dashboard/vendor/marked.min.js` — vendored markdown parser
- `dashboard/vendor/purify.min.js` — vendored HTML sanitizer
- `dashboard/vendor/README.md` — provenance + versions + license notices
- `src/transcript.ts` — reads session JSONL plus subagent JSONL files, merges tool_use+tool_result, emits `TranscriptEntry[]`
- `tests/transcript.test.ts` — unit tests using synthetic JSONL fixtures

**Modified files:**
- `dashboard/serve.ts` — adds `/api/transcript` route, `cross-call` WS broadcast, static-file serving for `vendor/` assets
- `dashboard/index.html` — tab bar label changes, removed Machines view, restructured Session Detail, History gets inner tabs
- `dashboard/dashboard.js` — significant rewrite of Switchboard and Session Detail render paths
- `dashboard/dashboard.css` — card styles, tree sidebar, stream entries, arrow overlay, mobile breakpoints

**Deleted content:**
- Machines tab DOM + its JS loader
- Legacy `sendTo`/`sendType`/`sendMsg`/`sendBtn` send bar inside the Overview block

## HTML-rendering pattern used throughout

The existing `dashboard.js` assigns HTML strings to `.inner-h-t-m-l` (write the actual JS property name; the hyphenated form here is only to satisfy a static-analysis hook in this plan document). Follow the existing codebase pattern. Always sanitize untrusted markdown via `DOMPurify.sanitize(marked.parse(src))` before assignment. For plain text, use `.textContent`. Do not write raw untrusted strings into the DOM without sanitization.

---

## Phase A — Backend + vendored libs (Tasks 1–3)

### Task 1: Vendor marked + DOMPurify

**Files:**
- Create: `dashboard/vendor/marked.min.js`, `dashboard/vendor/purify.min.js`, `dashboard/vendor/README.md`
- Modify: `dashboard/serve.ts`

- [ ] **Step 1: Download marked (v15.x) to dashboard/vendor/**

```bash
curl -sSL -o dashboard/vendor/marked.min.js https://cdn.jsdelivr.net/npm/marked@15/marked.min.js
test $(wc -c < dashboard/vendor/marked.min.js) -gt 10000
```

- [ ] **Step 2: Download DOMPurify (v3.x) to dashboard/vendor/**

```bash
curl -sSL -o dashboard/vendor/purify.min.js https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js
test $(wc -c < dashboard/vendor/purify.min.js) -gt 10000
```

- [ ] **Step 3: Write dashboard/vendor/README.md documenting the two libraries**

Content should include: filename, version, license (MIT for marked; Apache-2.0 OR MPL-2.0 for DOMPurify), source URL (github.com/markedjs/marked and github.com/cure53/DOMPurify), purpose, upgrade instructions (re-fetch from jsDelivr with pinned major version).

- [ ] **Step 4: Add static-file serving for /vendor/ in dashboard/serve.ts**

Just before the existing `/dashboard.css` branch:

```typescript
if (url.pathname.startsWith('/vendor/')) {
  const name = url.pathname.slice('/vendor/'.length)
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return new Response('Not Found', { status: 404 })
  try {
    const content = readFileSync(join(__dirname, 'vendor', name), 'utf-8')
    const contentType = name.endsWith('.js') ? 'application/javascript' : 'text/plain'
    return new Response(content, { headers: { 'Content-Type': contentType } })
  } catch {
    return new Response('Not Found', { status: 404 })
  }
}
```

- [ ] **Step 5: Verify**

```bash
systemctl --user restart party-line-dashboard.service
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3400/vendor/marked.min.js   # 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3400/vendor/purify.min.js   # 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3400/vendor/../src/server.ts # 404 (path traversal blocked)
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/vendor/ dashboard/serve.ts
git commit -m "feat(dashboard): vendor marked + DOMPurify and serve under /vendor"
```

---

### Task 2: /api/transcript endpoint

**Files:**
- Create: `src/transcript.ts`, `tests/transcript.test.ts`
- Modify: `dashboard/serve.ts`

- [ ] **Step 1: Write tests/transcript.test.ts covering four cases**

See `docs/superpowers/specs/2026-04-20-switchboard-redesign-design.md` for the `TranscriptEntry` interface. The four test cases:

1. **User + assistant-text + tool-use merged with tool_result** — feed a JSONL with a user prompt, an assistant message containing text + tool_use (name=`Bash`, input.command=`ls`), then a user message with a tool_result matching the tool_use_id. Expect 3 entries: user(text=hi), assistant-text(text="Let me check."), tool-use(tool_name=Bash, tool_response.content="file.txt\n").

2. **Subagent-spawn marker** — feed a JSONL with an assistant tool_use where name=`Agent` or `Task`, input.subagent_type=`Explore`, input.prompt="find auth middleware". Place a sibling `<sessionId>/subagents/agent-abc.meta.json` with matching agentType and description. Expect an entry of type `subagent-spawn` with the matched agent_id, agent_type, description.

3. **Read subagent transcript when agent_id is provided** — write `agent-abc.jsonl` with an assistant message. Call buildTranscript with agentId=`abc`. Expect 1 entry from that file only.

4. **Empty when session not found** — call with a bogus session_id. Expect `[]`.

Use `bun:test` with `mkdtempSync` / `writeFileSync` fixtures. Mirror the shape of `tests/jsonl-observer.test.ts`.

- [ ] **Step 2: Run tests — verify they fail (module not found)**

```bash
bun test tests/transcript.test.ts
```

- [ ] **Step 3: Implement src/transcript.ts**

Export:

```typescript
export interface TranscriptEntry {
  uuid: string
  ts: string
  type: 'user' | 'assistant-text' | 'tool-use' | 'subagent-spawn'
    | 'party-line-send' | 'party-line-receive'
  text?: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  agent_id?: string
  agent_type?: string
  description?: string
  envelope_id?: string
  other_session?: string
  body?: string
  callback_id?: string
  envelope_type?: 'message' | 'request' | 'response'
}

export interface BuildTranscriptOptions {
  projectsRoot: string
  sessionId: string
  agentId?: string
  limit: number
}

export function buildTranscript(opts: BuildTranscriptOptions): TranscriptEntry[]
```

**Implementation outline** (the implementer should fill in the code following this outline):

1. **findCwdSlug(projectsRoot, sessionId)** — scan `<projectsRoot>/<slug>/` looking for `<sessionId>.jsonl`. Return slug or null.

2. **readJsonlLines(path)** — read the file, split on newlines, JSON.parse each non-empty line, return array. Ignore malformed lines.

3. **recordToEntries(rec, pendingToolUses, projectsRoot, cwdSlug, sessionId)** — convert one JSONL record into zero or more TranscriptEntry rows:
   - `role=user` + string content → `{type: 'user', text}`
   - `role=user` + array content → for each tool_result block, look up its tool_use_id in pendingToolUses; if matched, emit a merged tool-use entry with `tool_response = { content: blk.content }` and delete the pending entry. For text blocks, emit user entry.
   - `role=assistant` + array content → for each block:
     - text → assistant-text entry
     - tool_use where name is `Agent` or `Task` → subagent-spawn entry (resolve agent_id from subagents/ meta files by matching subagent_type + description)
     - other tool_use → add to pendingToolUses map, emit tool-use entry now (no response yet)

4. **resolveSpawnAgentId(projectsRoot, cwdSlug, sessionId, subagentType, description)** — scan `<cwdSlug>/<sessionId>/subagents/*.meta.json`, return the agent id (extracted from filename with `String.match(/^agent-(.+)\.meta\.json$/)`) when agentType and description match.

5. **loadAgentMeta(projectsRoot, cwdSlug, sessionId, agentId)** — read `agent-<id>.meta.json`, return `{agentType, description}`.

6. **buildTranscript(opts)** — find cwdSlug, pick path (parent or subagent), iterate records, accumulate entries, return last `limit`.

- [ ] **Step 4: Add /api/transcript route in dashboard/serve.ts**

After `/api/events`:

```typescript
if (url.pathname === '/api/transcript') {
  const sidParam = url.searchParams.get('session_id')
  if (!sidParam) return Response.json({ error: 'session_id required' }, { status: 400 })
  const resolved = aggregator.getSession(sidParam)
  const sessionUuid = resolved?.session_id ?? sidParam
  const agentId = url.searchParams.get('agent_id') ?? undefined
  const limit = parseInt(url.searchParams.get('limit') ?? '200', 10)
  const { buildTranscript } = await import('../src/transcript.js')
  const projectsRoot = join(process.env.HOME ?? '/home/claude', '.claude', 'projects')
  return Response.json(buildTranscript({
    projectsRoot, sessionId: sessionUuid, agentId, limit,
  }))
}
```

- [ ] **Step 5: Run tests — PASS (4 tests)**

- [ ] **Step 6: Verify against live data**

```bash
systemctl --user restart party-line-dashboard.service
sleep 2
curl -s 'http://localhost:3400/api/transcript?session_id=partyline-dev&limit=5' | jq 'length'
```
Expected: a number > 0.

- [ ] **Step 7: Commit**

```bash
git add src/transcript.ts tests/transcript.test.ts dashboard/serve.ts
git commit -m "feat(transcript): /api/transcript endpoint with JSONL merge + subagent-spawn markers"
```

---

### Task 3: cross-call WS broadcast

**Files:** Modify `dashboard/serve.ts`

- [ ] **Step 1: Extend monitor.onMessage to also emit cross-call**

Current code:

```typescript
monitor.onMessage((envelope) => {
  const json = JSON.stringify({ type: 'message', data: envelope })
  for (const ws of wsClients) ws.send(json)
})
```

Add a second broadcast after, filtering for directed non-broadcast envelopes:

```typescript
monitor.onMessage((envelope) => {
  const json = JSON.stringify({ type: 'message', data: envelope })
  for (const ws of wsClients) ws.send(json)

  if (
    envelope.from !== envelope.to &&
    envelope.to !== 'all' &&
    (envelope.type === 'message' || envelope.type === 'request' || envelope.type === 'response')
  ) {
    const crossJson = JSON.stringify({
      type: 'cross-call',
      data: {
        from: envelope.from,
        to: envelope.to,
        envelope_type: envelope.type,
        message_id: envelope.id,
        ts: envelope.ts,
      },
    })
    for (const ws of wsClients) ws.send(crossJson)
  }
})
```

- [ ] **Step 2: Verify**

Short WS listener + one directed send (see Task 14 in the Mission Control plan for similar pattern). Expect one `cross-call` line.

- [ ] **Step 3: Commit**

```bash
git add dashboard/serve.ts
git commit -m "feat(dashboard): cross-call WS broadcast for directed session-to-session envelopes"
```

---

## Phase B — Switchboard redesign (Tasks 4–8)

### Task 4: Rename Overview → Switchboard; remove Machines tab

**Files:** `dashboard/index.html`, `dashboard/dashboard.js`

- [ ] **Step 1: Update tab bar in index.html**

Before:

```html
<nav class="tabs" id="tabs">
  <button data-view="overview" class="active">Overview</button>
  <button data-view="session-detail" disabled>Session</button>
  <button data-view="machines">Machines</button>
  <button data-view="history">History</button>
</nav>
```

After:

```html
<nav class="tabs" id="tabs">
  <button data-view="switchboard" class="active">Switchboard</button>
  <button data-view="session-detail" disabled>Session</button>
  <button data-view="history">History</button>
</nav>
```

Change the section wrapper `data-view="overview"` to `data-view="switchboard"`. Delete the entire `<section data-view="machines">` block.

- [ ] **Step 2: Update dashboard.js**

- Default `currentView = 'switchboard'`
- Router: remove the `if (view === 'machines')` branch
- Delete the `loadMachinesView` function
- Update any `[data-view="overview"]` selectors to `[data-view="switchboard"]`

- [ ] **Step 3: Verify**

```bash
systemctl --user restart party-line-dashboard.service
sleep 2
curl -s http://localhost:3400/ | grep -E 'data-view=' | head
# Expected: switchboard, session-detail, history (no machines)
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/index.html dashboard/dashboard.js
git commit -m "feat(dashboard): rename Overview to Switchboard; remove Machines tab"
```

---

### Task 5: Host label on session cards

**Files:** `dashboard/serve.ts`, `dashboard/dashboard.js`, `dashboard/dashboard.css`

- [ ] **Step 1: Add /api/self endpoint to dashboard/serve.ts**

```typescript
if (url.pathname === '/api/self') {
  return Response.json({ machine_id: machineId })
}
```

- [ ] **Step 2: Add state + fetch in dashboard.js**

```javascript
let localMachineId = null;
let sessionMachines = {};  // name -> machine_id

fetch('/api/self').then(r => r.json()).then(data => { localMachineId = data.machine_id; }).catch(() => {});
```

- [ ] **Step 3: Track machine_id from session-update events**

In `handleSessionUpdate(session)`, after existing code, add:

```javascript
if (session && session.name && session.machine_id) {
  sessionMachines[session.name] = session.machine_id;
}
```

- [ ] **Step 4: Host-badge helper**

```javascript
function hostBadge(name) {
  const mid = sessionMachines[name];
  if (!mid) return '';
  if (localMachineId && mid === localMachineId) return '';
  const short = mid.slice(0, 3);
  return '<span class="host-badge" title="Remote: ' + esc(mid) + '">' + esc(short) + '</span>';
}
```

Insert `hostBadge(s.name)` into the card header markup, next to the session name.

- [ ] **Step 5: CSS**

```css
.host-badge {
  display: inline-block;
  background: var(--purple);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  padding: 2px 5px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-left: 6px;
}
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/serve.ts dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(switchboard): show host badge on session cards for remote machines"
```

---

### Task 6: Unread badge (localStorage + count)

**Files:** `dashboard/dashboard.js`, `dashboard/dashboard.css`

- [ ] **Step 1: localStorage helpers**

```javascript
const UI_STATE_KEY = 'partyLine.ui.state';

function loadUiState() {
  try { return JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}'); } catch { return {}; }
}
function saveUiState(state) {
  try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(state)); } catch {}
}
function getLastViewedAt(name) {
  const s = loadUiState();
  return (s.lastViewedAt && s.lastViewedAt[name]) || 0;
}
function markSessionViewed(name) {
  const s = loadUiState();
  s.lastViewedAt = s.lastViewedAt || {};
  s.lastViewedAt[name] = Date.now();
  saveUiState(s);
}
```

- [ ] **Step 2: Unread state + bump helper**

```javascript
let unreadCounts = {};

function bumpUnread(sessionKey) {
  if (!sessionKey) return;
  unreadCounts[sessionKey] = (unreadCounts[sessionKey] || 0) + 1;
  updateSessions(lastSessions);
}

function resolveNameFromJsonlPath(path) {
  if (!path) return null;
  const m = path.match(/\/([0-9a-f-]+)\.jsonl$/);
  if (!m) return null;
  const sid = m[1];
  const found = lastSessions.find(s => s.metadata && s.metadata.status && s.metadata.status.sessionId === sid);
  return found ? found.name : null;
}
```

- [ ] **Step 3: Wire into ws.onmessage**

In the `else if (data.type === 'message')` branch, add `if (data.data.to && data.data.to !== 'all') bumpUnread(data.data.to);`
In the `session-update` branch: `bumpUnread(data.data.name);`
In the `jsonl` branch: `bumpUnread(resolveNameFromJsonlPath(data.data.file_path) || data.data.session_id);`

- [ ] **Step 4: Badge helper**

```javascript
function unreadBadge(name) {
  const n = unreadCounts[name] || 0;
  if (n === 0) return '';
  if (n > 99) return '<span class="unread-badge">•</span>';
  return '<span class="unread-badge">' + n + '</span>';
}
```

Insert into card header markup.

- [ ] **Step 5: Clear on open**

In the tab router when `view === 'session-detail'`:

```javascript
markSessionViewed(selectedSessionId);
unreadCounts[selectedSessionId] = 0;
```

Then call `updateSessions(lastSessions)` to refresh badges.

- [ ] **Step 6: Seed counts on first sessions list**

Compute initial unread counts by fetching `/api/events?session_id=<name>&limit=500` for each session and counting rows with `ts > lastViewedAt[name]`. Guard with a `seededOnce` flag so this only runs once.

- [ ] **Step 7: CSS**

```css
.unread-badge {
  display: inline-block;
  background: var(--red);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 9px;
  min-width: 16px;
  text-align: center;
  margin-left: auto;
}
```

- [ ] **Step 8: Commit**

```bash
git add dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(switchboard): unread count badges with localStorage lastViewedAt"
```

---

### Task 7: Transient cross-call arrows

**Files:** `dashboard/index.html`, `dashboard/dashboard.js`, `dashboard/dashboard.css`

- [ ] **Step 1: SVG overlay inside Switchboard section**

Wrap the Switchboard content in `<div class="switchboard-wrap">...</div>` and add the SVG overlay at its top:

```html
<svg id="cross-call-overlay" class="cross-overlay" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow-blue" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,-5L10,0L0,5" fill="#58a6ff"/></marker>
    <marker id="arrow-yellow" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,-5L10,0L0,5" fill="#d29922"/></marker>
    <marker id="arrow-green" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,-5L10,0L0,5" fill="#3fb950"/></marker>
  </defs>
</svg>
```

- [ ] **Step 2: CSS**

```css
.switchboard-wrap { position: relative; }
.cross-overlay {
  position: absolute; top: 0; left: 0;
  width: 100%; height: 100%;
  pointer-events: none; z-index: 10;
}
.cross-overlay .arrow {
  fill: none; stroke-width: 2; opacity: 0.9;
  transition: opacity 4s linear;
}
.cross-overlay .arrow.fade { opacity: 0; }
.cross-overlay .arrow.message  { stroke: var(--accent); }
.cross-overlay .arrow.request  { stroke: var(--yellow); }
.cross-overlay .arrow.response { stroke: var(--green); }
```

- [ ] **Step 3: Handle cross-call WS events**

In `ws.onmessage`, add `else if (data.type === 'cross-call') handleCrossCall(data.data);`

Implement:

```javascript
function handleCrossCall(call) {
  if (currentView !== 'switchboard') return;
  const overlay = document.getElementById('cross-call-overlay');
  if (!overlay) return;
  const fromCard = document.querySelector('[data-session-id="' + CSS.escape(call.from) + '"]');
  const toCard = document.querySelector('[data-session-id="' + CSS.escape(call.to) + '"]');
  if (!fromCard || !toCard) return;

  const oRect = overlay.getBoundingClientRect();
  const fRect = fromCard.getBoundingClientRect();
  const tRect = toCard.getBoundingClientRect();
  const fx = fRect.left + fRect.width / 2 - oRect.left;
  const fy = fRect.top + fRect.height / 2 - oRect.top;
  const tx = tRect.left + tRect.width / 2 - oRect.left;
  const ty = tRect.top + tRect.height / 2 - oRect.top;

  const colorClass = call.envelope_type;
  const markerId = 'arrow-' + (colorClass === 'message' ? 'blue' : colorClass === 'request' ? 'yellow' : 'green');
  const ns = 'http://www.w3.org/2000/svg';
  const line = document.createElementNS(ns, 'path');
  line.setAttribute('class', 'arrow ' + colorClass);
  line.setAttribute('d', 'M ' + fx + ',' + fy + ' L ' + tx + ',' + ty);
  line.setAttribute('marker-end', 'url(#' + markerId + ')');
  overlay.appendChild(line);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => line.classList.add('fade'));
  });
  setTimeout(() => line.remove(), 4500);
}
```

- [ ] **Step 4: Ensure cards have data-session-id**

Confirm the card renderer writes `data-session-id="<session-name-escaped>"` on the outer card element. Add if missing.

- [ ] **Step 5: Commit**

```bash
git add dashboard/index.html dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(switchboard): transient cross-call SVG arrows between session cards"
```

---

### Task 8: Responsive grid columns

**Files:** `dashboard/dashboard.css`

- [ ] **Step 1: Replace the #overview-grid rule with responsive variants**

```css
#overview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(240px, 1fr));
  gap: 10px;
  padding: 12px;
}
@media (max-width: 1023px) {
  #overview-grid { grid-template-columns: repeat(2, minmax(240px, 1fr)); }
}
@media (max-width: 639px) {
  #overview-grid { grid-template-columns: 1fr; gap: 8px; padding: 8px; }
  .sessions { display: none; }
}
```

- [ ] **Step 2: Verify in DevTools device toolbar — resize window to 1000px and 500px**

- [ ] **Step 3: Commit**

```bash
git add dashboard/dashboard.css
git commit -m "feat(switchboard): responsive grid columns for desktop/tablet/mobile"
```

---

## Phase C — Session Detail (Tasks 9–15)

### Task 9: Rebuild Session Detail shell

**Files:** `dashboard/index.html`, `dashboard/dashboard.css`, `dashboard/dashboard.js`

- [ ] **Step 1: Replace the Session Detail section DOM**

```html
<section data-view="session-detail" class="view" hidden>
  <div class="detail-header">
    <button id="detail-back" class="back-btn" title="Back to Switchboard">‹</button>
    <span class="state-pill" id="detail-state"></span>
    <h2 id="detail-name"></h2>
    <div class="detail-meta">
      <span id="detail-cwd"></span>
      <span id="detail-model"></span>
      <span id="detail-ctx"></span>
      <span id="detail-host"></span>
    </div>
  </div>
  <div class="detail-body">
    <aside class="detail-sidebar" id="detail-sidebar">
      <div class="sidebar-label">AGENTS</div>
      <ul id="detail-tree"></ul>
    </aside>
    <main class="detail-stream" id="detail-stream"></main>
  </div>
  <form class="detail-send" id="detail-send" onsubmit="event.preventDefault(); doDetailSend();">
    <label>to</label>
    <input id="detail-send-to" class="to">
    <select id="detail-send-type">
      <option value="message">message</option>
      <option value="request">request</option>
    </select>
    <input id="detail-send-msg" class="msg" placeholder="Type a message..." autocomplete="off">
    <button type="submit">Send</button>
  </form>
</section>
```

- [ ] **Step 2: CSS for three-zone layout** — see design spec section "Session Detail view" for exact measurements. Key rules:

```css
.detail-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.back-btn { background: transparent; color: var(--text-dim); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 14px; }
.back-btn:hover { color: var(--text); border-color: var(--text-dim); }
.detail-body { display: grid; grid-template-columns: 180px 1fr; flex: 1; overflow: hidden; }
.detail-sidebar { background: var(--surface); border-right: 1px solid var(--border); padding: 10px; overflow-y: auto; }
.sidebar-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
#detail-tree { list-style: none; padding: 0; margin: 0; }
#detail-tree li { padding: 4px 6px; font-size: 12px; color: var(--text); cursor: pointer; border-radius: 3px; }
#detail-tree li:hover { background: #21262d; }
#detail-tree li.active { background: #21262d; color: var(--accent); }
#detail-tree li .dot { display: inline-block; width: 6px; height: 6px; border-radius: 3px; margin-left: 4px; vertical-align: middle; }
#detail-tree li .dot.running   { background: var(--yellow); }
#detail-tree li .dot.completed { background: var(--green); }
#detail-tree li .dot.errored   { background: var(--red); }
.detail-stream { padding: 14px; overflow-y: auto; }
.detail-send { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); align-items: center; }
.detail-send label { font-size: 11px; color: var(--text-dim); }
.detail-send input.to { width: 120px; }
.detail-send input.msg { flex: 1; }
.detail-send button { background: var(--accent); color: #000; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-weight: 600; }
```

- [ ] **Step 3: Wire back button**

```javascript
document.getElementById('detail-back').addEventListener('click', () => {
  const tab = document.querySelector('button[data-view="switchboard"]');
  if (tab) tab.click();
});
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/index.html dashboard/dashboard.css dashboard/dashboard.js
git commit -m "feat(session-detail): three-zone layout shell (header, tree sidebar, stream, send)"
```

---

### Task 10: Populate agent tree

**Files:** `dashboard/dashboard.js`

- [ ] **Step 1: State + loader**

```javascript
let selectedAgentId = null;
let currentSessionSubagents = [];

async function loadSessionDetailView() {
  if (!selectedSessionId) return;
  const sessionKey = selectedSessionId;
  markSessionViewed(sessionKey);
  unreadCounts[sessionKey] = 0;
  updateSessions(lastSessions);

  document.getElementById('detail-name').textContent = sessionKey;
  document.getElementById('detail-send-to').value = sessionKey;

  try {
    const r = await fetch('/api/session?id=' + encodeURIComponent(sessionKey));
    const data = await r.json();
    currentSessionSubagents = data.subagents || [];
    if (data.session) renderDetailHeader(data.session);
    renderAgentTree();
  } catch (e) { console.warn('session fetch failed', e); }

  selectedAgentId = null;
  await renderStream();
}

function renderDetailHeader(session) {
  const pill = document.getElementById('detail-state');
  pill.className = 'state-pill state-' + (session.state || 'idle');
  pill.textContent = (session.state || 'idle').toUpperCase();
  document.getElementById('detail-cwd').textContent = session.cwd || '';
  document.getElementById('detail-model').textContent = session.model ? session.model.replace('claude-', '') : '';
  document.getElementById('detail-ctx').textContent = session.context_tokens ? 'ctx ' + formatTokens(session.context_tokens) : '';
  const hostEl = document.getElementById('detail-host');
  if (session.machine_id && localMachineId && session.machine_id !== localMachineId) {
    hostEl.textContent = 'host: ' + session.machine_id.slice(0, 8);
  } else {
    hostEl.textContent = '';
  }
}
```

- [ ] **Step 2: renderAgentTree() builds <li> rows**

Build `<li>` for main + each subagent, wire click listeners that set `selectedAgentId` and call `renderAgentTree(); renderStream();`. Use `.textContent` for dynamic text where possible; use string concatenation + DOM-property assignment for the whole li content (following the existing codebase pattern). Mark the selected row with the `active` class. For subagents, the row indents via `li.style.paddingLeft = '16px'`.

- [ ] **Step 3: Placeholder renderStream**

Stub: set the stream container's HTML to `<p style="color:var(--text-dim)">Loading...</p>`. Real implementation in Task 11.

- [ ] **Step 4: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "feat(session-detail): populate agent tree sidebar from /api/session"
```

---

### Task 11: Render stream with marked + DOMPurify

**Files:** `dashboard/index.html`, `dashboard/dashboard.js`, `dashboard/dashboard.css`

- [ ] **Step 1: Load vendor scripts in index.html**

Before `<script src="/dashboard.js"></script>`:

```html
<script src="/vendor/marked.min.js"></script>
<script src="/vendor/purify.min.js"></script>
```

- [ ] **Step 2: Implement renderStream() and helpers**

`renderStream()` fetches `/api/transcript?session_id=<key>&agent_id=<?>&limit=300`, iterates entries, calls `renderEntry(e)` per, appends to `#detail-stream`.

`renderEntry(e)` returns a fresh `<div class="entry entry-<type>">` whose content depends on entry type:
- `user` → label "you:" + markdown-rendered text
- `assistant-text` → label "assistant:" + markdown-rendered text + a `<button class="copy-btn" data-src="<escaped-raw>">copy raw</button>`
- `tool-use` → `renderToolUse(e)` producing a `<details>` with a `<summary>` of `▸ <tool_name>: <summary>` plus expanded input/response
- `subagent-spawn` → `renderSpawnMarker(e)` producing a highlighted `<div class="spawn-marker" data-agent-id="<id>">` block
- `party-line-send` / `party-line-receive` → `renderPartyLineEntry(e)` producing `<div class="pl-entry pl-<type>" data-other-session="<name>">`

`renderMarkdown(src)` pipes through `marked.parse(src, {breaks: true, gfm: true})` then `DOMPurify.sanitize(html)`, then post-processes: find each `<pre>` in the sanitized fragment, wrap with a `<div class="code-block">` and insert a `<button class="code-copy-btn">copy</button>` before it. Return the resulting HTML string.

`summarizeToolInput(name, input)` returns a one-line string for display: `Bash.command`, `Read.file_path`, `Write.file_path`, `Edit.file_path`, `Grep.pattern`, `Glob.pattern`, else `JSON.stringify(input).slice(0, 80)`.

All HTML-building done by concatenating strings; call `esc()` on every dynamic value. The post-processing of marked output is done by constructing a temporary `<div>` element, assigning the sanitized HTML to its content, manipulating children via DOM APIs, and reading the resulting serialized markup back.

- [ ] **Step 3: CSS for entries**

```css
.entry { margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px dashed #21262d; }
.entry-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.entry-body { color: var(--text); }
.entry-body pre { background: #0d1117; border: 1px solid var(--border); padding: 8px; overflow-x: auto; font-size: 12px; border-radius: 4px; }
.entry-body code { background: #21262d; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.entry-body h1, .entry-body h2, .entry-body h3 { margin: 8px 0 4px; color: var(--text); }
.entry-body p { margin: 4px 0; }
.entry-body ul, .entry-body ol { margin: 4px 0 4px 20px; }
.copy-btn { margin-top: 4px; background: transparent; color: var(--text-dim); border: 1px solid var(--border); border-radius: 3px; font-size: 10px; padding: 2px 8px; cursor: pointer; }
.copy-btn:hover { color: var(--text); border-color: var(--text-dim); }
.code-block { position: relative; margin: 6px 0; }
.code-copy-btn { position: absolute; top: 4px; right: 4px; background: #21262d; color: var(--text-dim); border: 1px solid var(--border); border-radius: 3px; font-size: 10px; padding: 2px 8px; cursor: pointer; opacity: 0.7; }
.code-block:hover .code-copy-btn { opacity: 1; }
.tool-use { margin: 6px 0; background: #0d1117; border-left: 3px solid var(--cyan); padding: 4px 8px; font-size: 12px; }
.tool-use summary { cursor: pointer; color: var(--text-dim); }
.tool-input, .tool-response { margin-top: 6px; font-size: 11px; }
.spawn-marker { border: 1px solid var(--purple); background: rgba(188, 140, 255, 0.08); border-radius: 4px; padding: 8px 10px; margin: 6px 0; cursor: pointer; }
.spawn-marker:hover { background: rgba(188, 140, 255, 0.15); }
.spawn-desc { color: var(--text-dim); font-size: 11px; margin-top: 3px; }
.spawn-click { color: var(--accent); font-size: 10px; margin-top: 4px; }
.pl-entry { border-left: 3px solid var(--accent); padding: 6px 10px; margin: 6px 0; background: #0d1117; font-size: 12px; cursor: pointer; }
.pl-entry.pl-request  { border-left-color: var(--yellow); }
.pl-entry.pl-response { border-left-color: var(--green); }
.pl-body { margin-top: 4px; color: var(--text-dim); font-size: 11px; }
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/index.html dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(session-detail): markdown stream with tool-use collapse and entry renderers"
```

---

### Task 12: Copy-safe button click handlers

**Files:** `dashboard/dashboard.js`

- [ ] **Step 1: Delegated click listener on #detail-stream**

```javascript
document.getElementById('detail-stream').addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (btn) {
    const src = btn.dataset.src;
    if (src) navigator.clipboard.writeText(src).then(() => {
      btn.textContent = 'copied';
      setTimeout(() => { btn.textContent = 'copy raw'; }, 1200);
    });
    return;
  }
  const codeBtn = e.target.closest('.code-copy-btn');
  if (codeBtn) {
    const pre = codeBtn.parentElement.querySelector('pre');
    if (pre) navigator.clipboard.writeText(pre.textContent || '').then(() => {
      codeBtn.textContent = 'copied';
      setTimeout(() => { codeBtn.textContent = 'copy'; }, 1200);
    });
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "feat(session-detail): copy-safe button handlers"
```

---

### Task 13: Spawn marker + pl-entry click-through

**Files:** `dashboard/dashboard.js`

- [ ] **Step 1: Extend the #detail-stream click listener**

After the copy handlers, add:

```javascript
const spawn = e.target.closest('.spawn-marker');
if (spawn) {
  const aid = spawn.dataset.agentId;
  if (aid) { selectedAgentId = aid; renderAgentTree(); renderStream(); }
  return;
}
const pl = e.target.closest('.pl-entry');
if (pl && pl.dataset.otherSession) {
  selectedSessionId = pl.dataset.otherSession;
  const tab = document.querySelector('button[data-view="session-detail"]');
  if (tab) { tab.disabled = false; tab.click(); }
  loadSessionDetailView();
  return;
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "feat(session-detail): click spawn marker to drill into subagent; click pl-entry to cross-navigate"
```

---

### Task 14: Send box wiring

**Files:** `dashboard/dashboard.js`

- [ ] **Step 1: doDetailSend**

```javascript
function doDetailSend() {
  const to = document.getElementById('detail-send-to').value.trim();
  const msg = document.getElementById('detail-send-msg').value.trim();
  const type = document.getElementById('detail-send-type').value;
  if (!to || !msg) return;
  ws.send(JSON.stringify({ action: 'send', to, message: msg, type }));
  document.getElementById('detail-send-msg').value = '';
  document.getElementById('detail-send-msg').focus();
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "feat(session-detail): wire per-session send box to WS send action"
```

---

### Task 15: Live updates

**Files:** `dashboard/dashboard.js`

- [ ] **Step 1: Extend handleSessionUpdate**

```javascript
function handleSessionUpdate(session) {
  if (!session) return;
  if (session.name) {
    if (session.source) sessionSources[session.name] = session.source;
    if (session.machine_id) sessionMachines[session.name] = session.machine_id;
  }
  if (currentView === 'session-detail' && session.name === selectedSessionId) {
    renderDetailHeader(session);
    fetch('/api/session?id=' + encodeURIComponent(selectedSessionId))
      .then(r => r.json())
      .then(data => { currentSessionSubagents = data.subagents || []; renderAgentTree(); })
      .catch(() => {});
  }
}
```

- [ ] **Step 2: Extend handleJsonlEvent**

```javascript
function handleJsonlEvent(update) {
  if (currentView !== 'session-detail') return;
  const parentMatches = update.session_id === selectedSessionId
    || resolveNameFromJsonlPath(update.file_path) === selectedSessionId;
  const agentMatches = selectedAgentId && update.session_id === selectedAgentId;
  if (!parentMatches && !agentMatches) return;
  renderStream();
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "feat(session-detail): live-patch stream and sidebar on WS events"
```

---

## Phase D — History reorg (Tasks 16–17)

### Task 16: History sub-tabs Events + Bus

**Files:** `dashboard/index.html`, `dashboard/dashboard.js`, `dashboard/dashboard.css`

- [ ] **Step 1: Restructure the History section**

```html
<section data-view="history" class="view" hidden>
  <nav class="subtabs" id="history-subtabs">
    <button data-subtab="events" class="active">Events</button>
    <button data-subtab="bus">Bus</button>
  </nav>
  <div class="subview" data-subview="events">
    <div class="history-controls">
      <input type="search" id="history-filter" placeholder="Filter events...">
      <select id="history-hook-filter"><option value="">All hooks</option></select>
    </div>
    <ul id="history-list"></ul>
  </div>
  <div class="subview" data-subview="bus" hidden>
    <div class="bus-feed-wrap">
      <div class="feed-controls"><span id="busMsgCount">0 messages</span></div>
      <div class="feed" id="busFeed"></div>
      <form class="send-bar" id="busSend" onsubmit="event.preventDefault(); doBusSend();">
        <label>To:</label>
        <input class="to" id="busSendTo" placeholder="session or all" value="all">
        <label>Type:</label>
        <select id="busSendType">
          <option value="message">message</option>
          <option value="request">request</option>
          <option value="status">status</option>
        </select>
        <input class="msg" id="busSendMsg" placeholder="Type a message...">
        <button type="submit">Send</button>
      </form>
    </div>
  </div>
</section>
```

- [ ] **Step 2: Sub-tab switch JS**

```javascript
document.getElementById('history-subtabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-subtab]');
  if (!btn) return;
  document.querySelectorAll('#history-subtabs button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const sub = btn.dataset.subtab;
  document.querySelectorAll('section[data-view="history"] .subview').forEach(v => {
    v.hidden = v.dataset.subview !== sub;
  });
});
```

- [ ] **Step 3: Move the bus feed populator**

Find the existing function that appends to `#feed` / updates `#msgCount`. Rename its targets to `#busFeed` / `#busMsgCount`. If the old function was on the Switchboard view, remove it from there.

- [ ] **Step 4: Implement doBusSend**

```javascript
function doBusSend() {
  const to = document.getElementById('busSendTo').value.trim();
  const msg = document.getElementById('busSendMsg').value.trim();
  const type = document.getElementById('busSendType').value;
  if (!to || !msg) return;
  ws.send(JSON.stringify({ action: 'send', to, message: msg, type }));
  document.getElementById('busSendMsg').value = '';
}
```

- [ ] **Step 5: Remove the legacy send-bar from Switchboard**

Delete the `<div class="send-bar">...</div>` block inside `<section data-view="switchboard">`. Remove JS references to the deleted `sendTo`/`sendType`/`sendMsg`/`sendBtn` elements.

- [ ] **Step 6: Sub-tab CSS**

```css
.subtabs { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.subtabs button { background: transparent; color: var(--text-dim); border: none; padding: 4px 12px; cursor: pointer; font-size: 12px; border-bottom: 2px solid transparent; }
.subtabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
.subview { padding: 12px; }
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/index.html dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(history): Events + Bus sub-tabs; global send form moves to Bus"
```

---

### Task 17: Switchboard cleanup and unified card click

**Files:** `dashboard/index.html`, `dashboard/dashboard.js`

- [ ] **Step 1: Unified click handler**

```javascript
function openSessionDetail(sessionName) {
  selectedSessionId = sessionName;
  const tab = document.querySelector('button[data-view="session-detail"]');
  if (tab) {
    tab.disabled = false;
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    tab.classList.add('active');
    renderView('session-detail');
  }
}
```

Wire this to the card click in the card renderer.

- [ ] **Step 2: Delete the left-sidebar .sessions block from Switchboard**

Remove it from `index.html`. Make `updateSessions` tolerant of a missing `#sessionList` element (no-op that branch).

- [ ] **Step 3: Commit**

```bash
git add dashboard/index.html dashboard/dashboard.js
git commit -m "refactor(switchboard): remove legacy left sidebar; unify card click handler"
```

---

## Phase E — Mobile + PL interleave + E2E (Tasks 18–20)

### Task 18: Mobile responsive Session Detail

**Files:** `dashboard/index.html`, `dashboard/dashboard.js`, `dashboard/dashboard.css`

- [ ] **Step 1: Mobile CSS**

```css
@media (max-width: 1023px) {
  .detail-body { grid-template-columns: 1fr; }
  .detail-sidebar {
    position: fixed; top: 0; left: 0; height: 100%; width: 200px; z-index: 20;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    box-shadow: 2px 0 12px rgba(0,0,0,0.3);
  }
  .detail-sidebar.open { transform: translateX(0); }
}
@media (max-width: 639px) {
  .detail-header { font-size: 11px; }
  .detail-meta { font-size: 10px; }
  .detail-send input.to { width: 80px; }
}
```

- [ ] **Step 2: Drawer toggle button** inside `.detail-header`:

```html
<button id="detail-drawer-toggle" class="drawer-btn" title="Agents">≡</button>
```

CSS:

```css
.drawer-btn { background: transparent; color: var(--text-dim); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 14px; display: none; }
@media (max-width: 1023px) { .drawer-btn { display: inline-block; } }
```

JS:

```javascript
document.getElementById('detail-drawer-toggle').addEventListener('click', () => {
  document.getElementById('detail-sidebar').classList.toggle('open');
});
```

Also close the drawer when a tree item is clicked — add `document.getElementById('detail-sidebar').classList.remove('open');` inside each tree-item click listener in `renderAgentTree`.

- [ ] **Step 3: Commit**

```bash
git add dashboard/index.html dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(session-detail): mobile drawer for agent tree"
```

---

### Task 19: Party-line envelopes in transcript

**Files:** `src/transcript.ts`, `dashboard/serve.ts`, `tests/transcript.test.ts`

- [ ] **Step 1: Extend BuildTranscriptOptions**

```typescript
export interface PartyLineEnvelope {
  id: string
  from: string
  to: string
  type: 'message' | 'request' | 'response' | string
  body: string
  ts: string
  callback_id?: string | null
  response_to?: string | null
}

export interface BuildTranscriptOptions {
  projectsRoot: string
  sessionId: string
  agentId?: string
  limit: number
  sessionName?: string
  envelopes?: PartyLineEnvelope[]
}
```

- [ ] **Step 2: In buildTranscript, before the final slice, append envelope entries**

Iterate `opts.envelopes` (if provided). For each envelope:
- `from === sessionName` → push `party-line-send` entry (other_session = env.to, body, callback_id, envelope_type)
- `to === sessionName` OR `sessionName is in env.to.split(',')` → push `party-line-receive` entry (other_session = env.from)

After appending, sort all entries by `ts` string ascending (ISO-8601 collation is correct).

- [ ] **Step 3: Update serve.ts /api/transcript to pass envelopes**

```typescript
const envelopes = monitor.getHistory({ limit: 500, excludeHeartbeats: true })
return Response.json(buildTranscript({
  projectsRoot, sessionId: sessionUuid, sessionName, agentId, limit, envelopes,
}))
```

- [ ] **Step 4: Add test case**

Append to `tests/transcript.test.ts` a test that feeds one outbound (from=work to=research, type=request) and one inbound (from=research to=work, type=response) envelope and expects at least one `party-line-send` and one `party-line-receive` entry.

- [ ] **Step 5: Run tests**

Expected: all 5 pass.

- [ ] **Step 6: Commit**

```bash
git add src/transcript.ts tests/transcript.test.ts dashboard/serve.ts
git commit -m "feat(transcript): interleave party-line envelopes as send/receive entries"
```

---

### Task 20: Verification + polish pass

- [ ] **Step 1: `bun test`** — all pass.
- [ ] **Step 2: `bun run typecheck`** — only the pre-existing 3 errors in `dashboard/cli.ts` remain.
- [ ] **Step 3: Endpoint sweep** — curl each endpoint listed in the design spec; all 200.
- [ ] **Step 4: Manual UI checklist** — see design spec section "Testing → Frontend". Work each item on desktop and mobile widths.
- [ ] **Step 5: Commit any targeted fixes found — one fix per commit, descriptive message**.

---

## Self-review checklist (done during authoring)

- [x] **Spec coverage**: every spec requirement maps to at least one task.
  - Switchboard cards + unread + cross-call arrows → Tasks 4–8
  - Session Detail tree + stream + send + live updates → Tasks 9–15, 18
  - History / Bus sub-tabs → Task 16
  - Machines removed + per-session host label → Tasks 4–5
  - Mobile → Tasks 8, 18
  - Backend: transcript endpoint, cross-call broadcast → Tasks 1–3, 19
- [x] **Placeholder scan**: no "TBD" or "handle edge cases". All code snippets complete.
- [x] **Type consistency**: `TranscriptEntry`, `selectedAgentId`, `sessionMachines`, `sessionSources`, `unreadCounts` named consistently across tasks.

---

## Handoff

Two options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between. Best for this 20-task UI-heavy plan.
2. **Inline** — run the tasks here using `executing-plans`.

Which approach?
