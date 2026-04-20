/**
 * serve.ts — Web dashboard + WebSocket bridge for the party line.
 *
 * Runs a Bun HTTP server that serves the dashboard UI and bridges the
 * switchboard's WebSocket routing to connected browsers via /ws/observer.
 *
 * Usage:
 *   bun dashboard/serve.ts [--port 3400] [--name dashboard]
 *                          [--cert path/to/cert.pem --key path/to/key.pem]
 *
 * TLS can also be enabled via env: PARTY_LINE_TLS_CERT, PARTY_LINE_TLS_KEY.
 * When both cert and key are present, the server speaks HTTPS/WSS instead
 * of HTTP/WS. Default remains plain HTTP.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { startQuotaPoller, stopQuotaPoller, getQuota } from './quota.js'
import { validatePermissionResponseBody, buildPermissionResponseEnvelope } from './serve-helpers.js'
import { openDb } from '../src/storage/db.js'
import { Aggregator } from '../src/aggregator.js'
import { handleIngest } from '../src/ingest/http.js'
import { loadOrCreateToken } from '../src/ingest/auth.js'
import { getMachineId } from '../src/machine-id.js'
import { JsonlObserver } from '../src/observers/jsonl.js'
import { GeminiTranscriptObserver } from '../src/observers/gemini-transcript.js'
import { recentEvents } from '../src/storage/queries.js'
import { listSessions as listCcplSessions } from '../src/storage/ccpl-queries.js'
import { buildTranscript, filterAfterUuid } from '../src/transcript.js'
import { pruneOldEvents } from '../src/storage/retention.js'
import { rollupDailyMetrics, hourlyToolCalls } from '../src/storage/metrics.js'
import {
  verifyPassword,
  mintCookie,
  verifyCookie,
  revokeCookie,
  parseCookieHeader,
  cookieHeaderForSet,
  cookieHeaderForClear,
  isAuthDisabled,
  pruneExpiredCookies,
} from '../src/server/auth.js'
import {
  handleCcplRegister,
  handleCcplGetSession,
  handleCcplRotate,
  handleCcplForget,
  handleCcplArchive,
  handleCcplList,
  handleCcplCleanup,
} from '../src/server/ccpl-api.js'
import { createSwitchboard } from '../src/server/switchboard.js'

// --- Args ---

const args = process.argv.slice(2)
function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] ? args[idx + 1]! : fallback
}

const PORT = parseInt(getArg('--port', '3400'), 10)
const NAME = getArg('--name', 'dashboard')
const TLS_CERT_PATH = getArg('--cert', process.env.PARTY_LINE_TLS_CERT ?? '')
const TLS_KEY_PATH = getArg('--key', process.env.PARTY_LINE_TLS_KEY ?? '')

// --- Context overrides config ---

interface ContextOverrides {
  [sessionName: string]: { contextLimit: number }
}

const OVERRIDES_DIR = resolve(process.env.HOME ?? '/home/claude', '.config/party-line')
const OVERRIDES_PATH = join(OVERRIDES_DIR, 'overrides.json')

function loadOverrides(): ContextOverrides {
  try {
    return JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8')) as ContextOverrides
  } catch {
    return {}
  }
}

function saveOverrides(overrides: ContextOverrides): void {
  mkdirSync(OVERRIDES_DIR, { recursive: true })
  writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2) + '\n')
}

// --- Mission Control: hook event ingest + storage ---

const CONFIG_DIR = resolve(process.env.HOME ?? '/home/claude', '.config/party-line')
const DB_PATH = join(CONFIG_DIR, 'dashboard.db')
const TOKEN_PATH = join(CONFIG_DIR, 'ingest-token')
const MACHINE_ID_PATH = join(CONFIG_DIR, 'machine-id')

mkdirSync(CONFIG_DIR, { recursive: true })
const db = openDb(DB_PATH)
if (!isAuthDisabled() && !process.env.PARTY_LINE_DASHBOARD_SECRET) {
  console.warn(
    '[auth] PARTY_LINE_DASHBOARD_SECRET not set; cookies will be invalidated on restart.',
  )
}
const token = loadOrCreateToken(TOKEN_PATH)
const machineId = getMachineId(MACHINE_ID_PATH)
const aggregator = new Aggregator(db)

// --- Hub-and-spoke switchboard (v2 transport) ---
const switchboard = createSwitchboard(db)

aggregator.onUpdate((session) => {
  switchboard.broadcastObserverFrame({ type: 'session-update', data: session })
})

const jsonlObserver = new JsonlObserver(
  join(process.env.HOME ?? '/home/claude', '.claude', 'projects'),
)
jsonlObserver.on((u) => {
  switchboard.broadcastObserverFrame({ type: 'jsonl', data: u })
})

// When a JSONL file shrinks (compaction / file replacement), broadcast a
// stream-reset event so connected clients can force a full transcript refetch
// for the affected session.
jsonlObserver.onReset((filePath) => {
  switchboard.broadcastObserverFrame({ type: 'stream-reset', data: { file_path: filePath } })
})

const geminiObserver = new GeminiTranscriptObserver(
  join(process.env.HOME ?? '/home/claude', '.gemini', 'tmp'),
)
geminiObserver.on((u) => {
  switchboard.broadcastObserverFrame({ type: 'gemini-transcript', data: u })
})

// Periodic quota push (every 30s — data only refreshes every 5min from API)
setInterval(() => {
  const quota = getQuota()
  if (!quota) return
  switchboard.broadcastObserverFrame({ type: 'quota', data: quota })
}, 30_000)

// --- HTML ---

const __dirname = dirname(fileURLToPath(import.meta.url))
const indexHtml = readFileSync(join(__dirname, 'index.html'), 'utf-8')
const dashboardCss = readFileSync(join(__dirname, 'dashboard.css'), 'utf-8')
const dashboardJs = readFileSync(join(__dirname, 'dashboard.js'), 'utf-8')
const notificationsJs = readFileSync(join(__dirname, 'notifications.js'), 'utf-8')

// --- Server ---

function loadTls(): { cert: string; key: string } | undefined {
  if (!TLS_CERT_PATH || !TLS_KEY_PATH) return undefined
  try {
    const cert = readFileSync(TLS_CERT_PATH, 'utf-8')
    const key = readFileSync(TLS_KEY_PATH, 'utf-8')
    return { cert, key }
  } catch (err) {
    console.error(`[serve] Failed to load TLS cert/key: ${String(err)}`)
    console.error('[serve] Falling back to plain HTTP.')
    return undefined
  }
}
const tls = loadTls()
const tlsActive = tls !== undefined

// --- Auth helpers ---

function isAuthed(req: Request): boolean {
  if (isAuthDisabled()) return true
  const cookie = parseCookieHeader(req.headers.get('cookie'))
  return verifyCookie(db, cookie)
}

function requireAuth(req: Request): Response | null {
  if (isAuthed(req)) return null
  const accept = req.headers.get('accept') ?? ''
  if (accept.includes('text/html')) {
    const next = new URL(req.url).pathname
    return new Response(null, {
      status: 302,
      headers: { location: `/login?next=${encodeURIComponent(next)}` },
    })
  }
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Periodic cleanup of expired dashboard cookies.
setInterval(() => pruneExpiredCookies(db), 60 * 60 * 1000).unref()

const server = Bun.serve({
  port: PORT,
  ...(tls ? { tls } : {}),
  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrades
    if (url.pathname === '/ws/session') {
      if (server.upgrade(req, { data: { kind: 'session' } })) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }
    if (url.pathname === '/ws/observer') {
      const unauth = requireAuth(req)
      if (unauth) return new Response('unauthorized', { status: 401 })
      if (server.upgrade(req, { data: { kind: 'observer' } })) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    // --- Auth routes (unauthenticated) ---

    if (url.pathname === '/login' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json().catch(() => ({}))) as { password?: string }
        if (!verifyPassword(body.password || '')) {
          return new Response(JSON.stringify({ error: 'invalid_password' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const cookie = mintCookie(db)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': cookieHeaderForSet(cookie, tlsActive),
          },
        })
      })()
    }

    if (url.pathname === '/login' && req.method === 'GET') {
      return new Response(Bun.file(resolve(__dirname, 'login.html')), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    if (url.pathname === '/login.js') {
      return new Response(Bun.file(resolve(__dirname, 'login.js')), {
        headers: { 'Content-Type': 'application/javascript' },
      })
    }

    if (url.pathname === '/logout' && req.method === 'POST') {
      const c = parseCookieHeader(req.headers.get('cookie'))
      if (c) revokeCookie(db, c)
      return new Response(null, {
        status: 204,
        headers: { 'Set-Cookie': cookieHeaderForClear(tlsActive) },
      })
    }

    // --- ccpl HTTP API ---
    // Register is unauthenticated. Per-session endpoints use X-Party-Line-Token.
    // List/cleanup require dashboard cookie.

    if (url.pathname === '/ccpl/register' && req.method === 'POST') {
      return handleCcplRegister(req, db)
    }
    if (url.pathname === '/ccpl/archive' && req.method === 'POST') {
      return handleCcplArchive(req, db)
    }
    if (url.pathname === '/ccpl/cleanup' && req.method === 'POST') {
      const unauth = requireAuth(req)
      if (unauth) return unauth
      return handleCcplCleanup(req, db)
    }
    if (url.pathname === '/ccpl/sessions' && req.method === 'GET') {
      const unauth = requireAuth(req)
      if (unauth) return unauth
      return handleCcplList(req, db)
    }

    const rotateMatch = url.pathname.match(/^\/ccpl\/session\/([^/]+)\/rotate$/)
    if (rotateMatch && req.method === 'POST') {
      return handleCcplRotate(req, db, decodeURIComponent(rotateMatch[1]!))
    }
    const sessionMatch = url.pathname.match(/^\/ccpl\/session\/([^/]+)$/)
    if (sessionMatch) {
      if (req.method === 'GET')
        return handleCcplGetSession(req, db, decodeURIComponent(sessionMatch[1]!))
      if (req.method === 'DELETE')
        return handleCcplForget(req, db, decodeURIComponent(sessionMatch[1]!))
    }

    // --- Unauth passes: static login assets already handled above; /ingest has its own auth ---
    // Everything below this marker requires dashboard cookie auth.

    if (url.pathname === '/ingest') {
      // /ingest uses its own bearer-token shared-secret auth.
      return handleIngest(req, {
        db,
        token,
        onEvent: (ev) => {
          aggregator.ingest(ev)
          // Broadcast the raw hook event so the History view can live-append.
          switchboard.broadcastObserverFrame({ type: 'hook-event', data: ev })
        },
      })
    }

    const authFail = requireAuth(req)
    if (authFail) return authFail

    // REST API: list sessions (debug-friendly view of ccpl_sessions)
    if (url.pathname === '/api/sessions') {
      const rows = listCcplSessions(db).map((r) => ({
        name: r.name,
        online: r.online,
        metadata: {
          status: {
            state: r.online ? 'idle' : 'ended',
            sessionId: r.cc_session_uuid,
          },
        },
      }))
      return Response.json(rows)
    }

    // REST API: get context overrides
    if (url.pathname === '/api/overrides' && req.method === 'GET') {
      return Response.json(loadOverrides())
    }

    // REST API: set context override for a session
    if (url.pathname === '/api/overrides' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as { session?: string; contextLimit?: number }
        if (!body.session || !body.contextLimit) {
          return Response.json({ error: '"session" and "contextLimit" required' }, { status: 400 })
        }
        const overrides = loadOverrides()
        overrides[body.session] = { contextLimit: body.contextLimit }
        saveOverrides(overrides)
        switchboard.broadcastObserverFrame({ type: 'overrides', data: overrides })
        return Response.json({ ok: true })
      })()
    }

    // REST API: delete context override for a session
    if (url.pathname === '/api/overrides' && req.method === 'DELETE') {
      return (async () => {
        const body = (await req.json()) as { session?: string }
        if (!body.session) {
          return Response.json({ error: '"session" required' }, { status: 400 })
        }
        const overrides = loadOverrides()
        delete overrides[body.session]
        saveOverrides(overrides)
        switchboard.broadcastObserverFrame({ type: 'overrides', data: overrides })
        return Response.json({ ok: true })
      })()
    }

    // REST API: quota status
    if (url.pathname === '/api/quota') {
      return Response.json(getQuota() ?? { error: 'no data yet' })
    }

    // REST API: permission response — route decision to target session via switchboard
    if (url.pathname === '/api/permission-response' && req.method === 'POST') {
      return (async () => {
        let body: unknown
        try {
          body = await req.json()
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 })
        }
        const result = validatePermissionResponseBody(body)
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: 400 })
        }
        const env = buildPermissionResponseEnvelope({
          from: NAME,
          session: result.value.session,
          request_id: result.value.request_id,
          behavior: result.value.behavior,
        })
        switchboard.routeEnvelope({
          id: env.id,
          ts: Date.parse(env.ts),
          from: env.from,
          to: env.to,
          envelope_type: env.type,
          body: env.body,
          callback_id: env.callback_id,
          response_to: env.response_to,
        })
        switchboard.broadcastObserverFrame({
          type: 'permission-resolved',
          data: {
            session: result.value.session,
            request_id: result.value.request_id,
            behavior: result.value.behavior,
            resolved_by: NAME,
          },
        })
        return Response.json({ ok: true })
      })()
    }

    // REST API: message history — reads the switchboard-persisted messages table.
    if (url.pathname === '/api/history') {
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10)
      const rows = db.query(`SELECT * FROM messages ORDER BY ts DESC LIMIT ?`).all(limit) as Array<{
        id: string
        ts: number
        from_name: string
        to_name: string
        type: string
        body: string | null
        callback_id: string | null
        response_to: string | null
      }>
      const envelopes = rows.reverse().map((r) => ({
        id: r.id,
        ts: new Date(r.ts).toISOString(),
        from: r.from_name,
        to: r.to_name,
        type: r.type,
        body: r.body ?? '',
        callback_id: r.callback_id,
        response_to: r.response_to,
      }))
      return Response.json(envelopes)
    }

    // REST API: send message — route through the switchboard.
    if (url.pathname === '/api/send' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as { to?: string; message?: string; type?: string }
        if (!body.to || !body.message) {
          return Response.json({ error: '"to" and "message" required' }, { status: 400 })
        }
        const { randomBytes } = await import('node:crypto')
        const envelope = {
          id: randomBytes(8).toString('hex'),
          ts: Date.now(),
          from: NAME,
          to: body.to,
          envelope_type: (body.type as string) ?? 'message',
          body: body.message,
          callback_id: null,
          response_to: null,
        }
        switchboard.routeEnvelope(envelope)
        return Response.json({ ok: true, id: envelope.id })
      })()
    }

    // REST API: single session + subagents
    if (url.pathname === '/api/session' && url.searchParams.get('id')) {
      const id = url.searchParams.get('id')!
      return Response.json({
        session: aggregator.getSession(id),
        subagents: aggregator.getSubagents(id),
      })
    }

    // REST API: recent events (all or filtered by session)
    if (url.pathname === '/api/events') {
      const id = url.searchParams.get('session_id') ?? undefined
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10)
      return Response.json(recentEvents(db, { sessionId: id, limit }))
    }

    // REST API: JSONL transcript for a session or subagent
    // Supports optional `after_uuid` param for incremental fetches:
    //   ?after_uuid=<uuid>  — return only entries whose position in the
    //   built transcript comes after the entry with the given uuid.
    //   If after_uuid is unknown (stale, file compacted), the full transcript
    //   is returned as a graceful fallback.
    if (url.pathname === '/api/transcript') {
      const sidParam = url.searchParams.get('session_id')
      if (!sidParam) return Response.json({ error: 'session_id required' }, { status: 400 })
      const resolved = aggregator.getSession(sidParam)
      const sessionUuid = resolved?.session_id ?? sidParam
      const sessionName = resolved?.name ?? sidParam
      const agentId = url.searchParams.get('agent_id') ?? undefined
      const limit = parseInt(url.searchParams.get('limit') ?? '200', 10)
      const afterUuid = url.searchParams.get('after_uuid') ?? undefined
      const projectsRoot = join(process.env.HOME ?? '/home/claude', '.claude', 'projects')
      const all = buildTranscript({
        projectsRoot,
        sessionId: sessionUuid,
        sessionName,
        agentId,
        limit,
        envelopes: [],
      })
      const result = afterUuid ? filterAfterUuid(all, afterUuid) : all
      return Response.json(result)
    }

    // REST API: sparkline (hourly tool calls over last 24h for a session)
    if (url.pathname === '/api/sparkline' && url.searchParams.get('session_id')) {
      const id = url.searchParams.get('session_id')!
      return Response.json({ buckets: hourlyToolCalls(db, id) })
    }

    // REST API: self (local machine identity)
    if (url.pathname === '/api/self') {
      return Response.json({ machine_id: machineId })
    }

    // REST API: machines
    if (url.pathname === '/api/machines') {
      const machines = db
        .query<
          { id: string; hostname: string; first_seen: string; last_seen: string },
          []
        >('SELECT * FROM machines ORDER BY last_seen DESC')
        .all()
      return Response.json(machines)
    }

    // Static assets: vendor files
    if (url.pathname.startsWith('/vendor/')) {
      const name = url.pathname.slice('/vendor/'.length)
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) return new Response('Not Found', { status: 404 })
      try {
        const content = readFileSync(join(__dirname, 'vendor', name), 'utf-8')
        const contentType = name.endsWith('.js') ? 'application/javascript' : 'text/plain'
        return new Response(content, { headers: { 'Content-Type': contentType } })
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }

    // Static assets
    if (url.pathname === '/dashboard.css') {
      return new Response(dashboardCss, { headers: { 'Content-Type': 'text/css' } })
    }
    if (url.pathname === '/dashboard.js') {
      return new Response(dashboardJs, { headers: { 'Content-Type': 'application/javascript' } })
    }
    if (url.pathname === '/notifications.js') {
      return new Response(notificationsJs, {
        headers: { 'Content-Type': 'application/javascript' },
      })
    }

    // --- Static PWA assets ---
    if (url.pathname === '/sw.js') {
      return new Response(Bun.file(resolve(__dirname, 'sw.js')), {
        headers: {
          'Content-Type': 'application/javascript',
          'Service-Worker-Allowed': '/',
          'Cache-Control': 'no-cache',
        },
      })
    }

    if (url.pathname === '/manifest.json') {
      return new Response(Bun.file(resolve(__dirname, 'manifest.json')), {
        headers: {
          'Content-Type': 'application/manifest+json',
          'Cache-Control': 'public, max-age=3600',
        },
      })
    }

    if (url.pathname.startsWith('/icons/')) {
      const rel = url.pathname.slice(1) // strip leading /
      if (rel.includes('..')) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(Bun.file(resolve(__dirname, rel)), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      })
    }

    // Dashboard HTML
    return new Response(indexHtml, {
      headers: { 'Content-Type': 'text/html' },
    })
  },
  websocket: {
    // Type hint so ws.data carries our per-connection kind tag.
    // See WebSocketHandler.data in bun-types for why this pattern exists.
    data: {} as
      | {
          kind?: 'session' | 'observer'
          helloTimer?: ReturnType<typeof setTimeout>
          name?: string
          token?: string
        }
      | undefined,
    idleTimeout: 30, // seconds; Bun kicks silent connections after this
    open(ws) {
      const kind = ws.data?.kind
      if (kind === 'session') {
        // Authenticate within 10s or we close.
        const deadline = setTimeout(() => {
          try {
            ws.send(JSON.stringify({ type: 'error', code: 'hello_deadline' }))
          } catch {
            /* ignore */
          }
          ws.close(4401, 'hello_deadline')
        }, 10_000)
        // Stash the timer on ws.data so message() can clear it after hello accept.
        ;(ws.data as { helloTimer?: ReturnType<typeof setTimeout> }).helloTimer = deadline
        return
      }
      if (kind === 'observer') {
        switchboard.handleObserverOpen(ws as never)
        return
      }
      // Unknown kind — close.
      ws.close(1008, 'unknown_kind')
    },
    message(ws, raw) {
      const kind = ws.data?.kind
      let frame: { type?: string; [k: string]: unknown }
      try {
        frame = JSON.parse(String(raw)) as { type?: string; [k: string]: unknown }
      } catch {
        return
      }
      if (kind === 'session') {
        const wsData = ws.data as {
          helloTimer?: ReturnType<typeof setTimeout>
          name?: string
        }
        if (frame.type === 'hello') {
          if (wsData.helloTimer) clearTimeout(wsData.helloTimer)
          wsData.helloTimer = undefined
          const res = switchboard.handleSessionHello(ws as never, frame as never)
          if (!res.ok) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: res.error }))
            } catch {
              /* ignore */
            }
            ws.close(res.code ?? 4401, res.error ?? 'error')
            return
          }
          try {
            ws.send(JSON.stringify({ type: 'accepted', server_time: Date.now() }))
          } catch {
            /* ignore */
          }
          return
        }
        // Pre-hello: any non-hello frame before auth is rejected.
        if (!wsData.name) {
          try {
            ws.send(JSON.stringify({ type: 'error', code: 'hello_required' }))
          } catch {
            /* ignore */
          }
          ws.close(4401, 'hello_required')
          return
        }
        switchboard.handleSessionFrame(ws as never, frame)
        return
      }
      if (kind === 'observer') {
        switchboard.handleObserverFrame(ws as never, frame)
        return
      }
    },
    close(ws) {
      const kind = ws.data?.kind
      if (kind === 'session') {
        const wsData = ws.data as { helloTimer?: ReturnType<typeof setTimeout> }
        if (wsData.helloTimer) {
          clearTimeout(wsData.helloTimer)
          wsData.helloTimer = undefined
        }
        switchboard.handleSessionClose(ws as never)
        return
      }
      if (kind === 'observer') {
        switchboard.handleObserverClose(ws as never)
      }
    },
  },
})

