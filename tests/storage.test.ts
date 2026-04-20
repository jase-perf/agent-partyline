import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync, mkdtempSync } from 'fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { openDb, SCHEMA_VERSION } from '../src/storage/db.js'
import { insertEvent, upsertSession, recentEvents, sessionState } from '../src/storage/queries.js'
import { pruneOldEvents } from '../src/storage/retention.js'

const TEST_PATH = '/tmp/party-line-test.db'

describe('storage', () => {
  beforeEach(() => {
    try {
      rmSync(TEST_PATH)
    } catch {
      /* no-op */
    }
  })

  test('openDb creates schema', () => {
    const db = openDb(TEST_PATH)
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name)
    expect(tables).toContain('machines')
    expect(tables).toContain('sessions')
    expect(tables).toContain('events')
    expect(tables).toContain('tool_calls')
    expect(tables).toContain('subagents')
    db.close()
  })

  test('openDb is idempotent', () => {
    openDb(TEST_PATH).close()
    const db = openDb(TEST_PATH)
    db.close()
  })

  test('openDb sets user_version to SCHEMA_VERSION', () => {
    const db = openDb(TEST_PATH)
    const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
    expect(row?.user_version).toBe(SCHEMA_VERSION)
    expect(row?.user_version).toBe(3)
    db.close()
  })

  test('openDb enables WAL mode and foreign keys', () => {
    const db = openDb(TEST_PATH)
    const journal = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
    expect(journal?.journal_mode).toBe('wal')
    const fk = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()
    expect(fk?.foreign_keys).toBe(1)
    db.close()
  })

  test('insertEvent + recentEvents roundtrip', () => {
    const db = openDb(TEST_PATH)
    insertEvent(db, {
      machine_id: 'm1',
      session_name: 'test',
      session_id: 's1',
      hook_event: 'PostToolUse',
      ts: '2026-04-19T12:00:00Z',
      payload: { tool_name: 'Bash' },
    })
    const rows = recentEvents(db, { sessionId: 's1', limit: 10 })
    expect(rows.length).toBe(1)
    expect(rows[0]!.hook_event).toBe('PostToolUse')
    expect((rows[0]!.payload as { tool_name: string }).tool_name).toBe('Bash')
    db.close()
  })

  test('upsertSession updates last_seen and name', () => {
    const db = openDb(TEST_PATH)
    upsertSession(db, { session_id: 's1', machine_id: 'm1', name: 'test', last_seen: 't1' })
    upsertSession(db, { session_id: 's1', machine_id: 'm1', name: 'test-renamed', last_seen: 't2' })
    const row = sessionState(db, 's1')
    expect(row?.name).toBe('test-renamed')
    expect(row?.last_seen).toBe('t2')
    db.close()
  })

  test('upsertSession preserves existing fields when inbound is null', () => {
    const db = openDb(TEST_PATH)
    upsertSession(db, {
      session_id: 's1',
      machine_id: 'm1',
      name: 'w',
      last_seen: 't1',
      cwd: '/home/x',
      model: 'sonnet',
    })
    upsertSession(db, {
      session_id: 's1',
      machine_id: 'm1',
      name: 'w',
      last_seen: 't2',
    }) // cwd/model omitted — should be preserved
    const row = sessionState(db, 's1')
    expect(row?.cwd).toBe('/home/x')
    expect(row?.model).toBe('sonnet')
    expect(row?.last_seen).toBe('t2')
    db.close()
  })

  test('pruneOldEvents deletes old events', () => {
    const db = openDb(TEST_PATH)
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    const recent = new Date().toISOString()
    insertEvent(db, {
      machine_id: 'm',
      session_name: 'x',
      session_id: 's1',
      hook_event: 'Stop',
      ts: old,
      payload: {},
    })
    insertEvent(db, {
      machine_id: 'm',
      session_name: 'x',
      session_id: 's1',
      hook_event: 'Stop',
      ts: recent,
      payload: {},
    })
    const deleted = pruneOldEvents(db, 30)
    expect(deleted).toBe(1)
    const remaining = recentEvents(db, { limit: 10 })
    expect(remaining.length).toBe(1)
    db.close()
  })

  test('openDb creates metrics_daily table via migration', () => {
    const db = openDb(TEST_PATH)
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name)
    expect(tables).toContain('metrics_daily')
    db.close()
  })

  test('insertEvent defaults source to claude-code when omitted', () => {
    const db = openDb(TEST_PATH)
    insertEvent(db, {
      machine_id: 'm1',
      session_name: 'test',
      session_id: 's1',
      hook_event: 'Stop',
      ts: '2026-04-19T12:00:00Z',
      payload: {},
    })
    const rows = recentEvents(db, { sessionId: 's1', limit: 1 })
    expect(rows[0]!.source).toBe('claude-code')
    db.close()
  })

  test('insertEvent preserves source when specified', () => {
    const db = openDb(TEST_PATH)
    insertEvent(db, {
      machine_id: 'm1',
      session_name: 'gem',
      session_id: 'gem-1',
      hook_event: 'Stop',
      ts: '2026-04-19T12:00:00Z',
      payload: {},
      source: 'gemini-cli',
    })
    const rows = recentEvents(db, { sessionId: 'gem-1', limit: 1 })
    expect(rows[0]!.source).toBe('gemini-cli')
    db.close()
  })

  test('insertEvent reads source from payload.source when ev.source absent', () => {
    const db = openDb(TEST_PATH)
    insertEvent(db, {
      machine_id: 'm1',
      session_name: 'gem2',
      session_id: 'gem-2',
      hook_event: 'Stop',
      ts: '2026-04-19T12:00:00Z',
      payload: { source: 'gemini-cli' },
    })
    const rows = recentEvents(db, { sessionId: 'gem-2', limit: 1 })
    expect(rows[0]!.source).toBe('gemini-cli')
    db.close()
  })

  test('upsertSession defaults source to claude-code when omitted', () => {
    const db = openDb(TEST_PATH)
    upsertSession(db, { session_id: 's2', machine_id: 'm1', name: 'test2', last_seen: 't1' })
    const row = sessionState(db, 's2')
    expect(row?.source).toBe('claude-code')
    db.close()
  })

  test('upsertSession preserves source when specified', () => {
    const db = openDb(TEST_PATH)
    upsertSession(db, {
      session_id: 's3',
      machine_id: 'm1',
      name: 'gem2',
      last_seen: 't1',
      source: 'gemini-cli',
    })
    const row = sessionState(db, 's3')
    expect(row?.source).toBe('gemini-cli')
    db.close()
  })

  test('upsertSession source is immutable after first write (conflict does not update source)', () => {
    const db = openDb(TEST_PATH)
    upsertSession(db, {
      session_id: 's4',
      machine_id: 'm1',
      name: 'x',
      last_seen: 't1',
      source: 'gemini-cli',
    })
    // Second upsert with different source — should not overwrite
    upsertSession(db, {
      session_id: 's4',
      machine_id: 'm1',
      name: 'x',
      last_seen: 't2',
      source: 'claude-code',
    })
    const row = sessionState(db, 's4')
    expect(row?.source).toBe('gemini-cli')
    db.close()
  })
})

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
