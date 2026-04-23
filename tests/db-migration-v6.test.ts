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
    const raw = new Database(path, { create: true })
    raw.exec('PRAGMA user_version = 5')
    raw.close()
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
