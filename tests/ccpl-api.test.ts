import { describe, test, expect, beforeEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import {
  handleCcplRegister,
  handleCcplGetSession,
  handleCcplRotate,
  handleCcplForget,
  handleCcplArchive,
  handleCcplList,
  handleCcplCleanup,
} from '../src/server/ccpl-api'
import { updateSessionOnConnect } from '../src/storage/ccpl-queries'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function withToken(req: Request, token: string): Request {
  const h = new Headers(req.headers)
  h.set('X-Party-Line-Token', token)
  return new Request(req.url, { method: req.method, body: req.body, headers: h })
}

describe('ccpl-api', () => {
  let db: Database
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pl-api-'))
    db = openDb(join(tmp, 't.db'))
  })

  function cleanup() {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  }

  test('register happy path', async () => {
    const res = await handleCcplRegister(
      postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }),
      db,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; name: string; cwd: string }
    expect(body.name).toBe('foo')
    expect(body.token).toMatch(/^[a-f0-9]{64}$/)
    cleanup()
  })

  test('register rejects duplicate name', async () => {
    await handleCcplRegister(postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }), db)
    const res = await handleCcplRegister(
      postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }),
      db,
    )
    expect(res.status).toBe(409)
    cleanup()
  })

  test('register rejects invalid name', async () => {
    const res = await handleCcplRegister(
      postJson('/ccpl/register', { name: '../../evil', cwd: '/tmp' }),
      db,
    )
    expect(res.status).toBe(400)
    cleanup()
  })

  test('getSession requires matching token', async () => {
    const reg = (await (
      await handleCcplRegister(postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }), db)
    ).json()) as { token: string }

    const unauth = await handleCcplGetSession(
      new Request('http://localhost/ccpl/session/foo'),
      db,
      'foo',
    )
    expect(unauth.status).toBe(401)

    const ok = await handleCcplGetSession(
      withToken(new Request('http://localhost/ccpl/session/foo'), reg.token),
      db,
      'foo',
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { name: string }
    expect(body.name).toBe('foo')
    cleanup()
  })

  test('rotate returns new token and old is invalidated', async () => {
    const reg = (await (
      await handleCcplRegister(postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }), db)
    ).json()) as { token: string }
    const rot = await handleCcplRotate(
      withToken(
        new Request('http://localhost/ccpl/session/foo/rotate', { method: 'POST' }),
        reg.token,
      ),
      db,
      'foo',
    )
    expect(rot.status).toBe(200)
    const { token: newToken } = (await rot.json()) as { token: string }
    expect(newToken).not.toBe(reg.token)

    const withOld = await handleCcplGetSession(
      withToken(new Request('http://localhost/ccpl/session/foo'), reg.token),
      db,
      'foo',
    )
    expect(withOld.status).toBe(401)
    cleanup()
  })

  test('forget removes the row', async () => {
    const reg = (await (
      await handleCcplRegister(postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }), db)
    ).json()) as { token: string }
    await handleCcplForget(
      withToken(new Request('http://localhost/ccpl/session/foo', { method: 'DELETE' }), reg.token),
      db,
      'foo',
    )
    const get = await handleCcplGetSession(
      withToken(new Request('http://localhost/ccpl/session/foo'), reg.token),
      db,
      'foo',
    )
    expect(get.status).toBe(401) // token no longer valid; row gone
    cleanup()
  })

  test('archive moves current uuid to archives', async () => {
    const reg = (await (
      await handleCcplRegister(postJson('/ccpl/register', { name: 'foo', cwd: '/tmp' }), db)
    ).json()) as { token: string }
    updateSessionOnConnect(db, 'foo', 'uuid-1', 1, 'm')
    const res = await handleCcplArchive(
      withToken(postJson('/ccpl/archive', { name: 'foo', reason: 'jsonl_missing' }), reg.token),
      db,
    )
    expect(res.status).toBe(200)
    const archives = db.query(`SELECT * FROM ccpl_archives`).all() as Array<{ old_uuid: string }>
    expect(archives.length).toBe(1)
    expect(archives[0]!.old_uuid).toBe('uuid-1')
    cleanup()
  })

  test('list returns all sessions', async () => {
    await handleCcplRegister(postJson('/ccpl/register', { name: 'a', cwd: '/tmp' }), db)
    await handleCcplRegister(postJson('/ccpl/register', { name: 'b', cwd: '/tmp' }), db)
    const res = await handleCcplList(new Request('http://localhost/ccpl/sessions'), db)
    const { sessions } = (await res.json()) as { sessions: { name: string }[] }
    expect(sessions.map((s) => s.name).sort()).toEqual(['a', 'b'])
    cleanup()
  })

  test('cleanup dry-run lists candidates', async () => {
    await handleCcplRegister(postJson('/ccpl/register', { name: 'old', cwd: '/tmp' }), db)
    db.query(`UPDATE ccpl_sessions SET last_active_at = 1 WHERE name = 'old'`).run()
    const res = await handleCcplCleanup(
      postJson('/ccpl/cleanup', { older_than_ms: 1000, dry_run: true }),
      db,
    )
    const { would_remove } = (await res.json()) as { would_remove: string[] }
    expect(would_remove).toContain('old')
    cleanup()
  })
})
