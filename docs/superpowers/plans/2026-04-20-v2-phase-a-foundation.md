# Party Line v2 — Phase A: Foundation Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the high-impact foundation bugs identified in the 2026-04-20 audit so the v2 rebuild starts on solid ground.

**Architecture:** A focused, low-risk sequence of inline fixes and one DB-migration correction. No new modules. Each task is independently revertable.

**Tech Stack:** TypeScript on Bun, SQLite via `bun:sqlite`, `bun:test`. No new dependencies.

**Part of:** Party Line v2 rebuild. Spec: `docs/superpowers/specs/2026-04-20-hub-and-spoke-design.md`. Audit: `docs/audit/2026-04-20-SUMMARY.md`.

---

## File Structure

| File                     | Responsibility             | Change                                                          |
| ------------------------ | -------------------------- | --------------------------------------------------------------- |
| `package.json`           | Project metadata, scripts  | Add `test` script                                               |
| `src/storage/schema.sql` | Fresh-DB schema            | Remove `PRAGMA user_version` line                               |
| `src/storage/db.ts`      | DB open + migration runner | Wrap migrations in transactions                                 |
| `tests/storage.test.ts`  | DB tests                   | Add v1→v4 upgrade test                                          |
| `dashboard/dashboard.js` | Client JS (monolith)       | sessionsReady gate, notif TDZ fix, dead code removal, try/catch |
| `dashboard/index.html`   | Client HTML                | Add missing checkbox inputs OR remove JS refs                   |

---

## Task A1: Add `test` script to `package.json`

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Read the current package.json**

```bash
cat package.json
```

Expected: JSON with `name`, `type: "module"`, `scripts`, etc.

- [ ] **Step 2: Add `test` script**

Merge the following into `package.json`'s `scripts` object:

```json
{
  "scripts": {
    "test": "bun test",
    "test:watch": "bun test --watch",
    "typecheck": "tsc --noEmit",
    "test:all": "bun run typecheck && bun test"
  }
}
```

Preserve any existing scripts already in the file.

- [ ] **Step 3: Verify it runs**

Run: `bun run test`
Expected: existing test suite runs; count matches `bun test` without the script. All pass.

Run: `bun run test:all`
Expected: typecheck passes, tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add test script + typecheck alias to package.json

Makes the suite discoverable via standard bun run test. Closes audit T1."
```

---

## Task A2: Remove `PRAGMA user_version` from `schema.sql`

**Files:**

- Modify: `src/storage/schema.sql`

**Background:** The audit found that `schema.sql` contains `PRAGMA user_version = 3` which is set before the migration runner checks the DB's version. This means an existing DB at v1 or v2 has its user_version bumped to 3 by `schema.sql`, so the migration runner thinks no migrations are needed and skips them. `db.ts` must be the sole owner of `user_version`.

- [ ] **Step 1: Find the PRAGMA line**

Run: `grep -n "PRAGMA user_version" src/storage/schema.sql`
Expected: one match near the top of the file.

- [ ] **Step 2: Delete the line**

Open `src/storage/schema.sql`. Remove the line `PRAGMA user_version = 3;` (and any comment immediately above it that refers to the PRAGMA).

Keep every other line — the `CREATE TABLE`s and indexes must stay.

- [ ] **Step 3: Verify grep finds nothing**

Run: `grep -n "PRAGMA user_version" src/storage/schema.sql`
Expected: no output, exit 1.

- [ ] **Step 4: Run existing storage tests**

Run: `bun test tests/storage.test.ts`
Expected: all pass. A fresh DB still works because `db.ts` will set `user_version` explicitly in a subsequent task.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.sql
git commit -m "fix(storage): remove PRAGMA user_version from schema.sql

Lets db.ts's migration runner be the sole owner of user_version,
so migrations actually run on upgrade. Closes audit S1 part 1."
```

---

## Task A3: Wrap each migration in a transaction and set user_version inside it

**Files:**

- Modify: `src/storage/db.ts`
- Test: `tests/storage.test.ts` (new test for upgrade path)

**Background:** `applyMigrations` must (a) explicitly set `user_version` imperatively after `schema.sql` runs on fresh DBs, (b) wrap each migration step in a transaction with the `PRAGMA user_version` bump inside the same transaction so partial failures don't leave the schema inconsistent.

- [ ] **Step 1: Write the failing test — v1 upgrade path**

