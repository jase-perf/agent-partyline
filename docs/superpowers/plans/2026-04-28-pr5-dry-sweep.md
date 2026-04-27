# PR5 — DRY + Dead Code Sweep

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dead code and fix five minor inconsistencies identified in the multi-reviewer audit: dead `wireDetailSend` IIFE, per-tab `selectedAgentId` migration, `getSessionByToken` unsafe removal, `'invalid JSON'` error-code typo, missing `Allow` headers on 405s, dead `presence.ts`, dead `serialize`/`deserialize` in `protocol.ts`, unused `MessageType` variants.

**Architecture:** Pure deletion + targeted fixes. No new tables, no wire-protocol changes, no new abstractions. Tasks are ordered from smallest to largest risk.

**Tech Stack:** TypeScript/Bun, vanilla JS (dashboard.js)

---

## File Map

| File                          | Change                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `src/storage/ccpl-queries.ts` | Delete `getSessionByToken` (no callers)                                                       |
| `dashboard/serve.ts`          | Fix `'invalid JSON'` typo; add `Allow` header to all 405 responses                            |
| `src/protocol.ts`             | Delete `serialize` / `deserialize` (no callers)                                               |
| `src/types.ts`                | Remove `'status'` and `'announce'` from `MessageType`; remove `'heartbeat'` + its dead filter |
| `src/presence.ts`             | Delete file (no callers)                                                                      |
| `src/server.ts`               | Remove dead heartbeat filter now that `'heartbeat'` is removed                                |
| `dashboard/dashboard.js`      | Delete `wireDetailSend` IIFE; migrate `selectedAgentId` global → per-Tab                      |

---

### Task 1: Tiny TS fixes — getSessionByToken, invalid_json, Allow header

Three independent one-liner fixes in TypeScript files.

**Files:**

- Modify: `src/storage/ccpl-queries.ts`
- Modify: `dashboard/serve.ts`

- [ ] **Step 1: Verify getSessionByToken has no external callers**

```bash
grep -rn "getSessionByToken" /home/claude/projects/claude-party-line/src/ /home/claude/projects/claude-party-line/dashboard/ --include="*.ts" | grep -v "ccpl-queries.ts"
```

Expected: no output. If any callers exist, DO NOT delete the function — report NEEDS_CONTEXT.

Also check tests:

```bash
grep -rn "getSessionByToken" /home/claude/projects/claude-party-line/tests/ --include="*.ts"
```

- [ ] **Step 2: Delete getSessionByToken from ccpl-queries.ts**

Read the file to find the function:

```bash
grep -n "getSessionByToken" /home/claude/projects/claude-party-line/src/storage/ccpl-queries.ts
```

Delete the entire `getSessionByToken` function (from its export line to its closing brace). Do NOT delete `findSessionByTokenSafe` — that's the timing-safe replacement that IS used.

- [ ] **Step 3: Fix 'invalid JSON' typo in serve.ts**

Find the inconsistent error code:

```bash
grep -n "invalid JSON\b" /home/claude/projects/claude-party-line/dashboard/serve.ts
```

Expected: one line with `'invalid JSON'`. Change it to `'invalid_json'` to match all other error codes in the file.

- [ ] **Step 4: Add Allow headers to all 405 responses in serve.ts**

Find all 405 responses:

```bash
grep -n "status: 405" /home/claude/projects/claude-party-line/dashboard/serve.ts
```

For each `new Response('Method Not Allowed', { status: 405 })`, add `headers: { Allow: 'GET' }` if the guard is `req.method !== 'GET'`, or `Allow: 'POST'` if it's `!== 'POST'`, etc.

The pattern to replace (for GET-only routes):

```ts
// Before:
return new Response('Method Not Allowed', { status: 405 })
// After:
return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } })
```

Check each 405 site: what method is it guarding against? Most are `!== 'GET'`. Some may be `!== 'POST'` or `!== 'DELETE'`. Match the `Allow` header to the allowed method.

Use replace_all only if all instances are the same pattern. If mixed, edit each individually.

- [ ] **Step 5: Run tests + type check**

```bash
cd /home/claude/projects/claude-party-line && bun test 2>&1 | tail -5
bun run tsc --noEmit 2>&1 | head -10
```

Expected: 358 pass, no type errors.

- [ ] **Step 6: Check tests that import getSessionByToken**

If any tests still import `getSessionByToken` after deletion, update them to use `findSessionByTokenSafe` or remove the test if it was testing the unsafe function specifically.

- [ ] **Step 7: Commit**

```bash
cd /home/claude/projects/claude-party-line && git add src/storage/ccpl-queries.ts dashboard/serve.ts tests/
git commit -m "fix: remove unsafe getSessionByToken; fix invalid_json typo; add Allow headers to 405s"
```

---

### Task 2: Dead code — presence.ts, protocol.ts UDP, MessageType variants

Remove files and functions that have no callers since the UDP multicast architecture was retired.

**Files:**

