import { describe, test, expect } from 'bun:test'
import { createWsClient } from '../src/transport/ws-client'

describe('ws-client', () => {
  test('connects to a local WS server, sends hello, receives echo', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req)) return
        return new Response('no', { status: 400 })
      },
      websocket: {
        open(_ws) {},
        message(ws, msg) {
          const frame = JSON.parse(String(msg)) as { type?: string }
          if (frame.type === 'hello') {
            ws.send(JSON.stringify({ type: 'accepted', server_time: Date.now() }))
          }
        },
      },
    })

    const url = `ws://localhost:${server.port}/`
    const frames: Array<{ type?: string }> = []
    const client = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: 't',
        name: 'foo',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'test',
      },
      pingIntervalMs: 60_000,
    })
    client.on('frame', (f: { type?: string }) => frames.push(f))
    client.start()

    for (let i = 0; i < 50 && frames.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(frames[0]?.type).toBe('accepted')

    client.stop()
    server.stop()
  })

  test('reconnects after server drop', async () => {
    let openCount = 0
    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req)) return
        return new Response('no', { status: 400 })
      },
      websocket: {
        open(ws) {
          openCount++
          if (openCount === 1) setTimeout(() => ws.close(), 50)
        },
        message() {},
      },
    })
    const url = `ws://localhost:${server.port}/`
    const client = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: 't',
        name: 'r',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'test',
      },
      pingIntervalMs: 60_000,
      reconnectInitialMs: 30,
      reconnectMaxMs: 100,
    })
    client.start()
    for (let i = 0; i < 50 && openCount < 2; i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(openCount).toBeGreaterThanOrEqual(2)
    client.stop()
    server.stop()
  })

  test('does NOT reconnect on close code 4401', async () => {
    let openCount = 0
    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req)) return
        return new Response('no', { status: 400 })
      },
      websocket: {
        open(ws) {
          openCount++
          setTimeout(() => ws.close(4401, 'invalid_token'), 30)
        },
        message() {},
      },
    })
    const url = `ws://localhost:${server.port}/`
    const client = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: 'bad',
        name: 'r',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'test',
      },
      pingIntervalMs: 60_000,
      reconnectInitialMs: 30,
    })
    client.start()
    await new Promise((r) => setTimeout(r, 300))
    expect(openCount).toBe(1)
    client.stop()
    server.stop()
  })
})
