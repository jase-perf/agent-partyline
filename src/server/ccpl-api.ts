import type { Database } from 'bun:sqlite'
import { unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  registerSession,
  getSessionByName,
  findSessionByTokenSafe,
  listSessions,
  rotateToken,
  deleteSession,
  archiveSession,
  pruneInactive,
} from '../storage/ccpl-queries'

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

export async function handleCcplRegister(req: Request, db: Database): Promise<Response> {
  let body: { name?: string; cwd?: string }
  try {
    body = (await req.json()) as { name?: string; cwd?: string }
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  const name = (body.name || '').trim()
  const cwd = (body.cwd || '').trim()
  if (!name) return json({ error: 'missing_name' }, 400)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) {
    return json(
      { error: 'invalid_name', message: 'name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,62}' },
      400,
    )
  }
  if (!cwd) return json({ error: 'missing_cwd' }, 400)
  if (getSessionByName(db, name)) {
    return json({ error: 'name_exists' }, 409)
  }
  const row = registerSession(db, name, cwd)
  return json({ token: row.token, name: row.name, cwd: row.cwd })
}

function authBearer(req: Request, db: Database): { name: string } | null {
  const token = req.headers.get('x-party-line-token')
  if (!token) return null
  const row = findSessionByTokenSafe(db, token)
  return row ? { name: row.name } : null
}

export async function handleCcplGetSession(
  req: Request,
  db: Database,
  name: string,
): Promise<Response> {
  const auth = authBearer(req, db)
  if (!auth || auth.name !== name) return json({ error: 'unauthorized' }, 401)
  const row = getSessionByName(db, name)
  if (!row) return json({ error: 'not_found' }, 404)
  return json({
    name: row.name,
    cwd: row.cwd,
    cc_session_uuid: row.cc_session_uuid,
    online: row.online,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
  })
}

export async function handleCcplRotate(
  req: Request,
  db: Database,
  name: string,
): Promise<Response> {
  const auth = authBearer(req, db)
  if (!auth || auth.name !== name) return json({ error: 'unauthorized' }, 401)
  const newToken = rotateToken(db, name)
  return json({ token: newToken })
}

export async function handleCcplForget(
  req: Request,
  db: Database,
  name: string,
): Promise<Response> {
  const auth = authBearer(req, db)
  if (!auth || auth.name !== name) return json({ error: 'unauthorized' }, 401)
  deleteSession(db, name)
  return json({ ok: true })
}

export async function handleCcplArchive(req: Request, db: Database): Promise<Response> {
  const auth = authBearer(req, db)
  if (!auth) return json({ error: 'unauthorized' }, 401)
  let body: { name?: string; reason?: string }
  try {
    body = (await req.json()) as { name?: string; reason?: string }
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  if (!body.name || body.name !== auth.name) return json({ error: 'unauthorized' }, 401)
  const row = getSessionByName(db, body.name)
  if (!row) return json({ error: 'not_found' }, 404)
  if (!row.cc_session_uuid) return json({ error: 'nothing_to_archive' }, 400)
  archiveSession(db, body.name, row.cc_session_uuid, body.reason || 'manual')
  return json({ ok: true })
}

export async function handleCcplList(_req: Request, db: Database): Promise<Response> {
  const rows = listSessions(db).map((r) => ({
    name: r.name,
    cwd: r.cwd,
    cc_session_uuid: r.cc_session_uuid,
    online: r.online,
    revision: r.revision,
    created_at: r.created_at,
    last_active_at: r.last_active_at,
  }))
  return json({ sessions: rows })
}

/**
 * Dependencies injected by serve.ts for the dashboard-authed
 * archive/remove endpoints. Keeping this abstract so we can test the
 * handlers in-process without standing up a real switchboard or an actual
 * filesystem token layout.
 */
export interface SessionMutationDeps {
  /** True if request has a valid dashboard cookie. */
  isAuthed(req: Request): boolean
  /** Emit a frame to all connected observers. */
  broadcastObserverFrame(frame: unknown): void
  /** Force-close a session's WS if online. Returns true if one was closed. */
  closeSession(name: string): boolean
  /** Delete the on-disk token file for this session. Errors are swallowed. */
  deleteTokenFile(name: string): void
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/

/** Default implementation of deleteTokenFile for production use. */
export function defaultDeleteTokenFile(name: string): void {
  try {
    unlinkSync(join(homedir(), '.config', 'party-line', 'sessions', `${name}.token`))
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code && code !== 'ENOENT') {
      console.warn(`[ccpl-api] failed to unlink token file for ${name}: ${code}`)
    }
  }
}

/**
 * POST /api/session/archive — dashboard-cookie-authed archive of the current
 * cc_session_uuid for a named session. Counterpart to POST /ccpl/archive
 * which uses the session's own token.
 */
export async function handleDashboardArchive(
  req: Request,
  db: Database,
  deps: SessionMutationDeps,
): Promise<Response> {
  if (!deps.isAuthed(req)) return json({ error: 'unauthorized' }, 401)
  let body: { name?: string }
  try {
    body = (await req.json()) as { name?: string }
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  const name = (body.name || '').trim()
  if (!name || !NAME_RE.test(name)) return json({ error: 'invalid_name' }, 400)
  const row = getSessionByName(db, name)
  if (!row) return json({ error: 'not_found' }, 404)
  if (!row.cc_session_uuid) return json({ error: 'nothing_to_archive' }, 400)
  archiveSession(db, name, row.cc_session_uuid, 'manual')
  const fresh = getSessionByName(db, name)
  if (fresh) {
    deps.broadcastObserverFrame({
      type: 'session-delta',
      session: fresh.name,
      revision: fresh.revision,
      changes: { cc_session_uuid: null },
    })
  }
  return json({ ok: true })
}

/**
 * DELETE /api/session/remove — dashboard-cookie-authed session deletion.
 * Drops the DB row, unlinks the local token file, force-closes any live WS
 * (with code 4401 so the client does NOT reconnect), and broadcasts a
 * `session-removed` observer frame so every dashboard drops the card.
 */
export async function handleDashboardRemove(
  req: Request,
  db: Database,
  deps: SessionMutationDeps,
): Promise<Response> {
  if (!deps.isAuthed(req)) return json({ error: 'unauthorized' }, 401)
  let body: { name?: string }
  try {
    body = (await req.json()) as { name?: string }
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  const name = (body.name || '').trim()
  if (!name || !NAME_RE.test(name)) return json({ error: 'invalid_name' }, 400)
  const row = getSessionByName(db, name)
  if (!row) return json({ error: 'not_found' }, 404)

  deps.closeSession(name)
  deleteSession(db, name)
  deps.deleteTokenFile(name)
  deps.broadcastObserverFrame({ type: 'session-removed', session: name })
  return json({ ok: true })
}

export async function handleCcplCleanup(req: Request, db: Database): Promise<Response> {
  let body: { older_than_ms?: number; dry_run?: boolean }
  try {
    body = (await req.json()) as { older_than_ms?: number; dry_run?: boolean }
  } catch {
    body = {}
  }
  const older = body.older_than_ms ?? 30 * 24 * 60 * 60 * 1000
  const cutoff = Date.now() - older
  if (body.dry_run) {
    const rows = (
      db
        .query(`SELECT name FROM ccpl_sessions WHERE online = 0 AND last_active_at < ?`)
        .all(cutoff) as { name: string }[]
    ).map((r) => r.name)
    return json({ would_remove: rows })
  }
  const removed = pruneInactive(db, cutoff)
  return json({ removed })
}
