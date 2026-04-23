# Transcript Persistence + Per-Session History UI + /resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream Claude Code JSONL turns into the dashboard SQLite DB, surface per-session History in the Session Detail sidebar, and handle `/resume` whether the resumed uuid is in our archives or brand new.

**Architecture:** Add a `transcript_entries` table (cc_session_uuid + monotonic seq + body_json). A new `TranscriptIngester` subscribes to the existing `JsonlObserver` poll stream and inserts one row per jsonl line. `reconcileCcSessionUuid` gains an `onUuidAdopted` callback that the ingester wires to `backfillIfNeeded` so resume-into-stranger fills history before live streaming continues. UI splits the session-detail sidebar into AGENTS / HISTORY; archives open at `/session/<name>/archive/<uuid>` with the same stream rendering plus a banner and disabled send bar.

**Tech Stack:** TypeScript + Bun, `bun:sqlite` (WAL), Bun.serve, native WebSocket, Atkinson Hyperlegible UI. Tests use `bun:test`. Browser verification via Playwright MCP at `http://localhost:3411` (HTTP test dashboard, no cert).

**Spec:** `docs/superpowers/specs/2026-04-22-transcript-persistence-history-resume-design.md`

**Prerequisites already shipped:**

- Hello-doesn't-overwrite-stored-uuid (`6fa8dea`'s switchboard fix already in place via `1078d44`).
- Attachment auth fix (`1078d44`).
- `cc_session_uuid` is the canonical source of truth for live transcript scope.

---

## File Map

**Create:**

- `src/storage/transcript-entries.ts` — typed query helpers (`insertEntry`, `listArchivesForSession`, `transcriptForUuid`, `archiveLabel`, `lastAssistantText`, `entryCount`, `deleteEntriesForUuid`).
- `src/observers/transcript-ingester.ts` — subscribes to `JsonlObserver` listeners + reset; manages per-uuid seq counter; `backfillFromUuid(uuid, filePath)` for one-shot stranger-uuid fill.
- `tests/transcript-entries.test.ts`
- `tests/transcript-ingester.test.ts`
- `tests/api-archives.test.ts` (HTTP fixture pattern, mirrors `tests/attachments-api.test.ts`)
- `tests/dashboard-router.test.ts` (DOM-light test for the archive route + view-state machine)

**Modify:**

- `src/storage/schema.sql` — append `transcript_entries` table + indexes.
- `src/storage/db.ts` — `SCHEMA_VERSION` 5 → 6; add migration case 6.
- `src/server/switchboard.ts` — `routeEnvelope` stamps `messages.cc_session_uuid` from sender's current row; `createSwitchboard(db, opts?)` accepts optional `onUuidAdopted` callback; `reconcileCcSessionUuid` invokes it after adopting.
- `dashboard/serve.ts` — wire `TranscriptIngester` into startup; add `GET /api/archives`, `GET /api/archive-label`, extend `GET /api/transcript` with `uuid` param; pass `onUuidAdopted` into the switchboard.
- `dashboard/dashboard.js` — router learns `/session/<name>/archive/<uuid>`; sidebar split renders AGENTS + HISTORY; archive view banner + disabled send bar + ignore live deltas.
- `dashboard/dashboard.css` — sidebar split, `.history-row`, `.history-row-live`, `.archive-banner`.
- `dashboard/index.html` — add `<div id="detail-history">` container under `#detail-sidebar`.

---

## Task 1: Schema migration — `transcript_entries` table (v5 → v6)

**Files:**

- Modify: `src/storage/schema.sql`
- Modify: `src/storage/db.ts:9` (SCHEMA_VERSION) and `src/storage/db.ts:14-192` (MIGRATIONS map)
- Test: `tests/db-migration-v6.test.ts` (new)

- [ ] **Step 1: Write the failing test** (`tests/db-migration-v6.test.ts`)

```ts
import { describe, test, expect, afterEach } from 'bun:test'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { openDb, SCHEMA_VERSION } from '../src/storage/db'

describe('schema v6 — transcript_entries table', () => {
  let dir: string

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('SCHEMA_VERSION is 6', () => {
    expect(SCHEMA_VERSION).toBe(6)
  })

  test('fresh DB has transcript_entries with PK (cc_session_uuid, seq)', () => {
    dir = mkdtempSync(join(tmpdir(), 'pl-schema-v6-'))
    const db = openDb(join(dir, 'fresh.db'))
    const cols = db.query('PRAGMA table_info(transcript_entries)').all() as Array<{
      name: string
      pk: number
    }>
    const colNames = cols.map((c) => c.name).sort()
    expect(colNames).toEqual([
      'body_json',
      'cc_session_uuid',
      'created_at',
      'kind',
      'seq',
      'session_name',
      'ts',
      'uuid',
    ])
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .map((c) => c.name)
      .sort()
    expect(pkCols).toEqual(['cc_session_uuid', 'seq'])
    db.close()
  })

  test('migrating an empty v5 DB to v6 adds transcript_entries', () => {
    dir = mkdtempSync(join(tmpdir(), 'pl-schema-v5to6-'))
    const path = join(dir, 'v5.db')
    // Bootstrap a v5 DB by stamping user_version=5 with a minimal schema
    // that v5 builds expected (the migration should not depend on v5 contents).
    const raw = new Database(path, { create: true })
    raw.exec('PRAGMA user_version = 5')
    raw.close()
    // Reopen with current build — should run only the v5→v6 migration.
    const db = openDb(path)
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='transcript_entries'")
      .all()
    expect(tables.length).toBe(1)
    const v = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!
    expect(v.user_version).toBe(6)
    db.close()
  })
})
```

- [ ] **Step 2: Run the test — confirm it fails**

```
bun test tests/db-migration-v6.test.ts
```

Expected: FAIL — `SCHEMA_VERSION` is 5; `transcript_entries` table does not exist.

- [ ] **Step 3: Add the table to `src/storage/schema.sql`**

Append at the very end of the file (after the `attachments` block at line 152):

```sql

-- transcript_entries: per-line copy of every Claude Code JSONL entry,
-- streamed in by TranscriptIngester (src/observers/transcript-ingester.ts).
-- This table is the durable source of truth for archived conversations and
-- is queried by /api/archives + /api/archive-label + /api/transcript?uuid=...
-- when rendering a read-only archive view. Live session-detail rendering
-- still reads JSONL directly until a follow-up flips that path too.
CREATE TABLE IF NOT EXISTS transcript_entries (
  cc_session_uuid TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  session_name    TEXT,
  ts              TEXT NOT NULL,
  kind            TEXT NOT NULL,
  uuid            TEXT,
  body_json       TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (cc_session_uuid, seq)
);
CREATE INDEX IF NOT EXISTS idx_transcript_entries_name_uuid
  ON transcript_entries(session_name, cc_session_uuid);
CREATE INDEX IF NOT EXISTS idx_transcript_entries_uuid_kind_seq
  ON transcript_entries(cc_session_uuid, kind, seq);
```

- [ ] **Step 4: Bump `SCHEMA_VERSION` and add v6 migration in `src/storage/db.ts`**

Change line 9:

```ts
export const SCHEMA_VERSION = 6
```

Add a new entry at the end of the `MIGRATIONS` object (after the `5:` block at line 191):

```ts
  // v5→v6: add `transcript_entries` table for streaming Claude Code JSONL
  // turns into SQLite. See spec
  // docs/superpowers/specs/2026-04-22-transcript-persistence-history-resume-design.md
  6: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_entries (
        cc_session_uuid TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        session_name    TEXT,
        ts              TEXT NOT NULL,
        kind            TEXT NOT NULL,
        uuid            TEXT,
        body_json       TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (cc_session_uuid, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_entries_name_uuid
        ON transcript_entries(session_name, cc_session_uuid);
      CREATE INDEX IF NOT EXISTS idx_transcript_entries_uuid_kind_seq
        ON transcript_entries(cc_session_uuid, kind, seq);
    `)
  },
```

- [ ] **Step 5: Run tests — confirm new tests pass and existing ones still pass**

```
bun test tests/db-migration-v6.test.ts
```

Expected: all 3 PASS.

```
bun test
```

Expected: 246 pass (243 existing + 3 new), 0 fail.

```
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```
git add src/storage/schema.sql src/storage/db.ts tests/db-migration-v6.test.ts
git commit -m "feat(storage): add transcript_entries table (schema v6)"
```

---

## Task 2: Query helpers for `transcript_entries`

**Files:**

- Create: `src/storage/transcript-entries.ts`
- Test: `tests/transcript-entries.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/transcript-entries.test.ts`)

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import {
  insertEntry,
  transcriptForUuid,
  listArchivesForSession,
  archiveLabel,
  lastAssistantText,
  entryCount,
  deleteEntriesForUuid,
  attributeSessionName,
  type TranscriptEntryRow,
} from '../src/storage/transcript-entries'
import {
  registerSession,
  archiveSession,
  updateSessionOnConnect,
} from '../src/storage/ccpl-queries'

const mk = (
  uuid: string,
  seq: number,
  kind: string,
  body: Record<string, unknown> = {},
  sessionName: string | null = 'foo',
): TranscriptEntryRow => ({
  cc_session_uuid: uuid,
  seq,
  session_name: sessionName,
  ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  kind,
  uuid: `entry-${seq}`,
  body_json: JSON.stringify(body),
  created_at: Date.now(),
})

