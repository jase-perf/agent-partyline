# PR 1 — Finish the Tab Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the single-tab globals and DOM lookups left behind by the multi-tab refactor (commits `aa3449b`…`52685fb`) so that per-session UI (permission cards, kebab, back/drawer/bell, archive banner, attachments, stream click handlers, iOS keyboard handler) operates on the focused tab's clone instead of the hidden template.

**Architecture:**

- `selectedSessionId` (permanently null after the refactor) is replaced by `focusedTabName` and `currentTab()`.
- `currentView` is set correctly inside `focusTab()` so existing `currentView === 'session-detail'` guards work again.
- `pendingAttachments` moves onto each `Tab` so paste/attach state is per-tab.
- Every `document.getElementById('detail-*')` outside template wiring goes through `scopedById(tab.contentEl, ...)`.
- Header-action handlers (`detail-back`, `detail-drawer-toggle`, `detail-actions`, `detail-bell`, `archive-banner`) are wired inside `wireTabFormHandlers(contentEl)` instead of at module init.
- Permission-request frames fan out to every matching tab (mirror of envelope fan-out at `dashboard.js:398-405`).
- Service Worker shell includes vendor scripts; cache write is awaited; `sw-routes.js` deleted (logic already inlined in `sw.js`).
- `handleSessionsSnapshot` merges revisions instead of clearing them; reconnect re-runs `prefetchAllPinnedTabs()`.

**Tech Stack:** Vanilla ESM JS (`dashboard/dashboard.js`), `bun:test` for unit tests, `node --check` for parse verification.

---

## Branch + verification commands

All tasks run on a new branch: `pr1-finish-tab-refactor` (created in Task 0). Verification commands referenced throughout:

- `node --check dashboard/dashboard.js` — parse check (catches syntax errors `bun test` misses)
- `bun test` — full suite
- `bun test tests/<name>.test.ts` — single file

---

## Task 0: Branch setup

**Files:** none yet.

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b pr1-finish-tab-refactor
git status
```

Expected: `On branch pr1-finish-tab-refactor`, working tree clean.

- [ ] **Step 2: Snapshot baseline test count**

```bash
bun test 2>&1 | tail -10
```

Record the pass/fail count in your task notes — every later task must keep it green.

---

## Task 1: Fix `currentView` so session-detail guards work

**Files:**

- Modify: `dashboard/dashboard.js` — `focusTab()` (locate via grep; near line 3700-ish in the tab-registry section)
- Modify: `dashboard/dashboard.js:289-308` — `renderView()`

`currentView` is set by `renderView()` for the History view but the tab-driven session view goes through `focusTab()` which never touches it. Result: every `currentView === 'session-detail'` guard silently no-ops in the multi-tab world. Fix: `focusTab(name)` sets `currentView = name === '' ? 'switchboard' : 'session-detail'`.

- [ ] **Step 1: Locate `focusTab` definition**

```bash
grep -n "^function focusTab\|^const focusTab" dashboard/dashboard.js
```

- [ ] **Step 2: Add `currentView` assignment at the top of `focusTab`**

In the body of `focusTab(name, opts)`, add as the first effective line:

```javascript
currentView = name === '' ? 'switchboard' : 'session-detail'
```

(Place it before any tab-registry mutations or DOM updates so subsequent function calls see the correct view.)

- [ ] **Step 3: Parse + test**

```bash
node --check dashboard/dashboard.js
bun test
```

Both must pass.

- [ ] **Step 4: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "fix(tabs): set currentView in focusTab — restores session-detail guards"
```

---

## Task 2: Replace `selectedSessionId` reads with `focusedTabName` / `currentTab().name`

**Files:**

- Modify: `dashboard/dashboard.js:188` — declaration
- Modify: `dashboard/dashboard.js` — every read site (25+ — list below)

`selectedSessionId` was never reassigned after the tab refactor; it is permanently `null`. Every read evaluates to `null`, breaking permission cards, the kebab menu, agent-tree clicks, archive guards, JSONL stream-reset, compact handling, and `visibilitychange` notifications.

**Replacement rules:**

- `selectedSessionId` used as **comparand** (e.g. `=== selectedSessionId`, `!== selectedSessionId`, `&& selectedSessionId === foo`) → replace with `focusedTabName` (note: `focusedTabName === ''` for Switchboard, so `name === focusedTabName && focusedTabName !== ''` for "is this the focused session?").
- `selectedSessionId` used as **value** (e.g. passed into a function, used in a navigate object) → replace with `(currentTab() && currentTab().name) || null`. Use a local `const tabName = currentTab() && currentTab().name` if used multiple times in the same function.
- `!selectedSessionId` guards → replace with `!focusedTabName` (since `focusedTabName === ''` when no session is focused).

- [ ] **Step 1: Enumerate read sites**

```bash
grep -n "selectedSessionId" dashboard/dashboard.js
```

You should see ~25 hits. The declaration is at line 188 (`let selectedSessionId = null`).

- [ ] **Step 2: Apply per-site replacements**

Walk every read top-to-bottom. Examples (line numbers from the audit; verify before editing — they may have shifted):

`dashboard.js:302-304` (renderView)

