import { describe, test, expect, beforeEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import { registerSession } from '../src/storage/ccpl-queries'
import { createSwitchboard } from '../src/server/switchboard'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function fakeWs(kind: 'session' | 'observer') {
  const sent: string[] = []
  const closeCalls: Array<[number | undefined, string | undefined]> = []
  return {
    sent,
    closeCalls,
    data: { kind } as Record<string, unknown>,
    send(msg: string) {
      sent.push(msg)
    },
    close(code?: number, reason?: string) {
      closeCalls.push([code, reason])
    },
  } as unknown as Parameters<ReturnType<typeof createSwitchboard>['handleSessionHello']>[0] & {
    sent: string[]
    closeCalls: Array<[number | undefined, string | undefined]>
    data: Record<string, unknown>
  }
}

describe('switchboard', () => {
  let db: Database
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pl-sw-'))
    db = openDb(join(tmp, 't.db'))
  })

  function cleanup() {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  }

  test('hello with valid token marks session online and emits session-delta', () => {
    const row = registerSession(db, 'foo', '/tmp')
    const sb = createSwitchboard(db)
    const ws = fakeWs('session')
    const obs = fakeWs('observer')
    sb.handleObserverOpen(obs as never)
    const res = sb.handleSessionHello(ws, {
      token: row.token,
      name: 'foo',
      cc_session_uuid: 'uuid-1',
      pid: 123,
      machine_id: 'm',
    })
    expect(res.ok).toBe(true)
    expect(obs.sent.length).toBeGreaterThanOrEqual(2) // snapshot + delta
    const delta = obs.sent
      .map((s) => JSON.parse(s) as { type: string })
      .find((f) => f.type === 'session-delta') as
      | { type: string; session: string; changes: { online: boolean } }
      | undefined
    expect(delta).toBeDefined()
    expect(delta?.session).toBe('foo')
    expect(delta?.changes.online).toBe(true)
    cleanup()
  })

  test('hello with bad token returns 4401', () => {
    const sb = createSwitchboard(db)
    const res = sb.handleSessionHello(fakeWs('session'), {
      token: 'nope',
      name: 'foo',
      cc_session_uuid: null,
      pid: 1,
      machine_id: null,
    })
    expect(res.ok).toBe(false)
    expect(res.code).toBe(4401)
    cleanup()
  })

  test('second hello for same name supersedes first (close 4408)', () => {
    const row = registerSession(db, 'foo', '/tmp')
    const sb = createSwitchboard(db)
    const first = fakeWs('session')
    sb.handleSessionHello(first, {
      token: row.token,
      name: 'foo',
      cc_session_uuid: null,
      pid: 1,
      machine_id: null,
    })
    const second = fakeWs('session')
    sb.handleSessionHello(second, {
      token: row.token,
      name: 'foo',
      cc_session_uuid: null,
      pid: 2,
      machine_id: null,
    })
    expect(first.closeCalls[0]?.[0]).toBe(4408)
    cleanup()
  })

  test('send routes to recipient and observer, returns sent ack', () => {
    const a = registerSession(db, 'a', '/tmp')
    const b = registerSession(db, 'b', '/tmp')
    const sb = createSwitchboard(db)
    const wsA = fakeWs('session')
    const wsB = fakeWs('session')
    const obs = fakeWs('observer')
    sb.handleObserverOpen(obs as never)
    sb.handleSessionHello(wsA, {
      token: a.token,
      name: 'a',
      cc_session_uuid: null,
      pid: 1,
      machine_id: null,
    })
    sb.handleSessionHello(wsB, {
      token: b.token,
      name: 'b',
      cc_session_uuid: null,
      pid: 2,
      machine_id: null,
    })

    obs.sent.length = 0
    wsA.sent.length = 0
    wsB.sent.length = 0

    sb.handleSessionFrame(wsA, {
      type: 'send',
      to: 'b',
      body: 'hello',
      client_ref: 'c1',
    })

    const ack = wsA.sent
      .map((s: string) => JSON.parse(s) as { type: string; client_ref?: string })
      .find((f) => f.type === 'sent')
    expect(ack).toBeDefined()
    expect(ack?.client_ref).toBe('c1')
    const delivery = wsB.sent
      .map(
        (s: string) => JSON.parse(s) as { type: string; body?: string; from?: string; to?: string },
      )
      .find((f) => f.type === 'envelope')
    expect(delivery).toBeDefined()
    expect(delivery?.body).toBe('hello')
    expect(delivery?.from).toBe('a')
    expect(delivery?.to).toBe('b')

    const obsEnvelope = obs.sent
      .map((s: string) => JSON.parse(s) as { type: string })
      .find((f) => f.type === 'envelope')
    expect(obsEnvelope).toBeDefined()
    cleanup()
  })

  test('session close marks offline and emits delta', () => {
    const row = registerSession(db, 'foo', '/tmp')
    const sb = createSwitchboard(db)
    const ws = fakeWs('session')
    const obs = fakeWs('observer')
    sb.handleObserverOpen(obs as never)
    sb.handleSessionHello(ws, {
      token: row.token,
      name: 'foo',
      cc_session_uuid: null,
      pid: 1,
      machine_id: null,
    })
    obs.sent.length = 0

    sb.handleSessionClose(ws)
    const delta = obs.sent
      .map((s) => JSON.parse(s) as { type: string; changes?: { online: boolean } })
      .find((f) => f.type === 'session-delta')
    expect(delta).toBeDefined()
    expect(delta?.changes?.online).toBe(false)
    cleanup()
  })

  test('uuid-rotate archives old uuid and updates current', () => {
    const row = registerSession(db, 'foo', '/tmp')
    const sb = createSwitchboard(db)
    const ws = fakeWs('session')
    sb.handleSessionHello(ws, {
      token: row.token,
      name: 'foo',
      cc_session_uuid: 'uuid-1',
      pid: 1,
      machine_id: null,
    })
    sb.handleSessionFrame(ws, {
      type: 'uuid-rotate',
      old_uuid: 'uuid-1',
      new_uuid: 'uuid-2',
    })
    const archives = db.query(`SELECT * FROM ccpl_archives WHERE name = ?`).all('foo') as Array<{
      old_uuid: string
      reason: string
    }>
    expect(archives.length).toBe(1)
    expect(archives[0]!.old_uuid).toBe('uuid-1')
    expect(archives[0]!.reason).toBe('clear')
    cleanup()
  })

  test('send permission-request envelope emits both envelope and permission-request observer frames', () => {
    const a = registerSession(db, 'a', '/tmp')
    const b = registerSession(db, 'b', '/tmp')
    const sb = createSwitchboard(db)
    const wsA = fakeWs('session')
    const wsB = fakeWs('session')
    const obs = fakeWs('observer')
    sb.handleObserverOpen(obs as never)
    sb.handleSessionHello(wsA, {
      token: a.token,
      name: 'a',
      cc_session_uuid: null,
      pid: 1,
      machine_id: null,
    })
    sb.handleSessionHello(wsB, {
      token: b.token,
      name: 'b',
      cc_session_uuid: null,
      pid: 2,
      machine_id: null,
    })

    obs.sent.length = 0

    const permBody = JSON.stringify({
      request_id: 'req-1',
      tool_name: 'Bash',
      description: 'run ls',
      input_preview: 'ls -la',
    })
    sb.handleSessionFrame(wsA, {
      type: 'send',
      to: 'b',
      frame_type: 'permission-request',
      body: permBody,
      client_ref: 'c1',
    })

    const frames = obs.sent.map(
      (s: string) =>
        JSON.parse(s) as {
          type: string
          envelope_type?: string
          data?: { request_id?: string; tool_name?: string; from?: string; to?: string }
        },
    )
    const envelopeFrame = frames.find(
      (f) => f.type === 'envelope' && f.envelope_type === 'permission-request',
    )
    expect(envelopeFrame).toBeDefined()

    const permFrame = frames.find((f) => f.type === 'permission-request')
    expect(permFrame).toBeDefined()
    expect(permFrame?.data?.request_id).toBe('req-1')
    expect(permFrame?.data?.tool_name).toBe('Bash')
    expect(permFrame?.data?.from).toBe('a')
    expect(permFrame?.data?.to).toBe('b')
    cleanup()
  })

  test('send permission-response envelope emits permission-resolved observer frame', () => {
    const a = registerSession(db, 'a', '/tmp')
    const b = registerSession(db, 'b', '/tmp')
    const sb = createSwitchboard(db)
    const wsA = fakeWs('session')
    const wsB = fakeWs('session')
    const obs = fakeWs('observer')
    sb.handleObserverOpen(obs as never)
    sb.handleSessionHello(wsA, {
      token: a.token,
      name: 'a',
      cc_session_uuid: null,
      pid: 1,
      machine_id: null,
    })
    sb.handleSessionHello(wsB, {
      token: b.token,
      name: 'b',
      cc_session_uuid: null,
      pid: 2,
      machine_id: null,
    })

    obs.sent.length = 0

    const respBody = JSON.stringify({
      request_id: 'req-1',
      behavior: 'allow',
    })
    // b responds to a's request.
    sb.handleSessionFrame(wsB, {
      type: 'send',
      to: 'a',
      frame_type: 'permission-response',
      body: respBody,
      client_ref: 'c2',
    })

    const frames = obs.sent.map(
      (s: string) =>
        JSON.parse(s) as {
          type: string
          data?: { session?: string; request_id?: string; behavior?: string; resolved_by?: string }
        },
    )
    const resolvedFrame = frames.find((f) => f.type === 'permission-resolved')
    expect(resolvedFrame).toBeDefined()
    expect(resolvedFrame?.data?.session).toBe('a')
    expect(resolvedFrame?.data?.request_id).toBe('req-1')
    expect(resolvedFrame?.data?.behavior).toBe('allow')
    expect(resolvedFrame?.data?.resolved_by).toBe('b')
    cleanup()
  })

  test('uuid-rotate with mismatched old_uuid still archives current uuid', () => {
    const row = registerSession(db, 'foo', '/tmp')
    const sb = createSwitchboard(db)
    const ws = fakeWs('session')
    sb.handleSessionHello(ws, {
      token: row.token,
      name: 'foo',
      cc_session_uuid: 'server-uuid',
      pid: 1,
      machine_id: null,
    })
    // Client claims old_uuid was something else.
    sb.handleSessionFrame(ws, {
      type: 'uuid-rotate',
      old_uuid: 'not-the-server-uuid',
      new_uuid: 'new-uuid',
    })
    const archives = db.query(`SELECT * FROM ccpl_archives WHERE name = ?`).all('foo') as Array<{
      old_uuid: string
      reason: string
    }>
    expect(archives.length).toBe(1)
    expect(archives[0]!.old_uuid).toBe('server-uuid')
    expect(archives[0]!.reason).toBe('rotate_uuid_drift')
    cleanup()
  })
})