describe('transcript-entries queries', () => {
  let db: Database
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-te-'))
    db = openDb(join(dir, 't.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('insertEntry then transcriptForUuid round-trips and orders by seq ASC', () => {
    insertEntry(db, mk('u1', 2, 'assistant-text', { text: 'second' }))
    insertEntry(db, mk('u1', 0, 'user', { text: 'first' }))
    insertEntry(db, mk('u1', 1, 'tool-use', { name: 'Bash' }))
    const rows = transcriptForUuid(db, 'u1', 100)
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2])
  })

  test('insertEntry is idempotent on (cc_session_uuid, seq) PK conflict', () => {
    insertEntry(db, mk('u1', 0, 'user', { text: 'a' }))
    // Re-insert with same PK but different body — INSERT OR IGNORE keeps original.
    insertEntry(db, mk('u1', 0, 'user', { text: 'b' }))
    const rows = transcriptForUuid(db, 'u1', 100)
    expect(rows.length).toBe(1)
    expect(JSON.parse(rows[0]!.body_json).text).toBe('a')
  })

  test('deleteEntriesForUuid removes only that uuid', () => {
    insertEntry(db, mk('u1', 0, 'user'))
    insertEntry(db, mk('u2', 0, 'user'))
    deleteEntriesForUuid(db, 'u1')
    expect(transcriptForUuid(db, 'u1', 10).length).toBe(0)
    expect(transcriptForUuid(db, 'u2', 10).length).toBe(1)
  })

  test('lastAssistantText returns the highest-seq assistant-text body', () => {
    insertEntry(db, mk('u1', 0, 'user', { text: 'hi' }))
    insertEntry(db, mk('u1', 1, 'assistant-text', { text: 'first reply' }))
    insertEntry(db, mk('u1', 2, 'tool-use', { name: 'Bash' }))
    insertEntry(db, mk('u1', 3, 'assistant-text', { text: 'second reply' }))
    expect(lastAssistantText(db, 'u1')).toBe('second reply')
  })

  test('lastAssistantText returns null when no assistant-text entries exist', () => {
    insertEntry(db, mk('u1', 0, 'user'))
    expect(lastAssistantText(db, 'u1')).toBeNull()
  })

  test('archiveLabel returns last-assistant-text truncated to maxLen', () => {
    insertEntry(db, mk('u1', 0, 'assistant-text', { text: 'a'.repeat(80) }))
    expect(archiveLabel(db, 'u1', 32)?.length).toBe(32)
    expect(archiveLabel(db, 'u1', 32)?.endsWith('…')).toBe(true)
    expect(archiveLabel(db, 'u1', 200)?.length).toBe(80)
  })

  test('entryCount returns total rows for the uuid', () => {
    insertEntry(db, mk('u1', 0, 'user'))
    insertEntry(db, mk('u1', 1, 'assistant-text'))
    expect(entryCount(db, 'u1')).toBe(2)
    expect(entryCount(db, 'never')).toBe(0)
  })

  test('listArchivesForSession returns archived uuids and excludes the live one', () => {
    registerSession(db, 'foo', '/tmp')
    updateSessionOnConnect(db, 'foo', 'live-uuid', 1, 'm')
    archiveSession(db, 'foo', 'old-uuid', 'clear')
    // Live entries
    insertEntry(db, mk('live-uuid', 0, 'assistant-text', { text: 'live label' }))
    // Archived entries
    insertEntry(db, mk('old-uuid', 0, 'assistant-text', { text: 'old label' }))

    const result = listArchivesForSession(db, 'foo', 32)
    expect(result.live?.uuid).toBe('live-uuid')
    expect(result.live?.label).toBe('live label')
    expect(result.live?.entry_count).toBe(1)
    expect(result.archives).toHaveLength(1)
    expect(result.archives[0]!.uuid).toBe('old-uuid')
    expect(result.archives[0]!.label).toBe('old label')
    expect(result.archives[0]!.entry_count).toBe(1)
  })

  test('listArchivesForSession folds duplicate archive rows to most-recent archived_at', () => {
    registerSession(db, 'foo', '/tmp')
    archiveSession(db, 'foo', 'u1', 'clear')
    archiveSession(db, 'foo', 'u1', 'rotate_uuid_drift') // same uuid archived again
    archiveSession(db, 'foo', 'u2', 'clear')
    insertEntry(db, mk('u1', 0, 'assistant-text'))
    insertEntry(db, mk('u2', 0, 'assistant-text'))
    const { archives } = listArchivesForSession(db, 'foo', 32)
    expect(archives.length).toBe(2)
    // u1 archived twice but appears once
    expect(archives.filter((a) => a.uuid === 'u1').length).toBe(1)
  })

  test('attributeSessionName fills in NULL session_name for a uuid', () => {
    insertEntry(db, mk('u1', 0, 'user', {}, null)) // session_name null
    insertEntry(db, mk('u1', 1, 'user', {}, null))
    insertEntry(db, mk('u2', 0, 'user', {}, 'other')) // already attributed — must not change
    attributeSessionName(db, 'u1', 'foo')
    const u1 = transcriptForUuid(db, 'u1', 10)
    expect(u1.every((r) => r.session_name === 'foo')).toBe(true)
    const u2 = transcriptForUuid(db, 'u2', 10)
    expect(u2[0]!.session_name).toBe('other') // untouched
  })
})
```

- [ ] **Step 2: Run test — confirm it fails**

```
bun test tests/transcript-entries.test.ts
```

Expected: FAIL — module `'../src/storage/transcript-entries'` not found.

- [ ] **Step 3: Implement `src/storage/transcript-entries.ts`**

```ts
import type { Database } from 'bun:sqlite'

export interface TranscriptEntryRow {
  cc_session_uuid: string
  seq: number
  session_name: string | null
  ts: string
  kind: string
  uuid: string | null
  body_json: string
  created_at: number
}

export interface ArchiveEntry {
  uuid: string
  archived_at: number
  label: string | null
  entry_count: number
}

export interface LiveEntry {
  uuid: string
  last_active_at: number
  label: string | null
  entry_count: number
}

export interface ArchivesResult {
  live: LiveEntry | null
  archives: ArchiveEntry[]
}

/**
 * Insert one transcript entry. Idempotent on (cc_session_uuid, seq) — duplicate
 * inserts are silently ignored, NOT updated. The first insert wins.
 */
