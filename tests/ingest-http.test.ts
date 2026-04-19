import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync } from 'fs'
import { openDb } from '../src/storage/db.js'
import { handleIngest } from '../src/ingest/http.js'

const DB_PATH = '/tmp/party-line-ingest-http-test.db'
const TOKEN = 'test-token'

describe('handleIngest', () => {
  beforeEach(() => {
    try { rmSync(DB_PATH) } catch { /* no-op */ }
  })

  test('accepts valid event with correct token', async () => {
    const db = openDb(DB_PATH)
    const body = JSON.stringify({
      machine_id: 'm1',
      session_name: 'test',
      session_id: 's1',
      hook_event: 'Stop',
      ts: '2026-04-19T12:00:00Z',
      payload: {},
    })
    const req = new Request('http://x/ingest', {
      method: 'POST',
      body,
      headers: { 'X-Party-Line-Token': TOKEN, 'Content-Type': 'application/json' },
    })
    let pushed: unknown = null
    const res = await handleIngest(req, { db, token: TOKEN, onEvent: (e) => { pushed = e } })
    expect(res.status).toBe(200)
    expect((pushed as { hook_event: string }).hook_event).toBe('Stop')
    db.close()
  })

  test('rejects bad token', async () => {
    const db = openDb(DB_PATH)
    const req = new Request('http://x/ingest', {
      method: 'POST',
      body: '{}',
      headers: { 'X-Party-Line-Token': 'wrong' },
    })
    const res = await handleIngest(req, { db, token: TOKEN, onEvent: () => {} })
    expect(res.status).toBe(401)
    db.close()
  })

  test('rejects malformed body', async () => {
    const db = openDb(DB_PATH)
    const req = new Request('http://x/ingest', {
      method: 'POST',
      body: '{"bad": true}',
      headers: { 'X-Party-Line-Token': TOKEN },
    })
    const res = await handleIngest(req, { db, token: TOKEN, onEvent: () => {} })
    expect(res.status).toBe(400)
    db.close()
  })

  test('rejects GET', async () => {
    const db = openDb(DB_PATH)
    const req = new Request('http://x/ingest', { method: 'GET' })
    const res = await handleIngest(req, { db, token: TOKEN, onEvent: () => {} })
    expect(res.status).toBe(405)
    db.close()
  })

  test('returns 500 if storage fails', async () => {
    const db = openDb(DB_PATH)
    db.close()
    const body = JSON.stringify({
      machine_id: 'm1', session_name: 'test', session_id: 's1',
      hook_event: 'Stop', ts: '2026-04-19T12:00:00Z', payload: {},
    })
    const req = new Request('http://x/ingest', {
      method: 'POST',
      body,
      headers: { 'X-Party-Line-Token': TOKEN, 'Content-Type': 'application/json' },
    })
    const res = await handleIngest(req, { db, token: TOKEN, onEvent: () => {} })
    expect(res.status).toBe(500)
  })
})
