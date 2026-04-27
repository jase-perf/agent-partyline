# PR 2 — Security Hygiene

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the security hygiene gaps surfaced by the code review: timing-unsafe token compare, missing CSRF protection on state-changing routes, unhandled JSON parse errors that crash request loops, missing HTTP method gates, non-atomic CLI token write, and an unbounded permission-bridge pending map.

**Architecture:**

- `getSessionByToken` keeps its current SQL `WHERE token = ?` lookup, but the token compare moves to userland with `crypto.timingSafeEqual` after fetching candidate rows by name OR returning a "not found" indistinguishable from "found-but-mismatch" via a constant-time compare. Simpler path: introduce `findSessionByTokenSafe(db, token)` that fetches all sessions, compares each token in constant time, returns the match. With ≤ ~100 sessions in practice, the cost is negligible.
- CSRF: dashboard cookie stays `SameSite=Lax` (deliberate, for installed-PWA launch). Add an `Origin` (or `Referer` fallback) check to all cookie-authed POST/DELETE handlers via a helper.
- JSON parse safety: every `await req.json()` for a JSON body wraps in try/catch returning 400 `invalid_json`.
- Method gate: every route handler checks `req.method` before dispatching.
- CLI token write: `writeFileSync('<name>.token.tmp', ...)` then `renameSync` to the final path — atomic on POSIX.
- Permission-bridge: pending map gets a per-entry TTL (5 minutes) and a hard cap (256 entries) to bound memory.

**Excluded from this PR (reasoning inline):**