export function insertEntry(db: Database, row: TranscriptEntryRow): void {
  db.query(
    `INSERT OR IGNORE INTO transcript_entries
       (cc_session_uuid, seq, session_name, ts, kind, uuid, body_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.cc_session_uuid,
    row.seq,
    row.session_name,
    row.ts,
    row.kind,
    row.uuid,
    row.body_json,
    row.created_at,
  )
}

/** Return all rows for a given cc_session_uuid ordered by seq ASC, capped. */
export function transcriptForUuid(db: Database, uuid: string, limit: number): TranscriptEntryRow[] {
  return db
    .query(
      `SELECT * FROM transcript_entries
       WHERE cc_session_uuid = ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(uuid, limit) as TranscriptEntryRow[]
}

/** Delete every entry for a uuid (used on file-shrink / reset). */
export function deleteEntriesForUuid(db: Database, uuid: string): void {
  db.query(`DELETE FROM transcript_entries WHERE cc_session_uuid = ?`).run(uuid)
}

/** Last assistant-text entry's `text` field, or null if none. */
export function lastAssistantText(db: Database, uuid: string): string | null {
  const row = db
    .query(
      `SELECT body_json FROM transcript_entries
       WHERE cc_session_uuid = ? AND kind = 'assistant-text'
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(uuid) as { body_json: string } | null
  if (!row) return null
  try {
    const parsed = JSON.parse(row.body_json) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text : null
  } catch {
    return null
  }
}

/**
 * Compact label for the History list. Returns lastAssistantText truncated
 * to maxLen-1 chars + "…" suffix when truncation occurs. Null if no label.
 */
export function archiveLabel(db: Database, uuid: string, maxLen: number): string | null {
  const text = lastAssistantText(db, uuid)
  if (text === null) return null
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '…'
}

/** Number of entries for this uuid. */
export function entryCount(db: Database, uuid: string): number {
  const row = db
    .query(`SELECT COUNT(*) AS n FROM transcript_entries WHERE cc_session_uuid = ?`)
    .get(uuid) as { n: number }
  return row.n
}

/**
 * Build the /api/archives response shape. The currently-live uuid (if any)
 * is returned in `live`; every other distinct cc_session_uuid that has been
 * archived for this name appears once in `archives`, ordered by most recent
 * archived_at DESC. A uuid that is currently live is NEVER also in archives.
 */
export function listArchivesForSession(
  db: Database,
  name: string,
  labelMaxLen: number,
): ArchivesResult {
  const sessionRow = db
    .query(`SELECT cc_session_uuid, last_active_at FROM ccpl_sessions WHERE name = ?`)
    .get(name) as { cc_session_uuid: string | null; last_active_at: number } | null

  const liveUuid = sessionRow?.cc_session_uuid ?? null
  const live: LiveEntry | null = liveUuid
    ? {
        uuid: liveUuid,
        last_active_at: sessionRow!.last_active_at,
        label: archiveLabel(db, liveUuid, labelMaxLen),
        entry_count: entryCount(db, liveUuid),
      }
    : null

  // Distinct old_uuids for this name with most-recent archived_at, excluding
  // the currently-live uuid.
  const rows = db
    .query<{ uuid: string; archived_at: number }, [string, string | null]>(
      `SELECT old_uuid AS uuid, MAX(archived_at) AS archived_at
       FROM ccpl_archives
       WHERE name = ? AND old_uuid != COALESCE(?, '')
       GROUP BY old_uuid
       ORDER BY archived_at DESC`,
    )
    .all(name, liveUuid)

  const archives: ArchiveEntry[] = rows.map((r) => ({
    uuid: r.uuid,
    archived_at: r.archived_at,
    label: archiveLabel(db, r.uuid, labelMaxLen),
    entry_count: entryCount(db, r.uuid),
  }))

  return { live, archives }
}

/**
 * Backfill session_name on all rows for a given cc_session_uuid where
 * session_name IS NULL. Called when reconcileCcSessionUuid adopts a uuid
 * we'd previously been ingesting as a stranger.
 */
export function attributeSessionName(db: Database, uuid: string, name: string): void {
  db.query(
    `UPDATE transcript_entries
     SET session_name = ?
     WHERE cc_session_uuid = ? AND session_name IS NULL`,
  ).run(name, uuid)
}
```

- [ ] **Step 4: Run test — confirm it passes**

```
bun test tests/transcript-entries.test.ts
```

Expected: all 9 PASS.

```
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```
git add src/storage/transcript-entries.ts tests/transcript-entries.test.ts
git commit -m "feat(storage): transcript_entries query helpers"
```

---

## Task 3: Stamp `messages.cc_session_uuid` on outgoing envelopes

**Files:**

- Modify: `src/server/switchboard.ts:98-109` (routeEnvelope's insertMessage call)
- Test: extend `tests/switchboard.test.ts` (new test)

- [ ] **Step 1: Write the failing test** — append to `tests/switchboard.test.ts` inside the existing `describe('switchboard'`, ...)`block (just before the closing`})`):

```ts
test('routeEnvelope stamps messages.cc_session_uuid from sender row', () => {
  const a = registerSession(db, 'a', '/tmp')
  registerSession(db, 'b', '/tmp')
  const sb = createSwitchboard(db)
  const wsA = fakeWs('session')
  sb.handleSessionHello(wsA, {
    token: a.token,
    name: 'a',
    cc_session_uuid: 'uuid-A',
    pid: 1,
    machine_id: null,
  })
  sb.handleSessionFrame(wsA, { type: 'send', to: 'b', body: 'hi', client_ref: 'r1' })
  const row = db
    .query(`SELECT cc_session_uuid FROM messages WHERE from_name = ? LIMIT 1`)
    .get('a') as { cc_session_uuid: string | null }
  expect(row.cc_session_uuid).toBe('uuid-A')
})

test('routeEnvelope stamps null for envelopes without a sender row (e.g. dashboard)', () => {
  const sb = createSwitchboard(db)
  sb.routeEnvelope({
    id: 'env-1',
    ts: 1000,
    from: 'dashboard',
    to: 'nobody',
    envelope_type: 'message',
    body: 'x',
    callback_id: null,
    response_to: null,
  })
  const row = db.query(`SELECT cc_session_uuid FROM messages WHERE id = ?`).get('env-1') as {
    cc_session_uuid: string | null
  }
  expect(row.cc_session_uuid).toBeNull()
})
```

- [ ] **Step 2: Run test — confirm it fails**

```
bun test tests/switchboard.test.ts
```

Expected: 2 new FAIL — `cc_session_uuid` is null for the sender-stamped case.

- [ ] **Step 3: Update `src/server/switchboard.ts` `routeEnvelope` to look up sender's uuid**

Replace the `insertMessage` call inside `routeEnvelope` (currently at lines 99-109):

```ts
  function routeEnvelope(envelope: Envelope): void {
    // Stamp the sender's current cc_session_uuid so messages can be filtered
    // per archived conversation in the archive viewer. Dashboard-originated
    // envelopes (envelope.from === 'dashboard') and any unknown sender stay
    // as null — the archive view shows them in the LIVE row by default.
    const senderRow =
      envelope.from && envelope.from !== 'dashboard'
        ? getSessionByName(db, envelope.from)
        : null
    const ccUuid = senderRow?.cc_session_uuid ?? null

    insertMessage(db, {
      id: envelope.id,
      ts: envelope.ts,
      from_name: envelope.from,
      to_name: envelope.to,
      type: envelope.envelope_type,
      body: envelope.body,
      callback_id: envelope.callback_id,
      response_to: envelope.response_to,
      cc_session_uuid: ccUuid,
    })
```

(The rest of `routeEnvelope` is unchanged.)

- [ ] **Step 4: Run tests — all switchboard tests pass**

```
bun test tests/switchboard.test.ts
```

Expected: all PASS (16 total — the existing 14 + 2 new).

```
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```
git add src/server/switchboard.ts tests/switchboard.test.ts
git commit -m "feat(switchboard): stamp messages.cc_session_uuid from sender row"
```

---

## Task 4: `TranscriptIngester` — stream-insert + reset

> **Design note on `seq`.** The original spec sketched surfacing positional file-line index from the `JsonlObserver`. After plan review the simpler approach is preferred: the ingester maintains a per-uuid monotonic `seq` counter (`MAX(seq)+1` from DB on first encounter of a uuid, then in-memory increment per insert). This satisfies the same dedupe + ordering guarantees without modifying the observer. The PK on `(cc_session_uuid, seq)` plus `INSERT OR IGNORE` makes restarts and overlapping backfill safe.

**Files:**

- Create: `src/observers/transcript-ingester.ts`
- Test: `tests/transcript-ingester.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/transcript-ingester.test.ts`)

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import { JsonlObserver } from '../src/observers/jsonl'
import { TranscriptIngester } from '../src/observers/transcript-ingester'
import {
  insertEntry,
  transcriptForUuid,
  attributeSessionName,
} from '../src/storage/transcript-entries'

describe('TranscriptIngester', () => {
  let db: Database
  let dir: string
  let projectsRoot: string
  let observer: JsonlObserver

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-ti-'))
    db = openDb(join(dir, 't.db'))
    projectsRoot = join(dir, 'projects')
    mkdirSync(projectsRoot, { recursive: true })
    observer = new JsonlObserver(projectsRoot, 50)
  })

  afterEach(async () => {
    observer.stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('streams new jsonl lines into transcript_entries', async () => {
    const cwd = join(projectsRoot, 'p1')
    mkdirSync(cwd, { recursive: true })
    const jsonl = join(cwd, 'uuid-1.jsonl')
    writeFileSync(jsonl, '')
    const ingester = new TranscriptIngester(db, projectsRoot)
    ingester.subscribe(observer)
    await observer.start()
    await new Promise((r) => setTimeout(r, 100))

    appendFileSync(
      jsonl,
      JSON.stringify({ type: 'user', uuid: 'e1', timestamp: '2026-04-22T00:00:00Z' }) +
        '\n' +
        JSON.stringify({ type: 'assistant', uuid: 'e2', timestamp: '2026-04-22T00:00:01Z' }) +
        '\n',
    )
    await new Promise((r) => setTimeout(r, 200))

    const rows = transcriptForUuid(db, 'uuid-1', 100)
    expect(rows.length).toBe(2)
    expect(rows[0]!.kind).toBe('user')
    expect(rows[1]!.kind).toBe('assistant-text')
    expect(rows[0]!.uuid).toBe('e1')
    expect(rows[1]!.uuid).toBe('e2')
  })

  test('seq monotonically increments per uuid across polls', async () => {
    const cwd = join(projectsRoot, 'p2')
    mkdirSync(cwd, { recursive: true })
    const jsonl = join(cwd, 'uuid-2.jsonl')
    writeFileSync(jsonl, '')
    const ingester = new TranscriptIngester(db, projectsRoot)
    ingester.subscribe(observer)
    await observer.start()
    await new Promise((r) => setTimeout(r, 100))

    appendFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'a' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    appendFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'b' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))

    const rows = transcriptForUuid(db, 'uuid-2', 100)
    expect(rows.map((r) => r.seq)).toEqual([0, 1])
  })

  test('reset (file shrink) deletes existing rows so re-ingest is clean', async () => {
    const cwd = join(projectsRoot, 'p3')
    mkdirSync(cwd, { recursive: true })
    const jsonl = join(cwd, 'uuid-3.jsonl')
    writeFileSync(jsonl, '')
    const ingester = new TranscriptIngester(db, projectsRoot)
    ingester.subscribe(observer)
    await observer.start()
    await new Promise((r) => setTimeout(r, 100))

    appendFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'a' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    expect(transcriptForUuid(db, 'uuid-3', 10).length).toBe(1)

    // Truncate file to a different content (simulate compaction)
    writeFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'b' }) + '\n')
    await new Promise((r) => setTimeout(r, 200))

    const rows = transcriptForUuid(db, 'uuid-3', 10)
    expect(rows.length).toBe(1)
    expect(rows[0]!.uuid).toBe('b')
  })

  test('attributes session_name when ccpl_sessions has the uuid', async () => {
    // Pre-seed a ccpl_sessions row that maps uuid-4 → "foo"
    db.query(
      `INSERT INTO ccpl_sessions
        (name, token, cwd, cc_session_uuid, online, revision, created_at, last_active_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('foo', 'tok-foo', '/tmp', 'uuid-4', Date.now(), Date.now())
    const cwd = join(projectsRoot, 'p4')
    mkdirSync(cwd, { recursive: true })
    const jsonl = join(cwd, 'uuid-4.jsonl')
    writeFileSync(jsonl, '')
    const ingester = new TranscriptIngester(db, projectsRoot)
    ingester.subscribe(observer)
    await observer.start()
    await new Promise((r) => setTimeout(r, 100))

    appendFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'x' }) + '\n')
    await new Promise((r) => setTimeout(r, 200))

    const rows = transcriptForUuid(db, 'uuid-4', 10)
    expect(rows[0]!.session_name).toBe('foo')
  })
})
```

- [ ] **Step 2: Run test — confirm it fails**

```
bun test tests/transcript-ingester.test.ts
```

Expected: FAIL — module `'../src/observers/transcript-ingester'` not found.

- [ ] **Step 3: Implement `src/observers/transcript-ingester.ts`**

```ts
import type { Database } from 'bun:sqlite'
import { basename } from 'node:path'
import type { JsonlObserver, JsonlUpdate } from './jsonl'
import { insertEntry, deleteEntriesForUuid } from '../storage/transcript-entries'
import { getSessionByCcUuid } from '../storage/ccpl-queries'

/**
 * Streams Claude Code JSONL entries into `transcript_entries`. Subscribes to
 * a JsonlObserver, inserts one row per emitted update, manages a per-uuid
 * monotonic seq counter, and clears rows on reset (file shrink/replacement).
 *
 * The seq counter starts at MAX(seq)+1 from the DB on first encounter of a
 * uuid (so a dashboard restart resumes correctly), then increments locally
 * per insert. Inserts are INSERT OR IGNORE — duplicate (uuid, seq) PKs are
 * silently dropped, which means a stranger-uuid backfill (Task 5) that
 * partially overlaps with later streaming reuses existing rows safely.
 */
export class TranscriptIngester {
  private nextSeq = new Map<string, number>()

  constructor(
    private db: Database,
    private _projectsRoot: string,
  ) {}

  subscribe(observer: JsonlObserver): void {
    observer.on((u) => this.handleUpdate(u))
    observer.onReset((path) => this.handleReset(path))
  }

  private handleUpdate(u: JsonlUpdate): void {
    const ccUuid = u.session_id
    const seq = this.allocateSeq(ccUuid)
    const sessionName = this.lookupSessionName(ccUuid)
    insertEntry(this.db, {
      cc_session_uuid: ccUuid,
      seq,
      session_name: sessionName,
      ts: extractTs(u.entry),
      kind: deriveKind(u.entry),
      uuid: extractUuid(u.entry),
      body_json: JSON.stringify(u.entry),
      created_at: Date.now(),
    })
  }

  private handleReset(filePath: string): void {
    const ccUuid = basename(filePath, '.jsonl')
    deleteEntriesForUuid(this.db, ccUuid)
    this.nextSeq.delete(ccUuid)
  }

  /** First call for a uuid queries DB for MAX(seq)+1 (or 0). Cached after that. */
  private allocateSeq(ccUuid: string): number {
    let n = this.nextSeq.get(ccUuid)
    if (n === undefined) {
      const row = this.db
        .query(`SELECT MAX(seq) AS m FROM transcript_entries WHERE cc_session_uuid = ?`)
        .get(ccUuid) as { m: number | null }
      n = (row.m ?? -1) + 1
    }
    this.nextSeq.set(ccUuid, n + 1)
    return n
  }

  private lookupSessionName(ccUuid: string): string | null {
    const row = getSessionByCcUuid(this.db, ccUuid)
    return row?.name ?? null
  }
}

function extractTs(entry: Record<string, unknown>): string {
  if (typeof entry.timestamp === 'string') return entry.timestamp
  if (typeof entry.ts === 'string') return entry.ts
  return new Date().toISOString()
}

function extractUuid(entry: Record<string, unknown>): string | null {
  return typeof entry.uuid === 'string' ? entry.uuid : null
}

/**
 * Map JSONL entry types to the `kind` column. Claude Code emits "user",
 * "assistant", "tool_use", "tool_result", "system", "subagent-spawn", and
 * other shapes. Normalise the most useful ones; everything else becomes
 * the raw type string (or 'unknown').
 */