```javascript
// BEFORE
if (view === 'session-detail' && selectedSessionId) {
  markSessionViewed(selectedSessionId)
  unreadCounts[selectedSessionId] = 0

// AFTER
if (view === 'session-detail' && focusedTabName) {
  markSessionViewed(focusedTabName)
  unreadCounts[focusedTabName] = 0
```

`dashboard.js:798` (handleSessionRemoved)

```javascript
// BEFORE
if (currentView === 'session-detail' && selectedSessionId === name) {
// AFTER
if (focusedTabName === name) {
```

(With `currentView` now set correctly by Task 1, the `currentView === 'session-detail'` half is redundant — `focusedTabName === name` and `name !== ''` implies session-detail view.)

`dashboard.js:887-890` (kebab handler)

```javascript
// BEFORE
if (!selectedSessionId) return
const btn = ev.currentTarget
const r = btn.getBoundingClientRect()
showSessionActionsMenu(selectedSessionId, r.left, r.bottom + 4)

// AFTER
if (!focusedTabName) return
const btn = ev.currentTarget
const r = btn.getBoundingClientRect()
showSessionActionsMenu(focusedTabName, r.left, r.bottom + 4)
```

`dashboard.js:1049` (applySessionDelta)

```javascript
// BEFORE
if (currentView === 'session-detail' && selectedSessionId === delta.session) {
// AFTER
if (focusedTabName === delta.session) {
```

`dashboard.js:1781-1785` (handleStreamReset)

```javascript
// BEFORE
if (currentView !== 'session-detail' || !selectedSessionId) return
...
if (sessionName !== selectedSessionId && sessionId !== selectedSessionId) return
// AFTER
if (!focusedTabName) return
...
if (sessionName !== focusedTabName && sessionId !== focusedTabName) return
```

`dashboard.js:2390, 2457` (agent tree clicks)

```javascript
// BEFORE
navigate({ view: 'session-detail', sessionName: selectedSessionId, agentId: null })
// AFTER
navigate({ view: 'session-detail', sessionName: focusedTabName, agentId: null })
```

`dashboard.js:3536` (stream click handler — view-agent button)

```javascript
// BEFORE
sessionName: selectedSessionId,
// AFTER
sessionName: focusedTabName,
```

`dashboard.js:4348-4349` (renderPermissionCard guard)

```javascript
// BEFORE
if (currentView !== 'session-detail') return
if (selectedSessionId !== data.session) return
// AFTER (Task 4 will replace the body too — for this task just unbreak the guard)
if (!focusedTabName) return
```

