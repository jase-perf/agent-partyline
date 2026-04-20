import { describe, test, expect } from 'bun:test'
import { openDb } from '../src/storage/db'
import { registerSession } from '../src/storage/ccpl-queries'
import { createSwitchboard } from '../src/server/switchboard'
import { createWsClient } from '../src/transport/ws-client'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('integration: two WS clients via switchboard', () => {
  test('A sends to B, B receives the envelope', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pl-int-'))
    const db = openDb(join(tmp, 't.db'))
    const a = registerSession(db, 'intA', '/tmp')
    const b = registerSession(db, 'intB', '/tmp')
    const sb = createSwitchboard(db)

    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req, { data: { kind: 'session' } })) return
        return new Response('no', { status: 400 })
      },
      websocket: {
        data: {} as { kind: 'session' },
        open() {},
        message(ws, raw) {
          let frame: { type?: string; [k: string]: unknown }
          try {
            frame = JSON.parse(String(raw)) as { type?: string; [k: string]: unknown }
          } catch {
            return
          }
          if (frame.type === 'hello') {
            const res = sb.handleSessionHello(ws as never, frame as never)
            if (!res.ok) {
              ws.close(res.code ?? 4401, res.error)
              return
            }
            ws.send(JSON.stringify({ type: 'accepted', server_time: Date.now() }))
            return
          }
          sb.handleSessionFrame(ws as never, frame)
        },
        close(ws) {
          sb.handleSessionClose(ws as never)
        },
      },
    })

    const url = `ws://localhost:${server.port}/`
    const received: Array<{
      type: string
      from: string
      to: string
      body: string | null
      envelope_type: string
    }> = []
    const clientA = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: a.token,
        name: 'intA',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'int',
      },
      pingIntervalMs: 60_000,
    })
    const clientB = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: b.token,
        name: 'intB',
        cc_session_uuid: null,
        pid: 2,
        machine_id: null,
        version: 'int',
      },
      pingIntervalMs: 60_000,
    })
    clientB.on('envelope', (f: (typeof received)[number]) => received.push(f))

    let aReady = false
    clientA.on('accepted', () => {
      aReady = true
    })
    let bReady = false
    clientB.on('accepted', () => {
      bReady = true
    })

    clientA.start()
    clientB.start()

    for (let i = 0; i < 100 && (!aReady || !bReady); i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(aReady).toBe(true)
    expect(bReady).toBe(true)

    clientA.send({
      type: 'send',
      to: 'intB',
      frame_type: 'message',
      body: 'hello int',
      client_ref: 'r1',
    })

    for (let i = 0; i < 100 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(received.length).toBe(1)
    expect(received[0]!.from).toBe('intA')
    expect(received[0]!.to).toBe('intB')
    expect(received[0]!.body).toBe('hello int')
    expect(received[0]!.envelope_type).toBe('message')

    clientA.stop()
    clientB.stop()
    server.stop()
    await new Promise((r) => setTimeout(r, 50))
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('bad token closes with 4401 and does NOT reconnect', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pl-int-'))
    const db = openDb(join(tmp, 't.db'))
    const sb = createSwitchboard(db)

    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req, { data: { kind: 'session' } })) return
        return new Response('no', { status: 400 })
      },
      websocket: {
        data: {} as { kind: 'session' },
        open() {},
        message(ws, raw) {
          let frame: { type?: string; [k: string]: unknown }
          try {
            frame = JSON.parse(String(raw)) as { type?: string; [k: string]: unknown }
          } catch {
            return
          }
          if (frame.type === 'hello') {
            const res = sb.handleSessionHello(ws as never, frame as never)
            if (!res.ok) {
              ws.close(res.code ?? 4401, res.error)
              return
            }
            ws.send(JSON.stringify({ type: 'accepted', server_time: Date.now() }))
          }
        },
        close(ws) {
          sb.handleSessionClose(ws as never)
        },
      },
    })

    const url = `ws://localhost:${server.port}/`
    let closeCount = 0
    let closeCode = 0
    const client = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: 'definitely-not-a-real-token',
        name: 'ghost',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'int',
      },
      pingIntervalMs: 60_000,
      reconnectInitialMs: 30,
    })
    client.on('close', (code: number) => {
      closeCount++
      closeCode = code
    })
    client.start()
    await new Promise((r) => setTimeout(r, 400))
    expect(closeCount).toBe(1)
    expect(closeCode).toBe(4401)

    client.stop()
    server.stop()
    await new Promise((r) => setTimeout(r, 50))
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('second connection with same token supersedes first (4408)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pl-int-'))
    const db = openDb(join(tmp, 't.db'))
    const row = registerSession(db, 'superA', '/tmp')
    const sb = createSwitchboard(db)

    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req, { data: { kind: 'session' } })) return
        return new Response('no', { status: 400 })
      },
      websocket: {
        data: {} as { kind: 'session' },
        open() {},
        message(ws, raw) {
          let frame: { type?: string; [k: string]: unknown }
          try {
            frame = JSON.parse(String(raw)) as { type?: string; [k: string]: unknown }
          } catch {
            return
          }
          if (frame.type === 'hello') {
            const res = sb.handleSessionHello(ws as never, frame as never)
            if (!res.ok) {
              ws.close(res.code ?? 4401, res.error)
              return
            }
            ws.send(JSON.stringify({ type: 'accepted', server_time: Date.now() }))
            return
          }
          sb.handleSessionFrame(ws as never, frame)
        },
        close(ws) {
          sb.handleSessionClose(ws as never)
        },
      },
    })

    const url = `ws://localhost:${server.port}/`
    const first = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: row.token,
        name: 'superA',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'int',
      },
      pingIntervalMs: 60_000,
      reconnectInitialMs: 30,
    })
    let firstCloseCode = 0
    first.on('close', (code: number) => {
      firstCloseCode = code
    })
    // Server sends an `error` frame (code: superseded) right before closing 4408.
    // Attach a no-op listener so EventEmitter doesn't treat it as unhandled.
    first.on('error', () => {})
    first.start()
    await new Promise((r) => {
      first.on('accepted', r)
    })

    const second = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: row.token,
        name: 'superA',
        cc_session_uuid: null,
        pid: 2,
        machine_id: null,
        version: 'int',
      },
      pingIntervalMs: 60_000,
    })
    second.start()
    await new Promise((r) => {
      second.on('accepted', r)
    })

    await new Promise((r) => setTimeout(r, 200))
    expect(firstCloseCode).toBe(4408)

    first.stop()
    second.stop()
    server.stop()
    await new Promise((r) => setTimeout(r, 50))
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })
})