function deriveKind(entry: Record<string, unknown>): string {
  const t = entry.type
  if (typeof t !== 'string') return 'unknown'
  if (t === 'assistant') return 'assistant-text'
  if (t === 'tool_use') return 'tool-use'
  if (t === 'tool_result') return 'tool-result'
  return t
}
```

- [ ] **Step 4: Add `getSessionByCcUuid` to `src/storage/ccpl-queries.ts`**

The ingester needs a uuid → session_name lookup. Add (after `getSessionByToken` around line 72):

```ts
export function getSessionByCcUuid(db: Database, ccUuid: string): CcplSessionRow | null {
  if (!ccUuid) return null
  const row = db
    .query(`SELECT * FROM ccpl_sessions WHERE cc_session_uuid = ? LIMIT 1`)
    .get(ccUuid) as CcplSessionRow | null
  return row
}
```

- [ ] **Step 5: Run test — confirm it passes**

```
bun test tests/transcript-ingester.test.ts
```

Expected: all 4 PASS.

```
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```
git add src/observers/transcript-ingester.ts src/storage/ccpl-queries.ts tests/transcript-ingester.test.ts
git commit -m "feat(observers): TranscriptIngester streams JSONL into DB"
```

---

## Task 5: Backfill stranger uuids on first-sight

**Files:**

- Modify: `src/observers/transcript-ingester.ts` (add `backfillFromUuid`)
- Test: extend `tests/transcript-ingester.test.ts` (new test)

- [ ] **Step 1: Write the failing test** — append to `tests/transcript-ingester.test.ts`'s describe block:

```ts
test('backfillFromUuid bulk-inserts the entire jsonl file when no rows exist', async () => {
  const cwd = join(projectsRoot, 'p5')
  mkdirSync(cwd, { recursive: true })
  const jsonl = join(cwd, 'stranger-uuid.jsonl')
  writeFileSync(
    jsonl,
    JSON.stringify({ type: 'user', uuid: 'h1', text: 'past 1' }) +
      '\n' +
      JSON.stringify({ type: 'assistant', uuid: 'h2', text: 'past 2' }) +
      '\n' +
      JSON.stringify({ type: 'user', uuid: 'h3', text: 'past 3' }) +
      '\n',
  )
  const ingester = new TranscriptIngester(db, projectsRoot)
  const inserted = ingester.backfillFromUuid('stranger-uuid')
  expect(inserted).toBe(3)
  const rows = transcriptForUuid(db, 'stranger-uuid', 100)
  expect(rows.length).toBe(3)
  expect(rows.map((r) => r.seq)).toEqual([0, 1, 2])
  expect(rows.map((r) => r.kind)).toEqual(['user', 'assistant-text', 'user'])
})

test('backfillFromUuid is a no-op when entries already exist for that uuid', async () => {
  insertEntry(db, {
    cc_session_uuid: 'already',
    seq: 0,
    session_name: null,
    ts: new Date().toISOString(),
    kind: 'user',
    uuid: 'pre',
    body_json: '{}',
    created_at: Date.now(),
  })
  const cwd = join(projectsRoot, 'p6')
  mkdirSync(cwd, { recursive: true })
  const jsonl = join(cwd, 'already.jsonl')
  writeFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'x' }) + '\n')
  const ingester = new TranscriptIngester(db, projectsRoot)
  const inserted = ingester.backfillFromUuid('already')
  expect(inserted).toBe(0)
  const rows = transcriptForUuid(db, 'already', 10)
  expect(rows.length).toBe(1)
  expect(rows[0]!.uuid).toBe('pre')
})

test('backfillFromUuid returns 0 when no jsonl file is found anywhere under projectsRoot', () => {
  const ingester = new TranscriptIngester(db, projectsRoot)
  expect(ingester.backfillFromUuid('does-not-exist')).toBe(0)
  expect(transcriptForUuid(db, 'does-not-exist', 10).length).toBe(0)
})
```

- [ ] **Step 2: Run test — confirm it fails**

```
bun test tests/transcript-ingester.test.ts
```

Expected: FAIL — `backfillFromUuid` is not a function.

- [ ] **Step 3: Add `backfillFromUuid` to `src/observers/transcript-ingester.ts`**

Add inside the `TranscriptIngester` class, after `subscribe`:

```ts
  /**
   * One-shot read of the JSONL file for `ccUuid` and bulk-insert every line.
   * No-op if the uuid already has rows in transcript_entries (the streaming
   * path is taking care of it). Returns the number of rows actually inserted.
   *
   * Used by reconcileCcSessionUuid via onUuidAdopted when the resumed uuid
   * is a stranger we've never seen before (Case B in the spec).
   */
  backfillFromUuid(ccUuid: string): number {
    const existing = this.db
      .query(`SELECT COUNT(*) AS n FROM transcript_entries WHERE cc_session_uuid = ?`)
      .get(ccUuid) as { n: number }
    if (existing.n > 0) return 0

    const filePath = this.findJsonlForUuid(ccUuid)
    if (!filePath) return 0

    let raw: string
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch {
      return 0
    }

    const sessionName = this.lookupSessionName(ccUuid)
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    let seq = 0
    const insertMany = this.db.transaction(() => {
      for (const line of lines) {
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        insertEntry(this.db, {
          cc_session_uuid: ccUuid,
          seq,
          session_name: sessionName,
          ts: extractTs(entry),
          kind: deriveKind(entry),
          uuid: extractUuid(entry),
          body_json: JSON.stringify(entry),
          created_at: Date.now(),
        })
        seq++
      }
    })
    insertMany()
    // Pre-seed the streaming counter so subsequent appends start at the next seq.
    this.nextSeq.set(ccUuid, seq)
    return seq
  }

  /** Walk the projectsRoot for a `<ccUuid>.jsonl` file. */
  private findJsonlForUuid(ccUuid: string): string | null {
    if (!existsSync(this._projectsRoot)) return null
    for (const cwdDir of readdirSync(this._projectsRoot, { withFileTypes: true })) {
      if (!cwdDir.isDirectory()) continue
      const candidate = join(this._projectsRoot, cwdDir.name, `${ccUuid}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
```

Add the new imports at the top of the file (replacing the existing `import { basename } from 'node:path'` line):

```ts
import { basename, join } from 'node:path'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
```

- [ ] **Step 4: Run tests — confirm new tests pass**

```
bun test tests/transcript-ingester.test.ts
```

Expected: all 7 PASS.

```
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```
git add src/observers/transcript-ingester.ts tests/transcript-ingester.test.ts
git commit -m "feat(observers): TranscriptIngester.backfillFromUuid for stranger uuids"
```

---

## Task 6: Switchboard `onUuidAdopted` callback + `attributeSessionName` on adopt

**Files:**

- Modify: `src/server/switchboard.ts` — extend `createSwitchboard(db, opts?)`, invoke callback in `reconcileCcSessionUuid`
- Modify: `src/server/switchboard.ts` — also call `attributeSessionName` so prior stranger rows get tagged
- Test: extend `tests/switchboard.test.ts` (new tests)

- [ ] **Step 1: Write the failing tests** — append to `tests/switchboard.test.ts`:

```ts
test('createSwitchboard accepts opts.onUuidAdopted and reconcile invokes it', () => {
  registerSession(db, 'foo', '/tmp')
  const calls: Array<{ name: string; uuid: string; reason: string }> = []
  const sb = createSwitchboard(db, {
    onUuidAdopted: (name, uuid, reason) => calls.push({ name, uuid, reason }),
  })
  sb.reconcileCcSessionUuid('foo', 'uuid-1', 'hook_drift')
  expect(calls).toEqual([{ name: 'foo', uuid: 'uuid-1', reason: 'hook_drift' }])

  // Same uuid again → no callback (no-op)
  sb.reconcileCcSessionUuid('foo', 'uuid-1', 'hook_drift')
  expect(calls.length).toBe(1)
})

test('reconcileCcSessionUuid attributes session_name for prior stranger entries', () => {
  registerSession(db, 'foo', '/tmp')
  // Simulate the ingester having captured stranger entries before adoption.
  const { insertEntry } = require('../src/storage/transcript-entries')
  insertEntry(db, {
    cc_session_uuid: 'stranger-uuid',
    seq: 0,
    session_name: null,
    ts: '2026-04-22T00:00:00Z',
    kind: 'user',
    uuid: 'e1',
    body_json: '{}',
    created_at: Date.now(),
  })
  const sb = createSwitchboard(db)
  sb.reconcileCcSessionUuid('foo', 'stranger-uuid', 'hook_drift')
  const row = db
    .query(`SELECT session_name FROM transcript_entries WHERE cc_session_uuid = ?`)
    .get('stranger-uuid') as { session_name: string }
  expect(row.session_name).toBe('foo')
})
```

- [ ] **Step 2: Run tests — confirm they fail**

```
bun test tests/switchboard.test.ts
```

Expected: FAIL — `createSwitchboard` doesn't accept opts; `attributeSessionName` not called.

- [ ] **Step 3: Update `src/server/switchboard.ts` — accept opts and wire callbacks**

Add at the top of the file (with the other imports):

```ts
import { attributeSessionName } from '../storage/transcript-entries'
```

Change the `createSwitchboard` signature (line 70):

```ts
export interface SwitchboardOpts {
  /** Invoked after reconcileCcSessionUuid (or hello bootstrap) adopts a uuid. */
  onUuidAdopted?: (name: string, uuid: string, reason: string) => void
}

export function createSwitchboard(db: Database, opts: SwitchboardOpts = {}): Switchboard {
```

Update `reconcileCcSessionUuid` (currently lines 175-186):

```ts
function reconcileCcSessionUuid(name: string, newUuid: string | null, reason: string): void {
  if (!newUuid) return
  const row = getSessionByName(db, name)
  if (!row) return
  if (row.cc_session_uuid === newUuid) return
  if (row.cc_session_uuid) {
    archiveSession(db, name, row.cc_session_uuid, reason)
  }
  updateSessionOnConnect(db, name, newUuid, row.pid, row.machine_id)
  // Backfill session_name for any stranger entries we'd ingested before
  // knowing this uuid belonged to `name`.
  attributeSessionName(db, newUuid, name)
  const fresh = getSessionByName(db, name)
  if (fresh) emitSessionDelta(fresh, { cc_session_uuid: fresh.cc_session_uuid })
  // Notify callers (dashboard wires this to TranscriptIngester.backfillFromUuid).
  opts.onUuidAdopted?.(name, newUuid, reason)
}
```

- [ ] **Step 4: Run tests — confirm pass**

```
bun test tests/switchboard.test.ts
```

Expected: all PASS.

```
bun test
```

Expected: all PASS.

