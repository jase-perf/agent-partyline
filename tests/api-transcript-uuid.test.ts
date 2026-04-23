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

  test('respects limit and orders envelopes by ts ASC', () => {
    // Three messages out of insertion order — verify ORDER BY ts ASC + LIMIT
    for (const [id, ts] of [
      ['env-c', 3000],
      ['env-a', 1000],
      ['env-b', 2000],
    ] as Array<[string, number]>) {
      db.query(
        `INSERT INTO messages (id, ts, from_name, to_name, type, body, callback_id, response_to, cc_session_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, ts, 'foo', 'bar', 'message', 'x', null, null, 'arch')
    }
    const result = buildArchiveTranscriptResponse(db, 'foo', 'arch', 2)
    // Limit honored
    expect(result.envelopes).toHaveLength(2)
    // Ascending by ts: env-a (1000) first, env-b (2000) second; env-c (3000) is excluded by limit=2.
    expect(result.envelopes.map((e) => e.id)).toEqual(['env-a', 'env-b'])
  })
})
