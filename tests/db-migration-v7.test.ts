import { describe, test, expect, afterEach } from 'bun:test'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { openDb, SCHEMA_VERSION } from '../src/storage/db'

describe('schema v7 — index on ccpl_sessions.cc_session_uuid', () => {
  let dir: string

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('SCHEMA_VERSION is 7', () => {
    expect(SCHEMA_VERSION).toBe(7)
  })

  test('fresh DB has idx_ccpl_sessions_cc_uuid index', () => {
    dir = mkdtempSync(join(tmpdir(), 'pl-schema-v7-fresh-'))
    const db = openDb(join(dir, 'fresh.db'))
    const idx = db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ccpl_sessions_cc_uuid'")
      .get()
    expect(idx?.name).toBe('idx_ccpl_sessions_cc_uuid')
    db.close()
  })

  test('migrating an empty v6 DB to v7 adds idx_ccpl_sessions_cc_uuid', () => {
    dir = mkdtempSync(join(tmpdir(), 'pl-schema-v6to7-'))
    const path = join(dir, 'v6.db')
    const raw = new Database(path, { create: true })
    // Build the minimal v6 shape we need: ccpl_sessions table without the new
    // index, plus user_version stamped at 6. We invoke raw.exec (the SQLite
    // method on bun:sqlite Database) — not child_process.exec.
    raw.exec(`
      CREATE TABLE ccpl_sessions (
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
      CREATE INDEX idx_ccpl_sessions_token ON ccpl_sessions(token);
      CREATE INDEX idx_ccpl_sessions_last_active ON ccpl_sessions(last_active_at);
      PRAGMA user_version = 6;
    `)
    raw.close()

    // Sanity: index does not exist before openDb runs the migration.
    const pre = new Database(path)
    const preIdx = pre
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ccpl_sessions_cc_uuid'")
      .get()
    expect(preIdx).toBeNull()
    pre.close()

    const db = openDb(path)
    const idx = db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ccpl_sessions_cc_uuid'")
      .get()
    expect(idx?.name).toBe('idx_ccpl_sessions_cc_uuid')

    const v = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!
    expect(v.user_version).toBe(7)
    db.close()
  })
})