```
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```
git add src/server/switchboard.ts tests/switchboard.test.ts
git commit -m "feat(switchboard): onUuidAdopted callback + session_name attribution"
```

---

## Task 7: Wire `TranscriptIngester` into `dashboard/serve.ts`

**Files:**

- Modify: `dashboard/serve.ts` — instantiate ingester at startup; subscribe to existing observer; pass `onUuidAdopted` into `createSwitchboard`
- No new tests in this task — wired via an integration test in Task 14

- [ ] **Step 1: Read the current observer wiring**

In `dashboard/serve.ts`, locate where `JsonlObserver` is instantiated and started (search for `new JsonlObserver(`). The switchboard is created via `createSwitchboard(db)` somewhere before HTTP listen. Note the variable names so you can wire them together.

Run:

```
grep -n "JsonlObserver\|createSwitchboard\b" dashboard/serve.ts
```

- [ ] **Step 2: Add ingester instantiation immediately after the observer**

Add the import at the top of `dashboard/serve.ts` near the other src imports:

```ts
import { TranscriptIngester } from '../src/observers/transcript-ingester.js'
```

After the `new JsonlObserver(...)` line, add:

```ts
const transcriptIngester = new TranscriptIngester(db, jsonlRoot)
transcriptIngester.subscribe(jsonlObserver)
```

(Variable names — `jsonlObserver` and `jsonlRoot` — must match the existing names used in `serve.ts`. Adjust if they differ.)

- [ ] **Step 3: Pass `onUuidAdopted` into `createSwitchboard`**

Change the `createSwitchboard(db)` call to:

```ts
const switchboard = createSwitchboard(db, {
  onUuidAdopted: (_name, uuid, _reason) => {
    transcriptIngester.backfillFromUuid(uuid)
  },
})
```

(`_name` and `_reason` are intentionally unused; preserved in the signature for clarity at the call site.)

- [ ] **Step 4: Run tests + typecheck + smoke-test the dashboard**

```
bun test
```

Expected: all PASS.

```
bunx tsc --noEmit
```

Expected: clean.

Smoke test (start the dashboard and verify it boots):

```
PARTY_LINE_DASHBOARD_PASSWORD=partyline PARTY_LINE_DASHBOARD_SECRET=$(openssl rand -hex 32) bun dashboard/serve.ts --port 3411 > /tmp/ingest-smoke.log 2>&1 &
sleep 2
grep -E "TranscriptIngester|listening|Web UI" /tmp/ingest-smoke.log | head
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3411/login
pkill -f "port 3411"
```

Expected: dashboard boots cleanly (200 on /login), no crashes mentioning the ingester.

- [ ] **Step 5: Commit**

```
git add dashboard/serve.ts
git commit -m "feat(dashboard): wire TranscriptIngester at startup"
```

---

## Task 8: API endpoint `GET /api/archives`

**Files:**

- Modify: `dashboard/serve.ts` — add the route handler
- Test: `tests/api-archives.test.ts` (new — uses the same in-process fixture pattern as `tests/attachments-api.test.ts`)

- [ ] **Step 1: Write the failing test** (`tests/api-archives.test.ts`)

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import {
  registerSession,
  archiveSession,
  updateSessionOnConnect,
} from '../src/storage/ccpl-queries'
import { insertEntry } from '../src/storage/transcript-entries'
import { handleApiArchives } from '../dashboard/api-archives.js'

describe('/api/archives endpoint', () => {
  let db: Database
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-api-arch-'))
    db = openDb(join(dir, 't.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('returns 400 when session param is missing', async () => {
    const req = new Request('http://x/api/archives')
    const res = await handleApiArchives(req, db)
    expect(res.status).toBe(400)
  })

  test('returns {live: null, archives: []} for an unknown session', async () => {
    const req = new Request('http://x/api/archives?session=nope')
    const res = await handleApiArchives(req, db)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { live: unknown; archives: unknown[] }
    expect(body.live).toBeNull()
    expect(body.archives).toEqual([])
  })

  test('returns live + archive entries with labels and entry counts', async () => {
    registerSession(db, 'foo', '/tmp')
    updateSessionOnConnect(db, 'foo', 'live-uuid', 1, 'm')
    archiveSession(db, 'foo', 'archived-uuid', 'clear')
    insertEntry(db, {
      cc_session_uuid: 'live-uuid',
      seq: 0,
      session_name: 'foo',
      ts: '2026-04-22T00:00:00Z',
      kind: 'assistant-text',
      uuid: 'a',
      body_json: JSON.stringify({ text: 'live label' }),
      created_at: Date.now(),
    })
    insertEntry(db, {
      cc_session_uuid: 'archived-uuid',
      seq: 0,
      session_name: 'foo',
      ts: '2026-04-22T00:00:00Z',
      kind: 'assistant-text',
      uuid: 'b',
      body_json: JSON.stringify({ text: 'archived label' }),
      created_at: Date.now(),
    })
    const req = new Request('http://x/api/archives?session=foo')
    const res = await handleApiArchives(req, db)
    const body = (await res.json()) as {
      live: { uuid: string; label: string; entry_count: number } | null
      archives: Array<{ uuid: string; label: string; entry_count: number }>
    }
    expect(body.live?.uuid).toBe('live-uuid')
    expect(body.live?.label).toBe('live label')
    expect(body.archives).toHaveLength(1)
    expect(body.archives[0]!.uuid).toBe('archived-uuid')
    expect(body.archives[0]!.label).toBe('archived label')
  })
})
```

- [ ] **Step 2: Run test — confirm it fails**

```
bun test tests/api-archives.test.ts
```

Expected: FAIL — module `'../dashboard/api-archives.js'` not found.

- [ ] **Step 3: Create `dashboard/api-archives.ts`**

```ts
import type { Database } from 'bun:sqlite'
import { listArchivesForSession } from '../src/storage/transcript-entries.js'

const LABEL_MAX_LEN = 32

/**
 * GET /api/archives?session=<name>
 *   → { live: LiveEntry | null, archives: ArchiveEntry[] }
 *
 * The live uuid (if any) is returned in `live`. Distinct archived uuids for
 * this name (excluding live) are returned in `archives`, ordered by most
 * recent archived_at DESC, with last-assistant-text labels truncated to 32
 * chars.
 */
export async function handleApiArchives(req: Request, db: Database): Promise<Response> {
  const url = new URL(req.url)
  const name = url.searchParams.get('session')
  if (!name) {
    return Response.json({ error: 'session param required' }, { status: 400 })
  }
  const result = listArchivesForSession(db, name, LABEL_MAX_LEN)
  return Response.json(result)
}
```

- [ ] **Step 4: Wire the route in `dashboard/serve.ts`**

Locate the `/api/archives` slot — it goes alongside the other `/api/*` GET handlers (e.g. near `/api/sessions` around line 635). Add:

```ts
// GET /api/archives?session=<name> — per-session History list
if (url.pathname === '/api/archives' && req.method === 'GET') {
  return handleApiArchives(req, db)
}
```

And at the top of `dashboard/serve.ts` (with the other dashboard imports):

```ts
import { handleApiArchives } from './api-archives.js'
```

- [ ] **Step 5: Run tests — confirm pass**

```
bun test tests/api-archives.test.ts
```

Expected: all 3 PASS.

```
bun test
```

Expected: all PASS.

```
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```
git add dashboard/serve.ts dashboard/api-archives.ts tests/api-archives.test.ts
git commit -m "feat(api): GET /api/archives — per-session live + archive list"
```

---

## Task 9: API endpoint `GET /api/archive-label`

**Files:**

- Modify: `dashboard/api-archives.ts` — add `handleApiArchiveLabel`
- Modify: `dashboard/serve.ts` — wire the route
- Test: extend `tests/api-archives.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `tests/api-archives.test.ts`'s describe block:

```ts
test('archive-label returns 200-char tooltip body for a uuid', async () => {
  insertEntry(db, {
    cc_session_uuid: 'u1',
    seq: 0,
    session_name: null,
    ts: '2026-04-22T00:00:00Z',
    kind: 'assistant-text',
    uuid: 'x',
    body_json: JSON.stringify({ text: 'a'.repeat(500) }),
    created_at: Date.now(),
  })
  const { handleApiArchiveLabel } = require('../dashboard/api-archives.js')
  const req = new Request('http://x/api/archive-label?uuid=u1')
  const res = await handleApiArchiveLabel(req, db)
  const body = (await res.json()) as { label: string | null }
  expect(body.label?.length).toBe(200)
  expect(body.label?.endsWith('…')).toBe(true)
})

test('archive-label returns null when no assistant-text entries exist', async () => {
  const { handleApiArchiveLabel } = require('../dashboard/api-archives.js')
  const req = new Request('http://x/api/archive-label?uuid=ghost')
  const res = await handleApiArchiveLabel(req, db)
  const body = (await res.json()) as { label: string | null }
  expect(body.label).toBeNull()
})

test('archive-label returns 400 when uuid param missing', async () => {
  const { handleApiArchiveLabel } = require('../dashboard/api-archives.js')
  const req = new Request('http://x/api/archive-label')
  const res = await handleApiArchiveLabel(req, db)
  expect(res.status).toBe(400)
})
```

- [ ] **Step 2: Run test — confirm it fails**

```
bun test tests/api-archives.test.ts
```

Expected: FAIL — `handleApiArchiveLabel` is not exported.

- [ ] **Step 3: Add `handleApiArchiveLabel` to `dashboard/api-archives.ts`**

Append after `handleApiArchives`:

```ts
const TOOLTIP_MAX_LEN = 200

/**
 * GET /api/archive-label?uuid=<uuid>
 *   → { label: string | null }
 *
 * Returns the same last-assistant-text basis as the row label, but
 * truncated to 200 chars for the hover tooltip. Loaded lazily on hover
 * so the History list itself stays cheap.
 */
export async function handleApiArchiveLabel(req: Request, db: Database): Promise<Response> {
  const url = new URL(req.url)
  const uuid = url.searchParams.get('uuid')
  if (!uuid) {
    return Response.json({ error: 'uuid param required' }, { status: 400 })
  }
  const { archiveLabel } = await import('../src/storage/transcript-entries.js')
  return Response.json({ label: archiveLabel(db, uuid, TOOLTIP_MAX_LEN) })
}
```

- [ ] **Step 4: Wire the route in `dashboard/serve.ts`**

Add next to the `/api/archives` route added in Task 8:

```ts
// GET /api/archive-label?uuid=<uuid> — 200-char tooltip body for History hover
if (url.pathname === '/api/archive-label' && req.method === 'GET') {
  return handleApiArchiveLabel(req, db)
}
```

Update the import line:

```ts
import { handleApiArchives, handleApiArchiveLabel } from './api-archives.js'
```

- [ ] **Step 5: Run tests + typecheck**

```
bun test tests/api-archives.test.ts
```

Expected: all 6 PASS (3 from Task 8 + 3 new).

```
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```
git add dashboard/api-archives.ts dashboard/serve.ts tests/api-archives.test.ts
git commit -m "feat(api): GET /api/archive-label — 200-char hover tooltip body"
```

---

## Task 10: Extend `GET /api/transcript` with `uuid` param (DB-backed)

**Files:**

- Modify: `dashboard/serve.ts` — branch on the `uuid` query param
- Test: extend `tests/api-archives.test.ts` (or new `tests/api-transcript-uuid.test.ts`)

- [ ] **Step 1: Write the failing test** — create `tests/api-transcript-uuid.test.ts`

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import { registerSession } from '../src/storage/ccpl-queries'
import { insertEntry } from '../src/storage/transcript-entries'
import { buildArchiveTranscriptResponse } from '../dashboard/api-transcript-uuid.js'

describe('buildArchiveTranscriptResponse', () => {
  let db: Database
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-api-tx-'))
    db = openDb(join(dir, 't.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('returns entries from transcript_entries for the given uuid in seq order', () => {
    registerSession(db, 'foo', '/tmp')
    insertEntry(db, {
      cc_session_uuid: 'arch',
      seq: 1,
      session_name: 'foo',
      ts: '2026-04-22T00:00:01Z',
      kind: 'assistant-text',
      uuid: 'b',
      body_json: JSON.stringify({ text: 'reply' }),
      created_at: Date.now(),
    })
    insertEntry(db, {
      cc_session_uuid: 'arch',
      seq: 0,
      session_name: 'foo',
      ts: '2026-04-22T00:00:00Z',
      kind: 'user',
      uuid: 'a',
      body_json: JSON.stringify({ text: 'question' }),
      created_at: Date.now(),
    })
    const result = buildArchiveTranscriptResponse(db, 'foo', 'arch', 100)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]!.kind).toBe('user')
    expect(result.entries[1]!.kind).toBe('assistant-text')
  })

  test('returns empty entries when uuid has no rows', () => {
    const result = buildArchiveTranscriptResponse(db, 'foo', 'never-seen', 100)
    expect(result.entries).toEqual([])
  })

  test('includes envelopes from messages table that match the uuid', () => {
    db.query(
      `INSERT INTO messages (id, ts, from_name, to_name, type, body, callback_id, response_to, cc_session_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('env-1', 1_700_000_000_000, 'foo', 'bar', 'message', 'pong', null, null, 'arch')
    insertEntry(db, {
      cc_session_uuid: 'arch',
      seq: 0,
      session_name: 'foo',
      ts: '2026-04-22T00:00:00Z',
      kind: 'user',
      uuid: 'a',
      body_json: '{}',
      created_at: Date.now(),
    })
    const result = buildArchiveTranscriptResponse(db, 'foo', 'arch', 100)
    expect(result.envelopes).toHaveLength(1)
    expect(result.envelopes[0]!.id).toBe('env-1')
  })
})
```

- [ ] **Step 2: Run test — confirm it fails**

```
bun test tests/api-transcript-uuid.test.ts
```

Expected: FAIL — module `'../dashboard/api-transcript-uuid.js'` not found.

- [ ] **Step 3: Create `dashboard/api-transcript-uuid.ts`**

```ts
import type { Database } from 'bun:sqlite'
import { transcriptForUuid, type TranscriptEntryRow } from '../src/storage/transcript-entries.js'

