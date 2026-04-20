import { describe, test, expect, beforeEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import {
  registerSession,
  getSessionByName,
  getSessionByToken,
  listSessions,
  updateSessionOnConnect,
  markSessionOffline,
  archiveSession,
  rotateToken,
  deleteSession,
  pruneInactive,
  insertMessage,
  recentMessages,
} from '../src/storage/ccpl-queries'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('ccpl-queries', () => {
  let db: Database
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'partylinedb-'))
    db = openDb(join(tmp, 'test.db'))
  })

  function cleanup() {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  }

  test('registerSession → getSessionByName round-trip', () => {
    const row = registerSession(db, 'research', '/home/claude/projects/research')
    expect(row.name).toBe('research')
    expect(row.token).toMatch(/^[a-f0-9]{64}$/)
    expect(row.cwd).toBe('/home/claude/projects/research')
    expect(row.online).toBe(false)
    expect(row.cc_session_uuid).toBeNull()
    const lookup = getSessionByName(db, 'research')
    expect(lookup?.token).toBe(row.token)
    cleanup()
  })

  test('getSessionByToken resolves by token', () => {
    const row = registerSession(db, 'foo', '/tmp')
    const byToken = getSessionByToken(db, row.token)
    expect(byToken?.name).toBe('foo')
    expect(getSessionByToken(db, 'not-a-real-token')).toBeNull()
    cleanup()
  })

  test('updateSessionOnConnect bumps revision + marks online', () => {
    registerSession(db, 'foo', '/tmp')
    updateSessionOnConnect(db, 'foo', 'uuid-1', 1234, 'mach-a')
    const row = getSessionByName(db, 'foo')!
    expect(row.online).toBe(true)
    expect(row.cc_session_uuid).toBe('uuid-1')
    expect(row.pid).toBe(1234)
    expect(row.machine_id).toBe('mach-a')
    expect(row.revision).toBe(1)
    cleanup()
  })

  test('markSessionOffline flips online + bumps revision', () => {
    registerSession(db, 'foo', '/tmp')
    updateSessionOnConnect(db, 'foo', 'uuid-1', 1, 'm')
    markSessionOffline(db, 'foo')
    const row = getSessionByName(db, 'foo')!
    expect(row.online).toBe(false)
    expect(row.revision).toBe(2)
    cleanup()
  })

  test('archiveSession moves current UUID into archives and nulls the row', () => {
    registerSession(db, 'foo', '/tmp')
    updateSessionOnConnect(db, 'foo', 'old-uuid', 1, 'm')
    archiveSession(db, 'foo', 'old-uuid', 'clear')
    const row = getSessionByName(db, 'foo')!
    expect(row.cc_session_uuid).toBeNull()
    const archives = db.query(`SELECT * FROM ccpl_archives WHERE name = ?`).all('foo') as any[]
    expect(archives.length).toBe(1)
    expect(archives[0].old_uuid).toBe('old-uuid')
    expect(archives[0].reason).toBe('clear')
    cleanup()
  })

  test('rotateToken replaces token + invalidates lookup by old token', () => {
    const a = registerSession(db, 'foo', '/tmp')
    const newToken = rotateToken(db, 'foo')
    expect(newToken).not.toBe(a.token)
    expect(getSessionByToken(db, a.token)).toBeNull()
    expect(getSessionByToken(db, newToken)?.name).toBe('foo')
    cleanup()
  })

  test('deleteSession removes session and its archives', () => {
    registerSession(db, 'foo', '/tmp')
    updateSessionOnConnect(db, 'foo', 'u1', 1, 'm')
    archiveSession(db, 'foo', 'u1', 'clear')
    deleteSession(db, 'foo')
    expect(getSessionByName(db, 'foo')).toBeNull()
    const archives = db.query(`SELECT * FROM ccpl_archives WHERE name = ?`).all('foo')
    expect(archives.length).toBe(0)
    cleanup()
  })

  test('pruneInactive deletes rows below cutoff + their archives', () => {
    registerSession(db, 'old', '/tmp')
    registerSession(db, 'fresh', '/tmp')
    db.query(`UPDATE ccpl_sessions SET last_active_at = 1000 WHERE name = 'old'`).run()
    const removed = pruneInactive(db, 2000)
    expect(removed).toBe(1)
    expect(getSessionByName(db, 'old')).toBeNull()
    expect(getSessionByName(db, 'fresh')).not.toBeNull()
    cleanup()
  })

  test('insertMessage + recentMessages DESC', () => {
    insertMessage(db, {
      id: 'a',
      ts: 1000,
      from_name: 'x',
      to_name: 'y',
      type: 'message',
      body: 'hi',
      callback_id: null,
      response_to: null,
      cc_session_uuid: null,
    })
    insertMessage(db, {
      id: 'b',
      ts: 2000,
      from_name: 'x',
      to_name: 'y',
      type: 'message',
      body: 'bye',
      callback_id: null,
      response_to: null,
      cc_session_uuid: null,
    })
    const recent = recentMessages(db, 10)
    expect(recent[0]!.id).toBe('b')
    expect(recent[1]!.id).toBe('a')
    cleanup()
  })

  test('listSessions orders online-first then last_active_at DESC', () => {
    registerSession(db, 'a', '/tmp')
    registerSession(db, 'b', '/tmp')
    registerSession(db, 'c', '/tmp')
    updateSessionOnConnect(db, 'b', 'u', 1, 'm')
    const list = listSessions(db)
    expect(list[0]!.name).toBe('b')
    expect(list[0]!.online).toBe(true)
    cleanup()
  })
})
