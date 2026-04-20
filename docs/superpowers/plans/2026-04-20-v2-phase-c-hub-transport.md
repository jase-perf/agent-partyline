# Party Line v2 — Phase C: Hub-and-Spoke Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the UDP-multicast peer-to-peer transport with a central switchboard-mediated hub-and-spoke model. Every session opens an authenticated WebSocket to the switchboard; the switchboard owns routing, persistence, and presence. Sessions become first-class, persistently identified entities managed by `ccpl`.

**Architecture:** The existing dashboard binary grows into the "switchboard" — it now owns the `ccpl_sessions` table (the registry of named sessions with tokens), a new `/ws/session` endpoint for MCP plugins, a unified `session-delta` stream on the existing observer WS, and HTTP endpoints for session lifecycle management. The MCP plugin replaces its UDP transport with a WS client. `ccpl` becomes a real Bun CLI (replacing the shell script) that manages token files and launches Claude Code with the right `--resume` / `--name` semantics.

**Tech Stack:** TypeScript on Bun, `bun:sqlite`, WebSocket (native), crypto.randomBytes for tokens + cookie signing. No new dependencies.

**Prerequisite:** Phase A complete (migration runner fixed, `sessionsReady` gate in place). Phase B is NOT a prerequisite — C can run in parallel.

**Part of:** Party Line v2 rebuild. Spec: `docs/superpowers/specs/2026-04-20-hub-and-spoke-design.md` §1–§6 and §9. Audit: `docs/audit/2026-04-20-SUMMARY.md`.

---

## File Structure

### Created