export interface ArchiveTranscriptResponse {
  uuid: string
  session_name: string
  entries: TranscriptEntryRow[]
  envelopes: Array<{
    id: string
    from: string
    to: string
    type: string
    body: string
    ts: string
    callback_id: string | null
    response_to: string | null
  }>
}

/**
 * Build the transcript response shape for /api/transcript when invoked with
 * an explicit `uuid` param. Reads exclusively from DB — `transcript_entries`
 * for turns and `messages` for party-line envelopes — so the archive viewer
 * never depends on JSONL files.
 */
export function buildArchiveTranscriptResponse(
  db: Database,
  sessionName: string,
  uuid: string,
  limit: number,
): ArchiveTranscriptResponse {
  const entries = transcriptForUuid(db, uuid, limit)
  const messageRows = db
    .query(`SELECT * FROM messages WHERE cc_session_uuid = ? ORDER BY ts ASC LIMIT ?`)
    .all(uuid, limit) as Array<{
    id: string
    ts: number
    from_name: string
    to_name: string
    type: string
    body: string | null
    callback_id: string | null
    response_to: string | null
  }>
  const envelopes = messageRows.map((r) => ({
    id: r.id,
    from: r.from_name,
    to: r.to_name,
    type: r.type,
    body: r.body ?? '',
    ts: new Date(r.ts).toISOString(),
    callback_id: r.callback_id,
    response_to: r.response_to,
  }))
  return { uuid, session_name: sessionName, entries, envelopes }
}
```

- [ ] **Step 4: Branch on `uuid` param in `dashboard/serve.ts`'s existing `/api/transcript` handler**

Locate the `if (url.pathname === '/api/transcript')` block in `dashboard/serve.ts` (around line 898). At the top of the handler, add the new branch BEFORE the existing live-rendering code:

```ts
if (url.pathname === '/api/transcript') {
  const sidParam = url.searchParams.get('session_id')
  if (!sidParam) return Response.json({ error: 'session_id required' }, { status: 400 })
  const explicitUuid = url.searchParams.get('uuid')
  const limit = parseInt(url.searchParams.get('limit') ?? '200', 10)
  if (explicitUuid) {
    // DB-backed read for an archived uuid (or the live uuid if explicitly
    // requested). Bypasses the live aggregator + JSONL path entirely.
    return Response.json(buildArchiveTranscriptResponse(db, sidParam, explicitUuid, limit))
  }
  // ... existing live-rendering block continues unchanged below ...
}
```

Add the import at the top of `dashboard/serve.ts`:

```ts
import { buildArchiveTranscriptResponse } from './api-transcript-uuid.js'
```

- [ ] **Step 5: Run tests + typecheck**

```
bun test tests/api-transcript-uuid.test.ts
bun test
bunx tsc --noEmit
```

Expected: all PASS, tsc clean.

- [ ] **Step 6: Commit**

```
git add dashboard/api-transcript-uuid.ts dashboard/serve.ts tests/api-transcript-uuid.test.ts
git commit -m "feat(api): GET /api/transcript?uuid= reads from transcript_entries"
```

---

## Task 11: UI — sidebar split (AGENTS top, HISTORY bottom) + history list rendering

**Files:**

- Modify: `dashboard/index.html` — add `<div id="detail-history">` below the agents tree
- Modify: `dashboard/dashboard.css` — sidebar split, `.history-row`, `.history-row-live`, tooltip
- Modify: `dashboard/dashboard.js` — fetch + render history; tooltip hover handler
- Verify via Playwright

- [ ] **Step 1: Update `dashboard/index.html`**

Find the existing sidebar block (`<aside class="detail-sidebar" id="detail-sidebar">` containing the AGENTS list at lines 155-158). Replace with:

```html
<aside class="detail-sidebar" id="detail-sidebar">
  <div class="sidebar-section sidebar-agents">
    <div class="sidebar-label">AGENTS</div>
    <ul id="detail-tree"></ul>
  </div>
  <div class="sidebar-section sidebar-history">
    <div class="sidebar-label">HISTORY</div>
    <ul id="detail-history"></ul>
  </div>
</aside>
```

- [ ] **Step 2: Update `dashboard/dashboard.css`**

Append at end of file (after the mobile-readability block added in `d4ef7e0`):

```css
/* -------------------------------------------------------------------------
   Session-detail sidebar split: AGENTS (top) + HISTORY (bottom).
   Each section scrolls independently. The history list renders one row per
   live + archived cc_session_uuid with last-assistant-text labels.
   ------------------------------------------------------------------------- */