Append to `tests/storage.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { openDb, SCHEMA_VERSION } from '../src/storage/db'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('openDb migration', () => {
  test('upgrades a pre-existing v1 DB to SCHEMA_VERSION without skipping migrations', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'partylinedb-'))
    const dbPath = join(tmp, 'test.db')
    try {
      // Simulate a v1 DB by creating the minimal schema the v1 code would have produced.
      const pre = new Database(dbPath)
      pre.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, hook_event TEXT, ts INTEGER)')
      pre.exec('PRAGMA user_version = 1')
      pre.close()

      // Open via the real migration runner.
      const db = openDb(dbPath)
      const row = db.query('PRAGMA user_version').get() as { user_version: number }
      expect(row.user_version).toBe(SCHEMA_VERSION)

      // All expected tables from the current SCHEMA_VERSION should exist.
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
      const names = tables.map((t) => t.name)
      expect(names).toContain('events')
      expect(names).toContain('sessions')
      expect(names).toContain('tool_calls')
      expect(names).toContain('subagents')
      expect(names).toContain('metrics_daily')
      db.close()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('is idempotent: opening an already-current DB is a no-op', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'partylinedb-'))
    const dbPath = join(tmp, 'test.db')
    try {
      openDb(dbPath).close()
      const db = openDb(dbPath) // second open should not throw
      const row = db.query('PRAGMA user_version').get() as { user_version: number }
      expect(row.user_version).toBe(SCHEMA_VERSION)
      db.close()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run the tests and verify the upgrade test fails (the idempotent test probably passes)**

Run: `bun test tests/storage.test.ts`
Expected: the `upgrades a pre-existing v1 DB…` test FAILS (migrations didn't run, tables are missing OR duplicate-column errors surface). The idempotent test probably passes on a correct setup.

- [ ] **Step 3: Read the current `openDb` and `applyMigrations`**

Read `src/storage/db.ts` in full. Locate `openDb`, `applyMigrations`, `SCHEMA_VERSION`.

- [ ] **Step 4: Rewrite the migration runner**

Replace the body of `openDb` and `applyMigrations` with the following logic (adjust names to match what's already exported):

```ts
export const SCHEMA_VERSION = 3 // bump to 4 in Phase C when we add v2 tables

export function openDb(path: string): Database {
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  const currentVersion = getUserVersion(db)

  if (currentVersion === 0) {
    // Fresh DB: apply the declarative schema once.
    const schema = readFileSync(resolve(import.meta.dir, 'schema.sql'), 'utf8')
    db.transaction(() => {
      db.exec(schema)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })()
  } else if (currentVersion < SCHEMA_VERSION) {
    applyMigrations(db, currentVersion)
  } else if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `DB at ${path} has user_version=${currentVersion} which is newer than this build's SCHEMA_VERSION=${SCHEMA_VERSION}. Refusing to open.`,
    )
  }

  return db
}

