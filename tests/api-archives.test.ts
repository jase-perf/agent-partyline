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
})
