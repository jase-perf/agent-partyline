import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createWsClient } from '../src/transport/ws-client'

function generateSelfSignedCert(): { certPath: string; keyPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ws-cert-'))
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  const res = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  if (res.status !== 0) throw new Error('openssl failed')
  return { certPath, keyPath, dir }
}

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

  test('re-evaluates helloPayload factory on each reconnect', async () => {
    let openCount = 0
    let receivedHelloUuids: Array<string | null> = []
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
        message(_ws, msg) {
          const frame = JSON.parse(String(msg)) as {
            type?: string
            cc_session_uuid?: string | null
          }
          if (frame.type === 'hello') receivedHelloUuids.push(frame.cc_session_uuid ?? null)
        },
      },
    })
    let uuid: string | null = null
    const client = createWsClient({
      url: `ws://localhost:${server.port}/`,
      helloPayload: () => ({
        type: 'hello',
        token: 't',
        name: 'factory',
        cc_session_uuid: uuid,
        pid: 1,
        machine_id: null,
        version: 'test',
      }),
      pingIntervalMs: 60_000,
      reconnectInitialMs: 30,
      reconnectMaxMs: 100,
    })
    client.start()
    // First hello (uuid=null), wait for close + reconnect.
    for (let i = 0; i < 50 && receivedHelloUuids.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    uuid = 'second-uuid'
    for (let i = 0; i < 50 && receivedHelloUuids.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(receivedHelloUuids[0]).toBe(null)
    expect(receivedHelloUuids[1]).toBe('second-uuid')
    client.stop()
    server.stop()
  })

  test('accepts self-signed cert for localhost WSS', async () => {
    const { certPath, keyPath, dir } = generateSelfSignedCert()
    const { readFileSync } = await import('node:fs')
    const cert = readFileSync(certPath)
    const key = readFileSync(keyPath)

    const server = Bun.serve({
      port: 0,
      tls: { cert, key },
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

    try {
      const url = `wss://localhost:${server.port}/`
      const frames: Array<{ type?: string }> = []
      const client = createWsClient({
        url,
        helloPayload: {
          type: 'hello',
          token: 't',
          name: 'tls',
          cc_session_uuid: null,
          pid: 1,
          machine_id: null,
          version: 'test',
        },
        pingIntervalMs: 60_000,
      })
      client.on('frame', (f: { type?: string }) => frames.push(f))
      client.start()
      for (let i = 0; i < 100 && frames.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(frames[0]?.type).toBe('accepted')
      client.stop()
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
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