function getUserVersion(db: Database): number {
  const row = db.query('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

function applyMigrations(db: Database, fromVersion: number): void {
  const migrations: Record<number, (db: Database) => void> = {
    1: (db) => {
      // v1 → v2: whatever v2 adds (keep existing migration SQL from current code)
      db.exec(`CREATE TABLE IF NOT EXISTS subagents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`)
    },
    2: (db) => {
      // v2 → v3: add source column to events (was the v3 migration)
      const cols = db.query('PRAGMA table_info(events)').all() as { name: string }[]
      if (!cols.some((c) => c.name === 'source')) {
        db.exec(`ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'local'`)
      }
    },
  }

  for (let v = fromVersion; v < SCHEMA_VERSION; v++) {
    const step = migrations[v]
    if (!step) throw new Error(`No migration registered for v${v} → v${v + 1}`)
    db.transaction(() => {
      step(db)
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })()
  }
}
```

Notes:

- `readFileSync` and `resolve` need to be imported from `node:fs` and `node:path` at the top of the file if not already present.
- Preserve any existing migration SQL — the snippet above shows the shape, not the exact v1/v2 content. Inspect the current migrations in `db.ts` and move them into the `migrations` map while wrapping in `db.transaction`.
- The `PRAGMA user_version = $next` bump now happens INSIDE the same transaction as the DDL, so partial failure rolls back together.

- [ ] **Step 5: Run the storage tests**

Run: `bun test tests/storage.test.ts`
Expected: both new tests pass. Existing tests also pass.

- [ ] **Step 6: Run the full suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/storage/db.ts tests/storage.test.ts
git commit -m "fix(storage): migration runner is now transactional and monotonic

Each migration step runs inside a db.transaction() alongside the
PRAGMA user_version bump, so partial failures roll back cleanly.
Fresh DBs get user_version set explicitly instead of relying on
schema.sql's PRAGMA (removed in Phase A task A2). Adds v1→current
upgrade test. Closes audit S1."
```

---

## Task A4: Add the `sessionsReady` gate in `dashboard.js`

**Files:**

- Modify: `dashboard/dashboard.js`

**Background:** Direct URL navigation to `/session/<name>` triggers `applyRoute` at module evaluation, before the WebSocket has opened. `lastSessions` is `[]`, so `known` is `false`, and the "Session not known to the dashboard" message paints permanently. This task introduces a `sessionsReady` flag that defers the unknown-session fallback until the first `sessions` WS frame arrives.

- [ ] **Step 1: Locate the relevant spots in `dashboard.js`**

Read the file. Find:

- The global declaration `let lastSessions = []` (near the top).
- Function `applyRoute` (around line 122).
- Function `updateSessions` (around line 482).
- The initial `applyRoute(parseUrl(), { skipPush: true })` call (around line 1928).

- [ ] **Step 2: Add the `sessionsReady` global + `pendingRoute` holder**

Near the top of `dashboard.js`, alongside the other global declarations, add:

```js
let sessionsReady = false
let pendingRouteState = null // if set, applyRoute will re-fire once sessions arrive
```

- [ ] **Step 3: Modify `applyRoute` to defer on unknown session when sessions-not-ready**

Replace the `!known` branch in `applyRoute` (the block that starts with `if (!known) { setTimeout(...) }`) with:

```js
if (!known) {
  if (!sessionsReady) {
    // Defer the "unknown session" UI until we've heard from the server at least once.
    pendingRouteState = state
    const stream = document.getElementById('detail-stream')
    if (stream) {
      stream.replaceChildren()
      const p = document.createElement('p')
      p.style.color = 'var(--text-dim)'
      p.textContent = 'Loading session…'
      stream.appendChild(p)
    }
    return
  }
  // Sessions are loaded and this name is genuinely unknown — render the fallback.
  setTimeout(() => {
    const stream = document.getElementById('detail-stream')
    if (!stream) return
    stream.replaceChildren()
    const p = document.createElement('p')
    p.style.color = 'var(--text-dim)'
    p.textContent =
      'Session "' +
      state.sessionName +
      '" is not currently known to the dashboard. It may have ended or the name may have changed. '
    const back = document.createElement('a')
    back.href = '/'
    back.textContent = 'Back to Switchboard'
    back.addEventListener('click', (e) => {
      e.preventDefault()
      navigate({ view: 'switchboard' })
    })
    p.appendChild(back)
    stream.appendChild(p)
  }, 100)
}
```

- [ ] **Step 4: Modify `updateSessions` to flip `sessionsReady` and re-apply pending route**

Find `function updateSessions(sessions)`. Update it to:

```js
function updateSessions(sessions) {
  lastSessions = sessions
  if (!seededOnce && lastSessions.length > 0) {
    seededOnce = true
    seedUnreadCounts()
  }
  updateOverviewGrid(sessions)

  if (!sessionsReady) {
    sessionsReady = true
    if (pendingRouteState) {
      const s = pendingRouteState
      pendingRouteState = null
      applyRoute(s, { skipPush: true })
    }
  }
}
```

- [ ] **Step 5: Manual test — direct URL load**

Start the dashboard (if not already running):

```bash
bun dashboard/serve.ts --port 3400
```

With a live session named, e.g., `partyline-dev` connected, open a fresh browser tab to `http://localhost:3400/session/partyline-dev`.

Expected: the page briefly shows "Loading session…", then the session detail view renders (header, stream, etc.) without the "not known" placeholder. Refreshing works too.

Test the "genuinely unknown name" path: open `http://localhost:3400/session/no-such-session`.
Expected: after ~100ms, the "not currently known to the dashboard" fallback renders (it must still fire when the session is truly absent).

- [ ] **Step 6: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "fix(dashboard): direct URL loads to /session/:name no longer stick on 'not known'

applyRoute now defers the 'unknown session' fallback until the first
sessions WebSocket frame arrives. Once sessions are loaded, pending
routes are re-applied. Closes audit C1."
```

---

## Task A5: Move `createNotifications()` call above the initial `applyRoute`

**Files:**

- Modify: `dashboard/dashboard.js`

**Background:** The `notif` const is declared around line 1963, but `applyRoute(parseUrl(), { skipPush: true })` runs at line 1928. During that first apply, `notif.dispatchSessionViewed(...)` in `applyRoute` throws a TDZ error, which the code currently swallows with a try/catch. Moving the declaration above eliminates the swallowing.

- [ ] **Step 1: Locate both call sites**

Find:

- `const notif = createNotifications({ ... })` — currently around line 1963.
- `applyRoute(parseUrl(), { skipPush: true })` — currently around line 1928.

- [ ] **Step 2: Move the `notif` declaration**

Cut the entire `const notif = createNotifications({ ... })` block (all of it — the factory call includes a multi-line options object). Paste it above the `applyRoute(parseUrl(), ...)` call so that `notif` is in scope when that first route application runs.

- [ ] **Step 3: Remove the TDZ try/catch in `applyRoute`**

Locate inside `applyRoute`:

```js
try {
  notif.dispatchSessionViewed(state.sessionName)
} catch {
  /* notif not yet initialized */
}
```

Replace with the plain call (the whole point of the move is that `notif` is always ready):

```js
notif.dispatchSessionViewed(state.sessionName)
```

- [ ] **Step 4: Run tests and load the dashboard**

Run: `bun test`
Expected: all pass.

Start the dashboard, load `/session/partyline-dev` directly. Open devtools console.
Expected: no ReferenceError about `notif`. Session view loads normally.

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "refactor(dashboard): eliminate notif TDZ by moving factory call above applyRoute

The try/catch around notif.dispatchSessionViewed was silently swallowing
a ReferenceError on every direct-URL page load. Declaration-before-use
is cleaner. Closes audit part of C1 followup."
```

---

## Task A6: Add try/catch around `notif.*` calls in the WS message handler

**Files:**

- Modify: `dashboard/dashboard.js`

**Background:** `notif.onPartyLineMessage(envelope)`, `notif.onSessionUpdate(update)`, `notif.onPermissionRequest(frame)`, etc., are called inside the WS `onmessage` handler. If any throws (e.g., mobile Chrome's `new Notification()` TypeError before the SW rebuild is in place), the exception propagates out of the WS callback and breaks downstream WS frames for that tick. Wrap each in a `try/catch` so one throw can't poison the handler.

- [ ] **Step 1: Locate the WS onmessage handler**

Find `ws.onmessage = function (e) {` (around line 250). Look for every `notif.*(...)` call inside.

- [ ] **Step 2: Wrap each `notif` call**

Replace calls of the form:

```js
notif.onPartyLineMessage(data.data)
```

with:

```js
try {
  notif.onPartyLineMessage(data.data)
} catch (err) {
  console.error('[notifications] onPartyLineMessage threw', err)
}
```

Do the same for every `notif.onXxx(...)` call in the handler — at minimum:

- `notif.onPartyLineMessage`
- `notif.onSessionUpdate`
- `notif.onPermissionRequest`
- `notif.onPermissionResolved`
- `notif.onNotificationDismiss`

- [ ] **Step 3: Run tests**

Run: `bun test`
Expected: all pass.

- [ ] **Step 4: Manual smoke test**

Open the dashboard. Send a message from CLI. Verify normal behavior; verify console has no new errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "fix(dashboard): isolate notification throws in WS handler

Wrap every notif.on* call in try/catch so a single throw (e.g. mobile
Chrome's Illegal-constructor error pre-SW-rebuild) can't prevent
other handlers from running on the same frame. Closes audit N4."
```

---

## Task A7: Delete dead `session_id` comparison in `handleSessionUpdate`

**Files:**

- Modify: `dashboard/dashboard.js`

**Background:** `handleSessionUpdate` at around line 880 has:

```js
if (currentView === 'session-detail' && selectedSessionId === session.session_id) { ... }
```

`selectedSessionId` is always a session NAME (per the router + usage patterns), never a session UUID — this branch is unreachable. The audit flagged this as C3.

- [ ] **Step 1: Locate the branch**

Find `if (currentView === 'session-detail' && selectedSessionId === session.session_id)` inside `handleSessionUpdate`.

- [ ] **Step 2: Delete the branch and its body**

Remove the entire `if` block. Keep the surrounding `if (currentView === 'session-detail' && session.name === selectedSessionId)` block intact — that one is the real, reachable branch.

- [ ] **Step 3: Test**

Run: `bun test`
Expected: all pass.

Load the dashboard, navigate to a session detail, let a session update flow through (e.g., trigger a tool call in that session). Verify the detail view still updates.

- [ ] **Step 4: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "refactor(dashboard): remove unreachable session_id branch in handleSessionUpdate

selectedSessionId is always a name, never a UUID. The dead branch
could never fire and was confusing readers. Closes audit C3."
```

---

## Task A8: Reconcile `showHeartbeats` / `showAnnounce` JS refs with HTML

**Files:**

- Modify: `dashboard/dashboard.js` OR `dashboard/index.html` (pick one — see below)

**Background:** Top of `dashboard.js` references `const showHeartbeats = document.getElementById('showHeartbeats')` and uses it in `addMessage` to filter heartbeat/announce frames out of the bus feed. But there are no corresponding `<input>` elements in `index.html`. Result: handles are always null-ish, filtering doesn't work, heartbeats spam the Bus feed.

Decision: add the checkboxes to `index.html` (preserves the intent). Alternative: delete the JS refs if the feature isn't wanted. Go with adding the HTML.

- [ ] **Step 1: Find the bus panel in `index.html`**

Open `dashboard/index.html`. Find the section that contains the bus feed (look for `id="busFeed"` or similar).

- [ ] **Step 2: Add the two checkboxes**

Immediately above (or in the header of) the bus feed, add:

```html
<div class="bus-filters">
  <label><input type="checkbox" id="showHeartbeats" checked /> heartbeats</label>
  <label><input type="checkbox" id="showAnnounce" checked /> announces</label>
  <label><input type="checkbox" id="autoscroll" checked /> autoscroll</label>
</div>
```

(If `autoscroll` already has an input element nearby, drop that line from the block above and reuse the existing one.)

- [ ] **Step 3: Add minimal CSS for the filters**

In `dashboard/dashboard.css`, append:

```css
.bus-filters {
  display: flex;
  gap: 12px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.bus-filters label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
```

- [ ] **Step 4: Verify filtering works**

Reload the dashboard. In the bus feed, heartbeat frames should be visible (checkbox checked = show). Uncheck "heartbeats"; new heartbeat messages should no longer append to the feed.

- [ ] **Step 5: Commit**

```bash
git add dashboard/index.html dashboard/dashboard.css
git commit -m "fix(dashboard): add missing heartbeat/announce filter checkboxes

JS referenced #showHeartbeats and #showAnnounce but the inputs were
never in the HTML, so filtering silently no-op'd and the bus feed
was spammed with heartbeats. Closes audit C6."
```

---

## Phase A Exit Criteria

After all 8 tasks are complete:

- [ ] `bun run test:all` passes.
- [ ] Direct navigation to `https://<host>/session/<valid-name>` renders the session detail view on first load.
- [ ] Direct navigation to `/session/<nonexistent-name>` shows the "not known" fallback after ~100ms.
- [ ] Opening a fresh SQLite file that's currently at `user_version=1` via `openDb` successfully migrates to the current SCHEMA_VERSION.
- [ ] Bus feed heartbeat/announce filter checkboxes work.
- [ ] No ReferenceError for `notif` in console on direct-URL page load.
- [ ] `git log --oneline` shows 8 clean commits.

When exit criteria pass, Phase A is shippable. Phase B and Phase C can begin independently of each other.

---

## Notes for the Implementer

- Use superpowers:test-driven-development for A3 (the migration test). For A4–A8, write the test afterwards only if the existing suite doesn't already cover the behavior you changed — don't add parallel coverage.
- Commit after each task. Small commits are the explicit goal of this plan.
- If a task's exact file paths don't match what you find (e.g., `dashboard.js` line numbers drift as earlier tasks commit), trust the file contents over the plan's line numbers. The plan is a guide, not a contract on line numbers.
- Phase A runs on `main` because the fixes are low-risk. If you prefer isolation, create a worktree via superpowers:using-git-worktrees before starting.