(Don't gate on `focusedTabName === data.session` here — Task 4 fans cards out to background tabs too.)

`dashboard.js:4463-4464` (visibilitychange)

```javascript
// BEFORE
if (currentView !== 'session-detail' || !selectedSessionId) return
notif.dispatchSessionViewed(selectedSessionId)
// AFTER
if (!focusedTabName) return
notif.dispatchSessionViewed(focusedTabName)
```

For every other site found by the grep, apply the same rule. Pay attention to:

- `appendEnvelopeToStream` (`dashboard.js:1820-1865`) — this is the legacy single-tab path. The per-tab path is `appendEnvelopeToStreamForTab` and the fan-out at `398-405` already calls it. **Do not** rewrite `appendEnvelopeToStream` — Task 11 will delete it. For this task, leave it alone.
- `handleUserPromptLive` (`dashboard.js:1730`) — replace `selectedSessionId` with `focusedTabName`.
- `maybeHandleCompactForCurrentView` (`dashboard.js:1802-1806`) — same.
- `dashboard.js:547` (`renderDetailHeader` guard) — same.
- Sites at `2083, 2109, 2111, 2171, 2191, 2201, 2211, 2301, 2356, 2526, 3217, 3212` — apply the rules above. Note that `2191` and `2201` already have a "don't guard on selectedSessionId" comment — replace the now-stale comment (just delete the comment block; the guard itself is gone).

- [ ] **Step 3: Delete the declaration**

`dashboard.js:188`:

```javascript
// BEFORE
let selectedSessionId = null
// AFTER
// (deleted)
```

- [ ] **Step 4: Parse + test**

```bash
node --check dashboard/dashboard.js
bun test
```

If `node --check` errors with "selectedSessionId is not defined", you missed a read site. Use `grep -n selectedSessionId dashboard/dashboard.js` to find it.

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "refactor(tabs): delete dead selectedSessionId global, route through focusedTabName"
```

---

## Task 3: Fix the notification banner selector

**Files:**

- Modify: `dashboard/dashboard.js:4220`

`updateBanner()` calls `banner.querySelector('.notif-banner-text')` but `index.html:28` declares `id="notif-banner-text"` with no class. The lookup returns `null`, the early return at 4222 fires, and the banner text never updates after initial HTML.

- [ ] **Step 1: Replace the selector**

```javascript
// BEFORE
const text = banner.querySelector('.notif-banner-text')
// AFTER
const text = document.getElementById('notif-banner-text')
```

- [ ] **Step 2: Verify the banner element ID exists**

```bash
grep -n "notif-banner-text" dashboard/index.html
```

Expected: `<span id="notif-banner-text">...`.

- [ ] **Step 3: Parse**

```bash
node --check dashboard/dashboard.js
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "fix(notif): banner uses id selector — class never existed"
```

---

## Task 4: Move `pendingAttachments` onto Tab

**Files:**

- Modify: `dashboard/dashboard.js:3112` — declaration
- Modify: `dashboard/dashboard.js:88-105` — `Tab` typedef
- Modify: `dashboard/dashboard.js:3114-3251` — `renderAttachChips`, `uploadPending`, `addFiles`, `doDetailSend`
- Modify: `dashboard/dashboard.js` — `pinTab()` (search for the tab-construction site)

Today `pendingAttachments` is module-global. A user attaching a file in tab A, switching to tab B, and pressing Send sends from B with A's files. Fix: each tab owns its own attachments list.

- [ ] **Step 1: Add field to `Tab` typedef**

`dashboard.js:88-105` add to the JSDoc:

```javascript
 *   pendingAttachments: Array<{id: string|null, localId?: string, name: string, size: number, kind: string, media_type: string, url: string|null, objectUrl?: string, status: 'uploading'|'ready'|'error'}>,
```

- [ ] **Step 2: Initialize per-tab in tab construction**

Find every Tab construction (`pinTab`, `ensureSwitchboardTabRegistered` — grep for `streamKeys: new Set`):

```bash
grep -n "streamKeys: new Set" dashboard/dashboard.js
```

For each construction, add `pendingAttachments: [],` next to the other initial fields.

- [ ] **Step 3: Delete the global**

`dashboard.js:3112`:

```javascript
// BEFORE
let pendingAttachments = []
// AFTER
// (deleted)
```

- [ ] **Step 4: Refactor `renderAttachChips()` to take a tab**

```javascript
// AFTER (replaces lines 3114-3160)
function renderAttachChips(tab) {
  if (!tab || !tab.contentEl) return
  const wrap = scopedById(tab.contentEl, 'detail-attach-chips')
  if (!wrap) return
  wrap.replaceChildren()
  if (tab.pendingAttachments.length === 0) {
    wrap.hidden = true
    return
  }
  wrap.hidden = false
  for (const p of tab.pendingAttachments) {
    const chip = document.createElement('span')
    chip.className =
      'attach-chip' +
      (p.status === 'uploading' ? ' uploading' : '') +
      (p.status === 'error' ? ' errored' : '')
    if (p.kind === 'image' && (p.objectUrl || p.url)) {
      const img = document.createElement('img')
      img.src = p.objectUrl || p.url
      img.alt = ''
      chip.appendChild(img)
    }
    const name = document.createElement('span')
    name.className = 'attach-name'
    name.textContent = p.name
    chip.appendChild(name)
    const size = document.createElement('span')
    size.className = 'attach-size'
    size.textContent = p.status === 'uploading' ? '…' : formatFileSize(p.size)
    chip.appendChild(size)
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'attach-chip-x'
    x.textContent = '×'
    x.addEventListener('click', () => {
      tab.pendingAttachments = tab.pendingAttachments.filter((q) => q !== p)
      if (p.objectUrl) URL.revokeObjectURL(p.objectUrl)
      renderAttachChips(tab)
    })
    chip.appendChild(x)
    wrap.appendChild(chip)
  }
}
```

- [ ] **Step 5: Refactor `uploadPending(file)` to `uploadPending(tab, file)`**

```javascript
// AFTER (replaces lines 3162-3195)
async function uploadPending(tab, file) {
  const localId = Math.random().toString(36).slice(2)
  const placeholder = {
    localId,
    id: null,
    name: file.name || 'pasted-image',
    size: file.size,
    media_type: file.type || 'application/octet-stream',
    kind: (file.type || '').startsWith('image/') ? 'image' : 'file',
    objectUrl: URL.createObjectURL(file),
    url: null,
    status: 'uploading',
  }
  tab.pendingAttachments.push(placeholder)
  renderAttachChips(tab)
  try {
    const form = new FormData()
    form.append('file', file, placeholder.name)
    const res = await fetch('/api/upload', { method: 'POST', body: form })
    if (!res.ok) throw new Error('upload failed: ' + res.status)
    const meta = await res.json()
    placeholder.id = meta.id
    placeholder.url = meta.url
    placeholder.kind = meta.kind
    placeholder.media_type = meta.media_type
    placeholder.size = meta.size
    placeholder.status = 'ready'
  } catch (err) {
    placeholder.status = 'error'
    console.error('[attach] upload failed', err)
  } finally {
    renderAttachChips(tab)
  }
}
```

- [ ] **Step 6: Refactor `addFiles(fileList)` to `addFiles(tab, fileList)`**

```javascript
// AFTER (replaces lines 3197-3205)
function addFiles(tab, fileList) {
  if (!tab) return
  for (const f of Array.from(fileList)) {
    if (tab.pendingAttachments.length >= 5) {
      console.warn('[attach] max 5 attachments; ignoring', f.name)
      break
    }
    uploadPending(tab, f)
  }
}
```

- [ ] **Step 7: Refactor `doDetailSend(form)` to use tab attachments**

In `doDetailSend(form)` at `dashboard.js:3210-3252`, after deriving `targetName` from `form.closest('.session-tab-content').dataset.tabName`, also resolve the tab:

```javascript
const tab = tabRegistry.get(targetName)
if (!tab) return
```

Then replace every `pendingAttachments` reference in this function with `tab.pendingAttachments`. The clear-on-send block at the end becomes:

```javascript
for (const p of tab.pendingAttachments) if (p.objectUrl) URL.revokeObjectURL(p.objectUrl)
tab.pendingAttachments = []
renderAttachChips(tab)
```

- [ ] **Step 8: Update every caller of `addFiles` / `renderAttachChips`**

Search:

```bash
grep -n "addFiles\|renderAttachChips" dashboard/dashboard.js
```

For each call, supply the tab. Most callers are inside `wireTabFormHandlers(contentEl)` where the tab can be derived as:

```javascript
const tabName = contentEl.dataset.tabName
const tab = tabRegistry.get(tabName)
```

and passed in. For paste/drop handlers, the tab is the focused tab when the event fires — use `currentTab()`.

- [ ] **Step 9: Parse + test**

```bash
node --check dashboard/dashboard.js
bun test
```

- [ ] **Step 10: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "refactor(tabs): per-tab pendingAttachments — paste in one tab no longer leaks to another"
```

---

## Task 5: Fan permission-request frames out to every matching tab

**Files:**

- Modify: `dashboard/dashboard.js:406-412` — observer-WS `permission-request` handler
- Modify: `dashboard/dashboard.js:4347-4414` — `renderPermissionCard()`

Today the observer-WS handler at line 406 calls `renderPermissionCard(data.data || data)` once. With the focused-tab guard removed in Task 2 (Step 4348), the card is rendered into the FIRST matching `[data-orig-id="detail-stream"]` it finds — usually the focused tab. Background tabs miss it entirely. Mirror what envelopes do at lines 398-405: walk `tabRegistry` and render into every tab whose `name === data.session`.

- [ ] **Step 1: Refactor `renderPermissionCard` to take an explicit stream root**

Change the signature:

```javascript
// BEFORE
function renderPermissionCard(data) {
  if (!focusedTabName) return  // (from Task 2)
  const stream = document.getElementById('detail-stream')
  if (!stream) return
  const existing = document.querySelector(
    `.perm-card[data-request-id="${CSS.escape(data.request_id)}"]`,
  )
  if (existing) return // idempotent
  ...

// AFTER
function renderPermissionCard(data, streamRoot) {
  if (!streamRoot) return
  const existing = streamRoot.querySelector(
    `.perm-card[data-request-id="${CSS.escape(data.request_id)}"]`,
  )
  if (existing) return // idempotent (per stream)
  ...
  // (rest of body uses `streamRoot` instead of `stream`)
}
```

The idempotency check now scopes to the stream root — that's correct, because each tab gets its own card with the same `data-request-id`, and `updatePermissionCardResolved` updates them all by selector.

- [ ] **Step 2: Fan out in the observer-WS handler**

Replace `dashboard.js:406-412`:

```javascript
// BEFORE
} else if (data.type === 'permission-request') {
  try {
    notif.onPermissionRequest(data.data || data)
  } catch (err) {
    console.error('[notifications] onPermissionRequest threw', err)
  }
  renderPermissionCard(data.data || data)

// AFTER
} else if (data.type === 'permission-request') {
  const payload = data.data || data
  try {
    notif.onPermissionRequest(payload)
  } catch (err) {
    console.error('[notifications] onPermissionRequest threw', err)
  }
  for (const tab of tabRegistry.values()) {
    if (tab.name === '') continue
    if (!tab.contentEl) continue
    if (tab.name !== payload.session) continue
    const streamRoot = scopedById(tab.contentEl, 'detail-stream')
    if (streamRoot instanceof HTMLElement) renderPermissionCard(payload, streamRoot)
  }
}
```

- [ ] **Step 3: `updatePermissionCardResolved` — verify it still works**

`dashboard.js:4441-4456` uses `document.querySelector` which finds only one card. With multiple tabs, multiple cards exist — change to `querySelectorAll`:

```javascript
// BEFORE
const card = document.querySelector(
  `.perm-card[data-request-id="${CSS.escape(data.request_id)}"]`,
)
if (!card) return
card.classList.remove('perm-card-pending')
card.classList.add('perm-card-resolved')
const actions = card.querySelector('.perm-card-actions')
if (actions) {
  actions.replaceChildren()
  ...
}

// AFTER
const cards = document.querySelectorAll(
  `.perm-card[data-request-id="${CSS.escape(data.request_id)}"]`,
)
if (cards.length === 0) return
for (const card of cards) {
  card.classList.remove('perm-card-pending')
  card.classList.add('perm-card-resolved')
  const actions = card.querySelector('.perm-card-actions')
  if (actions) {
    actions.replaceChildren()
    const status = document.createElement('span')
    status.className = 'perm-card-status perm-card-status-' + data.behavior
    status.textContent = data.behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    actions.appendChild(status)
  }
}
```

- [ ] **Step 4: Parse + test**

```bash
node --check dashboard/dashboard.js
bun test
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "fix(perm): fan permission cards into every matching tab + per-stream idempotency"
```

---

## Task 6: Move stream click handler into `wireTabFormHandlers`

**Files:**

- Modify: `dashboard/dashboard.js:3503-3547` — module-init stream click handler
- Modify: `dashboard/dashboard.js` — `wireTabFormHandlers(contentEl)` (locate via grep)

The module-init `document.getElementById('detail-stream').addEventListener('click', ...)` wires the hidden template's stream. Per-tab clones never receive a click handler, so copy buttons, code-copy buttons, view-agent navigation, and pl-entry navigation are all dead in the multi-tab world.

- [ ] **Step 1: Locate `wireTabFormHandlers`**

```bash
grep -n "function wireTabFormHandlers\|wireTabFormHandlers =" dashboard/dashboard.js
```

- [ ] **Step 2: Add the stream click handler inside `wireTabFormHandlers(contentEl)`**

Inside the function body (after the existing per-tab wiring), add:

```javascript
const clonedStream = scopedById(contentEl, 'detail-stream')
if (clonedStream) {
  clonedStream.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target)
    const btn = target.closest('.copy-btn')
    if (btn) {
      const src = btn.dataset.src
      if (src)
        navigator.clipboard.writeText(src).then(() => {
          btn.textContent = 'copied'
          setTimeout(() => {
            btn.textContent = 'copy raw'
          }, 1200)
        })
      return
    }
    const codeBtn = target.closest('.code-copy-btn')
    if (codeBtn) {
      const pre = codeBtn.parentElement.querySelector('pre')
      if (pre)
        navigator.clipboard.writeText(pre.textContent || '').then(() => {
          codeBtn.textContent = 'copied'
          setTimeout(() => {
            codeBtn.textContent = 'copy'
          }, 1200)
        })
      return
    }
    const viewAgentBtn = target.closest('.view-agent')
    if (viewAgentBtn && viewAgentBtn.dataset.agentId) {
      e.preventDefault()
      const tabName = contentEl.dataset.tabName || focusedTabName
      navigate({
        view: 'session-detail',
        sessionName: tabName,
        agentId: viewAgentBtn.dataset.agentId,
      })
      return
    }
    const pl = target.closest('.pl-entry')
    if (pl && pl.dataset.otherSession) {
      navigate({ view: 'session-detail', sessionName: pl.dataset.otherSession, agentId: null })
      return
    }
  })
}
```

- [ ] **Step 3: Delete the module-init handler**

Remove `dashboard.js:3503-3547` entirely (the `document.getElementById('detail-stream').addEventListener('click', (e) => { ... })` block).

- [ ] **Step 4: Parse + test**

```bash
node --check dashboard/dashboard.js
bun test
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "fix(tabs): wire stream click handler per-tab, not on hidden template"
```

---

## Task 7: Move header-action handlers into `wireTabFormHandlers`

**Files:**

- Modify: `dashboard/dashboard.js:885-891` — `detail-actions` (kebab) handler
- Modify: `dashboard/dashboard.js:3494-3501` — `detail-back` + `detail-drawer-toggle` handlers
- Modify: `dashboard/dashboard.js:4337-4343` — `detail-bell` handler
- Modify: `dashboard/dashboard.js` — `wireTabFormHandlers(contentEl)`

Same pattern as Task 6: these handlers are wired on the hidden template at module init. Move into per-tab wiring.

- [ ] **Step 1: Add header-action wiring inside `wireTabFormHandlers(contentEl)`**

After the stream click block from Task 6, add:

```javascript
// Back button
const backBtn = scopedById(contentEl, 'detail-back')
if (backBtn) {
  backBtn.addEventListener('click', () => {
    const stripBtn = document.querySelector('button[data-view="switchboard"]')
    if (stripBtn instanceof HTMLElement) stripBtn.click()
  })
}

// Drawer toggle (mobile sidebar)
const drawerBtn = scopedById(contentEl, 'detail-drawer-toggle')
const sidebar = scopedById(contentEl, 'detail-sidebar')
if (drawerBtn && sidebar) {
  drawerBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open')
  })
}

// Kebab menu
const actionsBtn = scopedById(contentEl, 'detail-actions')
if (actionsBtn) {
  actionsBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    const tabName = contentEl.dataset.tabName
    if (!tabName) return
    const r = actionsBtn.getBoundingClientRect()
    showSessionActionsMenu(tabName, r.left, r.bottom + 4)
  })
}

// Bell toggle
const bellEl = scopedById(contentEl, 'detail-bell')
if (bellEl) {
  bellEl.addEventListener('click', () => {
    const session = bellEl.getAttribute('data-session')
    if (!session) return
    handleBellClick(bellEl, session)
  })
}
```

- [ ] **Step 2: Delete the module-init handlers**

- Remove `dashboard.js:885-891` (kebab).
- Remove `dashboard.js:3494-3501` (back + drawer).
- Remove `dashboard.js:4337-4343` (bell).

- [ ] **Step 3: Parse + test**

```bash
node --check dashboard/dashboard.js
bun test
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "fix(tabs): wire detail header buttons per-tab (back/drawer/kebab/bell)"
```

---

## Task 8: Scope `setArchiveMode` and the iOS keyboard handler per-tab

**Files:**

- Modify: `dashboard/dashboard.js:70-80` — `focusin` handler
- Modify: `dashboard/dashboard.js:4197-4215` — visualViewport handler
- Modify: `dashboard/dashboard.js` — `setArchiveMode` (locate via grep)

These three call `document.getElementById('detail-stream')` — finds the hidden template. iOS keyboard scroll fix and archive banner handling silently no-op on the focused tab.

- [ ] **Step 1: Add a helper near the top of dashboard.js (after `currentTab()` declaration)**

```javascript
/**
 * Stream element of the currently focused session tab, or null on Switchboard / no clone.
 * @returns {HTMLElement | null}
 */
function focusedStream() {
  const tab = currentTab()
  if (!tab || tab.name === '' || !tab.contentEl) return null
  const el = scopedById(tab.contentEl, 'detail-stream')
  return el instanceof HTMLElement ? el : null
}
```

(If `focusedStream` already exists from earlier work, reuse it.)

- [ ] **Step 2: Update the `focusin` handler**

```javascript
// BEFORE (lines 70-80)
document.addEventListener('focusin', (e) => {
  const target = e.target
  if (!target || typeof target.closest !== 'function') return
  if (!target.closest('.detail-send')) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const stream = document.getElementById('detail-stream')
      if (stream) stream.scrollTop = stream.scrollHeight
    })
  })
})

// AFTER
document.addEventListener('focusin', (e) => {
  const target = e.target
  if (!target || typeof target.closest !== 'function') return
  if (!target.closest('.detail-send')) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const stream = focusedStream()
      if (stream) stream.scrollTop = stream.scrollHeight
    })
  })
})
```

- [ ] **Step 3: Update the visualViewport handler**

```javascript
// BEFORE (lines 4197-4215)
if (window.visualViewport) {
  const vv = window.visualViewport
  function updateViewportHeight() {
    const stream = document.getElementById('detail-stream')
    const bottomDist = stream ? stream.scrollHeight - stream.scrollTop - stream.clientHeight : null
    document.body.style.height = vv.height + 'px'
    if (stream && bottomDist !== null && bottomDist < 80) {
      requestAnimationFrame(() => {
        stream.scrollTop = stream.scrollHeight - stream.clientHeight
      })
    }
  }
  ...
}

// AFTER
if (window.visualViewport) {
  const vv = window.visualViewport
  function updateViewportHeight() {
    const stream = focusedStream()
    const bottomDist = stream ? stream.scrollHeight - stream.scrollTop - stream.clientHeight : null
    document.body.style.height = vv.height + 'px'
    if (stream && bottomDist !== null && bottomDist < 80) {
      requestAnimationFrame(() => {
        stream.scrollTop = stream.scrollHeight - stream.clientHeight
      })
    }
  }
  vv.addEventListener('resize', updateViewportHeight)
  vv.addEventListener('scroll', updateViewportHeight)
  updateViewportHeight()
}
```

- [ ] **Step 4: Locate `setArchiveMode`**

```bash
grep -n "function setArchiveMode\|setArchiveMode =" dashboard/dashboard.js
```

In its body, every `document.querySelector('.detail-send')` or `document.getElementById('archive-banner')` should resolve via `currentTab().contentEl`:

```javascript
const tab = currentTab()
if (!tab || !tab.contentEl) return
const sendForm = tab.contentEl.querySelector('.detail-send')
const banner = scopedById(tab.contentEl, 'archive-banner')
const bannerText = scopedById(tab.contentEl, 'archive-banner-text')
const bannerLink = scopedById(tab.contentEl, 'archive-back-link')
// ...remainder uses these scoped refs
```

Apply this pattern to every DOM lookup inside `setArchiveMode`. If the function is called with an explicit tab/session arg, use that instead of `currentTab()`.

- [ ] **Step 5: Parse + test**

```bash
node --check dashboard/dashboard.js
bun test
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "fix(tabs): scope iOS keyboard + archive-banner handlers to focused tab"
```

---

## Task 9: Service Worker — add vendor scripts to shell, await cache writes, remove dead `sw-routes.js`

**Files:**

- Modify: `dashboard/sw.js`
- Delete: `dashboard/sw-routes.js`
- Possibly modify: `dashboard/serve.ts` if it serves `/sw-routes.js` explicitly (verify with grep)
- Modify: any test referencing `sw-routes.js`

`sw.js` SHELL list omits `/vendor/marked.min.js` and `/vendor/purify.min.js`. Offline mode falls back to `<pre>` for every assistant turn because `renderMarkdownInto` throws when `marked`/`DOMPurify` are missing. The fetch handler also fires-and-forgets `cache.put`, racing first reload after install. `sw-routes.js` exists but is never `importScripts`'d — `notificationRouteFromData` lives duplicated in `sw.js:61-65`.

- [ ] **Step 1: Bump cache version**

`dashboard/sw.js:4`:

```javascript
const CACHE_NAME = 'party-line-shell-v6'
```

- [ ] **Step 2: Add vendor scripts to SHELL**

`dashboard/sw.js:6-17`:

```javascript
const SHELL = [
  '/',
  '/index.html',
  '/dashboard.css',
  '/dashboard.js',
  '/notifications.js',
  '/tabs-state.js',
  '/transcript-grouping.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/vendor/marked.min.js',
  '/vendor/purify.min.js',
]
```

- [ ] **Step 3: Await the cache write inside the fetch handler**

`dashboard/sw.js:38-54`:

```javascript
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET') return
  if (!SHELL.includes(url.pathname)) return
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(event.request)
        if (res && res.ok) {
          const cache = await caches.open(CACHE_NAME)
          await cache.put(event.request, res.clone())
        }
        return res
      } catch {
        const cached = await caches.match(event.request)
        return cached || Response.error()
      }
    })(),
  )
})
```

- [ ] **Step 4: Delete `dashboard/sw-routes.js`**

```bash
git rm dashboard/sw-routes.js
```

- [ ] **Step 5: Verify nothing else references it**

```bash
grep -rn "sw-routes" --include='*.js' --include='*.ts' --include='*.html'
```

If any test file (e.g., `tests/pwa-shell.test.ts`) imports it, update the test to import from `dashboard/sw.js` directly OR delete the test if it was only validating the duplicate. If `dashboard/serve.ts` has an explicit route, remove it.

- [ ] **Step 6: Verify tests still pass**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/sw.js dashboard/serve.ts tests/
git commit -m "fix(sw): add vendor scripts to shell, await cache writes, remove dead sw-routes.js"
```

---

## Task 10: Snapshot revision merge + reconnect re-prefetch

**Files:**

- Modify: `dashboard/dashboard.js:980-1001` — `handleSessionsSnapshot`
- Modify: `dashboard/dashboard.js:964-975` — `updateSessions` (the prefetch gate)

Today `handleSessionsSnapshot` calls `sessionRevisions.clear()` before reseeding. After a reconnect, deltas applied during the gap can have higher revisions than the snapshot — clearing means a stale snapshot revision wins and subsequent valid deltas are dropped. Also, `prefetchAllPinnedTabs()` only runs on the first snapshot — tabs evicted by LRU during a reconnect window stay empty.

- [ ] **Step 1: Merge revisions in `handleSessionsSnapshot`**

```javascript
// BEFORE (lines 995-998)
sessionRevisions.clear()
sessions.forEach(function (s) {
  sessionRevisions.set(s.name, s.revision)
})

// AFTER
sessions.forEach(function (s) {
  const prior = sessionRevisions.has(s.name) ? sessionRevisions.get(s.name) : -1
  sessionRevisions.set(s.name, Math.max(prior, s.revision))
})
// Note: we intentionally do NOT delete entries for sessions absent from the snapshot.
// A session that just disconnected may not appear, but its revision is still meaningful
// for future deltas after it reconnects.
```

- [ ] **Step 2: Re-run `prefetchAllPinnedTabs` on reconnect**

Find the `connect()` reconnect path:

```bash
grep -n "function connect\|sessionsReady" dashboard/dashboard.js
```

Currently `dashboard.js:964-975` gates prefetch on the first snapshot via `if (!sessionsReady)`. After a disconnect, `sessionsReady` should reset, OR the prefetch should run on every snapshot for tabs that have `dataset.loaded !== 'true'`.

Simpler fix: in the WS `onclose` (find via `grep -n "onclose\|ws.addEventListener('close'" dashboard/dashboard.js`), set `sessionsReady = false` so the next snapshot re-arms prefetch.

```javascript
// In the WS onclose handler, add:
sessionsReady = false
```

- [ ] **Step 3: Verify prefetch is idempotent**

`prefetchAllPinnedTabs()` should already skip tabs with `dataset.loaded === 'true'`. Verify by reading its body — if not, add the guard. The implementer should grep:

```bash
grep -n "function prefetchAllPinnedTabs\|prefetchAllPinnedTabs =" dashboard/dashboard.js
```

and confirm the implementation skips already-loaded tabs.

- [ ] **Step 4: Parse + test**

```bash
node --check dashboard/dashboard.js
bun test
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "fix(observer): merge snapshot revisions; re-prefetch on reconnect"
```

---

## Task 11: Delete confirmed-dead helpers and the legacy `appendEnvelopeToStream`

**Files:**

- Modify: `dashboard/dashboard.js`

After Tasks 1-10 land, several functions and globals are confirmed unreferenced. Delete them in one focused commit so the file shrinks before PR 5's broader cleanup.

- [ ] **Step 1: Confirm no remaining callers for each candidate**

For each name below, run:

```bash
grep -n "<name>" dashboard/dashboard.js
```

Candidates (from the audit report, items already confirmed dead):

- `appendEnvelopeToStream` (the legacy single-tab path, `dashboard.js:1820-1865`) — only the per-tab `appendEnvelopeToStreamForTab` is used now.
- `selectedAgentId` declaration at `dashboard.js:189` (read sites at 2421-2453 are inside the agent-tree click handlers; verify those reads now use `tab.agentId` after Task 2; if any still read `selectedAgentId`, keep them in scope and delete the declaration last).
- `selectedArchiveUuid` at `dashboard.js:190` — declared but never assigned (the audit confirmed this).
- `historyBuffer` at `dashboard.js:192` — declared, never read.
- `pressCard` undeclared global write at `dashboard.js:838` — delete the assignment line.

If any candidate still has live readers, **do not delete it** — flag it in the commit message and let PR 5 clean it up after deeper investigation.

- [ ] **Step 2: Delete each confirmed-dead item**

For each, remove the declaration AND every reference. Re-run the grep after each delete to confirm zero hits.

- [ ] **Step 3: Parse + test**

```bash
node --check dashboard/dashboard.js
bun test
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "chore(dashboard): delete dead single-tab helpers (appendEnvelopeToStream, etc.)"
```

---

## Task 12: Document #17 (persist-then-route at-most-once) in SPEC.md

**Files:**

- Modify: `SPEC.md`

User decision (this session): Option A — at-most-once delivery, documented and accepted.

- [ ] **Step 1: Add a section to SPEC.md**

Locate the "Wire Protocol" or "Key Design Decisions" section and append (or add to the latter):

```markdown
### Delivery semantics

Envelope delivery is **at-most-once**. The switchboard inserts each envelope into SQLite _before_ fanning out to recipient WebSocket clients. If the dashboard process dies, restarts, or a recipient is disconnected mid-route, the envelope persists in `messages` but is not retried — the recipient will not see it via WebSocket on reconnect. Sessions can query `/ccpl/history` (or the dashboard `/api/transcript`) to backfill missed envelopes by id.

This trade-off was made because (a) the dashboard rarely restarts in practice and (b) inter-agent messaging is a small fraction of dashboard traffic. If higher reliability becomes important, the natural extension is per-session `last_seen_id` tracking with a SELECT-and-replay step inside the `hello` handler.
```

- [ ] **Step 2: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): document at-most-once envelope delivery semantics"
```

---

## Final verification

After all tasks complete, on the `pr1-finish-tab-refactor` branch:

- [ ] **Step 1: Full test suite**

```bash
bun test
```

Expected: pass count matches or exceeds the Task 0 baseline.

- [ ] **Step 2: Parse check**

```bash
node --check dashboard/dashboard.js
```

- [ ] **Step 3: Manual smoke (controller does this — not the implementer)**

The controller (main session) will perform the manual smoke after all tasks merge. Implementer's job ends at Task 12 commit. Smoke checklist for the controller:

1. Refresh dashboard. Switchboard renders with session cards.
2. Click into a session — tab opens, transcript loads, header populates.
3. Click into a second session — tab opens, transcript loads. First tab still in strip.
4. In session 1: paste an image → chip appears in session 1's composer ONLY.
5. Switch to session 2. Composer shows no chips (session 1's stay).
6. In session 2: type a message + Send. Message lands in session 2.
7. Switch back to session 1. Image chip still there. Send. Image lands in session 1.
8. Trigger a tool that requires permission in any open session. Card appears in that session's tab. Clicking Allow/Deny resolves it; switching to another tab and back, the resolved state persists.
9. Click the kebab (⋯) on a session tab. Menu appears.
10. Click the bell on a session detail. Permission flow (or toggle) fires correctly.
11. Click the back button (`‹`) on a session tab. Returns to Switchboard.
12. Toggle the drawer (`≡`) on mobile width. Sidebar opens/closes.
13. Open the dashboard offline (DevTools → Application → Service Worker → Offline). Markdown renders correctly (vendor scripts cached).
14. Disconnect the WebSocket (DevTools → Network → throttle to Offline briefly, then back). On reconnect, all open tabs still show transcripts; no blank states.
15. Open a session that triggers a notification banner state change. Banner text updates (Task 3 fix).

If all 15 pass, the PR is ready to merge.

- [ ] **Step 4: Open PR**

```bash
git push -u origin pr1-finish-tab-refactor
gh pr create --title "PR 1 — Finish the tab refactor" --body "$(cat <<'EOF'
## Summary
- Eliminates dead `selectedSessionId` global and routes lookups through `focusedTabName` / `currentTab()`
- Per-tab `pendingAttachments` so paste in one tab no longer leaks into another
- Fans permission cards into every matching tab; `updatePermissionCardResolved` updates them all
- Moves stream click + header-action handlers (back, drawer, kebab, bell) into `wireTabFormHandlers` so per-tab clones receive them
- Scopes iOS keyboard + archive-banner handlers to the focused tab
- SW shell now caches vendor markdown libs; cache write is awaited; dead `sw-routes.js` removed
- Snapshot revision logic merges instead of clearing; reconnect re-arms prefetch
- Documents at-most-once envelope delivery in SPEC.md

## Test plan
- [ ] `bun test` green
- [ ] `node --check dashboard/dashboard.js` clean
- [ ] Manual smoke per `docs/superpowers/plans/2026-04-27-pr1-finish-tab-refactor.md` (15 checks)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes for the implementer

- **Do not** convert this plan into a different task ordering. Tasks build on each other (Task 1 fixes `currentView` so Task 2's replacements line up; Task 4-7 need Task 1+2 done first; etc.).
- **Do not** widen scope. Each task should produce only the change described. PR 5 will sweep DRY/dead code more broadly — leave that work alone here.
- If `node --check` fails, you missed a reference. `grep` the missing identifier before re-running tests.
- If `bun test` regresses, the failing test name tells you which file to inspect. Don't push past a regression.
- Commit at the end of every task. Do not bundle commits.
