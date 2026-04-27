import { describe, test, expect } from 'bun:test'
import { openDb } from '../src/storage/db'
import { pruneOldEvents } from '../src/storage/retention'

describe('pruneOldEvents', () => {
  test('deletes all old events in chunks, returns total deleted', () => {
    const db = openDb(':memory:')

    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const oldTs = new Date(cutoffDate.getTime() - 1000).toISOString()
    const newTs = new Date().toISOString()

    const insertStmt = db.prepare(
      `INSERT INTO events (machine_id, session_id, session_name, hook_event, ts, payload_json, source)
       VALUES ('m1', 's1', 'test', 'Stop', ?, '{}', 'claude-code')`,
    )

    // Insert 2500 old events and 100 new ones
    for (let i = 0; i < 2500; i++) insertStmt.run(oldTs)
    for (let i = 0; i < 100; i++) insertStmt.run(newTs)

    const deleted = pruneOldEvents(db, 30)
    expect(deleted).toBe(2500)

    const remaining = db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    expect(remaining.n).toBe(100)
  })
})
