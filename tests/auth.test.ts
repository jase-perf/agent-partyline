import { describe, test, expect, beforeEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import {
  verifyPassword,
  mintCookie,
  verifyCookie,
  revokeCookie,
  parseCookieHeader,
  pruneExpiredCookies,
  isAuthDisabled,
} from '../src/server/auth'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('auth', () => {
  let db: Database
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pl-auth-'))
    db = openDb(join(tmp, 't.db'))
    process.env.PARTY_LINE_DASHBOARD_SECRET = 'x'.repeat(32)
    process.env.PARTY_LINE_DASHBOARD_PASSWORD = 'hunter2'
  })

  function cleanup() {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  }

  test('verifyPassword true for correct, false for wrong', () => {
    expect(verifyPassword('hunter2')).toBe(true)
    expect(verifyPassword('wrong')).toBe(false)
    cleanup()
  })

  test('mintCookie returns a cookie that verifyCookie accepts', () => {
    const c = mintCookie(db)
    expect(verifyCookie(db, c)).toBe(true)
    cleanup()
  })

  test('verifyCookie rejects tampered signature', () => {
    const c = mintCookie(db)
    const [payload] = c.split('.')
    expect(verifyCookie(db, `${payload}.deadbeef`)).toBe(false)
    cleanup()
  })

  test('verifyCookie rejects expired cookie and removes it from DB', () => {
    const c = mintCookie(db)
    db.query(`UPDATE dashboard_sessions SET expires_at = 1 WHERE cookie = ?`).run(c)
    expect(verifyCookie(db, c)).toBe(false)
    const row = db.query(`SELECT * FROM dashboard_sessions WHERE cookie = ?`).get(c)
    expect(row).toBeNull()
    cleanup()
  })

  test('revokeCookie removes it', () => {
    const c = mintCookie(db)
    revokeCookie(db, c)
    expect(verifyCookie(db, c)).toBe(false)
    cleanup()
  })

  test('parseCookieHeader extracts pl_dash', () => {
    expect(parseCookieHeader('foo=bar; pl_dash=abc.def; baz=qux')).toBe('abc.def')
    expect(parseCookieHeader('foo=bar')).toBeNull()
    expect(parseCookieHeader(null)).toBeNull()
    cleanup()
  })

  test('isAuthDisabled when password unset', () => {
    delete process.env.PARTY_LINE_DASHBOARD_PASSWORD
    expect(isAuthDisabled()).toBe(true)
    process.env.PARTY_LINE_DASHBOARD_PASSWORD = 'x'
    cleanup()
  })

  test('verifyCookie auto-true when auth disabled', () => {
    delete process.env.PARTY_LINE_DASHBOARD_PASSWORD
    expect(verifyCookie(db, null)).toBe(true)
    process.env.PARTY_LINE_DASHBOARD_PASSWORD = 'hunter2'
    cleanup()
  })

  test('pruneExpiredCookies removes only expired rows', () => {
    const c1 = mintCookie(db)
    const c2 = mintCookie(db)
    db.query(`UPDATE dashboard_sessions SET expires_at = 1 WHERE cookie = ?`).run(c1)
    pruneExpiredCookies(db)
    const rows = db.query(`SELECT cookie FROM dashboard_sessions`).all() as {
      cookie: string
    }[]
    expect(rows.map((r) => r.cookie)).toEqual([c2])
    cleanup()
  })
})