.detail-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.sidebar-section {
  flex: 1 1 50%;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.sidebar-section:last-child {
  border-bottom: none;
}
.sidebar-section .sidebar-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  padding: 0 8px 6px;
}
#detail-history {
  list-style: none;
  margin: 0;
  padding: 0;
}
.history-row {
  padding: 6px 8px;
  cursor: pointer;
  border-left: 3px solid transparent;
  position: relative;
}
.history-row:hover {
  background: var(--surface);
}
.history-row.selected {
  border-left-color: var(--accent);
  background: var(--surface);
}
.history-row-live {
  font-weight: 600;
}
.history-row-live::before {
  content: '● ';
  color: var(--green);
}
.history-row-label {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-row-meta {
  font-size: 10px;
  color: var(--text-dim);
  margin-top: 2px;
}
.history-tooltip {
  position: fixed;
  z-index: 100;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
  max-width: 320px;
  font-size: 12px;
  color: var(--text);
  pointer-events: none;
  white-space: pre-wrap;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}
```

- [ ] **Step 3: Add the history-rendering JS in `dashboard/dashboard.js`**

The router primitives already exist. From `dashboard/dashboard.js`:

- `parseUrl()` returns `{ view, sessionName, agentId }` for the current pathname.
- `urlForView(state)` builds a URL from that state shape.
- `pushRoute(state)` calls `window.history.pushState(state, '', urlForView(state))`.
- `applyRoute(state, opts)` switches the visible view + invokes `loadSessionDetailView(...)` (the actual detail loader) for `view === 'session-detail'`.

This task adds **only** the history-sidebar rendering — wiring it into the existing detail load happens at the end of this step. The next task (Task 12) extends the route shape with `archiveUuid` and the route handlers to use it.

Add the new functions near the bottom of `dashboard.js` (or wherever helper utilities live). The `pushRoute` calls below pass an `archiveUuid` field that Task 12 will teach `urlForView`/`parseUrl` about; until Task 12 lands, `pushRoute({ view: 'session-detail', sessionName, archiveUuid })` will serialize as `/session/<name>` (the field is ignored), so clicking an archive row in this task's deliverable still navigates correctly to the live view. The full archive route comes online in Task 12.

```js
async function renderHistorySidebar(sessionName, currentArchiveUuid) {
  var el = document.getElementById('detail-history')
  if (!el) return
  el.innerHTML = ''
  var res = await fetch('/api/archives?session=' + encodeURIComponent(sessionName))
  if (!res.ok) {
    el.innerHTML = '<li class="history-row" style="color:var(--text-dim)">unable to load</li>'
    return
  }
  var data = await res.json()
  if (data.live) {
    el.appendChild(makeHistoryRow(sessionName, data.live, true, currentArchiveUuid))
  }
  for (var i = 0; i < data.archives.length; i++) {
    el.appendChild(makeHistoryRow(sessionName, data.archives[i], false, currentArchiveUuid))
  }
  if (!data.live && data.archives.length === 0) {
    var empty = document.createElement('li')
    empty.className = 'history-row'
    empty.style.color = 'var(--text-dim)'
    empty.textContent = '(no history yet)'
    el.appendChild(empty)
  }
}

function makeHistoryRow(sessionName, item, isLive, selectedUuid) {
  var li = document.createElement('li')
  li.className = 'history-row' + (isLive ? ' history-row-live' : '')
  if ((isLive && !selectedUuid) || item.uuid === selectedUuid) {
    li.classList.add('selected')
  }
  var label = document.createElement('div')
  label.className = 'history-row-label'
  label.textContent = item.label || (isLive ? 'LIVE' : '(no transcript)')
  li.appendChild(label)
  var meta = document.createElement('div')
  meta.className = 'history-row-meta'
  meta.textContent = isLive ? 'LIVE' : relativeTime(item.archived_at)
  li.appendChild(meta)
  li.addEventListener('click', function () {
    var state = isLive
      ? { view: 'session-detail', sessionName: sessionName, agentId: null, archiveUuid: null }
      : {
          view: 'session-detail',
          sessionName: sessionName,
          agentId: null,
          archiveUuid: item.uuid,
        }
    pushRoute(state)
    applyRoute(state, { skipPush: true })
  })
  attachHistoryTooltip(li, item.uuid)
  return li
}

function relativeTime(ms) {
  var diff = Date.now() - ms
  var sec = Math.floor(diff / 1000)
  if (sec < 60) return sec + 's ago'
  var min = Math.floor(sec / 60)
  if (min < 60) return min + 'm ago'
  var hr = Math.floor(min / 60)
  if (hr < 24) return hr + 'h ago'
  var day = Math.floor(hr / 24)
  if (day < 30) return day + 'd ago'
  return new Date(ms).toLocaleDateString()
}

var __historyTooltipCache = {}
function attachHistoryTooltip(li, uuid) {
  var tipEl = null
  li.addEventListener('mouseenter', async function (ev) {
    var label = __historyTooltipCache[uuid]
    if (label === undefined) {
      try {
        var r = await fetch('/api/archive-label?uuid=' + encodeURIComponent(uuid))
        if (r.ok) {
          var b = await r.json()
          label = b.label
        } else {
          label = null
        }
      } catch (e) {
        label = null
      }
      __historyTooltipCache[uuid] = label
    }
    if (!label) return
    tipEl = document.createElement('div')
    tipEl.className = 'history-tooltip'
    tipEl.textContent = label
    document.body.appendChild(tipEl)
    var rect = li.getBoundingClientRect()
    tipEl.style.left = rect.right + 8 + 'px'
    tipEl.style.top = rect.top + 'px'
  })
  li.addEventListener('mouseleave', function () {
    if (tipEl && tipEl.parentNode) tipEl.parentNode.removeChild(tipEl)
    tipEl = null
  })
}
```

Wire `renderHistorySidebar(sessionName, null)` into `loadSessionDetailView` (the function called from `applyRoute` for `view === 'session-detail'`). Add the call right after the existing AGENTS tree render so HISTORY populates on every navigation to a session detail. Until Task 12 lands, the `archiveUuid` second arg is always `null` here — Task 12 plumbs the real value through.

- [ ] **Step 4: Browser verification via Playwright**

Start a test HTTP dashboard:

```
PARTY_LINE_DASHBOARD_PASSWORD=partyline PARTY_LINE_DASHBOARD_SECRET=$(openssl rand -hex 32) bun dashboard/serve.ts --port 3411 > /tmp/sidebar-test.log 2>&1 &
sleep 2
```

Use Playwright MCP to:

1. `mcp__plugin_playwright_playwright__browser_navigate` to `http://localhost:3411/login`
2. `browser_evaluate` to POST `/login` with password `partyline`
3. `browser_navigate` to `http://localhost:3411/session/partyline-dev` (or any session that exists in your DB)
4. `browser_evaluate` to read `document.querySelector('#detail-history').children.length` — assert > 0
5. `browser_evaluate` to read `document.querySelector('.history-row-live')?.textContent` — assert it contains a label or "LIVE"
6. `browser_take_screenshot` filename `verify-history-sidebar.png` — eyeball that AGENTS is on top, HISTORY on bottom, with rows visible

Stop the server:

```
pkill -f "port 3411"
rm -f verify-history-sidebar.png
```

- [ ] **Step 5: Run tests + tsc one more time, then commit**

```
bun test
bunx tsc --noEmit
git add dashboard/index.html dashboard/dashboard.css dashboard/dashboard.js
git commit -m "feat(dashboard): split sidebar into AGENTS + HISTORY, render archive list"
```

---

## Task 12: UI — archive route + read-only archive view

**Files:**

- Modify: `dashboard/dashboard.js` — router learns `/session/<name>/archive/<uuid>`; archive view banner + disabled send bar + ignore live deltas
- Modify: `dashboard/dashboard.css` — `.archive-banner` style
- Modify: `dashboard/index.html` — placeholder `<div id="archive-banner" hidden></div>` in the detail header area

- [ ] **Step 1: Update `dashboard/index.html` — add the banner placeholder**

Inside the `<div class="detail-header">` block (around lines 120-153), add a banner div right after the back button (or wherever fits the visual flow):

```html
<div class="archive-banner" id="archive-banner" hidden>
  <span id="archive-banner-text">Viewing archive</span>
  <a class="archive-back" id="archive-back-link" href="#">← Back to live</a>
</div>
```

- [ ] **Step 2: Update `dashboard/dashboard.css` — banner style**

Append:

```css
.archive-banner {
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--accent);
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0;
}
.archive-banner .archive-back {
  margin-left: auto;
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
}
.archive-banner .archive-back:hover {
  text-decoration: underline;
}
.detail-send.archive-readonly {
  opacity: 0.4;
  pointer-events: none;
}
```

- [ ] **Step 3: Extend `parseUrl` and `urlForView` to handle the archive route**

`dashboard/dashboard.js:102-117` defines `parseUrl()`. Add the archive-route branch BEFORE the existing `/session/<name>` match (so it wins for the longer path):

```js
function parseUrl() {
  const path = window.location.pathname
  // /session/<name>/archive/<uuid>  ← NEW
  let m = path.match(/^\/session\/([^/]+)\/archive\/([^/]+)\/?$/)
  if (m) {
    return {
      view: 'session-detail',
      sessionName: decodeURIComponent(m[1]),
      agentId: null,
      archiveUuid: decodeURIComponent(m[2]),
    }
  }
  // /session/<name>/agent/<id>
  m = path.match(/^\/session\/([^/]+)\/agent\/([^/]+)\/?$/)
  if (m) return { view: 'session-detail', sessionName: decodeURIComponent(m[1]), agentId: m[2] }
  // /session/<name>
  m = path.match(/^\/session\/([^/]+)\/?$/)
  if (m) return { view: 'session-detail', sessionName: decodeURIComponent(m[1]), agentId: null }
  // /history/<sub>
  m = path.match(/^\/history\/([^/]+)\/?$/)
  if (m) return { view: 'history', subtab: m[1] }
  // /history
  if (path === '/history' || path === '/history/') return { view: 'history', subtab: 'events' }
  // default
  return { view: 'switchboard' }
}
```

Update `urlForView` (lines 119-132) — extend the session-detail branch to render the archive route when `archiveUuid` is present:

```js
function urlForView(state) {
  if (!state) return '/'
  if (state.view === 'switchboard') return '/'
  if (state.view === 'history') {
    return state.subtab && state.subtab !== 'events' ? '/history/' + state.subtab : '/history'
  }
  if (state.view === 'session-detail') {
    const enc = encodeURIComponent(state.sessionName || '')
    if (state.archiveUuid)
      return '/session/' + enc + '/archive/' + encodeURIComponent(state.archiveUuid)
    return state.agentId
      ? '/session/' + enc + '/agent/' + encodeURIComponent(state.agentId)
      : '/session/' + enc
  }
  return '/'
}
```

- [ ] **Step 4: Branch the session-detail loader on `archiveUuid`**

Find `loadSessionDetailView(...)` (the function `applyRoute` invokes for `view === 'session-detail'`). At the top, read `archiveUuid` from the route state and branch:

```js
async function loadSessionDetailView(state) {
  const sessionName = state.sessionName
  const archiveUuid = state.archiveUuid || null
  // Banner + send-bar mode FIRST so first paint matches the URL even before fetch returns.
  setArchiveMode(sessionName, archiveUuid)
  // History sidebar always re-renders (passes archiveUuid to highlight the selected row).
  renderHistorySidebar(sessionName, archiveUuid)

  if (archiveUuid) {
    const r = await fetch(
      '/api/transcript?session_id=' +
        encodeURIComponent(sessionName) +
        '&uuid=' +
        encodeURIComponent(archiveUuid),
    )
    if (!r.ok) {
      const stream = document.getElementById('detail-stream')
      if (stream)
        stream.replaceChildren(
          Object.assign(document.createElement('p'), { textContent: 'Archive not found.' }),
        )
      return
    }
    const data = await r.json()
    renderArchiveStream(data)
    return
  }

  // ... existing live-load body unchanged from here ...
}
```

`setArchiveMode` and `renderArchiveStream` are new helpers in the same file:

```js
function setArchiveMode(sessionName, archiveUuid) {
  const banner = document.getElementById('archive-banner')
  const sendBar = document.querySelector('.detail-send')
  if (archiveUuid) {
    banner.hidden = false
    const txt = document.getElementById('archive-banner-text')
    if (txt) txt.textContent = 'Viewing archive · uuid ' + archiveUuid.slice(0, 8) + '…'
    const back = document.getElementById('archive-back-link')
    if (back) {
      back.onclick = function (ev) {
        ev.preventDefault()
        const liveState = {
          view: 'session-detail',
          sessionName: sessionName,
          agentId: null,
          archiveUuid: null,
        }
        pushRoute(liveState)
        applyRoute(liveState, { skipPush: true })
      }
    }
    if (sendBar) sendBar.classList.add('archive-readonly')
  } else {
    banner.hidden = true
    if (sendBar) sendBar.classList.remove('archive-readonly')
  }
}

function renderArchiveStream(data) {
  // Re-use the existing live-render helper that converts entries+envelopes
  // into DOM. Search dashboard.js for the function the live path calls after
  // /api/transcript returns (commonly named renderTranscript / renderStream
  // / paintDetailStream — look for the assignment to #detail-stream's
  // children inside loadSessionDetailView). Pass data.entries + data.envelopes
  // through unmodified — the API shape matches the live path's input arrays.
  // If the live helper takes a single combined array, merge here:
  //   const merged = mergeByTs(data.entries, data.envelopes)
}
```

(The exact call to the live render helper depends on what's already in `dashboard.js` — the implementing engineer must locate it and call it with the same shape the live path uses. The `/api/transcript?uuid=` response from Task 10 was deliberately built to match the live path's existing `entries`/`envelopes` arrays.)

- [ ] **Step 5: Ignore live observer deltas while viewing an archive**

Locate the observer WebSocket message handler in `dashboard/dashboard.js` (search for `ws.onmessage` near the top of the file). Wrap the per-session dispatch:

```js
ws.onmessage = function (e) {
  const msg = JSON.parse(e.data)
  // While viewing an archive, drop live updates for the same session — the
  // archive is a frozen snapshot.
  const route = parseUrl()
  if (route.view === 'session-detail' && route.archiveUuid) {
    if (
      (msg.type === 'envelope' &&
        (msg.from === route.sessionName || msg.to === route.sessionName)) ||
      (msg.type === 'session-delta' && msg.session === route.sessionName) ||
      (msg.type === 'user-prompt' && msg.data?.session_name === route.sessionName)
    ) {
      return
    }
  }
  // ... existing dispatch unchanged ...
}
```

- [ ] **Step 6: Browser verification via Playwright**

Start the test dashboard:

```
PARTY_LINE_DASHBOARD_PASSWORD=partyline PARTY_LINE_DASHBOARD_SECRET=$(openssl rand -hex 32) bun dashboard/serve.ts --port 3411 > /tmp/archive-test.log 2>&1 &
sleep 2
```

Seed a test archive in the DB:

```
bun -e "
import { Database } from 'bun:sqlite'
import { insertEntry } from './src/storage/transcript-entries.ts'
import { archiveSession, registerSession } from './src/storage/ccpl-queries.ts'
const db = new Database(process.env.HOME + '/.config/party-line/dashboard.db')
try { registerSession(db, 'test-archive-session', '/tmp') } catch {}
archiveSession(db, 'test-archive-session', 'archive-uuid-1', 'clear')
insertEntry(db, {
  cc_session_uuid: 'archive-uuid-1', seq: 0, session_name: 'test-archive-session',
  ts: '2026-04-22T00:00:00Z', kind: 'user', uuid: 'a',
  body_json: JSON.stringify({type:'user', text:'Hi from archive'}), created_at: Date.now(),
})
insertEntry(db, {
  cc_session_uuid: 'archive-uuid-1', seq: 1, session_name: 'test-archive-session',
  ts: '2026-04-22T00:00:01Z', kind: 'assistant-text', uuid: 'b',
  body_json: JSON.stringify({type:'assistant', text:'Hello from the past'}), created_at: Date.now(),
})
"
```

Via Playwright:

1. Login + navigate to `/session/test-archive-session`
2. `browser_evaluate` to read `document.querySelector('#detail-history .history-row:not(.history-row-live)')?.textContent` — should contain the archive label
3. Click the archive row via `browser_click`
4. `browser_evaluate` to read `location.pathname` — should be `/session/test-archive-session/archive/archive-uuid-1`
5. `browser_evaluate` to read `document.getElementById('archive-banner').hidden` — should be `false`
6. `browser_evaluate` to read `document.querySelector('.detail-send').classList.contains('archive-readonly')` — should be `true`
7. `browser_evaluate` to read `document.getElementById('detail-stream').children.length` — should be > 0
8. Click the back link via `browser_click`
9. `browser_evaluate` to read `location.pathname` — should be `/session/test-archive-session`
10. `browser_evaluate` to read `document.getElementById('archive-banner').hidden` — should be `true`
11. `browser_take_screenshot` filename `verify-archive-view.png`

Cleanup:

```
pkill -f "port 3411"
rm -f verify-archive-view.png
bun -e "
import { Database } from 'bun:sqlite'
const db = new Database(process.env.HOME + '/.config/party-line/dashboard.db')
db.query('DELETE FROM transcript_entries WHERE cc_session_uuid = ?').run('archive-uuid-1')
db.query('DELETE FROM ccpl_archives WHERE old_uuid = ?').run('archive-uuid-1')
db.query('DELETE FROM ccpl_sessions WHERE name = ?').run('test-archive-session')
"
```

- [ ] **Step 7: Run tests + tsc, commit**

```
bun test
bunx tsc --noEmit
git add dashboard/index.html dashboard/dashboard.css dashboard/dashboard.js
git commit -m "feat(dashboard): archive route + read-only view"
```

---

## Task 13: Resume tests — switchboard + ingester end-to-end

**Files:**

- Test: extend `tests/switchboard.test.ts` (resume scenarios)

- [ ] **Step 1: Add tests for both resume cases** — append to `tests/switchboard.test.ts`'s describe block:

```ts
test('Case A — resuming an archived uuid keeps the archive row + adopts uuid as live', () => {
  registerSession(db, 'foo', '/tmp')
  const sb = createSwitchboard(db)

  // Phase 1: live=A, then archive A and adopt B (e.g. /clear)
  sb.handleSessionHello(fakeWs('session'), {
    token: getSessionByName(db, 'foo')!.token,
    name: 'foo',
    cc_session_uuid: 'A',
    pid: 1,
    machine_id: null,
  })
  sb.reconcileCcSessionUuid('foo', 'B', 'hook_drift')

  // Phase 2: user runs /resume back to A. New hook event carries A.
  sb.reconcileCcSessionUuid('foo', 'A', 'hook_drift')

  // Live uuid should now be A again. B is now archived.
  const cur = db.query(`SELECT cc_session_uuid FROM ccpl_sessions WHERE name = ?`).get('foo') as {
    cc_session_uuid: string
  }
  expect(cur.cc_session_uuid).toBe('A')

  // Both A and B archives exist as historical rows. listArchivesForSession
  // should excludes the live uuid (A) from `archives`.
  const { listArchivesForSession } = require('../src/storage/transcript-entries')
  const list = listArchivesForSession(db, 'foo', 32)
  expect(list.live?.uuid).toBe('A')
  expect(list.archives.map((a: { uuid: string }) => a.uuid)).toEqual(['B'])
})

test('Case B — onUuidAdopted fires for stranger uuid (dashboard wires backfill there)', () => {
  registerSession(db, 'foo', '/tmp')
  const adopted: Array<{ name: string; uuid: string }> = []
  const sb = createSwitchboard(db, {
    onUuidAdopted: (name, uuid) => adopted.push({ name, uuid }),
  })
  sb.reconcileCcSessionUuid('foo', 'never-seen-uuid', 'hook_drift')
  expect(adopted).toEqual([{ name: 'foo', uuid: 'never-seen-uuid' }])
})
```

- [ ] **Step 2: Run tests — confirm they pass**

```
bun test tests/switchboard.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```
git add tests/switchboard.test.ts
git commit -m "test(switchboard): /resume Case A (archive) + Case B (stranger)"
```

---

## Task 14: End-to-end browser verification of the full feature

**Files:** None — this task is verification, no code changes.

- [ ] **Step 1: Start a fresh test dashboard**

```
PARTY_LINE_DASHBOARD_PASSWORD=partyline PARTY_LINE_DASHBOARD_SECRET=$(openssl rand -hex 32) bun dashboard/serve.ts --port 3411 > /tmp/e2e-test.log 2>&1 &
sleep 2
```

- [ ] **Step 2: Seed live entries + a couple archives via SQL**

```
bun -e "
import { Database } from 'bun:sqlite'
const db = new Database(process.env.HOME + '/.config/party-line/dashboard.db')
const insertSession = (name, uuid, online) => {
  try {
    db.query(\`INSERT INTO ccpl_sessions
      (name, token, cwd, cc_session_uuid, online, revision, created_at, last_active_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)\`).run(name, 'tok-' + name, '/tmp', uuid, online ? 1 : 0, Date.now(), Date.now())
  } catch {}
}
const insertArchive = (name, oldUuid) => {
  db.query(\`INSERT INTO ccpl_archives (name, old_uuid, archived_at, reason) VALUES (?, ?, ?, ?)\`)
    .run(name, oldUuid, Date.now() - 3600_000, 'clear')
}
const insertEntry = (uuid, seq, kind, text) => {
  db.query(\`INSERT OR IGNORE INTO transcript_entries
    (cc_session_uuid, seq, session_name, ts, kind, uuid, body_json, created_at)
    VALUES (?, ?, 'e2e-demo', ?, ?, ?, ?, ?)\`)
    .run(uuid, seq, new Date().toISOString(), kind, 'e' + seq, JSON.stringify({ text }), Date.now())
}
insertSession('e2e-demo', 'live-uuid-e2e', 1)
insertEntry('live-uuid-e2e', 0, 'assistant-text', 'Currently working on the spec')
insertArchive('e2e-demo', 'arch-1-e2e')
insertArchive('e2e-demo', 'arch-2-e2e')
insertEntry('arch-1-e2e', 0, 'assistant-text', 'Yesterday I helped debug the PWA install flow')
insertEntry('arch-2-e2e', 0, 'assistant-text', 'Earlier we set up the cookie auth')
console.log('seeded')
"
```

- [ ] **Step 3: Walk the full UX via Playwright**

Use the Playwright MCP tools to:

1. Login
2. Navigate to `/session/e2e-demo`
3. Verify HISTORY sidebar shows 1 LIVE row + 2 archive rows
4. Hover the first archive row — verify tooltip appears with the longer label
5. Click the first archive row — verify URL changes to `/session/e2e-demo/archive/arch-1-e2e`
6. Verify banner is visible, send bar is greyed
7. Verify the stream shows "Yesterday I helped debug the PWA install flow" content
8. Click "Back to live" — verify URL returns to `/session/e2e-demo`
9. Verify banner is hidden, send bar is enabled
10. Take a final screenshot `verify-history-end-to-end.png`

- [ ] **Step 4: Cleanup**

```
pkill -f "port 3411"
rm -f verify-history-end-to-end.png
bun -e "
import { Database } from 'bun:sqlite'
const db = new Database(process.env.HOME + '/.config/party-line/dashboard.db')
db.query('DELETE FROM transcript_entries WHERE session_name = ?').run('e2e-demo')
db.query('DELETE FROM ccpl_archives WHERE name = ?').run('e2e-demo')
db.query('DELETE FROM ccpl_sessions WHERE name = ?').run('e2e-demo')
"
```

- [ ] **Step 5: Final test run + push**

```
bun test
bunx tsc --noEmit
```

Expected: all PASS, tsc clean.

```
git push origin main
```

If any browser verification step fails, do NOT push — diagnose, fix, re-run, and only push when every step in steps 3.1-3.10 passes.

---

## Done

After Task 14, all spec requirements are implemented:

- Schema v6 + `transcript_entries` table
- Streaming ingest from JsonlObserver into DB
- Stranger-uuid backfill on first sight
- /resume Case A (no re-archive of resumed uuid; LIVE becomes that uuid again)
- /resume Case B (stranger adopt + backfill)
- `messages.cc_session_uuid` stamped per envelope
- `/api/archives`, `/api/archive-label`, `/api/transcript?uuid=`
- Sidebar split AGENTS / HISTORY with row labels + tooltips
- `/session/<name>/archive/<uuid>` route + read-only archive view
- All paths verified via Playwright at production-equivalent settings
