import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const EMIT_SH = join(import.meta.dir, '..', 'hooks', 'emit.sh')

describe('emit.sh', () => {
  let home: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let received: Array<{ headers: Record<string, string>; body: string }> = []

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'emit-hook-'))
    mkdirSync(join(home, '.config', 'party-line'), { recursive: true })
    writeFileSync(join(home, '.config', 'party-line', 'ingest-token'), 'tkn')
    writeFileSync(join(home, '.config', 'party-line', 'machine-id'), 'mid')
    received = []
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const headers: Record<string, string> = {}
        req.headers.forEach((v, k) => {
          headers[k] = v
        })
        const body = await req.text()
        received.push({ headers, body })
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
      },
    })
  })

  afterEach(() => {
    server?.stop()
    rmSync(home, { recursive: true, force: true })
  })

  test('default endpoint is HTTPS (not HTTP)', () => {
    const content = readFileSync(EMIT_SH, 'utf8')
    expect(content).toMatch(/PARTY_LINE_INGEST:-https:\/\//)
    expect(content).not.toMatch(/PARTY_LINE_INGEST:-http:\/\//)
  })

  test('includes -k for localhost HTTPS (accepts self-signed cert)', () => {
    const content = readFileSync(EMIT_SH, 'utf8')
    expect(content).toMatch(/https:\/\/localhost/)
    expect(content).toMatch(/-k/)
  })

  test('posts envelope to PARTY_LINE_INGEST override', async () => {
    const port = (server as { port: number }).port
    const endpoint = `http://127.0.0.1:${port}/ingest`
    const res = spawnSync('bash', [EMIT_SH, 'Stop'], {
      input: JSON.stringify({ session_id: 'sid-1' }),
      env: {
        HOME: home,
        PATH: process.env.PATH ?? '',
        CLAUDE_SESSION_NAME: 'tname',
        PARTY_LINE_INGEST: endpoint,
      },
    })
    expect(res.status).toBe(0)

    // emit.sh backgrounds the curl with `&`; poll briefly for arrival.
    for (let i = 0; i < 50 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(received.length).toBeGreaterThan(0)
    const r = received[0]!
    expect(r.headers['x-party-line-token']).toBe('tkn')
    const body = JSON.parse(r.body) as {
      machine_id: string
      session_name: string
      session_id: string
      hook_event: string
    }
    expect(body.machine_id).toBe('mid')
    expect(body.session_name).toBe('tname')
    expect(body.session_id).toBe('sid-1')
    expect(body.hook_event).toBe('Stop')
  })

  test('exits silently if token file is missing (no POST)', async () => {
    rmSync(join(home, '.config', 'party-line', 'ingest-token'))
    const port = (server as { port: number }).port
    const endpoint = `http://127.0.0.1:${port}/ingest`
    const res = spawnSync('bash', [EMIT_SH, 'Stop'], {
      input: '{}',
      env: {
        HOME: home,
        PATH: process.env.PATH ?? '',
        CLAUDE_SESSION_NAME: 't',
        PARTY_LINE_INGEST: endpoint,
      },
    })
    expect(res.status).toBe(0)
    await new Promise((r) => setTimeout(r, 200))
    expect(received.length).toBe(0)
  })
})
