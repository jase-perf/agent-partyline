import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync } from 'fs'
import { openDb, SCHEMA_VERSION } from '../src/storage/db.js'

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
})