- Delete: `src/presence.ts`
- Modify: `src/protocol.ts` (delete `serialize` and `deserialize`)
- Modify: `src/types.ts` (remove `'status'`, `'announce'`, `'heartbeat'` from `MessageType`)
- Modify: `src/server.ts` (remove dead heartbeat filter)

- [ ] **Step 1: Verify presence.ts has no importers**

```bash
grep -rn "from.*presence\|import.*presence" /home/claude/projects/claude-party-line/src/ /home/claude/projects/claude-party-line/dashboard/ --include="*.ts"
```

Expected: no output (just a comment in queries.ts). If imported, report NEEDS_CONTEXT.

- [ ] **Step 2: Delete src/presence.ts**

```bash
rm /home/claude/projects/claude-party-line/src/presence.ts
```

- [ ] **Step 3: Verify serialize/deserialize have no callers**

```bash
grep -rn "\bserialize\b\|\bdeserialize\b" /home/claude/projects/claude-party-line/src/ /home/claude/projects/claude-party-line/dashboard/ --include="*.ts" | grep -v "protocol.ts"
```

Expected: no output. If callers exist, report NEEDS_CONTEXT.

- [ ] **Step 4: Delete serialize and deserialize from src/protocol.ts**

Read the file:

```bash
cat -n /home/claude/projects/claude-party-line/src/protocol.ts
```

Delete the two functions (`serialize` and `deserialize`) and their JSDoc comments. Keep `generateId`, `generateCallbackId`, and `createEnvelope`.

Also remove the `import type { Envelope, MessageType } from './types.js'` import if `Envelope` is no longer used after deleting the two functions. Keep `MessageType` import if `createEnvelope` still uses it.

- [ ] **Step 5: Remove unused MessageType variants from src/types.ts**

Read the current `MessageType`:

```bash
grep -n "MessageType\|'status'\|'announce'\|'heartbeat'" /home/claude/projects/claude-party-line/src/types.ts
```

Remove `| 'status'`, `| 'announce'`, and `| 'heartbeat'` from the union type. The remaining values should be:

```ts
export type MessageType =
  | 'message'
  | 'request'
  | 'response'
  | 'permission-request'
  | 'permission-response'
```

- [ ] **Step 6: Remove dead heartbeat filter from src/server.ts**

Find the filter:

```bash
grep -n "heartbeat" /home/claude/projects/claude-party-line/src/server.ts
```

The line `const filtered = messageHistory.filter((m) => m.type !== 'heartbeat')` filters out heartbeat messages. Since `'heartbeat'` is no longer in `MessageType`, this filter is dead (no heartbeats will ever be in the array). Remove it and use `messageHistory` directly, or if `filtered` is used downstream, change `filtered` to `messageHistory`.

Read the context around that line:

```bash
sed -n '890,900p' /home/claude/projects/claude-party-line/src/server.ts
```

- [ ] **Step 7: Run tests + type check**

```bash
cd /home/claude/projects/claude-party-line && bun test 2>&1 | tail -5
bun run tsc --noEmit 2>&1 | head -20
```

Fix any type errors from the MessageType removal (e.g., if any code compares `.type === 'heartbeat'` that would now be a dead-branch error in strict mode).

- [ ] **Step 8: Commit**

```bash
cd /home/claude/projects/claude-party-line && git add src/presence.ts src/protocol.ts src/types.ts src/server.ts
git commit -m "chore: delete presence.ts; remove UDP serialize/deserialize; trim dead MessageType variants"
```

---

### Task 3: dashboard.js — wireDetailSend deletion + selectedAgentId per-Tab

Two JavaScript changes in `dashboard/dashboard.js`. Read the file before editing.

**Files:**

- Modify: `dashboard/dashboard.js`

#### Part A: Delete wireDetailSend IIFE

The IIFE at the bottom of the file (starting with `;(function wireDetailSend()`) wires event handlers on the hidden template elements (`document.getElementById('detail-send-msg')` etc). Since PR1 moved all per-tab wiring into `wireTabFormHandlers(contentEl)`, this IIFE is dead — it wires the invisible prototype copy that's never interacted with.

Also remove the `document.getElementById('detail-send-msg')` fallback from `autosizeDetailSend`.

- [ ] **Step 1: Find and delete wireDetailSend**

```bash
grep -n "wireDetailSend\|function wireDetailSend" /home/claude/projects/claude-party-line/dashboard/dashboard.js
```

Expected: two hits — the comment and the IIFE start. Read from the comment line to the closing `})()`:

```bash
sed -n '3215,3295p' /home/claude/projects/claude-party-line/dashboard/dashboard.js
```

Delete from the comment `// Wire textarea behaviors once...` through the `})()` that ends the IIFE. Verify the lines after the IIFE start with `// --- History view ---` so the deletion boundary is clear.

- [ ] **Step 2: Remove the document.getElementById fallback in autosizeDetailSend**

Find `autosizeDetailSend`:

```bash
grep -n "autosizeDetailSend\|detail-send-msg" /home/claude/projects/claude-party-line/dashboard/dashboard.js | head -10
```

