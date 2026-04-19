import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync } from 'fs'
import { openDb, SCHEMA_VERSION } from '../src/storage/db.js'
import { insertEvent, upsertSession, recentEvents, sessionState } from '../src/storage/queries.js'

const TEST_PATH = '/tmp/party-line-test.db'

describe('storage', () => {
  beforeEach(() => {
    try { rmSync(TEST_PATH) } catch { /* no-op */ }
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
    expect(row?.user_version).toBe(1)
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
      session_id: 's1', machine_id: 'm1', name: 'w', last_seen: 't1',
      cwd: '/home/x', model: 'sonnet',
    })
    upsertSession(db, {
      session_id: 's1', machine_id: 'm1', name: 'w', last_seen: 't2',
    }) // cwd/model omitted — should be preserved
    const row = sessionState(db, 's1')
    expect(row?.cwd).toBe('/home/x')
    expect(row?.model).toBe('sonnet')
    expect(row?.last_seen).toBe('t2')
    db.close()
  })
})
