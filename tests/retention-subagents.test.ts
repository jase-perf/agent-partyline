import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db.js'
import { cancelStaleSubagents } from '../src/storage/retention.js'

describe('cancelStaleSubagents', () => {
  let db: Database
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-retsa-'))
    db = openDb(join(dir, 't.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function insert(agent_id: string, startedHoursAgo: number, status: string, now: number): void {
    const startedIso = new Date(now - startedHoursAgo * 60 * 60 * 1000).toISOString()
    db.query(
      `INSERT INTO subagents (agent_id, session_id, agent_type, description, started_at, status)
       VALUES (?, 's', 'X', 'd', ?, ?)`,
    ).run(agent_id, startedIso, status)
  }

  test('cancels running subagents older than maxAgeHours', () => {
    const now = Date.now()
    insert('old', 25, 'running', now)
    insert('fresh', 1, 'running', now)
    const n = cancelStaleSubagents(db, 24, now)
    expect(n).toBe(1)
    const old = db.query(`SELECT status, ended_at FROM subagents WHERE agent_id='old'`).get() as {
      status: string
      ended_at: string
    }
    expect(old.status).toBe('cancelled')
    expect(old.ended_at).toBe(new Date(now).toISOString())
    const fresh = db.query(`SELECT status FROM subagents WHERE agent_id='fresh'`).get() as {
      status: string
    }
    expect(fresh.status).toBe('running')
  })

  test('does not touch already-completed subagents', () => {
    const now = Date.now()
    insert('done', 48, 'completed', now)
    const n = cancelStaleSubagents(db, 24, now)
    expect(n).toBe(0)
    const done = db.query(`SELECT status FROM subagents WHERE agent_id='done'`).get() as {
      status: string
    }
    expect(done.status).toBe('completed')
  })

  test('returns 0 when nothing stale', () => {
    const n = cancelStaleSubagents(db, 24, Date.now())
    expect(n).toBe(0)
  })
})