| File                                   | Responsibility                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/server/switchboard.ts`            | Routing layer — takes inbound `/ws/session` frames, persists, fans out to recipients + observers |
| `src/server/ws-session.ts`             | `/ws/session` WebSocket handler (hello, send, respond, uuid-rotate, permission-response, ping)   |
| `src/server/ws-observer.ts`            | `/ws/observer` WebSocket handler (session-delta, envelope, permission-request, dismiss, ping)    |
| `src/server/ccpl-api.ts`               | HTTP handlers for `/ccpl/*` (register/session/rotate/archive/forget/list/cleanup)                |
| `src/server/auth.ts`                   | Dashboard password verification + signed cookie handling                                         |
| `src/storage/ccpl-queries.ts`          | Typed query helpers for `ccpl_sessions`, `ccpl_archives`, `messages`, `dashboard_sessions`       |
| `src/transport/ws-client.ts`           | Outbound WS client used by MCP plugin + CLI + monitor (reconnect, ping, handshake)               |
| `bin/ccpl`                             | Bun CLI (new, new, list, forget, rotate, cleanup + launch subcommand)                            |
| `dashboard/login.html`                 | Minimal login page HTML                                                                          |
| `dashboard/login.js`                   | Login page JS (POST credentials, set cookie on success)                                          |
| `tests/switchboard.test.ts`            | Unit tests for the routing layer                                                                 |
| `tests/ccpl-api.test.ts`               | HTTP API tests (in-process against serve.ts)                                                     |
| `tests/ws-session-integration.test.ts` | Two WS clients round-tripping through the switchboard                                            |

### Modified

| File                     | Change                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `src/types.ts`           | Drop `seq` from `Envelope`; add `SessionDelta`, `HelloFrame`, `CcplSessionRow` types |
| `src/protocol.ts`        | Remove `Deduplicator` class and `sequenceCounter`; keep envelope helpers             |
| `src/server.ts`          | MCP plugin uses `ws-client.ts` instead of multicast transport                        |
| `src/presence.ts`        | Drop heartbeat loop; `listSessions` now queries `ccpl_sessions` via HTTP             |
| `src/storage/schema.sql` | Add new tables                                                                       |
| `src/storage/db.ts`      | `SCHEMA_VERSION = 4`; register v3→v4 migration                                       |
| `dashboard/serve.ts`     | Mount new endpoints + auth middleware; remove UDP-adjacent code                      |
| `dashboard/monitor.ts`   | WS client; no UDP                                                                    |
| `dashboard/cli.ts`       | WS client for `watch`, HTTP for `sessions`/`send`                                    |
| `dashboard/dashboard.js` | Consume `session-delta`, login flow, drop `jsonl`/`session-update`/`sessions` paths  |

### Deleted

| File                                                    |
| ------------------------------------------------------- |
| `src/transport/udp-multicast.ts`                        |
| `ccpl` (shell-script launcher — replaced by `bin/ccpl`) |

---

## Task C1: Add new tables + v3→v4 migration

**Files:**

- Modify: `src/storage/schema.sql`
- Modify: `src/storage/db.ts`
- Modify: `tests/storage.test.ts`

- [ ] **Step 1: Append new tables to `schema.sql`**

Append to `src/storage/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS ccpl_sessions (
  name TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  cwd TEXT NOT NULL,
  cc_session_uuid TEXT,
  pid INTEGER,
  machine_id TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ccpl_sessions_token ON ccpl_sessions(token);
CREATE INDEX IF NOT EXISTS idx_ccpl_sessions_last_active ON ccpl_sessions(last_active_at);

CREATE TABLE IF NOT EXISTS ccpl_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  old_uuid TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ccpl_archives_name ON ccpl_archives(name);
CREATE INDEX IF NOT EXISTS idx_ccpl_archives_uuid ON ccpl_archives(old_uuid);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  from_name TEXT NOT NULL,
  to_name TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT,
  callback_id TEXT,
  response_to TEXT,
  cc_session_uuid TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_name, ts);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_name, ts);
CREATE INDEX IF NOT EXISTS idx_messages_uuid ON messages(cc_session_uuid, ts);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  cookie TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires ON dashboard_sessions(expires_at);
```

- [ ] **Step 2: Bump SCHEMA_VERSION and add migration**

In `src/storage/db.ts`:

```ts
export const SCHEMA_VERSION = 4
```

In the `migrations` map (introduced in Phase A Task A3):

```ts
3: (db) => {
  // v3 → v4: add hub-and-spoke tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ccpl_sessions (
      name TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      cwd TEXT NOT NULL,
      cc_session_uuid TEXT,
      pid INTEGER,
      machine_id TEXT,
      online INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ccpl_sessions_token ON ccpl_sessions(token);
    CREATE INDEX IF NOT EXISTS idx_ccpl_sessions_last_active ON ccpl_sessions(last_active_at);
    CREATE TABLE IF NOT EXISTS ccpl_archives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      old_uuid TEXT NOT NULL,
      archived_at INTEGER NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ccpl_archives_name ON ccpl_archives(name);
    CREATE INDEX IF NOT EXISTS idx_ccpl_archives_uuid ON ccpl_archives(old_uuid);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      from_name TEXT NOT NULL,
      to_name TEXT NOT NULL,
      type TEXT NOT NULL,
      body TEXT,
      callback_id TEXT,
      response_to TEXT,
      cc_session_uuid TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_name, ts);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_name, ts);
    CREATE INDEX IF NOT EXISTS idx_messages_uuid ON messages(cc_session_uuid, ts);
    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      cookie TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires ON dashboard_sessions(expires_at);
  `)
},
```

- [ ] **Step 3: Write the failing test — v4 upgrade**

Append to `tests/storage.test.ts`:

```ts
test('upgrade v3 → v4 creates ccpl_sessions, ccpl_archives, messages, dashboard_sessions', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'partylinedb-'))
  const dbPath = join(tmp, 'test.db')
  try {
    const pre = new Database(dbPath)
    pre.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, hook_event TEXT, ts INTEGER)')
    pre.exec('PRAGMA user_version = 3')
    pre.close()

    const db = openDb(dbPath)
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('ccpl_sessions')
    expect(names).toContain('ccpl_archives')
    expect(names).toContain('messages')
    expect(names).toContain('dashboard_sessions')
    db.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/storage.test.ts`
Expected: all pass, including the new v4 upgrade test.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.sql src/storage/db.ts tests/storage.test.ts
git commit -m "feat(storage): add v2 schema tables (ccpl_sessions, archives, messages, dashboard_sessions)

Bumps SCHEMA_VERSION to 4 with a v3→v4 migration. Tables are also
present in schema.sql for fresh-DB installs. Covers spec §4."
```

---

## Task C2: Add typed query helpers in `ccpl-queries.ts`

**Files:**

- Create: `src/storage/ccpl-queries.ts`
- Test: `tests/ccpl-queries.test.ts`

- [ ] **Step 1: Write the file**

```ts
import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'

export interface CcplSessionRow {
  name: string
  token: string
  cwd: string
  cc_session_uuid: string | null
  pid: number | null
  machine_id: string | null
  online: boolean
  revision: number
  created_at: number
  last_active_at: number
}

export interface CcplArchiveRow {
  id: number
  name: string
  old_uuid: string
  archived_at: number
  reason: string
}

export interface MessageRow {
  id: string
  ts: number
  from_name: string
  to_name: string
  type: string
  body: string | null
  callback_id: string | null
  response_to: string | null
  cc_session_uuid: string | null
}

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

function rowToSession(row: any): CcplSessionRow {
  return {
    name: row.name,
    token: row.token,
    cwd: row.cwd,
    cc_session_uuid: row.cc_session_uuid,
    pid: row.pid,
    machine_id: row.machine_id,
    online: row.online === 1,
    revision: row.revision,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
  }
}

export function registerSession(db: Database, name: string, cwd: string): CcplSessionRow {
  const token = generateToken()
  const now = Date.now()
  db.query(
    `INSERT INTO ccpl_sessions
      (name, token, cwd, cc_session_uuid, pid, machine_id, online, revision, created_at, last_active_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, 0, 0, ?, ?)`,
  ).run(name, token, cwd, now, now)
  return getSessionByName(db, name)!
}

export function getSessionByName(db: Database, name: string): CcplSessionRow | null {
  const row = db.query(`SELECT * FROM ccpl_sessions WHERE name = ?`).get(name)
  return row ? rowToSession(row) : null
}

export function getSessionByToken(db: Database, token: string): CcplSessionRow | null {
  const row = db.query(`SELECT * FROM ccpl_sessions WHERE token = ?`).get(token)
  return row ? rowToSession(row) : null
}

export function listSessions(db: Database): CcplSessionRow[] {
  const rows = db
    .query(`SELECT * FROM ccpl_sessions ORDER BY online DESC, last_active_at DESC`)
    .all() as any[]
  return rows.map(rowToSession)
}

export function updateSessionOnConnect(
  db: Database,
  name: string,
  ccUuid: string | null,
  pid: number | null,
  machineId: string | null,
): void {
  db.query(
    `UPDATE ccpl_sessions
     SET cc_session_uuid = ?, pid = ?, machine_id = ?, online = 1,
         revision = revision + 1, last_active_at = ?
     WHERE name = ?`,
  ).run(ccUuid, pid, machineId, Date.now(), name)
}

export function markSessionOffline(db: Database, name: string): void {
  db.query(`UPDATE ccpl_sessions SET online = 0, revision = revision + 1 WHERE name = ?`).run(name)
}

export function archiveSession(db: Database, name: string, oldUuid: string, reason: string): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO ccpl_archives (name, old_uuid, archived_at, reason)
       VALUES (?, ?, ?, ?)`,
    ).run(name, oldUuid, Date.now(), reason)
    db.query(
      `UPDATE ccpl_sessions
       SET cc_session_uuid = NULL, revision = revision + 1 WHERE name = ?`,
    ).run(name)
  })()
}

export function rotateToken(db: Database, name: string): string {
  const token = generateToken()
  db.query(`UPDATE ccpl_sessions SET token = ? WHERE name = ?`).run(token, name)
  return token
}

export function deleteSession(db: Database, name: string): void {
  db.transaction(() => {
    db.query(`DELETE FROM ccpl_sessions WHERE name = ?`).run(name)
    db.query(`DELETE FROM ccpl_archives WHERE name = ?`).run(name)
  })()
}

export function pruneInactive(db: Database, cutoff: number): number {
  const res = db
    .query(
      `DELETE FROM ccpl_sessions
       WHERE online = 0 AND last_active_at < ?
       RETURNING name`,
    )
    .all(cutoff) as { name: string }[]
  for (const r of res) {
    db.query(`DELETE FROM ccpl_archives WHERE name = ?`).run(r.name)
  }
  return res.length
}

export function insertMessage(db: Database, row: MessageRow): void {
  db.query(
    `INSERT INTO messages
      (id, ts, from_name, to_name, type, body, callback_id, response_to, cc_session_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.ts,
    row.from_name,
    row.to_name,
    row.type,
    row.body,
    row.callback_id,
    row.response_to,
    row.cc_session_uuid,
  )
}

export function recentMessages(db: Database, limit: number): MessageRow[] {
  return db.query(`SELECT * FROM messages ORDER BY ts DESC LIMIT ?`).all(limit) as MessageRow[]
}
```

- [ ] **Step 2: Write tests**

Create `tests/ccpl-queries.test.ts`:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import {
  registerSession,
  getSessionByName,
  getSessionByToken,
  listSessions,
  updateSessionOnConnect,
  markSessionOffline,
  archiveSession,
  rotateToken,
  deleteSession,
  pruneInactive,
  insertMessage,
  recentMessages,
} from '../src/storage/ccpl-queries'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('ccpl-queries', () => {
  let db: Database
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'partylinedb-'))
    db = openDb(join(tmp, 'test.db'))
  })

  function cleanup() {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  }

  test('registerSession → getSessionByName round-trip', () => {
    const row = registerSession(db, 'research', '/home/claude/projects/research')
    expect(row.name).toBe('research')
    expect(row.token).toMatch(/^[a-f0-9]{64}$/)
    expect(row.cwd).toBe('/home/claude/projects/research')
    expect(row.online).toBe(false)
    expect(row.cc_session_uuid).toBeNull()
    const lookup = getSessionByName(db, 'research')
    expect(lookup?.token).toBe(row.token)
    cleanup()
  })

  test('getSessionByToken resolves by token', () => {
    const row = registerSession(db, 'foo', '/tmp')
    const byToken = getSessionByToken(db, row.token)
    expect(byToken?.name).toBe('foo')
    expect(getSessionByToken(db, 'not-a-real-token')).toBeNull()
    cleanup()
  })

  test('updateSessionOnConnect bumps revision + marks online', () => {
    registerSession(db, 'foo', '/tmp')
    updateSessionOnConnect(db, 'foo', 'uuid-1', 1234, 'mach-a')
    const row = getSessionByName(db, 'foo')!
    expect(row.online).toBe(true)
    expect(row.cc_session_uuid).toBe('uuid-1')
    expect(row.pid).toBe(1234)
    expect(row.machine_id).toBe('mach-a')
    expect(row.revision).toBe(1)
    cleanup()
  })

  test('markSessionOffline flips online + bumps revision', () => {
    registerSession(db, 'foo', '/tmp')
    updateSessionOnConnect(db, 'foo', 'uuid-1', 1, 'm')
    markSessionOffline(db, 'foo')
    const row = getSessionByName(db, 'foo')!
    expect(row.online).toBe(false)
    expect(row.revision).toBe(2)
    cleanup()
  })

  test('archiveSession moves current UUID into archives and nulls the row', () => {
    registerSession(db, 'foo', '/tmp')
    updateSessionOnConnect(db, 'foo', 'old-uuid', 1, 'm')
    archiveSession(db, 'foo', 'old-uuid', 'clear')
    const row = getSessionByName(db, 'foo')!
    expect(row.cc_session_uuid).toBeNull()
    const archives = db.query(`SELECT * FROM ccpl_archives WHERE name = ?`).all('foo') as any[]
    expect(archives.length).toBe(1)
    expect(archives[0].old_uuid).toBe('old-uuid')
    expect(archives[0].reason).toBe('clear')
    cleanup()
  })

  test('rotateToken replaces token + invalidates lookup by old token', () => {
    const a = registerSession(db, 'foo', '/tmp')
    const newToken = rotateToken(db, 'foo')
    expect(newToken).not.toBe(a.token)
    expect(getSessionByToken(db, a.token)).toBeNull()
    expect(getSessionByToken(db, newToken)?.name).toBe('foo')
    cleanup()
  })

  test('deleteSession removes session and its archives', () => {
    registerSession(db, 'foo', '/tmp')
    updateSessionOnConnect(db, 'foo', 'u1', 1, 'm')
    archiveSession(db, 'foo', 'u1', 'clear')
    deleteSession(db, 'foo')
    expect(getSessionByName(db, 'foo')).toBeNull()
    const archives = db.query(`SELECT * FROM ccpl_archives WHERE name = ?`).all('foo')
    expect(archives.length).toBe(0)
    cleanup()
  })

  test('pruneInactive deletes rows below cutoff + their archives', () => {
    registerSession(db, 'old', '/tmp')
    registerSession(db, 'fresh', '/tmp')
    db.query(`UPDATE ccpl_sessions SET last_active_at = 1000 WHERE name = 'old'`).run()
    const removed = pruneInactive(db, 2000)
    expect(removed).toBe(1)
    expect(getSessionByName(db, 'old')).toBeNull()
    expect(getSessionByName(db, 'fresh')).not.toBeNull()
    cleanup()
  })

  test('insertMessage + recentMessages DESC', () => {
    insertMessage(db, {
      id: 'a',
      ts: 1000,
      from_name: 'x',
      to_name: 'y',
      type: 'message',
      body: 'hi',
      callback_id: null,
      response_to: null,
      cc_session_uuid: null,
    })
    insertMessage(db, {
      id: 'b',
      ts: 2000,
      from_name: 'x',
      to_name: 'y',
      type: 'message',
      body: 'bye',
      callback_id: null,
      response_to: null,
      cc_session_uuid: null,
    })
    const recent = recentMessages(db, 10)
    expect(recent[0].id).toBe('b')
    expect(recent[1].id).toBe('a')
    cleanup()
  })

  test('listSessions orders online-first then last_active_at DESC', () => {
    registerSession(db, 'a', '/tmp')
    registerSession(db, 'b', '/tmp')
    registerSession(db, 'c', '/tmp')
    updateSessionOnConnect(db, 'b', 'u', 1, 'm')
    const list = listSessions(db)
    expect(list[0].name).toBe('b')
    expect(list[0].online).toBe(true)
    cleanup()
  })
})
```

- [ ] **Step 3: Run the tests**

Run: `bun test tests/ccpl-queries.test.ts`
Expected: all 10 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/storage/ccpl-queries.ts tests/ccpl-queries.test.ts
git commit -m "feat(storage): typed query helpers for ccpl_sessions, archives, messages

Covers register, update-on-connect, archive, rotate, delete, prune,
listSessions ordering, message insert + recent. Full unit coverage."
```

---

## Task C3: Dashboard password + signed-cookie auth

**Files:**

- Create: `src/server/auth.ts`
- Test: `tests/auth.test.ts`

- [ ] **Step 1: Write the auth module**

```ts
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import type { Database } from 'bun:sqlite'

const COOKIE_NAME = 'pl_dash'
const COOKIE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

function getSecret(): string {
  const s = process.env.PARTY_LINE_DASHBOARD_SECRET
  if (!s || s.length < 32) {
    // Generate a per-process secret if unset — sessions don't survive restart.
    if (!getSecret._cache) {
      getSecret._cache = randomBytes(32).toString('hex')
      console.warn(
        '[auth] PARTY_LINE_DASHBOARD_SECRET not set; using ephemeral in-memory secret. Dashboard sessions will not survive restart.',
      )
    }
    return getSecret._cache
  }
  return s
}
namespace getSecret {
  export let _cache: string | undefined
}

export function isAuthDisabled(): boolean {
  return !process.env.PARTY_LINE_DASHBOARD_PASSWORD
}

export function verifyPassword(plaintext: string): boolean {
  const expected = process.env.PARTY_LINE_DASHBOARD_PASSWORD
  if (!expected) return true // auth disabled
  const a = Buffer.from(plaintext)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function sign(value: string): string {
  return createHmac('sha256', getSecret()).update(value).digest('hex')
}

export function mintCookie(db: Database): string {
  const payload = randomBytes(24).toString('hex')
  const now = Date.now()
  const expiresAt = now + COOKIE_TTL_MS
  const sig = sign(payload)
  const cookie = `${payload}.${sig}`
  db.query(
    `INSERT INTO dashboard_sessions (cookie, created_at, last_seen, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(cookie, now, now, expiresAt)
  return cookie
}

export function verifyCookie(db: Database, raw: string | null): boolean {
  if (isAuthDisabled()) return true
  if (!raw) return false
  const [payload, sig] = raw.split('.')
  if (!payload || !sig) return false
  const expected = sign(payload)
  if (expected.length !== sig.length) return false
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false

  const row = db.query(`SELECT expires_at FROM dashboard_sessions WHERE cookie = ?`).get(raw) as {
    expires_at: number
  } | null
  if (!row) return false
  if (row.expires_at < Date.now()) {
    db.query(`DELETE FROM dashboard_sessions WHERE cookie = ?`).run(raw)
    return false
  }
  db.query(`UPDATE dashboard_sessions SET last_seen = ? WHERE cookie = ?`).run(Date.now(), raw)
  return true
}

export function revokeCookie(db: Database, raw: string): void {
  db.query(`DELETE FROM dashboard_sessions WHERE cookie = ?`).run(raw)
}

export function parseCookieHeader(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === COOKIE_NAME) return v ?? null
  }
  return null
}

export function cookieHeaderForSet(cookie: string): string {
  const maxAge = Math.floor(COOKIE_TTL_MS / 1000)
  return `${COOKIE_NAME}=${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}

export function cookieHeaderForClear(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
}

export function pruneExpiredCookies(db: Database): void {
  db.query(`DELETE FROM dashboard_sessions WHERE expires_at < ?`).run(Date.now())
}
```

- [ ] **Step 2: Write tests**

Create `tests/auth.test.ts`:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { openDb } from '../src/storage/db'
import {
  verifyPassword,
  mintCookie,
  verifyCookie,
  revokeCookie,
  parseCookieHeader,
  pruneExpiredCookies,
  isAuthDisabled,
} from '../src/server/auth'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('auth', () => {
  let db: Database
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pl-auth-'))
    db = openDb(join(tmp, 't.db'))
    process.env.PARTY_LINE_DASHBOARD_SECRET = 'x'.repeat(32)
    process.env.PARTY_LINE_DASHBOARD_PASSWORD = 'hunter2'
  })

  test('verifyPassword true for correct, false for wrong', () => {
    expect(verifyPassword('hunter2')).toBe(true)
    expect(verifyPassword('wrong')).toBe(false)
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('mintCookie returns a cookie that verifyCookie accepts', () => {
    const c = mintCookie(db)
    expect(verifyCookie(db, c)).toBe(true)
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('verifyCookie rejects tampered signature', () => {
    const c = mintCookie(db)
    const [payload] = c.split('.')
    expect(verifyCookie(db, `${payload}.deadbeef`)).toBe(false)
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('verifyCookie rejects expired cookie and removes it from DB', () => {
    const c = mintCookie(db)
    db.query(`UPDATE dashboard_sessions SET expires_at = 1 WHERE cookie = ?`).run(c)
    expect(verifyCookie(db, c)).toBe(false)
    const row = db.query(`SELECT * FROM dashboard_sessions WHERE cookie = ?`).get(c)
    expect(row).toBeNull()
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('revokeCookie removes it', () => {
    const c = mintCookie(db)
    revokeCookie(db, c)
    expect(verifyCookie(db, c)).toBe(false)
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('parseCookieHeader extracts pl_dash', () => {
    expect(parseCookieHeader('foo=bar; pl_dash=abc.def; baz=qux')).toBe('abc.def')
    expect(parseCookieHeader('foo=bar')).toBeNull()
    expect(parseCookieHeader(null)).toBeNull()
  })

  test('isAuthDisabled when password unset', () => {
    delete process.env.PARTY_LINE_DASHBOARD_PASSWORD
    expect(isAuthDisabled()).toBe(true)
    process.env.PARTY_LINE_DASHBOARD_PASSWORD = 'x'
  })

  test('verifyCookie auto-true when auth disabled', () => {
    delete process.env.PARTY_LINE_DASHBOARD_PASSWORD
    expect(verifyCookie(db, null)).toBe(true)
    process.env.PARTY_LINE_DASHBOARD_PASSWORD = 'hunter2'
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('pruneExpiredCookies removes only expired rows', () => {
    const c1 = mintCookie(db)
    const c2 = mintCookie(db)
    db.query(`UPDATE dashboard_sessions SET expires_at = 1 WHERE cookie = ?`).run(c1)
    pruneExpiredCookies(db)
    const rows = db.query(`SELECT cookie FROM dashboard_sessions`).all() as {
      cookie: string
    }[]
    expect(rows.map((r) => r.cookie)).toEqual([c2])
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })
})
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/auth.test.ts`
Expected: all 9 pass.

- [ ] **Step 4: Commit**

```bash
git add src/server/auth.ts tests/auth.test.ts
git commit -m "feat(auth): dashboard password + HMAC-signed cookie module

verifyPassword uses timingSafeEqual. mintCookie persists to
dashboard_sessions with 24h TTL. verifyCookie checks DB row + signature
+ expiry and prunes on expiry. Auto-accepts when password env unset."
```

---

## Task C4: ccpl HTTP API endpoints

**Files:**

- Create: `src/server/ccpl-api.ts`
- Test: `tests/ccpl-api.test.ts`

- [ ] **Step 1: Write the API handlers**

```ts
import type { Database } from 'bun:sqlite'
import {
  registerSession,
  getSessionByName,
  getSessionByToken,
  listSessions,
  rotateToken,
  deleteSession,
  archiveSession,
  pruneInactive,
} from '../storage/ccpl-queries'

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

export async function handleCcplRegister(req: Request, db: Database): Promise<Response> {
  let body: { name?: string; cwd?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  const name = (body.name || '').trim()
  const cwd = (body.cwd || '').trim()
  if (!name) return json({ error: 'missing_name' }, 400)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) {
    return json(
      { error: 'invalid_name', message: 'name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,62}' },
      400,
    )
  }
  if (!cwd) return json({ error: 'missing_cwd' }, 400)
  if (getSessionByName(db, name)) {
    return json({ error: 'name_exists' }, 409)
  }
  const row = registerSession(db, name, cwd)
  return json({ token: row.token, name: row.name, cwd: row.cwd })
}

function authBearer(req: Request, db: Database): { name: string } | null {
  const token = req.headers.get('x-party-line-token')
  if (!token) return null
  const row = getSessionByToken(db, token)
  return row ? { name: row.name } : null
}

export async function handleCcplGetSession(
  req: Request,
  db: Database,
  name: string,
): Promise<Response> {
  const auth = authBearer(req, db)
  if (!auth || auth.name !== name) return json({ error: 'unauthorized' }, 401)
  const row = getSessionByName(db, name)
  if (!row) return json({ error: 'not_found' }, 404)
  return json({
    name: row.name,
    cwd: row.cwd,
    cc_session_uuid: row.cc_session_uuid,
    online: row.online,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
  })
}

export async function handleCcplRotate(
  req: Request,
  db: Database,
  name: string,
): Promise<Response> {
  const auth = authBearer(req, db)
  if (!auth || auth.name !== name) return json({ error: 'unauthorized' }, 401)
  const newToken = rotateToken(db, name)
  return json({ token: newToken })
}

export async function handleCcplForget(
  req: Request,
  db: Database,
  name: string,
): Promise<Response> {
  const auth = authBearer(req, db)
  if (!auth || auth.name !== name) return json({ error: 'unauthorized' }, 401)
  deleteSession(db, name)
  return json({ ok: true })
}

export async function handleCcplArchive(req: Request, db: Database): Promise<Response> {
  const auth = authBearer(req, db)
  if (!auth) return json({ error: 'unauthorized' }, 401)
  let body: { name?: string; reason?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  if (!body.name || body.name !== auth.name) return json({ error: 'unauthorized' }, 401)
  const row = getSessionByName(db, body.name)
  if (!row) return json({ error: 'not_found' }, 404)
  if (!row.cc_session_uuid) return json({ error: 'nothing_to_archive' }, 400)
  archiveSession(db, body.name, row.cc_session_uuid, body.reason || 'manual')
  return json({ ok: true })
}

export async function handleCcplList(req: Request, db: Database): Promise<Response> {
  // Auth is dashboard-cookie or token; here we require dashboard cookie via caller.
  const rows = listSessions(db).map((r) => ({
    name: r.name,
    cwd: r.cwd,
    cc_session_uuid: r.cc_session_uuid,
    online: r.online,
    revision: r.revision,
    created_at: r.created_at,
    last_active_at: r.last_active_at,
  }))
  return json({ sessions: rows })
}

export async function handleCcplCleanup(req: Request, db: Database): Promise<Response> {
  let body: { older_than_ms?: number; dry_run?: boolean }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const older = body.older_than_ms ?? 30 * 24 * 60 * 60 * 1000
  const cutoff = Date.now() - older
  if (body.dry_run) {
    const rows = (
      db
        .query(`SELECT name FROM ccpl_sessions WHERE online = 0 AND last_active_at < ?`)
        .all(cutoff) as { name: string }[]
    ).map((r) => r.name)
    return json({ would_remove: rows })
  }
  const removed = pruneInactive(db, cutoff)
  return json({ removed })
}
```

- [ ] **Step 2: Write tests**

Create `tests/ccpl-api.test.ts`:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { openDb } from '../src/storage/db'
import type { Database } from 'bun:sqlite'
import {
  handleCcplRegister,
  handleCcplGetSession,
  handleCcplRotate,
  handleCcplForget,
  handleCcplArchive,
  handleCcplList,
  handleCcplCleanup,
} from '../src/server/ccpl-api'
import { updateSessionOnConnect } from '../src/storage/ccpl-queries'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function withToken(req: Request, token: string): Request {
  const h = new Headers(req.headers)
  h.set('X-Party-Line-Token', token)
  return new Request(req.url, { method: req.method, body: req.body, headers: h })
}

describe('ccpl-api', () => {
  let db: Database
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pl-api-'))
    db = openDb(join(tmp, 't.db'))
  })

  function cleanup() {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  }

  test('register happy path', async () => {
    const res = await handleCcplRegister(
      postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }),
      db,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; name: string; cwd: string }
    expect(body.name).toBe('foo')
    expect(body.token).toMatch(/^[a-f0-9]{64}$/)
    cleanup()
  })

  test('register rejects duplicate name', async () => {
    await handleCcplRegister(postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }), db)
    const res = await handleCcplRegister(
      postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }),
      db,
    )
    expect(res.status).toBe(409)
    cleanup()
  })

  test('register rejects invalid name', async () => {
    const res = await handleCcplRegister(
      postJson('/ccpl/register', { name: '../../evil', cwd: '/tmp' }),
      db,
    )
    expect(res.status).toBe(400)
    cleanup()
  })

  test('getSession requires matching token', async () => {
    const reg = (await (
      await handleCcplRegister(postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }), db)
    ).json()) as { token: string }

    const unauth = await handleCcplGetSession(
      new Request('http://localhost/ccpl/session/foo'),
      db,
      'foo',
    )
    expect(unauth.status).toBe(401)

    const ok = await handleCcplGetSession(
      withToken(new Request('http://localhost/ccpl/session/foo'), reg.token),
      db,
      'foo',
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { name: string }
    expect(body.name).toBe('foo')
    cleanup()
  })

  test('rotate returns new token and old is invalidated', async () => {
    const reg = (await (
      await handleCcplRegister(postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }), db)
    ).json()) as { token: string }
    const rot = await handleCcplRotate(
      withToken(
        new Request('http://localhost/ccpl/session/foo/rotate', { method: 'POST' }),
        reg.token,
      ),
      db,
      'foo',
    )
    expect(rot.status).toBe(200)
    const { token: newToken } = (await rot.json()) as { token: string }
    expect(newToken).not.toBe(reg.token)

    const withOld = await handleCcplGetSession(
      withToken(new Request('http://localhost/ccpl/session/foo'), reg.token),
      db,
      'foo',
    )
    expect(withOld.status).toBe(401)
    cleanup()
  })

  test('forget removes the row', async () => {
    const reg = (await (
      await handleCcplRegister(postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }), db)
    ).json()) as { token: string }
    await handleCcplForget(
      withToken(new Request('http://localhost/ccpl/session/foo', { method: 'DELETE' }), reg.token),
      db,
      'foo',
    )
    const get = await handleCcplGetSession(
      withToken(new Request('http://localhost/ccpl/session/foo'), reg.token),
      db,
      'foo',
    )
    expect(get.status).toBe(401) // token no longer valid; row gone
    cleanup()
  })

  test('archive moves current uuid to archives', async () => {
    const reg = (await (
      await handleCcplRegister(postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }), db)
    ).json()) as { token: string }
    updateSessionOnConnect(db, 'foo', 'uuid-1', 1, 'm')
    const res = await handleCcplArchive(
      withToken(postJson('/ccpl/archive', { name: 'foo', reason: 'jsonl_missing' }), reg.token),
      db,
    )
    expect(res.status).toBe(200)
    const archives = db.query(`SELECT * FROM ccpl_archives`).all() as any[]
    expect(archives.length).toBe(1)
    expect(archives[0].old_uuid).toBe('uuid-1')
    cleanup()
  })

  test('list returns all sessions', async () => {
    await handleCcplRegister(postJson('/ccpl/register', { name: 'a', cwd: '/tmp' }), db)
    await handleCcplRegister(postJson('/ccpl/register', { name: 'b', cwd: '/tmp' }), db)
    const res = await handleCcplList(new Request('http://localhost/ccpl/sessions'), db)
    const { sessions } = (await res.json()) as { sessions: { name: string }[] }
    expect(sessions.map((s) => s.name).sort()).toEqual(['a', 'b'])
    cleanup()
  })

  test('cleanup dry-run lists candidates', async () => {
    await handleCcplRegister(postJson('/ccpl/register', { name: 'old', cwd: '/tmp' }), db)
    db.query(`UPDATE ccpl_sessions SET last_active_at = 1 WHERE name = 'old'`).run()
    const res = await handleCcplCleanup(
      postJson('/ccpl/cleanup', { older_than_ms: 1000, dry_run: true }),
      db,
    )
    const { would_remove } = (await res.json()) as { would_remove: string[] }
    expect(would_remove).toContain('old')
    cleanup()
  })
})
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/ccpl-api.test.ts`
Expected: all 9 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/server/ccpl-api.ts tests/ccpl-api.test.ts
git commit -m "feat(server): HTTP API for ccpl session lifecycle

Endpoints: POST /ccpl/register, GET /ccpl/session/:name,
POST /ccpl/session/:name/rotate, DELETE /ccpl/session/:name,
POST /ccpl/archive, GET /ccpl/sessions, POST /ccpl/cleanup.
Token auth via X-Party-Line-Token header. Spec §2.5, §2.6."
```

---

## Task C5: Mount auth + ccpl-api on the dashboard server

**Files:**

- Modify: `dashboard/serve.ts`
- Create: `dashboard/login.html`
- Create: `dashboard/login.js`

- [ ] **Step 1: Create the login page HTML**

`dashboard/login.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Party Line — Sign In</title>
    <link rel="stylesheet" href="/dashboard.css" />
  </head>
  <body class="login-body">
    <main class="login-card">
      <h1>🔔 Party Line</h1>
      <form id="login-form">
        <label>
          Password
          <input
            type="password"
            name="password"
            autocomplete="current-password"
            required
            autofocus
          />
        </label>
        <button type="submit">Sign in</button>
        <p id="login-error" class="login-error" hidden></p>
      </form>
    </main>
    <script src="/login.js" type="module"></script>
  </body>
</html>
```

Append to `dashboard/dashboard.css`:

```css
.login-body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: #0d1117;
}
.login-card {
  background: #1f2937;
  padding: 24px 32px;
  border-radius: 8px;
  min-width: 320px;
  color: #e2e8f0;
}
.login-card h1 {
  margin: 0 0 16px;
  text-align: center;
}
.login-card form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.login-card label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.login-card input {
  padding: 8px;
  border: 1px solid #374151;
  background: #0d1117;
  color: #e2e8f0;
  border-radius: 4px;
}
.login-card button {
  padding: 8px;
  background: #3fb950;
  color: #0d1117;
  border: none;
  border-radius: 4px;
  font-weight: 600;
  cursor: pointer;
}
.login-error {
  color: #f85149;
  font-size: 12px;
  margin: 0;
}
```

- [ ] **Step 2: Create the login JS**

`dashboard/login.js`:

```js
const form = document.getElementById('login-form')
const errorEl = document.getElementById('login-error')

form.addEventListener('submit', async (ev) => {
  ev.preventDefault()
  errorEl.hidden = true
  const password = new FormData(form).get('password')
  const res = await fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    credentials: 'same-origin',
  })
  if (res.ok) {
    const next = new URL(location.href).searchParams.get('next') || '/'
    location.href = next
  } else {
    errorEl.textContent = 'Incorrect password'
    errorEl.hidden = false
  }
})
```

- [ ] **Step 3: Wire routes and auth middleware in `dashboard/serve.ts`**

Add imports at the top of `dashboard/serve.ts`:

```ts
import {
  verifyPassword,
  mintCookie,
  verifyCookie,
  revokeCookie,
  parseCookieHeader,
  cookieHeaderForSet,
  cookieHeaderForClear,
  isAuthDisabled,
  pruneExpiredCookies,
} from '../src/server/auth'
import {
  handleCcplRegister,
  handleCcplGetSession,
  handleCcplRotate,
  handleCcplForget,
  handleCcplArchive,
  handleCcplList,
  handleCcplCleanup,
} from '../src/server/ccpl-api'
```

Before the main route dispatch, add an auth-check helper:

```ts
function isAuthed(req: Request): boolean {
  if (isAuthDisabled()) return true
  const cookie = parseCookieHeader(req.headers.get('cookie'))
  return verifyCookie(db, cookie)
}

function requireAuth(req: Request): Response | null {
  if (isAuthed(req)) return null
  const accept = req.headers.get('accept') ?? ''
  if (accept.includes('text/html')) {
    const next = new URL(req.url).pathname
    return new Response(null, {
      status: 302,
      headers: { location: `/login?next=${encodeURIComponent(next)}` },
    })
  }
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

In the main fetch handler, add routes (place BEFORE the catch-all):

```ts
// --- Auth routes (unauthenticated) ---
if (url.pathname === '/login' && req.method === 'POST') {
  const body = (await req.json().catch(() => ({}))) as { password?: string }
  if (!verifyPassword(body.password || '')) {
    return new Response(JSON.stringify({ error: 'invalid_password' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const cookie = mintCookie(db)
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieHeaderForSet(cookie),
    },
  })
}

if (url.pathname === '/login' && req.method === 'GET') {
  return new Response(Bun.file(resolve(import.meta.dir, 'login.html')), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

if (url.pathname === '/login.js') {
  return new Response(Bun.file(resolve(import.meta.dir, 'login.js')), {
    headers: { 'Content-Type': 'application/javascript' },
  })
}

if (url.pathname === '/logout' && req.method === 'POST') {
  const c = parseCookieHeader(req.headers.get('cookie'))
  if (c) revokeCookie(db, c)
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': cookieHeaderForClear() },
  })
}

// --- ccpl HTTP API (X-Party-Line-Token auth, not cookie) ---
if (url.pathname === '/ccpl/register' && req.method === 'POST') {
  return handleCcplRegister(req, db)
}
if (url.pathname === '/ccpl/archive' && req.method === 'POST') {
  return handleCcplArchive(req, db)
}
if (url.pathname === '/ccpl/cleanup' && req.method === 'POST') {
  // Admin op; require dashboard cookie.
  const unauth = requireAuth(req)
  if (unauth) return unauth
  return handleCcplCleanup(req, db)
}
if (url.pathname === '/ccpl/sessions' && req.method === 'GET') {
  const unauth = requireAuth(req)
  if (unauth) return unauth
  return handleCcplList(req, db)
}

const sessMatch = url.pathname.match(/^\/ccpl\/session\/([^/]+)\/rotate$/)
if (sessMatch && req.method === 'POST') {
  return handleCcplRotate(req, db, decodeURIComponent(sessMatch[1]))
}
const getMatch = url.pathname.match(/^\/ccpl\/session\/([^/]+)$/)
if (getMatch) {
  if (req.method === 'GET') return handleCcplGetSession(req, db, decodeURIComponent(getMatch[1]))
  if (req.method === 'DELETE') return handleCcplForget(req, db, decodeURIComponent(getMatch[1]))
}

// --- Authenticated dashboard routes (existing ones) below this point ---
const unauth = requireAuth(req)
if (unauth) return unauth
// ...existing route handling continues...
```

Add a periodic cookie cleanup (once per hour):

```ts
setInterval(() => pruneExpiredCookies(db), 60 * 60 * 1000).unref()
```

- [ ] **Step 4: Manual test**

Start the dashboard with `PARTY_LINE_DASHBOARD_PASSWORD=test`:

```bash
PARTY_LINE_DASHBOARD_PASSWORD=test PARTY_LINE_DASHBOARD_SECRET=$(openssl rand -hex 32) bun dashboard/serve.ts --port 3400
```

Open `http://localhost:3400/`. Expected: redirected to `/login?next=%2F`. Enter password. Expected: redirected to `/` and dashboard loads.

Test API: `curl -s http://localhost:3400/ccpl/register -X POST -H 'content-type: application/json' -d '{"name":"testfoo","cwd":"/tmp"}' | jq`
Expected: JSON with `token`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/serve.ts dashboard/login.html dashboard/login.js dashboard/dashboard.css
git commit -m "feat(server): mount auth + ccpl HTTP API on dashboard server

GET/POST /login, POST /logout, POST /ccpl/register, and the rest
of the /ccpl/* endpoints. Cookie-auth guards dashboard routes;
X-Party-Line-Token guards per-session ccpl endpoints. Spec §2.5, §2.6."
```

---

## Task C6: Remove `seq` + `Deduplicator` from `types.ts` and `protocol.ts`

**Files:**

- Modify: `src/types.ts`
- Modify: `src/protocol.ts`
- Modify: any caller that reads `seq` or imports `Deduplicator`
- Modify: `tests/protocol.test.ts` — drop dedup tests

- [ ] **Step 1: Find callers**

```bash
grep -rn "seq:" src/ dashboard/ tests/ | head -20
grep -rn "Deduplicator" src/ dashboard/ tests/
grep -rn "sequenceCounter" src/ dashboard/ tests/
```

- [ ] **Step 2: Drop `seq` from `Envelope` type**

In `src/types.ts`, find the `Envelope` interface/type and remove the `seq: number` field. Any type that references `seq` (e.g., `createEnvelope` signature) loses the arg too.

- [ ] **Step 3: Remove `Deduplicator` from `src/protocol.ts`**

Delete the `Deduplicator` class, the `sequenceCounter` variable, and any `seq` logic in `createEnvelope`. Keep `generateId`, `generateCallbackId`, and any remaining envelope helpers.

- [ ] **Step 4: Update all callers**

For each match from Step 1, remove the `seq` field from envelope construction/read. Most places can just delete the line or the property access.

If `dashboard/cli.ts` or any view prints `seq` — remove those references.

- [ ] **Step 5: Drop dedup tests**

In `tests/protocol.test.ts`, delete any test that exercises `Deduplicator` or `seq`. Keep envelope-shape tests.

- [ ] **Step 6: Run tests**

Run: `bun test`
Expected: all pass (with the dedup tests removed).

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ dashboard/ tests/
git commit -m "refactor(protocol): drop seq field and Deduplicator

The seq counter was never validated or used, and dedup was a UDP-layer
concern that the hub-and-spoke transport doesn't need (server assigns
unique ids). Closes audit S2 + S4."
```

---

## Task C7: Build the outbound WS client (`ws-client.ts`)

**Files:**

- Create: `src/transport/ws-client.ts`
- Test: `tests/ws-client.test.ts`

- [ ] **Step 1: Write the client**

```ts
import { EventEmitter } from 'node:events'

export interface HelloPayload {
  type: 'hello'
  token: string
  name: string
  cc_session_uuid: string | null
  pid: number
  machine_id: string | null
  version: string
}

export interface WsClientOpts {
  url: string
  helloPayload: HelloPayload
  pingIntervalMs?: number
  reconnectInitialMs?: number
  reconnectMaxMs?: number
  logger?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export interface WsClient extends EventEmitter {
  start(): void
  stop(): void
  send(frame: unknown): void
  isConnected(): boolean
}

export function createWsClient(opts: WsClientOpts): WsClient {
  const emitter = new EventEmitter() as WsClient
  let ws: WebSocket | null = null
  let pingTimer: Timer | null = null
  let reconnectTimer: Timer | null = null
  let reconnectDelay = opts.reconnectInitialMs ?? 100
  let stopped = false
  const log = opts.logger ?? (() => {})

  function setPingTimer() {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
        } catch {}
      }
    }, opts.pingIntervalMs ?? 20_000)
  }

  function scheduleReconnect() {
    if (stopped) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, opts.reconnectMaxMs ?? 30_000)
  }

  function connect() {
    if (stopped) return
    try {
      ws = new WebSocket(opts.url)
    } catch (err) {
      log('error', `ws construct failed: ${err}`)
      scheduleReconnect()
      return
    }

    ws.addEventListener('open', () => {
      log('info', `ws open to ${opts.url}`)
      reconnectDelay = opts.reconnectInitialMs ?? 100
      try {
        ws!.send(JSON.stringify(opts.helloPayload))
      } catch (err) {
        log('error', `hello send failed: ${err}`)
      }
      setPingTimer()
      emitter.emit('open')
    })

    ws.addEventListener('message', (e) => {
      let data: any
      try {
        data = JSON.parse(e.data as string)
      } catch {
        log('warn', 'non-JSON frame dropped')
        return
      }
      emitter.emit('frame', data)
      emitter.emit(data.type, data)
    })

    ws.addEventListener('close', (e) => {
      log('warn', `ws close code=${e.code} reason=${e.reason}`)
      if (pingTimer) {
        clearInterval(pingTimer)
        pingTimer = null
      }
      emitter.emit('close', e.code, e.reason)
      // Don't reconnect on permanent failures.
      if (e.code === 4401 || e.code === 4408) {
        log('error', `permanent ws close, not reconnecting (code ${e.code})`)
        stopped = true
        return
      }
      scheduleReconnect()
    })

    ws.addEventListener('error', (e) => {
      log('warn', `ws error: ${e}`)
    })
  }

  emitter.start = () => {
    stopped = false
    connect()
  }
  emitter.stop = () => {
    stopped = true
    if (pingTimer) clearInterval(pingTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (ws) ws.close()
  }
  emitter.send = (frame: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('ws not open')
    }
    ws.send(JSON.stringify(frame))
  }
  emitter.isConnected = () => ws !== null && ws.readyState === WebSocket.OPEN

  return emitter
}
```

- [ ] **Step 2: Write tests**

Create `tests/ws-client.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { createWsClient } from '../src/transport/ws-client'

describe('ws-client', () => {
  test('connects to a local WS server, sends hello, receives echo', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req)) return
        return new Response('no', { status: 400 })
      },
      websocket: {
        open(ws) {},
        message(ws, msg) {
          const frame = JSON.parse(String(msg))
          if (frame.type === 'hello') {
            ws.send(JSON.stringify({ type: 'accepted', server_time: Date.now() }))
          }
        },
      },
    })

    const url = `ws://localhost:${server.port}/`
    const frames: any[] = []
    const client = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: 't',
        name: 'foo',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'test',
      },
      pingIntervalMs: 60_000,
    })
    client.on('frame', (f) => frames.push(f))
    client.start()

    // Wait for accepted frame.
    for (let i = 0; i < 50 && frames.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(frames[0].type).toBe('accepted')

    client.stop()
    server.stop()
  })

  test('reconnects after server drop', async () => {
    let openCount = 0
    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req)) return
        return new Response('no', { status: 400 })
      },
      websocket: {
        open(ws) {
          openCount++
          // Close the first connection to force reconnect.
          if (openCount === 1) setTimeout(() => ws.close(), 50)
        },
        message() {},
      },
    })
    const url = `ws://localhost:${server.port}/`
    const client = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: 't',
        name: 'r',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'test',
      },
      pingIntervalMs: 60_000,
      reconnectInitialMs: 30,
      reconnectMaxMs: 100,
    })
    client.start()
    for (let i = 0; i < 50 && openCount < 2; i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(openCount).toBeGreaterThanOrEqual(2)
    client.stop()
    server.stop()
  })

  test('does NOT reconnect on close code 4401', async () => {
    let openCount = 0
    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req)) return
        return new Response('no', { status: 400 })
      },
      websocket: {
        open(ws) {
          openCount++
          setTimeout(() => ws.close(4401, 'invalid_token'), 30)
        },
        message() {},
      },
    })
    const url = `ws://localhost:${server.port}/`
    const client = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: 'bad',
        name: 'r',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'test',
      },
      pingIntervalMs: 60_000,
      reconnectInitialMs: 30,
    })
    client.start()
    await new Promise((r) => setTimeout(r, 300))
    expect(openCount).toBe(1)
    client.stop()
    server.stop()
  })
})
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/ws-client.test.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/transport/ws-client.ts tests/ws-client.test.ts
git commit -m "feat(transport): WebSocket client with reconnect + ping + hello

Exponential backoff (100ms → 30s), 20s ping, hello-on-open.
Does NOT reconnect on close codes 4401 (invalid_token) or 4408
(superseded) — permanent failures require human intervention.
Spec §2.3, §3.4."
```

---

## Task C8: Switchboard routing layer

**Files:**

- Create: `src/server/switchboard.ts`
- Test: `tests/switchboard.test.ts`

The switchboard owns in-memory maps of connected sessions + observer clients, routes envelopes, persists messages, and emits `session-delta` frames.

- [ ] **Step 1: Write the routing layer**

```ts
import type { Database } from 'bun:sqlite'
import type { ServerWebSocket } from 'bun'
import {
  getSessionByToken,
  getSessionByName,
  updateSessionOnConnect,
  markSessionOffline,
  archiveSession,
  insertMessage,
  listSessions,
  type CcplSessionRow,
} from '../storage/ccpl-queries'
import { randomBytes } from 'node:crypto'

type SessionSocket = ServerWebSocket<{ kind: 'session'; name: string; token: string }>
type ObserverSocket = ServerWebSocket<{ kind: 'observer' }>

export interface Switchboard {
  handleSessionHello(
    ws: SessionSocket,
    frame: {
      token: string
      name: string
      cc_session_uuid: string | null
      pid: number
      machine_id: string | null
    },
  ): { ok: boolean; error?: string; code?: number }
  handleSessionFrame(ws: SessionSocket, frame: any): void
  handleSessionClose(ws: SessionSocket): void
  handleObserverOpen(ws: ObserverSocket): void
  handleObserverFrame(ws: ObserverSocket, frame: any): void
  handleObserverClose(ws: ObserverSocket): void
  broadcastObserverFrame(frame: unknown): void
}

export function createSwitchboard(db: Database): Switchboard {
  const sessionsByName = new Map<string, SessionSocket>()
  const observers = new Set<ObserverSocket>()

  function serverId(): string {
    return randomBytes(8).toString('hex')
  }

  function toObservers(frame: unknown): void {
    const payload = JSON.stringify(frame)
    for (const o of observers) {
      try {
        o.send(payload)
      } catch {}
    }
  }

  function emitSessionDelta(row: CcplSessionRow, changes: Record<string, unknown>): void {
    toObservers({
      type: 'session-delta',
      session: row.name,
      revision: row.revision,
      changes,
    })
  }

  function routeEnvelope(envelope: {
    id: string
    ts: number
    from: string
    to: string
    type: string
    body: string | null
    callback_id: string | null
    response_to: string | null
  }): void {
    // Persist.
    insertMessage(db, {
      id: envelope.id,
      ts: envelope.ts,
      from_name: envelope.from,
      to_name: envelope.to,
      type: envelope.type,
      body: envelope.body,
      callback_id: envelope.callback_id,
      response_to: envelope.response_to,
      cc_session_uuid: null,
    })

    // Deliver to recipient(s).
    const deliverTo = (name: string) => {
      const target = sessionsByName.get(name)
      if (target) {
        try {
          target.send(JSON.stringify({ type: 'envelope', ...envelope }))
        } catch {}
      }
    }

    if (envelope.to === 'all') {
      for (const [name, sock] of sessionsByName) {
        if (name === envelope.from) continue
        try {
          sock.send(JSON.stringify({ type: 'envelope', ...envelope }))
        } catch {}
      }
    } else {
      for (const part of envelope.to.split(',').map((s) => s.trim())) {
        if (part) deliverTo(part)
      }
    }

    // Broadcast to observers.
    toObservers({ type: 'envelope', ...envelope })
  }

  return {
    handleSessionHello(ws, frame) {
      const row = getSessionByToken(db, frame.token)
      if (!row) return { ok: false, error: 'invalid_token', code: 4401 }
      if (row.name !== frame.name) return { ok: false, error: 'name_mismatch', code: 4401 }

      // Supersede any existing connection for this name.
      const existing = sessionsByName.get(row.name)
      if (existing && existing !== ws) {
        try {
          existing.send(JSON.stringify({ type: 'error', code: 'superseded' }))
          existing.close(4408, 'superseded')
        } catch {}
      }

      // UUID drift: if row had a different UUID, archive it.
      if (
        row.cc_session_uuid &&
        frame.cc_session_uuid &&
        row.cc_session_uuid !== frame.cc_session_uuid
      ) {
        archiveSession(db, row.name, row.cc_session_uuid, 'reconnect_different_uuid')
      }

      updateSessionOnConnect(db, row.name, frame.cc_session_uuid, frame.pid, frame.machine_id)
      ws.data.name = row.name
      ws.data.token = row.token
      sessionsByName.set(row.name, ws)

      const fresh = getSessionByName(db, row.name)!
      emitSessionDelta(fresh, {
        online: true,
        cc_session_uuid: fresh.cc_session_uuid,
      })

      return { ok: true }
    },

    handleSessionFrame(ws, frame) {
      const name = ws.data.name
      if (!name) return // Should never happen — hello must succeed first.

      switch (frame.type) {
        case 'ping':
          try {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
          } catch {}
          return
        case 'uuid-rotate': {
          const row = getSessionByName(db, name)
          if (!row) return
          if (row.cc_session_uuid && frame.old_uuid && row.cc_session_uuid === frame.old_uuid) {
            archiveSession(db, name, frame.old_uuid, 'clear')
          }
          updateSessionOnConnect(db, name, frame.new_uuid, row.pid, row.machine_id)
          const fresh = getSessionByName(db, name)!
          emitSessionDelta(fresh, { cc_session_uuid: fresh.cc_session_uuid })
          return
        }
        case 'send':
        case 'respond': {
          const id = serverId()
          const envelope = {
            id,
            ts: Date.now(),
            from: name,
            to: String(frame.to || ''),
            type: frame.frame_type || 'message',
            body: frame.body ?? null,
            callback_id: frame.callback_id ?? null,
            response_to: frame.response_to ?? null,
          }
          routeEnvelope(envelope)
          try {
            ws.send(JSON.stringify({ type: 'sent', client_ref: frame.client_ref, id }))
          } catch {}
          return
        }
        case 'permission-response': {
          // Broadcast to observers so the UI can resolve the card, and route
          // back to the originator if we know who that was.
          toObservers({
            type: 'permission-resolved',
            session: name,
            request_id: frame.request_id,
            decision: frame.decision,
          })
          return
        }
        default:
          // Unknown frames are silently dropped.
          return
      }
    },

    handleSessionClose(ws) {
      const name = ws.data.name
      if (!name) return
      const current = sessionsByName.get(name)
      if (current === ws) {
        sessionsByName.delete(name)
        markSessionOffline(db, name)
        const fresh = getSessionByName(db, name)
        if (fresh) emitSessionDelta(fresh, { online: false })
      }
    },

    handleObserverOpen(ws) {
      observers.add(ws)
      // Send handshake snapshot.
      const rows = listSessions(db)
      try {
        ws.send(
          JSON.stringify({
            type: 'sessions-snapshot',
            sessions: rows.map((r) => ({
              name: r.name,
              cwd: r.cwd,
              cc_session_uuid: r.cc_session_uuid,
              online: r.online,
              revision: r.revision,
            })),
          }),
        )
      } catch {}
    },

    handleObserverFrame(ws, frame) {
      if (frame.type === 'ping') {
        try {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
        } catch {}
      } else if (frame.type === 'session-viewed') {
        toObservers({ type: 'notification-dismiss', session: frame.session })
      }
    },

    handleObserverClose(ws) {
      observers.delete(ws)
    },

    broadcastObserverFrame(frame) {
      toObservers(frame)
    },
  }
}
```

- [ ] **Step 2: Write tests**

Create `tests/switchboard.test.ts`:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { openDb } from '../src/storage/db'
import { registerSession } from '../src/storage/ccpl-queries'
import { createSwitchboard } from '../src/server/switchboard'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function fakeWs(kind: 'session' | 'observer') {
  const sent: string[] = []
  const closeCalls: [number | undefined, string | undefined][] = []
  return {
    sent,
    closeCalls,
    data: { kind } as any,
    send(msg: string) {
      sent.push(msg)
    },
    close(code?: number, reason?: string) {
      closeCalls.push([code, reason])
    },
  } as any
}

describe('switchboard', () => {
  let db: Database
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pl-sw-'))
    db = openDb(join(tmp, 't.db'))
  })

  test('hello with valid token marks session online and emits session-delta', () => {
    const row = registerSession(db, 'foo', '/tmp')
    const sb = createSwitchboard(db)
    const ws = fakeWs('session')
    const obs = fakeWs('observer')
    sb.handleObserverOpen(obs)
    const res = sb.handleSessionHello(ws, {
      token: row.token,
      name: 'foo',
      cc_session_uuid: 'uuid-1',
      pid: 123,
      machine_id: 'm',
    })
    expect(res.ok).toBe(true)
    expect(obs.sent.length).toBeGreaterThanOrEqual(2) // snapshot + delta
    const delta = obs.sent.map((s) => JSON.parse(s)).find((f) => f.type === 'session-delta')
    expect(delta).toBeDefined()
    expect(delta.session).toBe('foo')
    expect(delta.changes.online).toBe(true)
  })

  test('hello with bad token returns 4401', () => {
    const sb = createSwitchboard(db)
    const res = sb.handleSessionHello(fakeWs('session'), {
      token: 'nope',
      name: 'foo',
      cc_session_uuid: null,
      pid: 1,
      machine_id: null,
    })
    expect(res.ok).toBe(false)
    expect(res.code).toBe(4401)
  })

  test('second hello for same name supersedes first (close 4408)', () => {
    const row = registerSession(db, 'foo', '/tmp')
    const sb = createSwitchboard(db)
    const first = fakeWs('session')
    sb.handleSessionHello(first, {
      token: row.token,
      name: 'foo',
      cc_session_uuid: null,
      pid: 1,
      machine_id: null,
    })
    const second = fakeWs('session')
    sb.handleSessionHello(second, {
      token: row.token,
      name: 'foo',
      cc_session_uuid: null,
      pid: 2,
      machine_id: null,
    })
    expect(first.closeCalls[0][0]).toBe(4408)
  })

  test('send routes to recipient and observer, returns sent ack', () => {
    const a = registerSession(db, 'a', '/tmp')
    const b = registerSession(db, 'b', '/tmp')
    const sb = createSwitchboard(db)
    const wsA = fakeWs('session')
    const wsB = fakeWs('session')
    const obs = fakeWs('observer')
    sb.handleObserverOpen(obs)
    sb.handleSessionHello(wsA, {
      token: a.token,
      name: 'a',
      cc_session_uuid: null,
      pid: 1,
      machine_id: null,
    })
    sb.handleSessionHello(wsB, {
      token: b.token,
      name: 'b',
      cc_session_uuid: null,
      pid: 2,
      machine_id: null,
    })

    obs.sent.length = 0
    wsA.sent.length = 0
    wsB.sent.length = 0

    sb.handleSessionFrame(wsA, {
      type: 'send',
      to: 'b',
      body: 'hello',
      client_ref: 'c1',
    })

    const ack = wsA.sent.map((s: string) => JSON.parse(s)).find((f: any) => f.type === 'sent')
    expect(ack).toBeDefined()
    expect(ack.client_ref).toBe('c1')
    const delivery = wsB.sent
      .map((s: string) => JSON.parse(s))
      .find((f: any) => f.type === 'envelope')
    expect(delivery).toBeDefined()
    expect(delivery.body).toBe('hello')
    expect(delivery.from).toBe('a')
    expect(delivery.to).toBe('b')

    const obsEnvelope = obs.sent
      .map((s: string) => JSON.parse(s))
      .find((f: any) => f.type === 'envelope')
    expect(obsEnvelope).toBeDefined()
  })

  test('session close marks offline and emits delta', () => {
    const row = registerSession(db, 'foo', '/tmp')
    const sb = createSwitchboard(db)
    const ws = fakeWs('session')
    const obs = fakeWs('observer')
    sb.handleObserverOpen(obs)
    sb.handleSessionHello(ws, {
      token: row.token,
      name: 'foo',
      cc_session_uuid: null,
      pid: 1,
      machine_id: null,
    })
    obs.sent.length = 0

    sb.handleSessionClose(ws)
    const delta = obs.sent.map((s) => JSON.parse(s)).find((f) => f.type === 'session-delta')
    expect(delta).toBeDefined()
    expect(delta.changes.online).toBe(false)
  })

  test('uuid-rotate archives old uuid and updates current', () => {
    const row = registerSession(db, 'foo', '/tmp')
    const sb = createSwitchboard(db)
    const ws = fakeWs('session')
    sb.handleSessionHello(ws, {
      token: row.token,
      name: 'foo',
      cc_session_uuid: 'uuid-1',
      pid: 1,
      machine_id: null,
    })
    sb.handleSessionFrame(ws, {
      type: 'uuid-rotate',
      old_uuid: 'uuid-1',
      new_uuid: 'uuid-2',
    })
    const archives = db.query(`SELECT * FROM ccpl_archives WHERE name = ?`).all('foo') as any[]
    expect(archives.length).toBe(1)
    expect(archives[0].old_uuid).toBe('uuid-1')
    expect(archives[0].reason).toBe('clear')
  })
})
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/switchboard.test.ts`
Expected: all 6 pass.

- [ ] **Step 4: Commit**

```bash
git add src/server/switchboard.ts tests/switchboard.test.ts
git commit -m "feat(server): switchboard routing layer

Manages sessionsByName + observers maps. Hello validation, uuid-rotate
archive, send routing with persistence + observer broadcast,
supersede-old-connection on duplicate hello, offline delta on close.
Spec §3.2, §3.3."
```

---

## Task C9: Mount `/ws/session` + `/ws/observer` endpoints

**Files:**

- Modify: `dashboard/serve.ts`

- [ ] **Step 1: Instantiate switchboard and replace existing WS handlers**

In `dashboard/serve.ts`, import and create a switchboard:

```ts
import { createSwitchboard } from '../src/server/switchboard'
const switchboard = createSwitchboard(db)
```

Configure `Bun.serve`'s websocket handlers to route by `ws.data.kind`:

```ts
Bun.serve({
  port,
  ...tls,
  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrades
    if (url.pathname === '/ws/session') {
      if (server.upgrade(req, { data: { kind: 'session' } })) return
      return new Response('ws upgrade required', { status: 400 })
    }
    if (url.pathname === '/ws/observer') {
      const unauth = requireAuth(req)
      if (unauth) return new Response('unauthorized', { status: 401 })
      if (server.upgrade(req, { data: { kind: 'observer' } })) return
      return new Response('ws upgrade required', { status: 400 })
    }

    // ...existing HTTP route handling...
  },

  websocket: {
    idleTimeout: 30,
    open(ws) {
      if (ws.data.kind === 'observer') {
        switchboard.handleObserverOpen(ws as any)
      }
      // For 'session', we wait for hello frame before doing anything.
    },
    message(ws, raw) {
      let frame: any
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      if (ws.data.kind === 'session') {
        if (frame.type === 'hello') {
          const res = switchboard.handleSessionHello(ws as any, frame)
          if (!res.ok) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: res.error }))
            } catch {}
            ws.close(res.code ?? 4401, res.error ?? 'error')
            return
          }
          try {
            ws.send(JSON.stringify({ type: 'accepted', server_time: Date.now() }))
          } catch {}
        } else {
          switchboard.handleSessionFrame(ws as any, frame)
        }
      } else if (ws.data.kind === 'observer') {
        switchboard.handleObserverFrame(ws as any, frame)
      }
    },
    close(ws) {
      if (ws.data.kind === 'session') switchboard.handleSessionClose(ws as any)
      else if (ws.data.kind === 'observer') switchboard.handleObserverClose(ws as any)
    },
  },
})
```

Remove the previous single `/ws` endpoint and its `wsClients` set — it's superseded by the two typed endpoints.

- [ ] **Step 2: Manual round-trip via `ws-client.ts`**

Write an ad-hoc script `/tmp/hub-smoke.ts`:

```ts
import { openDb } from './src/storage/db'
import { registerSession } from './src/storage/ccpl-queries'
import { createWsClient } from './src/transport/ws-client'

const db = openDb(process.env.DB_PATH || process.env.HOME + '/.config/party-line/dashboard.db')
const a = registerSession(db, 'smokeA', '/tmp')
const b = registerSession(db, 'smokeB', '/tmp')
db.close()

const clientA = createWsClient({
  url: 'ws://localhost:3400/ws/session',
  helloPayload: {
    type: 'hello',
    token: a.token,
    name: 'smokeA',
    cc_session_uuid: null,
    pid: process.pid,
    machine_id: null,
    version: 'smoke',
  },
  logger: (l, m) => console.log(`[A:${l}]`, m),
})
const clientB = createWsClient({
  url: 'ws://localhost:3400/ws/session',
  helloPayload: {
    type: 'hello',
    token: b.token,
    name: 'smokeB',
    cc_session_uuid: null,
    pid: process.pid,
    machine_id: null,
    version: 'smoke',
  },
  logger: (l, m) => console.log(`[B:${l}]`, m),
})
clientB.on('envelope', (f) => console.log('[B] got', f))
clientA.on('accepted', () => {
  setTimeout(
    () => clientA.send({ type: 'send', to: 'smokeB', body: 'hi from A', client_ref: 'r1' }),
    200,
  )
})
clientA.start()
clientB.start()
setTimeout(() => {
  clientA.stop()
  clientB.stop()
  process.exit(0)
}, 2000)
```

Run the dashboard (if not already) then `bun /tmp/hub-smoke.ts`.
Expected: output shows `[B] got { type: 'envelope', from: 'smokeA', to: 'smokeB', body: 'hi from A', ... }`.

- [ ] **Step 3: Commit**

```bash
git add dashboard/serve.ts
git commit -m "feat(server): mount /ws/session + /ws/observer endpoints

Bun.serve.websocket handlers route by ws.data.kind to the switchboard
layer. idleTimeout: 30 for WS-layer staleness detection. /ws/observer
requires dashboard cookie. Spec §3."
```

---

## Task C10: Rewrite `src/server.ts` MCP plugin to use WS client

**Files:**

- Modify: `src/server.ts`

**Background:** The MCP plugin currently binds UDP. Replace with a WS client that holds the connection for the life of the plugin process. Tool calls (`party_line_send`, `party_line_request`, `party_line_respond`) translate into `send`/`respond` frames.

- [ ] **Step 1: Replace the transport setup**

At the top of the plugin's main entry, replace the UDP bootstrap with:

```ts
import { createWsClient } from './transport/ws-client'

const token = process.env.PARTY_LINE_TOKEN
if (!token) {
  console.error(
    '[party-line] PARTY_LINE_TOKEN not set — running in degraded mode (tool calls will fail)',
  )
}
const name = resolveNameFromProcessTree() // existing helper
const ccUuid = readCcSessionUuidFromIntrospect() // existing helper
const pid = process.pid
const machineId = readMachineId() // existing helper
const switchboardUrl = process.env.PARTY_LINE_SWITCHBOARD_URL || 'wss://localhost:3400/ws/session'

const ws = token
  ? createWsClient({
      url: switchboardUrl,
      helloPayload: {
        type: 'hello',
        token,
        name: name || 'unknown',
        cc_session_uuid: ccUuid,
        pid,
        machine_id: machineId,
        version: PARTY_LINE_VERSION,
      },
    })
  : null

ws?.start()

ws?.on('envelope', (frame) => {
  // Existing in-bound delivery hook: raise MCP notification to Claude Code.
  deliverEnvelopeToMcp(frame)
})
ws?.on('permission-request', (frame) => {
  deliverPermissionRequestToMcp(frame)
})
ws?.on('error', (f) => {
  console.error('[party-line] server error frame:', f)
})
ws?.on('close', (code) => {
  if (code === 4401)
    console.error('[party-line] invalid token — not reconnecting. Run `ccpl rotate <name>`.')
  if (code === 4408) console.error('[party-line] superseded by another connection.')
})
```

- [ ] **Step 2: Replace tool handlers' send paths**

For each tool handler that previously built a UDP envelope and called `transport.send(...)`, replace the body with:

```ts
// party_line_send
if (!ws) return toolErr('switchboard_unreachable', 'PARTY_LINE_TOKEN not set')
if (!ws.isConnected()) return toolErr('switchboard_unreachable', 'WS not connected')
const clientRef = generateClientRef()
ws.send({ type: 'send', to: args.to, body: args.body, client_ref: clientRef })
return { ok: true, client_ref: clientRef }
```

```ts
// party_line_respond
if (!ws) return toolErr('switchboard_unreachable', '...')
ws.send({
  type: 'respond',
  to: args.to,
  body: args.body,
  callback_id: args.callback_id,
  response_to: args.response_to,
  client_ref: generateClientRef(),
})
return { ok: true }
```

Remove any remaining calls into `transport/udp-multicast.ts`.

- [ ] **Step 3: JSONL-observer UUID rotation**

The plugin's existing JSONL observer already detects UUID changes. Wire it to emit:

```ts
onUuidChange: (oldUuid, newUuid) => {
  if (ws && ws.isConnected()) {
    ws.send({ type: 'uuid-rotate', old_uuid: oldUuid, new_uuid: newUuid })
  }
}
```

- [ ] **Step 4: Typecheck + smoke test**

Run: `bun run typecheck`
Expected: passes.

Manual test: start the dashboard, register a test session via `curl`, get the token, then start CC with `PARTY_LINE_TOKEN=<token> claude --name <name>`. In another terminal, send to that session via the dashboard. Verify the session receives + Claude wakes.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(mcp): replace UDP transport with WS client to switchboard

Plugin reads PARTY_LINE_TOKEN at startup, dials wss://.../ws/session,
holds the connection for the life of the process. Tool sends become
'send'/'respond' WS frames. UUID rotation events become 'uuid-rotate'
frames. Spec §2.3, §2.4."
```

---

## Task C11: Build `bin/ccpl` Bun CLI

**Files:**

- Create: `bin/ccpl`
- Delete: `ccpl` (the existing shell-script launcher, when the new CLI has feature parity)

- [ ] **Step 1: Write the CLI**

```ts
#!/usr/bin/env bun
// ccpl — Party Line session manager + launcher.

import { mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const SWITCHBOARD = process.env.PARTY_LINE_SWITCHBOARD_URL
  ? process.env.PARTY_LINE_SWITCHBOARD_URL.replace(/^wss?:\/\//, 'https://').replace(/\/ws.*$/, '')
  : 'https://localhost:3400'
const CFG_DIR = join(homedir(), '.config', 'party-line')
const SESS_DIR = join(CFG_DIR, 'sessions')

function tokenPath(name: string): string {
  return join(SESS_DIR, `${name}.token`)
}

function readToken(name: string): string | null {
  try {
    return readFileSync(tokenPath(name), 'utf8').trim()
  } catch {
    return null
  }
}

function writeToken(name: string, token: string): void {
  mkdirSync(SESS_DIR, { recursive: true, mode: 0o700 })
  chmodSync(SESS_DIR, 0o700)
  writeFileSync(tokenPath(name), token, { mode: 0o600 })
}

function removeToken(name: string): void {
  try {
    unlinkSync(tokenPath(name))
  } catch {}
}

function die(msg: string, code = 1): never {
  console.error(msg)
  process.exit(code)
}

async function api(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  if (token) headers.set('X-Party-Line-Token', token)
  // Allow self-signed certs for localhost dev.
  const res = await fetch(SWITCHBOARD + path, { ...init, headers })
  return res
}

async function cmdNew(name: string, cwdOverride?: string): Promise<void> {
  const cwd = cwdOverride ? resolve(cwdOverride) : process.cwd()
  const res = await api('/ccpl/register', {
    method: 'POST',
    body: JSON.stringify({ name, cwd }),
  })
  if (res.status === 409) die(`Session '${name}' already exists. Run 'ccpl forget ${name}' first.`)
  if (!res.ok) die(`Register failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { token: string }
  writeToken(name, body.token)
  console.log(`Registered '${name}' at ${cwd}. Token stored at ${tokenPath(name)}.`)
  console.log(`Run 'ccpl ${name}' to launch.`)
}

async function cmdLaunch(name: string): Promise<void> {
  const token = readToken(name)
  if (!token) die(`No session named '${name}'. Use 'ccpl new ${name}' to create it.`)
  const res = await api(`/ccpl/session/${encodeURIComponent(name)}`, {}, token)
  if (res.status === 401) die(`Token rejected for '${name}'. Try 'ccpl rotate ${name}'.`)
  if (!res.ok) die(`Lookup failed: ${res.status} ${await res.text()}`)
  const row = (await res.json()) as { cwd: string; cc_session_uuid: string | null }

  process.chdir(row.cwd)

  // Rename tmux window if applicable.
  if (process.env.TMUX) {
    spawn('tmux', ['rename-window', name], { stdio: 'ignore' })
  }

  // Decide resume vs fresh.
  const jsonlPath =
    row.cc_session_uuid &&
    join(
      homedir(),
      '.claude',
      'projects',
      row.cwd.replace(/\//g, '-').replace(/^-/, ''),
      row.cc_session_uuid + '.jsonl',
    )

  let launchArgs = ['--name', name]
  if (row.cc_session_uuid) {
    if (jsonlPath && existsSync(jsonlPath)) {
      launchArgs = ['--resume', row.cc_session_uuid, '--name', name]
    } else {
      // Prompt to archive and start fresh.
      const yes = await promptYn(
        `No resumable CC session for '${name}' (UUID ${row.cc_session_uuid} not found). Archive prior history and start fresh? [Y/n] `,
      )
      if (!yes) process.exit(0)
      const archRes = await api(
        `/ccpl/archive`,
        { method: 'POST', body: JSON.stringify({ name, reason: 'jsonl_missing' }) },
        token,
      )
      if (!archRes.ok) die(`Archive failed: ${archRes.status}`)
      // Fresh launch uses only --name.
    }
  }

  // Exec Claude Code with PARTY_LINE_TOKEN in env.
  const env = { ...process.env, PARTY_LINE_TOKEN: token }
  const child = spawn('claude', launchArgs, { stdio: 'inherit', env })
  child.on('exit', (code) => process.exit(code ?? 0))
}

function promptYn(q: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(q, (ans) => {
      rl.close()
      const a = ans.trim().toLowerCase()
      resolve(a === '' || a === 'y' || a === 'yes')
    })
  })
}

async function cmdList(asJson: boolean): Promise<void> {
  // Auth via dashboard cookie (we expect the user to have logged in via browser).
  // For CLI-only use, fall back to PARTY_LINE_DASHBOARD_PASSWORD exchange.
  const pw = process.env.PARTY_LINE_DASHBOARD_PASSWORD
  let cookie: string | null = null
  if (pw) {
    const login = await fetch(SWITCHBOARD + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    })
    if (login.ok) {
      const setCookie = login.headers.get('set-cookie') || ''
      const m = setCookie.match(/pl_dash=([^;]+)/)
      if (m) cookie = `pl_dash=${m[1]}`
    }
  }
  const res = await fetch(SWITCHBOARD + '/ccpl/sessions', {
    headers: cookie ? { cookie } : {},
  })
  if (!res.ok)
    die(
      `List failed: ${res.status}. Set PARTY_LINE_DASHBOARD_PASSWORD or log in via browser first.`,
    )
  const { sessions } = (await res.json()) as { sessions: any[] }
  if (asJson) {
    console.log(JSON.stringify(sessions, null, 2))
    return
  }
  console.log('NAME            STATE    CWD                                  CC_UUID')
  for (const s of sessions) {
    const state = s.online ? 'live' : 'offline'
    console.log(
      `${s.name.padEnd(15)} ${state.padEnd(8)} ${String(s.cwd).padEnd(36)} ${s.cc_session_uuid || '-'}`,
    )
  }
}

async function cmdForget(name: string): Promise<void> {
  const token = readToken(name)
  if (!token) {
    removeToken(name)
    console.log(`(no local token for '${name}'; nothing to remove)`)
    return
  }
  const res = await api(`/ccpl/session/${encodeURIComponent(name)}`, { method: 'DELETE' }, token)
  if (!res.ok) die(`Forget failed: ${res.status}`)
  removeToken(name)
  console.log(`Forgot '${name}'.`)
}

async function cmdRotate(name: string): Promise<void> {
  const token = readToken(name)
  if (!token) die(`No token on disk for '${name}'.`)
  const res = await api(
    `/ccpl/session/${encodeURIComponent(name)}/rotate`,
    { method: 'POST' },
    token,
  )
  if (!res.ok) die(`Rotate failed: ${res.status}`)
  const { token: newToken } = (await res.json()) as { token: string }
  writeToken(name, newToken)
  console.log(`Rotated token for '${name}'.`)
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2)
  if (!sub) die('Usage: ccpl (new|list|forget|rotate) <name> | ccpl <name>')
  if (sub === 'new') {
    const name = rest[0]
    if (!name) die('Usage: ccpl new <name> [--cwd DIR]')
    const cwdIdx = rest.indexOf('--cwd')
    const cwd = cwdIdx >= 0 ? rest[cwdIdx + 1] : undefined
    await cmdNew(name, cwd)
    return
  }
  if (sub === 'list') {
    await cmdList(rest.includes('--json'))
    return
  }
  if (sub === 'forget') {
    const name = rest[0]
    if (!name) die('Usage: ccpl forget <name>')
    await cmdForget(name)
    return
  }
  if (sub === 'rotate') {
    const name = rest[0]
    if (!name) die('Usage: ccpl rotate <name>')
    await cmdRotate(name)
    return
  }
  // Else treat sub as a session name to launch.
  await cmdLaunch(sub)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x bin/ccpl
```

- [ ] **Step 3: Add to PATH or install into `~/.local/bin`**

```bash
ln -sfn "$(pwd)/bin/ccpl" ~/.local/bin/ccpl
```

Verify: `which ccpl` → `~/.local/bin/ccpl`; `ccpl new --help` (will die with usage — expected).

- [ ] **Step 4: Manual end-to-end**

```bash
PARTY_LINE_SWITCHBOARD_URL=https://localhost:3400 ccpl new testses --cwd /tmp
ls -la ~/.config/party-line/sessions/testses.token
ccpl list --json
ccpl forget testses
```

Expected: register returns a token, `list` shows `testses` offline, `forget` removes it.

- [ ] **Step 5: Delete the old shell-script launcher**

Remove the shell-script `ccpl` (at repo root, if present). Update README or docs that reference it.

- [ ] **Step 6: Commit**

```bash
git add bin/ccpl
git rm -f ccpl
git commit -m "feat(ccpl): Bun CLI replaces shell-script launcher

Subcommands: new, list, forget, rotate, and bare <name> to launch.
Token files live at ~/.config/party-line/sessions/<name>.token (0600).
Reads PARTY_LINE_SWITCHBOARD_URL; defaults to https://localhost:3400.
Spec §2.5."
```

---

## Task C12: Rewrite `dashboard/monitor.ts` + `dashboard/cli.ts` to use `/ws/observer`

**Files:**

- Modify: `dashboard/monitor.ts`
- Modify: `dashboard/cli.ts`

- [ ] **Step 1: Rewrite `monitor.ts`**

Replace the UDP multicast binding with an observer WS client. Keep the public interface (`onMessage`, `onSessionDelta`, etc.) so `serve.ts` doesn't need changes after this — but `serve.ts` already uses the in-process switchboard, so monitor.ts is now CLI-only. Simplification: monitor.ts becomes a thin `createWsClient` wrapper for the CLI, or can be deleted entirely.

Concretely: delete `dashboard/monitor.ts` and have `dashboard/cli.ts` use `ws-client.ts` directly.

- [ ] **Step 2: Rewrite `dashboard/cli.ts`**

Replace the UDP + monitor logic with:

```ts
#!/usr/bin/env bun
import { createWsClient } from '../src/transport/ws-client'

const SWITCHBOARD = process.env.PARTY_LINE_SWITCHBOARD_URL
  ? process.env.PARTY_LINE_SWITCHBOARD_URL.replace(/^wss?:\/\//, 'https://').replace(/\/ws.*$/, '')
  : 'https://localhost:3400'

async function login(): Promise<string> {
  const pw = process.env.PARTY_LINE_DASHBOARD_PASSWORD
  if (!pw) {
    return ''
  }
  const res = await fetch(SWITCHBOARD + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') || ''
  const m = setCookie.match(/pl_dash=([^;]+)/)
  return m ? `pl_dash=${m[1]}` : ''
}

async function watch(argv: string[]): Promise<void> {
  const asJson = argv.includes('--json')
  const cookie = await login()
  const url = SWITCHBOARD.replace(/^https/, 'wss') + '/ws/observer'
  // Use native WebSocket with cookie header isn't supported in browsers, but
  // Bun's WebSocket accepts a `headers` option:
  const ws = new WebSocket(url, {
    headers: cookie ? { cookie } : {},
  } as any)
  ws.addEventListener('message', (e) => {
    const frame = JSON.parse(e.data as string)
    if (asJson) {
      console.log(JSON.stringify(frame))
    } else {
      formatFrame(frame)
    }
  })
  ws.addEventListener('close', () => process.exit(0))
  ws.addEventListener('error', (e) => {
    console.error(e)
    process.exit(1)
  })
}

function formatFrame(f: any): void {
  if (f.type === 'envelope') {
    console.log(
      `[${new Date(f.ts).toLocaleTimeString()}] ${f.from} → ${f.to} [${f.type}] ${f.body || ''}`,
    )
  } else if (f.type === 'session-delta') {
    console.log(`[delta] ${f.session} rev=${f.revision} ${JSON.stringify(f.changes)}`)
  } else if (f.type === 'sessions-snapshot') {
    console.log(`[snapshot] ${f.sessions.length} sessions`)
  }
}

async function sessions(argv: string[]): Promise<void> {
  const cookie = await login()
  const res = await fetch(SWITCHBOARD + '/ccpl/sessions', {
    headers: cookie ? { cookie } : {},
  })
  const body = (await res.json()) as { sessions: any[] }
  for (const s of body.sessions) {
    console.log(`${s.name}\t${s.online ? 'live' : 'offline'}\t${s.cwd}`)
  }
}

async function send(argv: string[]): Promise<void> {
  // send <to> <message> — requires a session token to speak on the session
  // WS. Simplest: use the first token on disk.
  const [to, ...msgParts] = argv
  if (!to || msgParts.length === 0) {
    console.error('Usage: cli.ts send <to> <message>')
    process.exit(1)
  }
  const msg = msgParts.join(' ')
  // Use the 'cli' token — create an ephemeral session named 'cli' if needed.
  await fetch(SWITCHBOARD + '/ccpl/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'cli', cwd: process.cwd() }),
  })
  const lookup = await fetch(SWITCHBOARD + '/ccpl/sessions', {
    headers: { cookie: await login() },
  })
  // ...simplified: for the CLI send path, call the existing /api/send HTTP
  // endpoint the dashboard already has, which routes through switchboard.
  const res = await fetch(SWITCHBOARD + '/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: await login() },
    body: JSON.stringify({ to, message: msg }),
  })
  if (!res.ok) {
    console.error('send failed:', res.status, await res.text())
    process.exit(1)
  }
}

const [sub, ...rest] = process.argv.slice(2)
if (sub === 'watch') await watch(rest)
else if (sub === 'sessions') await sessions(rest)
else if (sub === 'send') await send(rest)
else {
  console.error('Usage: bun dashboard/cli.ts (watch [--json] | sessions | send <to> <message>)')
  process.exit(1)
}
```

- [ ] **Step 2b: Add `/api/send` server-side endpoint**

In `dashboard/serve.ts`, add a cookie-authed endpoint that constructs an envelope server-side (observer-source):

```ts
if (url.pathname === '/api/send' && req.method === 'POST') {
  const unauth = requireAuth(req)
  if (unauth) return unauth
  const body = (await req.json().catch(() => ({}))) as { to?: string; message?: string }
  if (!body.to || !body.message) {
    return new Response(JSON.stringify({ error: 'missing' }), { status: 400 })
  }
  const envelope = {
    id: randomBytes(8).toString('hex'),
    ts: Date.now(),
    from: 'dashboard',
    to: body.to,
    type: 'message',
    body: body.message,
    callback_id: null,
    response_to: null,
  }
  // Use a helper on switchboard to route directly.
  switchboard.broadcastObserverFrame({ type: 'envelope', ...envelope })
  // Also persist + deliver to recipient.
  // (Call into a public routeEnvelope method — expose it from switchboard.ts.)
  return new Response(JSON.stringify({ ok: true, id: envelope.id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

(Expose `routeEnvelope` publicly on the `Switchboard` interface in `src/server/switchboard.ts` — add it to the returned object.)

- [ ] **Step 3: Manual smoke test**

```bash
PARTY_LINE_DASHBOARD_PASSWORD=test bun dashboard/cli.ts sessions
PARTY_LINE_DASHBOARD_PASSWORD=test bun dashboard/cli.ts watch
# in another shell
PARTY_LINE_DASHBOARD_PASSWORD=test bun dashboard/cli.ts send someone "hi"
```

Expected: `watch` prints envelopes as they arrive; `send` completes with no error.

- [ ] **Step 4: Commit**

```bash
git rm -f dashboard/monitor.ts
git add dashboard/cli.ts dashboard/serve.ts src/server/switchboard.ts
git commit -m "refactor(dashboard): CLI + server-side send use /ws/observer + /api/send

dashboard/monitor.ts (UDP-centric) removed. CLI authenticates via
PARTY_LINE_DASHBOARD_PASSWORD, opens /ws/observer for watch, and uses
the new cookie-authed /api/send for sending. Spec §9.2."
```

---

## Task C13: Dashboard client consumes `session-delta`

**Files:**

- Modify: `dashboard/dashboard.js`

**Background:** The old client listened for four frame types (`sessions`, `session-update`, `jsonl`, `hook-event`) and each independently updated the UI. The new client listens for one: `session-delta`, indexed by `session` name, gated by `revision`.

- [ ] **Step 1: Update WS URL and add cookie-based auth gate**

At the top of `connect()`:

```js
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(proto + '//' + location.host + '/ws/observer')
  // Cookie is sent automatically by the browser because the WS URL is same-origin.
  // If the server 401s the upgrade, we get a close event and redirect to /login.
  ...
  ws.onclose = function (e) {
    if (e.code === 1006 || e.code === 4401) {
      // Likely auth failure — redirect to login.
      location.href = '/login?next=' + encodeURIComponent(location.pathname)
      return
    }
    connStatus.textContent = 'disconnected — reconnecting...'
    connStatus.style.color = '#f85149'
    setTimeout(connect, 2000)
  }
}
```

- [ ] **Step 2: Introduce `sessionRevisions` map**

Near the other globals, add:

```js
const sessionRevisions = new Map() // name -> last applied revision
```

- [ ] **Step 3: Rewrite the message handler**

Replace the `ws.onmessage` dispatch with:

```js
ws.onmessage = function (e) {
  let data
  try {
    data = JSON.parse(e.data)
  } catch {
    return
  }
  if (data.type === 'sessions-snapshot') {
    handleSessionsSnapshot(data.sessions)
  } else if (data.type === 'session-delta') {
    applySessionDelta(data)
  } else if (data.type === 'envelope') {
    addMessage(data) // existing helper: writes to bus feed
    try {
      notif.onPartyLineMessage(data)
    } catch (err) {
      console.error(err)
    }
    if (
      currentView === 'session-detail' &&
      selectedSessionId &&
      (data.from === selectedSessionId || data.to === selectedSessionId)
    ) {
      appendEnvelopeToStream(data)
    }
  } else if (data.type === 'permission-request') {
    try {
      notif.onPermissionRequest(data)
    } catch (err) {
      console.error(err)
    }
    renderPermissionCard(data)
  } else if (data.type === 'permission-resolved') {
    try {
      notif.onPermissionResolved(data)
    } catch (err) {
      console.error(err)
    }
    updatePermissionCardResolved(data)
  } else if (data.type === 'notification-dismiss') {
    try {
      notif.onNotificationDismiss(data)
    } catch (err) {
      console.error(err)
    }
  } else if (data.type === 'quota') {
    updateQuota(data.data)
  }
  // Old types (sessions, session-update, jsonl, hook-event) no longer sent.
}

function handleSessionsSnapshot(sessions) {
  lastSessions = sessions.map((s) => ({
    name: s.name,
    metadata: {
      status: {
        state: s.online ? 'idle' : 'ended',
        sessionId: s.cc_session_uuid,
      },
    },
  }))
  sessionRevisions.clear()
  for (const s of sessions) sessionRevisions.set(s.name, s.revision)
  updateSessions(lastSessions)
}

function applySessionDelta(delta) {
  const prior = sessionRevisions.get(delta.session) ?? -1
  if (delta.revision <= prior) return // stale
  sessionRevisions.set(delta.session, delta.revision)

  // Find and patch the row in lastSessions.
  let row = lastSessions.find((s) => s.name === delta.session)
  if (!row) {
    row = { name: delta.session, metadata: { status: {} } }
    lastSessions.push(row)
  }
  const st = (row.metadata = row.metadata || {})
  const status = (st.status = st.status || {})
  const c = delta.changes
  if ('online' in c) status.state = c.online ? 'idle' : 'ended'
  if ('cc_session_uuid' in c) status.sessionId = c.cc_session_uuid
  if ('state' in c) status.state = c.state
  if ('current_tool' in c) status.currentTool = c.current_tool
  if ('last_text' in c) status.lastText = c.last_text
  if ('context_tokens' in c) status.contextTokens = c.context_tokens
  // Rerender the card in place.
  updateOverviewGrid(lastSessions)
  // If viewing this session, refresh detail header.
  if (currentView === 'session-detail' && selectedSessionId === delta.session) {
    renderDetailHeader(row)
  }
}
```

- [ ] **Step 4: Remove now-dead handlers**

Delete `handleSessionUpdate`, `handleJsonlEvent`, `handleHookEvent`, `handleStreamReset`, and the rest of the four-channel logic. The polling sparkline fetches + transcript endpoints are still used — keep them.

- [ ] **Step 5: Manual test**

Load the dashboard. Expected: switchboard shows sessions. Trigger a CC session to connect/disconnect — the card pill flips between live/offline without flicker.

Send a message from one session to another. Expected: bus feed shows the envelope; session detail stream appends it live.

- [ ] **Step 6: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "refactor(dashboard): single session-delta channel replaces 4 racing streams

Client tracks sessionRevisions per-session; any delta with revision
<= stored is dropped. No more flicker. Spec §3.3, audit S11."
```

---

## Task C14: Delete UDP transport + old presence heartbeat

**Files:**

- Delete: `src/transport/udp-multicast.ts`
- Modify: `src/presence.ts` — replace heartbeat loop with a thin HTTP client for `/ccpl/sessions`

- [ ] **Step 1: Delete UDP transport**

```bash
git rm src/transport/udp-multicast.ts
```

If any test imports it, delete those too (already handled if Phase A didn't touch them).

- [ ] **Step 2: Rewrite `src/presence.ts`**

Replace the body with:

```ts
// src/presence.ts — thin client for the switchboard's /ccpl/sessions endpoint.

export interface PresenceSession {
  name: string
  online: boolean
  cc_session_uuid: string | null
  cwd: string
}

export async function listSessions(
  switchboardUrl: string,
  cookie?: string,
): Promise<PresenceSession[]> {
  const res = await fetch(switchboardUrl + '/ccpl/sessions', {
    headers: cookie ? { cookie } : {},
  })
  if (!res.ok) throw new Error(`listSessions: ${res.status}`)
  const body = (await res.json()) as { sessions: PresenceSession[] }
  return body.sessions
}
```

Remove the heartbeat loop, HeartbeatOptions, emit-announce code, session timeout pruning — all of it.

- [ ] **Step 3: Update any caller that used the old presence module**

Search for imports of the removed functions and either delete the call sites (if they're dead code after the UDP removal) or convert them to use the new `listSessions(url)` shape.

- [ ] **Step 4: Run full tests**

Run: `bun run test:all`
Expected: all tests pass. `typecheck` has no complaints about missing UDP exports.

- [ ] **Step 5: Commit**

```bash
git rm src/transport/udp-multicast.ts
git add src/presence.ts
git commit -m "refactor: remove UDP multicast transport + heartbeat loop

UDP-specific dedup, send-twice, multicast binding are all gone.
presence.ts shrinks to a thin /ccpl/sessions HTTP client since
presence is now connection-state on the switchboard. Spec §6."
```

---

## Task C15: Integration test — two WS clients round-tripping

**Files:**

- Create: `tests/ws-session-integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, test, expect } from 'bun:test'
import { openDb } from '../src/storage/db'
import { registerSession } from '../src/storage/ccpl-queries'
import { createSwitchboard } from '../src/server/switchboard'
import { createWsClient } from '../src/transport/ws-client'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('integration: two WS clients via switchboard', () => {
  test('A sends to B, B receives the envelope', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pl-int-'))
    const db = openDb(join(tmp, 't.db'))
    const a = registerSession(db, 'intA', '/tmp')
    const b = registerSession(db, 'intB', '/tmp')
    const sb = createSwitchboard(db)

    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req, { data: { kind: 'session' } })) return
        return new Response('no', { status: 400 })
      },
      websocket: {
        open() {},
        message(ws: any, raw) {
          const frame = JSON.parse(String(raw))
          if (frame.type === 'hello') {
            const res = sb.handleSessionHello(ws, frame)
            if (!res.ok) {
              ws.close(res.code ?? 4401, res.error)
              return
            }
            ws.send(JSON.stringify({ type: 'accepted', server_time: Date.now() }))
          } else {
            sb.handleSessionFrame(ws, frame)
          }
        },
        close(ws: any) {
          sb.handleSessionClose(ws)
        },
      },
    })

    const url = `ws://localhost:${server.port}/`
    const received: any[] = []
    const clientA = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: a.token,
        name: 'intA',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'int',
      },
      pingIntervalMs: 60_000,
    })
    const clientB = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: b.token,
        name: 'intB',
        cc_session_uuid: null,
        pid: 2,
        machine_id: null,
        version: 'int',
      },
      pingIntervalMs: 60_000,
    })
    clientB.on('envelope', (f) => received.push(f))

    let aReady = false
    clientA.on('accepted', () => {
      aReady = true
    })
    let bReady = false
    clientB.on('accepted', () => {
      bReady = true
    })

    clientA.start()
    clientB.start()

    for (let i = 0; i < 50 && (!aReady || !bReady); i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(aReady).toBe(true)
    expect(bReady).toBe(true)

    clientA.send({ type: 'send', to: 'intB', body: 'hello int', client_ref: 'r1' })

    for (let i = 0; i < 50 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(received.length).toBe(1)
    expect(received[0].from).toBe('intA')
    expect(received[0].to).toBe('intB')
    expect(received[0].body).toBe('hello int')

    clientA.stop()
    clientB.stop()
    server.stop()
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run**

Run: `bun test tests/ws-session-integration.test.ts`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add tests/ws-session-integration.test.ts
git commit -m "test(integration): two WS clients exchange envelope via switchboard

End-to-end: Bun.serve + switchboard + two ws-client instances.
Closes audit T2 part 1."
```

---

## Phase C Exit Criteria

After all 15 tasks:

- [ ] `bun run test:all` passes.
- [ ] A fresh VM flow works: install plugin → `ccpl new foo --cwd /tmp` → `ccpl foo` → CC launches → send message from dashboard → CC session receives.
- [ ] `ccpl list` reflects live/offline transitions within ~30s of disconnect (WS idleTimeout).
- [ ] Dashboard password auth works: accessing `/` without cookie redirects to `/login`; valid password sets cookie; subsequent requests authorized.
- [ ] `src/transport/udp-multicast.ts` no longer exists; `grep -r "Multicast" src/` returns nothing.
- [ ] `seq` field no longer appears in envelopes (`grep -rn "seq:" src/ tests/`).
- [ ] `ccpl_sessions`, `ccpl_archives`, `messages`, `dashboard_sessions` tables exist in the DB.
- [ ] `uuid-rotate` frame (simulating `/clear`) creates an `ccpl_archives` row.
- [ ] Dashboard UI updates via `session-delta` frames — no "flicker" when a session rapidly transitions idle↔working.
- [ ] Switching a session's WS from one process to another cleanly supersedes (close code 4408).

Phase C is the biggest ship. When these pass, the hub-and-spoke architecture is live.

---

## Notes for the Implementer

- Run Phase A first; its migration fix is a hard prerequisite for C1's SCHEMA_VERSION bump.
- C10 and C11 are critical paths — get them right before deleting the old code in C14. A working fallback lets you dogfood the new path before burning the boats.
- Each task's tests run in < 1s typically; don't be shy about `bun test` after every change.
- For mobile smoke-testing at the end, set `PARTY_LINE_DASHBOARD_PASSWORD` as a Twingate-side env var; your phone hits `https://claude.argo:3400/login` normally.
- If a step's code block doesn't compile as-is against the current repo (import paths shift, type names drift), adjust the imports and the TS surface — the plan describes shape, not byte-perfect patches. Keep the behavior/test spec intact.
