import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import type { Database } from 'bun:sqlite'

const COOKIE_NAME = 'pl_dash'
const COOKIE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

let secretCache: string | undefined

function getSecret(): string {
  const s = process.env.PARTY_LINE_DASHBOARD_SECRET
  if (s && s.length >= 32) return s
  if (!secretCache) {
    secretCache = randomBytes(32).toString('hex')
    console.warn(
      '[auth] PARTY_LINE_DASHBOARD_SECRET not set; using ephemeral in-memory secret. Dashboard sessions will not survive restart.',
    )
  }
  return secretCache
}

export function isAuthDisabled(): boolean {
  return !process.env.PARTY_LINE_DASHBOARD_PASSWORD
}

export function verifyPassword(plaintext: string): boolean {
  const expected = process.env.PARTY_LINE_DASHBOARD_PASSWORD
  if (!expected) return true // auth disabled
  const a = Buffer.from(plaintext)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function sign(value: string): string {
  return createHmac('sha256', getSecret()).update(value).digest('hex')
}

export function mintCookie(db: Database): string {
  const payload = randomBytes(24).toString('hex')
  const now = Date.now()
  const expiresAt = now + COOKIE_TTL_MS
  const sig = sign(payload)
  const cookie = `${payload}.${sig}`
  db.query(
    `INSERT INTO dashboard_sessions (cookie, created_at, last_seen, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(cookie, now, now, expiresAt)
  return cookie
}

export function verifyCookie(db: Database, raw: string | null): boolean {
  if (isAuthDisabled()) return true
  if (!raw) return false
  const parts = raw.split('.')
  if (parts.length !== 2) return false
  const [payload, sig] = parts
  if (!payload || !sig) return false
  const expected = sign(payload)
  if (expected.length !== sig.length) return false
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false

  const row = db.query(`SELECT expires_at FROM dashboard_sessions WHERE cookie = ?`).get(raw) as {
    expires_at: number
  } | null
  if (!row) return false
  if (row.expires_at < Date.now()) {
    db.query(`DELETE FROM dashboard_sessions WHERE cookie = ?`).run(raw)
    return false
  }
  db.query(`UPDATE dashboard_sessions SET last_seen = ? WHERE cookie = ?`).run(Date.now(), raw)
  return true
}

export function revokeCookie(db: Database, raw: string): void {
  db.query(`DELETE FROM dashboard_sessions WHERE cookie = ?`).run(raw)
}

export function parseCookieHeader(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === COOKIE_NAME) return v ?? null
  }
  return null
}

// SameSite=Lax (not Strict). When an installed PWA is launched from the
// home screen on Android, Chrome treats the navigation as cross-site for
// the first request, which would drop a Strict cookie and force a re-login
// every launch. Lax sends the cookie on top-level navigations (PWA launch
// included) while still blocking cross-site POSTs and iframe loads.
export function cookieHeaderForSet(cookie: string, secure: boolean): string {
  const maxAge = Math.floor(COOKIE_TTL_MS / 1000)
  const secureAttr = secure ? '; Secure' : ''
  return `${COOKIE_NAME}=${cookie}; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=${maxAge}`
}

export function cookieHeaderForClear(secure: boolean): string {
  const secureAttr = secure ? '; Secure' : ''
  return `${COOKIE_NAME}=; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=0`
}

export function pruneExpiredCookies(db: Database): void {
  db.query(`DELETE FROM dashboard_sessions WHERE expires_at < ?`).run(Date.now())
}