// --- Start ---

async function main(): Promise<void> {
  await jsonlObserver.start()
  await geminiObserver.start()
  startQuotaPoller(300_000) // poll every 5 minutes

  // Retention + daily metrics rollup
  try {
    const deleted = pruneOldEvents(db, 30)
    if (deleted > 0) console.log(`  Retention: pruned ${deleted} old events`)
    const rolled = rollupDailyMetrics(db)
    if (rolled > 0) console.log(`  Metrics:   rolled up ${rolled} daily rows`)
  } catch (err) {
    console.error('  Warning: retention/rollup failed:', err)
  }

  const proto = tls ? 'https' : 'http'
  console.log(`Party Line Dashboard${tls ? ' (TLS)' : ''}`)
  console.log(`  Web UI:   ${proto}://localhost:${PORT}`)
  console.log(`  Ingest:   ${proto}://localhost:${PORT}/ingest`)
  console.log(`  Token:    ${TOKEN_PATH}`)
  console.log(`  DB:       ${DB_PATH}`)
  console.log(`  Machine:  ${machineId}`)
  console.log(`  Name:     ${NAME}`)
  console.log(`  Quota:    polling every 5 min`)
  console.log()
}

function shutdown(): void {
  jsonlObserver.stop()
  geminiObserver.stop()
  db.close()
  stopQuotaPoller()
  server.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

void main()