The function currently:

```js
function autosizeDetailSend(ta) {
  const el = ta || document.getElementById('detail-send-msg')
  if (!el) return
  ...
}
```

After deleting the IIFE, this fallback is dead (all callers pass an explicit `ta`). Change to:

```js
function autosizeDetailSend(ta) {
  if (!ta) return
  ta.style.height = 'auto'
  ...
}
```

Replace `el` with `ta` throughout the function body (there should be 2-3 uses).

#### Part B: Migrate selectedAgentId to per-Tab

The global `let selectedAgentId = null` (line ~202) must move to the `Tab` object so each tab has independent agent selection.

- [ ] **Step 3: Add selectedAgentId to Tab initialization**

Find where `Tab` objects are created (search for `tabRegistry.set` or the Tab constructor pattern):

```bash
grep -n "tabRegistry.set\|contentEl:\|pendingAttachments" /home/claude/projects/claude-party-line/dashboard/dashboard.js | head -20
```

In the tab creation code, add `selectedAgentId: null` to each Tab object literal (there may be 2-3 places that create Tab objects).

- [ ] **Step 4: Delete the global declaration**

Remove line ~202: `let selectedAgentId = null`

- [ ] **Step 5: Replace all reads and writes**

There are 9 usages of `selectedAgentId`. Read each in context and replace:

```bash
grep -n "selectedAgentId" /home/claude/projects/claude-party-line/dashboard/dashboard.js
```

For each:

**Line ~1771** (inside `for (const tab of tabRegistry.values())` loop with `tab.name === focusedTabName`):

```js
// Before:
const agentMatches = selectedAgentId && sessionId === selectedAgentId
// After:
const agentMatches = tab.selectedAgentId && sessionId === tab.selectedAgentId
```

`tab` is already in scope from the for-loop.

**Line ~2129** (inside `loadSessionDetailView`):

```js
// Before:
const agentId = opts.agentId ?? selectedAgentId
// After:
const agentId =
  opts.agentId ??
  (focusedTabName ? (tabRegistry.get(focusedTabName)?.selectedAgentId ?? null) : null)
```

**Line ~2339** (inside `renderAgentTree`, reads `selectedAgentId` to mark 'main' active):

```js
// Before:
if (!selectedAgentId) mainLi.classList.add('active')
// After:
const currentAgentId = focusedTabName
  ? (tabRegistry.get(focusedTabName)?.selectedAgentId ?? null)
  : null
if (!currentAgentId) mainLi.classList.add('active')
```

**Line ~2341** (inside click handler for 'main' row):

```js
// Before:
selectedAgentId = null
// After:
const tab = tabRegistry.get(focusedTabName)
if (tab) tab.selectedAgentId = null
```

**Line ~2373** (check if selectedAgentId is in completed group):

```js
// Before:
if (selectedAgentId && completed.some((sa) => sa.agent_id === selectedAgentId)) {
// After:
if (currentAgentId && completed.some((sa) => sa.agent_id === currentAgentId)) {
```

(reuse `currentAgentId` defined above)

**Line ~2405** (inside `buildAgentLi`):

```js
// Before:
if (selectedAgentId === sa.agent_id) li.classList.add('active')
// After:
const activeAgentId = focusedTabName
  ? (tabRegistry.get(focusedTabName)?.selectedAgentId ?? null)
  : null
if (activeAgentId === sa.agent_id) li.classList.add('active')
```

**Line ~2408** (click handler in `buildAgentLi` — sets the selected agent):

```js
// Before:
selectedAgentId = sa.agent_id
// After:
const tab = tabRegistry.get(focusedTabName)
if (tab) tab.selectedAgentId = sa.agent_id
```

**Line ~2479** (second `loadSessionDetailView` or similar):
Same pattern as line ~2129 — check context and apply same fix.

- [ ] **Step 6: Verify no remaining references**

```bash
grep -n "selectedAgentId" /home/claude/projects/claude-party-line/dashboard/dashboard.js
```

Expected: no output.

- [ ] **Step 7: Run the full test suite**

```bash
cd /home/claude/projects/claude-party-line && bun test 2>&1 | tail -5
```

Expected: same count as before (dashboard.js changes don't add new tests; the JS is not unit-tested directly). If tests drop, investigate.

- [ ] **Step 8: Commit**

```bash
cd /home/claude/projects/claude-party-line && git add dashboard/dashboard.js
git commit -m "fix(dashboard): delete wireDetailSend IIFE; migrate selectedAgentId to per-tab"
```

---

## Final Steps

After all 3 tasks committed:

- [ ] **Full test suite**

```bash
bun test 2>&1 | tail -5
```

Expected: ≥358 tests pass, 0 fail.

- [ ] **TypeScript check**

```bash
bun run tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Merge and push**

```bash
git checkout main
git merge pr5-dry-sweep --no-ff -m "chore: merge pr5-dry-sweep — DRY + dead code sweep"
git push
```
