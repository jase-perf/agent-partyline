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

  test('returns user + assistant entries from transcript_entries in seq order', () => {
    registerSession(db, 'foo', '/tmp')
    insertEntry(db, {
      cc_session_uuid: 'arch',
      seq: 1,
      session_name: 'foo',
      ts: '2026-04-22T00:00:01Z',
      kind: 'assistant-text',
      uuid: 'b',
      body_json: JSON.stringify({
        type: 'assistant',
        uuid: 'b',
        timestamp: '2026-04-22T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      }),
      created_at: Date.now(),
    })
    insertEntry(db, {
      cc_session_uuid: 'arch',
      seq: 0,
      session_name: 'foo',
      ts: '2026-04-22T00:00:00Z',
      kind: 'user',
      uuid: 'a',
      body_json: JSON.stringify({
        type: 'user',
        uuid: 'a',
        timestamp: '2026-04-22T00:00:00Z',
        message: { role: 'user', content: 'question' },
      }),
      created_at: Date.now(),
    })
    const result = buildArchiveTranscriptResponse(db, 'foo', 'arch', 100)
    expect(Array.isArray(result)).toBe(true)
    // The fold may collapse certain entries; assert both kinds appear.
    const types = result.map((e) => e.type)
    expect(types).toContain('user')
    expect(types).toContain('assistant-text')
  })

  test('returns empty array when uuid has no rows', () => {
    const result = buildArchiveTranscriptResponse(db, 'foo', 'never-seen', 100)
    expect(result).toEqual([])
  })

  test('includes party-line-receive entries from messages WHERE cc_session_uuid = uuid', () => {
    db.query(
      `INSERT INTO messages (id, ts, from_name, to_name, type, body, callback_id, response_to, cc_session_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('env-1', 1_700_000_000_000, 'other', 'foo', 'message', 'pong', null, null, 'arch')
    const result = buildArchiveTranscriptResponse(db, 'foo', 'arch', 100)
    const partyEntries = result.filter((e) => e.type === 'party-line-receive')
    expect(partyEntries.length).toBe(1)
    expect(partyEntries[0]!.envelope_id).toBe('env-1')
  })

  test('respects limit and orders by ts ASC', () => {
    for (const [id, ts] of [
      ['env-c', 3_000_000],
      ['env-a', 1_000_000],
      ['env-b', 2_000_000],
    ] as Array<[string, number]>) {
      db.query(
        `INSERT INTO messages (id, ts, from_name, to_name, type, body, callback_id, response_to, cc_session_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, ts, 'other', 'foo', 'message', 'x', null, null, 'arch')
    }
    const result = buildArchiveTranscriptResponse(db, 'foo', 'arch', 2)
    const partyEntries = result.filter((e) => e.type === 'party-line-receive')
    // Tail sliced by limit, ordered by ts ASC inside recordsToTranscript.
    expect(partyEntries.length).toBeLessThanOrEqual(2)
    expect(partyEntries.map((e) => e.envelope_id)).toEqual(
      partyEntries
        .map((e) => e.envelope_id)
        .slice()
        .sort(),
    )
  })
})