- **Quota poller (#11)**: probed live; both `x-api-key: <oauth_token>` and `Authorization: Bearer` return 200 with valid headers. Current code works. The "burns real quota" concern is real but `max_tokens: 1` is negligible.
- **PARTY_LINE_TOKEN env leak to grandchildren (part of #16)**: this would require the MCP plugin to resolve the token from a stable file path at startup instead of reading `process.env.PARTY_LINE_TOKEN`. That's a plugin-loader change with its own test surface; defer to PR 5 (DRY/cleanup) or its own PR.
- **`/ccpl/register` rate limit (#23)**: defer to PR 3 (transport reliability) where rate limiting fits more naturally.

**Tech Stack:** TypeScript (strict), Bun runtime, `node:crypto` for `timingSafeEqual`, `bun:test` for tests.

---

## Branch + verification commands

All tasks run on `pr2-security-hygiene` (created in Task 0). Verification commands:

- `bun test` — full suite (baseline 338 / 0)
- `bunx tsc --noEmit -p .` — strict type check (if the project uses one — verify in Task 0)
- `node --check dashboard/dashboard.js` — frontend parse (only relevant for tasks that touch dashboard.js, which PR 2 doesn't)

---

## Task 0: Branch + baseline

**Files:** none.

- [ ] **Step 1: Branch**

```bash
git status
git checkout -b pr2-security-hygiene
```

Expected: clean tree (only `bin/ccpl.ts` was committed in PR 1's tail, no other dirt).

- [ ] **Step 2: Baseline**

```bash
bun test 2>&1 | tail -5
```

Record pass/fail count. Should be `338 pass / 0 fail`.

---

## Task 1: Timing-safe token compare

**Files:**

- Modify: `src/storage/ccpl-queries.ts` — add `findSessionByTokenSafe`
- Modify: `src/server/switchboard.ts:215` — `getSessionByToken` → `findSessionByTokenSafe`
- Modify: `src/server/ccpl-api.ts:50` — same swap inside `authBearer`
- Test: `tests/ccpl-queries.test.ts` — new test for the safe variant
- Test: `tests/ccpl-api.test.ts` — assert wrong-token returns 401 in constant-ish time (smoke; can't truly test timing in JS)

`getSessionByToken(db, token)` runs `SELECT * FROM ccpl_sessions WHERE token = ?`. SQLite's string compare short-circuits on the first byte difference — leaks length/prefix via timing. Replace with a userland constant-time compare against all rows.

- [ ] **Step 1: Add `findSessionByTokenSafe` helper**

In `src/storage/ccpl-queries.ts`, after `getSessionByToken` (around line 76):

```typescript
import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time token lookup. Fetches every row's token and compares with
 * timingSafeEqual; defeats the timing side-channel that SQL `WHERE token = ?`
 * leaks. With O(N) rows in practice, the cost is negligible.
 *
 * Returns null on no-match — caller cannot distinguish "no such token" from
 * "valid format but unknown" by timing.
 */
export function findSessionByTokenSafe(db: Database, token: string): CcplSessionRow | null {
  const candidate = Buffer.from(token)
  // Fetch all (name, token) pairs, then re-fetch the row by name on match.
  // We can't compare hex strings of different lengths with timingSafeEqual,
  // so we pre-pad to a fixed length (token is always 64 chars hex from
  // generateToken; if a stored row has a different length, it's not a match).
  const rows = db.query(`SELECT name, token FROM ccpl_sessions`).all() as {
    name: string
    token: string
  }[]
  let matchName: string | null = null
  for (const row of rows) {
    const stored = Buffer.from(row.token)
    if (stored.length !== candidate.length) continue
    if (timingSafeEqual(stored, candidate)) matchName = row.name
    // do NOT break — keep iterating to keep the timing constant w.r.t. position
  }
  if (!matchName) return null
  return getSessionByName(db, matchName)
}
```

- [ ] **Step 2: Write a failing test**

Add to `tests/ccpl-queries.test.ts`:

```typescript
import { findSessionByTokenSafe, registerSession } from '../src/storage/ccpl-queries'

test('findSessionByTokenSafe returns row on exact match', () => {
  const db = openTestDb() // existing helper in this test file
  const row = registerSession(db, 'alice', '/tmp')
  const found = findSessionByTokenSafe(db, row.token)
  expect(found?.name).toBe('alice')
})

test('findSessionByTokenSafe returns null on mismatch', () => {
  const db = openTestDb()
  registerSession(db, 'alice', '/tmp')
  expect(findSessionByTokenSafe(db, 'a'.repeat(64))).toBe(null)
})

test('findSessionByTokenSafe returns null on length mismatch', () => {
  const db = openTestDb()
  registerSession(db, 'alice', '/tmp')
  expect(findSessionByTokenSafe(db, 'short')).toBe(null)
})
```

- [ ] **Step 3: Run failing test**

```bash
bun test tests/ccpl-queries.test.ts
```

Expected: 3 new failures (function doesn't exist yet — but you wrote the function in Step 1; if Step 1 was applied, expect 3 passes).

- [ ] **Step 4: Swap call sites**

`src/server/switchboard.ts:215`:

```typescript
// BEFORE
const row = getSessionByToken(db, frame.token)
// AFTER
const row = findSessionByTokenSafe(db, frame.token)
```

`src/server/ccpl-api.ts:48-51`:

```typescript
// BEFORE
function authBearer(req: Request, db: Database): { name: string } | null {
  const token = req.headers.get('x-party-line-token')
  if (!token) return null
  const row = getSessionByToken(db, token)
  return row ? { name: row.name } : null
}
// AFTER
function authBearer(req: Request, db: Database): { name: string } | null {
  const token = req.headers.get('x-party-line-token')
  if (!token) return null
  const row = findSessionByTokenSafe(db, token)
  return row ? { name: row.name } : null
}
```

Don't delete `getSessionByToken` — it may be referenced in tests. `grep -n "getSessionByToken" .` to confirm; remove if dead.

- [ ] **Step 5: Update import in switchboard.ts**

Add `findSessionByTokenSafe` to the import at the top of `src/server/switchboard.ts`. Same in `src/server/ccpl-api.ts`.

- [ ] **Step 6: Run full test suite**

```bash
bun test
```

Expected: 338 + 3 = 341 pass / 0 fail (or whatever the new count is — must be ≥ baseline + new tests).

- [ ] **Step 7: Commit**

```bash
git add src/storage/ccpl-queries.ts src/server/switchboard.ts src/server/ccpl-api.ts tests/ccpl-queries.test.ts
git commit -m "fix(auth): timing-safe token compare via findSessionByTokenSafe"
```

---

## Task 2: JSON parse safety on POST/DELETE handlers

**Files:**

- Modify: `dashboard/serve.ts` — wrap unguarded `await req.json()` calls

The reviewer flagged `serve.ts:693-719, 795-840` as crashing on malformed JSON. Audit the file: `/login`, `/api/permission-response`, `/ccpl/archive` already handle this via `.catch(() => ({}))` or try/catch. The unguarded ones need the same treatment.

- [ ] **Step 1: Enumerate unguarded `await req.json()` calls**

```bash
grep -n "await req.json()" dashboard/serve.ts
```

For each hit, look ~3 lines above and below to determine if it's already inside a try/catch. List the unguarded ones.

Expected unguarded sites (per reviewer): inside `/api/overrides POST` (~line 693), `/api/overrides DELETE` (~line 707), `/api/send POST` (~line 795). Verify by reading.

- [ ] **Step 2: Wrap each in try/catch returning 400**

Pattern (use this for every site):

```typescript
let body: { ... }
try {
  body = (await req.json()) as { ... }
} catch {
  return new Response(JSON.stringify({ error: 'invalid_json' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

If `serve.ts` already has a `json(body, status)` helper (it does, in `src/server/ccpl-api.ts` — but `serve.ts` may not import it), use it. Otherwise the inline `Response` form above is fine.

- [ ] **Step 3: Add a regression test**

Add to `tests/ccpl-api.test.ts` (or a new `tests/serve-json-safety.test.ts` — use whichever is closer to the routing layer; `serve.ts` is hard to test in isolation, so `tests/ccpl-api.test.ts` may not work. If creating a new test file, prefer testing `handleDashboardArchive`/`handleDashboardRemove` style helpers if you can extract one for `/api/overrides` and `/api/send`. If extraction is too invasive, mark this as DONE_WITH_CONCERNS and skip the test.)

For each unguarded site, the test should POST/DELETE with `Content-Type: application/json` and an empty body, expect 400.

- [ ] **Step 4: Run tests**

```bash
bun test
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/serve.ts tests/
git commit -m "fix(serve): JSON-parse-safe POST/DELETE handlers — 400 instead of throw"
```

---

## Task 3: HTTP method gate on routes

**Files:**

- Modify: `dashboard/serve.ts` — add `req.method` check on routes that match path-only

Reviewer flagged `serve.ts:662, 687, 722, 769, 914, 923, 935, 991, 997, 1002` (and also `/api/quota`, `/api/sparkline`, `/api/self`, `/api/machines`) — most of these match pathname only; a `DELETE /api/history` would run the SELECT and return 200.

- [ ] **Step 1: Enumerate path-only routes**

```bash
grep -n "if (url.pathname ===" dashboard/serve.ts | grep -v "req.method"
```

List the hits. Each is a route that should also gate on `req.method`.

- [ ] **Step 2: For each, add the method check**

Pattern:

```typescript
// BEFORE
if (url.pathname === '/api/sessions') {
  // ... GET handler body
}

// AFTER
if (url.pathname === '/api/sessions') {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
  // ... GET handler body
}
```

For routes that legitimately accept multiple methods, gate them as a set:

```typescript
if (req.method !== 'GET' && req.method !== 'HEAD') ...
```

For static-asset routes (`/sw.js`, `/manifest.json`, `/favicon.ico`, `/icons/*`, `/vendor/*`, `/dashboard.js`, etc.) — gate on GET only.

- [ ] **Step 3: Add a smoke test**

Add to a new `tests/serve-method-gate.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test'
// (Use the existing test harness pattern for serve.ts — if there isn't one,
//  this test may need to start a real server. If too invasive, document and skip.)
```

If `serve.ts` doesn't have a unit-test harness (most likely — it's a top-level script), an integration test would require booting Bun.serve, which is heavy. Acceptable to skip the test and verify manually via:

```bash
curl -X DELETE http://localhost:3400/api/history  # should return 405
```

…but that requires a running server. Mark DONE_WITH_CONCERNS if no test added.

- [ ] **Step 4: Run tests**

```bash
bun test
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/serve.ts tests/
git commit -m "fix(serve): method gate every route — DELETE on read-only paths now 405s"
```

---

## Task 4: CSRF Origin/Referer check on cookie-authed mutating routes

**Files:**

- Modify: `src/server/auth.ts` — add `verifyOrigin(req)` helper
- Modify: `dashboard/serve.ts` — call `verifyOrigin(req)` on every cookie-authed POST/DELETE
- Modify: `src/server/ccpl-api.ts` — call `verifyOrigin(req)` inside the dashboard-cookie-authed handlers (`handleDashboardArchive`, `handleDashboardRemove`)
- Test: `tests/auth.test.ts` — verifyOrigin behaviors

Cookie is `SameSite=Lax` (deliberate; PWA launch needs it). Lax does NOT block cross-site POSTs from forms with `text/plain`/`application/x-www-form-urlencoded` bodies. Add an `Origin`/`Referer` check.

- [ ] **Step 1: Add `verifyOrigin` to `src/server/auth.ts`**

Append to the file:

```typescript
/**
 * CSRF guard: verify the request's Origin (or Referer fallback) matches the
 * server's host. Returns true if the request is same-origin OR comes from a
 * non-browser caller (no Origin/Referer header — e.g., curl, the CLI, or
 * server-to-server). Returns false on a same-host header that doesn't match,
 * which is the only thing that should block.
 *
 * Browsers always send Origin on POST/DELETE/PUT (per Fetch spec, even with
 * SameSite=Lax cross-site triggers). A missing Origin AND missing Referer is
 * either a non-browser caller (legitimate) or a very old browser (vanishingly
 * rare). Allowing those through preserves the CLI workflow.
 */
export function verifyOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  const referer = req.headers.get('referer')
  if (!origin && !referer) return true // non-browser caller; allow

  const host = req.headers.get('host')
  if (!host) return false // can't compare; refuse

  // Build the expected origin from Host. We don't know the scheme from inside
  // the handler; check both http and https.
  const candidates = [`http://${host}`, `https://${host}`]

  if (origin) {
    return candidates.includes(origin)
  }

  // Referer is a full URL — extract origin.
  if (referer) {
    try {
      const u = new URL(referer)
      return candidates.includes(`${u.protocol}//${u.host}`)
    } catch {
      return false
    }
  }

  return false
}
```

- [ ] **Step 2: Write tests**

Add to `tests/auth.test.ts`:

```typescript
import { verifyOrigin } from '../src/server/auth'

function req(headers: Record<string, string>): Request {
  return new Request('http://example.com/api/foo', { method: 'POST', headers })
}

test('verifyOrigin allows non-browser callers (no Origin or Referer)', () => {
  expect(verifyOrigin(req({ host: 'localhost:3400' }))).toBe(true)
})

test('verifyOrigin allows matching Origin', () => {
  expect(
    verifyOrigin(
      req({
        host: 'localhost:3400',
        origin: 'http://localhost:3400',
      }),
    ),
  ).toBe(true)
})

test('verifyOrigin allows matching https Origin', () => {
  expect(
    verifyOrigin(
      req({
        host: 'dashboard.example.com',
        origin: 'https://dashboard.example.com',
      }),
    ),
  ).toBe(true)
})

test('verifyOrigin blocks mismatched Origin', () => {
  expect(
    verifyOrigin(
      req({
        host: 'localhost:3400',
        origin: 'https://evil.com',
      }),
    ),
  ).toBe(false)
})

test('verifyOrigin allows matching Referer when no Origin', () => {
  expect(
    verifyOrigin(
      req({
        host: 'localhost:3400',
        referer: 'http://localhost:3400/dashboard',
      }),
    ),
  ).toBe(true)
})

test('verifyOrigin blocks mismatched Referer', () => {
  expect(
    verifyOrigin(
      req({
        host: 'localhost:3400',
        referer: 'https://evil.com/page',
      }),
    ),
  ).toBe(false)
})
```

- [ ] **Step 3: Run failing tests, then verify they pass after Step 1**

```bash
bun test tests/auth.test.ts
```

- [ ] **Step 4: Apply the check to mutating routes in `dashboard/serve.ts`**

For each cookie-authed POST/DELETE route in `dashboard/serve.ts`, add at the top of the handler block (after the auth check but before any work):

```typescript
if (!verifyOrigin(req)) {
  return new Response(JSON.stringify({ error: 'csrf_blocked' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

Routes to gate (cookie-authed mutation):

- `/login` POST (yes — even login should resist CSRF)
- `/logout` POST
- `/api/overrides` POST and DELETE
- `/api/permission-response` POST
- `/api/send` POST
- `/api/upload` POST

NOT to gate (token-authed or read-only):

- `/ccpl/register` POST (no cookie auth)
- `/ccpl/archive` POST (token-authed, not cookie-authed)
- `/ingest` POST (shared-secret authed)
- All GETs

`/api/session/archive` POST and `/api/session/remove` DELETE go through `handleDashboardArchive` / `handleDashboardRemove` in `src/server/ccpl-api.ts` — apply the check there instead.

- [ ] **Step 5: Apply to `src/server/ccpl-api.ts`**

In `handleDashboardArchive` and `handleDashboardRemove`, add `verifyOrigin` check after the `isAuthed` guard:

```typescript
import { verifyOrigin } from './auth'

// Inside both handlers, AFTER:
//   if (!deps.isAuthed(req)) return json({ error: 'unauthorized' }, 401)
// ADD:
if (!verifyOrigin(req)) return json({ error: 'csrf_blocked' }, 403)
```

- [ ] **Step 6: Run full test suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/server/auth.ts dashboard/serve.ts src/server/ccpl-api.ts tests/auth.test.ts
git commit -m "fix(csrf): verifyOrigin guard on cookie-authed POST/DELETE routes"
```

---

## Task 5: Atomic CLI token write

**Files:**

- Modify: `bin/ccpl.ts:46-50` — `writeToken` becomes write-tmp-then-rename
- Test: `tests/` — new test if straightforward; otherwise inline verification only (this is a one-off CLI helper, not on the hot path)

Today `writeFileSync(tokenPath(name), token, { mode: 0o600 })` writes in place. A crash mid-write or a concurrent read can yield a truncated or world-readable file (the mode is set AFTER write begins on some kernels).

- [ ] **Step 1: Replace `writeToken`**

In `bin/ccpl.ts` (around line 46-50):

```typescript
// BEFORE
function writeToken(name: string, token: string): void {
  mkdirSync(SESS_DIR, { recursive: true, mode: 0o700 })
  chmodSync(SESS_DIR, 0o700)
  writeFileSync(tokenPath(name), token, { mode: 0o600 })
}

// AFTER
function writeToken(name: string, token: string): void {
  mkdirSync(SESS_DIR, { recursive: true, mode: 0o700 })
  chmodSync(SESS_DIR, 0o700)
  // Atomic write: write to a sibling tmp file with O_EXCL so a concurrent
  // writer can't overwrite ours mid-flight, then rename. POSIX rename(2) is
  // atomic on the same filesystem. Use a unique tmp name per call so two
  // concurrent invocations for the same name don't collide.
  const tmp = `${tokenPath(name)}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, token, { mode: 0o600, flag: 'wx' })
  renameSync(tmp, tokenPath(name))
}
```

Add the imports `renameSync` to the existing `node:fs` import at the top of the file.

- [ ] **Step 2: Verify with a manual smoke**

```bash
# Build a token, ensure it's the right contents and 0600.
bun bin/ccpl.ts new test-atomic-token --cwd /tmp
ls -la ~/.config/party-line/sessions/test-atomic-token.token
cat ~/.config/party-line/sessions/test-atomic-token.token
# Cleanup
bun bin/ccpl.ts forget test-atomic-token
rm -f ~/.config/party-line/sessions/test-atomic-token.token*
```

(If `ccpl forget` requires a running dashboard, do the cleanup with `rm` only.)

Expected: file exists, mode `-rw-------`, contents are a 64-char hex token. No `.tmp` files left behind.

- [ ] **Step 3: Run full test suite (regression check)**

```bash
bun test
```

- [ ] **Step 4: Commit**

```bash
git add bin/ccpl.ts
git commit -m "fix(ccpl): atomic token write — write-tmp-then-rename, no truncation race"
```

---

## Task 6: Permission-bridge TTL + cap

**Files:**

- Modify: `src/permission-bridge.ts` — add `Map`-with-TTL semantics + cap
- Test: `tests/` — new test for TTL eviction and cap behavior

Today `pending` Map only deletes on a matching response. A spammy or crashed counterpart grows the map indefinitely.

- [ ] **Step 1: Add TTL + cap to `createPermissionBridge`**

Replace the body of `createPermissionBridge`:

```typescript
const PENDING_TTL_MS = 5 * 60 * 1000 // 5 min — Claude Code permission timeout
const PENDING_CAP = 256

interface PendingEntry {
  params: PermissionRequestParams
  expiresAt: number
}

export function createPermissionBridge(deps: PermissionBridgeDeps): PermissionBridge {
  const pending = new Map<string, PendingEntry>()

  function evictExpired(): void {
    const now = Date.now()
    for (const [id, entry] of pending) {
      if (entry.expiresAt < now) pending.delete(id)
    }
  }

  function evictToCap(): void {
    if (pending.size <= PENDING_CAP) return
    // Drop oldest entries until under cap.
    const sorted = [...pending.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    const drop = pending.size - PENDING_CAP
    for (let i = 0; i < drop; i++) pending.delete(sorted[i]![0])
  }

  return {
    handlePermissionRequest(params) {
      evictExpired()
      pending.set(params.request_id, { params, expiresAt: Date.now() + PENDING_TTL_MS })
      evictToCap()
      const body = JSON.stringify(params)
      const envelope = createEnvelope(deps.sessionName, 'dashboard', 'permission-request', body)
      deps.sendEnvelope(envelope)
    },

    handlePermissionResponseEnvelope(envelope) {
      if (envelope.type !== 'permission-response') return
      let parsed: PermissionResponseBody
      try {
        parsed = JSON.parse(envelope.body) as PermissionResponseBody
      } catch {
        return
      }
      if (parsed.behavior !== 'allow' && parsed.behavior !== 'deny') return
      const entry = pending.get(parsed.request_id)
      if (!entry) return
      pending.delete(parsed.request_id)
      // Even if the entry has expired, the user has explicitly clicked
      // allow/deny — honor the decision.
      deps.sendMcpNotification(parsed)
    },

    hasPending(requestId) {
      const entry = pending.get(requestId)
      if (!entry) return false
      if (entry.expiresAt < Date.now()) {
        pending.delete(requestId)
        return false
      }
      return true
    },
  }
}
```

- [ ] **Step 2: Write tests**

Find or create `tests/permission-bridge.test.ts` — should already exist. Add:

```typescript
import { createPermissionBridge } from '../src/permission-bridge'

test('hasPending returns false after TTL expires', () => {
  const sent: unknown[] = []
  const bridge = createPermissionBridge({
    sessionName: 'alice',
    sendEnvelope: (e) => sent.push(e),
    sendMcpNotification: () => {},
  })
  bridge.handlePermissionRequest({
    request_id: 'r1',
    tool_name: 'Bash',
    description: 'list files',
    input_preview: '{"command":"ls"}',
  })
  expect(bridge.hasPending('r1')).toBe(true)

  // Mock time advance: rather than waiting 5 min, manipulate Date.now via
  // bun:test mocks if available, or skip this and test the cap instead.
  // Or expose a TTL override for testing.
})

test('cap evicts oldest entries beyond 256', () => {
  const bridge = createPermissionBridge({
    sessionName: 'alice',
    sendEnvelope: () => {},
    sendMcpNotification: () => {},
  })
  for (let i = 0; i < 300; i++) {
    bridge.handlePermissionRequest({
      request_id: `r${i}`,
      tool_name: 'Bash',
      description: '',
      input_preview: '',
    })
  }
  // First ~44 entries should have been evicted.
  expect(bridge.hasPending('r0')).toBe(false)
  expect(bridge.hasPending('r299')).toBe(true)
})
```

If TTL is hard to test without time mocking, write the cap test only and document the TTL behavior in a comment for manual verification. Do not add fragile sleep-based tests.

- [ ] **Step 3: Run tests**

```bash
bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/permission-bridge.ts tests/permission-bridge.test.ts
git commit -m "fix(perm-bridge): pending map gets 5-min TTL + 256-entry cap"
```

---

## Final verification

- [ ] **Step 1: Full test suite**

```bash
bun test
```

Expected: ≥ 338 + new tests, 0 fail.

- [ ] **Step 2: Type check (if project has one)**

```bash
bunx tsc --noEmit -p .
```

If no `tsconfig.json` exists, skip.

- [ ] **Step 3: Manual smoke (controller does this — not the implementer)**

The controller's manual checklist after merge:

1. Reload the dashboard. Login still works.
2. Send a message via the dashboard composer (cookie-authed POST → `/api/send`). Should succeed (Origin header sent automatically).
3. Run `bun dashboard/cli.ts send all "ping"` — should still work (no Origin header from CLI; allowed by `verifyOrigin`).
4. `curl -X DELETE http://localhost:3400/api/history` — should return 405.
5. `curl -H "Origin: https://evil.com" -H "Cookie: pl_dash=..." -X POST http://localhost:3400/api/send -d '{"to":"x","message":"x","type":"message"}'` — should return 403.
6. `curl -X POST http://localhost:3400/api/send -H "Cookie: ..." -H "Content-Type: application/json" -d 'not json'` — should return 400, NOT crash.
7. `ccpl new smoke-test --cwd /tmp` — token file exists, mode `-rw-------`, no `.tmp` files left.

- [ ] **Step 4: Merge to main**

```bash
git checkout main
git merge --ff-only pr2-security-hygiene
git branch -d pr2-security-hygiene
bun test 2>&1 | tail -3
```

---

## Notes for the implementer

- Each task ends in a commit. Don't bundle tasks.
- Tasks 1, 4, 6 are TDD-friendly (extract logic into testable units, then test). Tasks 2, 3, 5 are mechanical or manual-test-only — that's OK.
- If a task's test is too invasive to write (e.g., requires booting Bun.serve), document in DONE_WITH_CONCERNS and proceed.
- Strict TypeScript — explicit types on new function signatures, no `any` in exports.
- DO NOT touch any file in `dashboard/dashboard.js`, `dashboard/sw.js`, or anything in PR 1's scope. Stay in `src/server/`, `src/storage/`, `src/permission-bridge.ts`, `dashboard/serve.ts`, `bin/ccpl.ts`, and the matching test files.
