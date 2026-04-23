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
import {
  validatePermissionResponseBody,
  buildPermissionResponseEnvelope,
  buildUserPromptFrame,
  classifyApiError,
} from './serve-helpers.js'
import { upsertSession } from '../src/storage/queries.js'
import { openDb } from '../src/storage/db.js'
import { Aggregator } from '../src/aggregator.js'
import type { Database } from 'bun:sqlite'
import { handleIngest } from '../src/ingest/http.js'
import { loadOrCreateToken } from '../src/ingest/auth.js'
import { getMachineId } from '../src/machine-id.js'
import { JsonlObserver } from '../src/observers/jsonl.js'
import { TranscriptIngester } from '../src/observers/transcript-ingester.js'
import { GeminiTranscriptObserver } from '../src/observers/gemini-transcript.js'
import { recentEvents } from '../src/storage/queries.js'
import {
  listSessions as listCcplSessions,
  getSessionByName as getCcplSessionByName,
  getSessionByToken as getCcplSessionByToken,
  messagesForSession,
} from '../src/storage/ccpl-queries.js'
import {
  insertAttachment,
  getAttachment,
  linkAttachmentsToEnvelope,
  attachmentRowToMeta,
  attachmentsForEnvelope,
} from '../src/storage/attachments.js'
import type { Attachment } from '../src/types.js'
import { randomBytes } from 'node:crypto'
import { buildTranscript, filterAfterUuid } from '../src/transcript.js'
import { pruneOldEvents, pruneExpiredAttachments } from '../src/storage/retention.js'
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
  handleDashboardArchive,
  handleDashboardRemove,
  defaultDeleteTokenFile,
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

// JSONL observer + transcript ingester (ingester must exist before
// switchboard so we can wire onUuidAdopted to backfillFromUuid).
const jsonlRoot = join(process.env.HOME ?? '/home/claude', '.claude', 'projects')
const jsonlObserver = new JsonlObserver(jsonlRoot)
const transcriptIngester = new TranscriptIngester(db, jsonlRoot)
transcriptIngester.subscribe(jsonlObserver)

// --- Hub-and-spoke switchboard (v2 transport) ---
const switchboard = createSwitchboard(db, {
  onUuidAdopted: (_name, uuid, _reason) => {
    // Resume into a stranger uuid → bulk-load the existing JSONL once so
    // the History view has the full conversation, not just post-resume.
    transcriptIngester.backfillFromUuid(uuid)
  },
})

aggregator.onUpdate((session) => {
  // Enrich the broadcast session row with live active-subagent count so the
  // dashboard card can show "+N subagents" without a separate fetch.
  const row = db
    .query<
      { n: number },
      { $s: string }
    >("SELECT count(*) AS n FROM subagents WHERE session_id = $s AND status = 'running'")
    .get({ $s: session.session_id })
  const activeSubagents = row ? row.n : 0
  switchboard.broadcastObserverFrame({
    type: 'session-update',
    data: { ...session, active_subagents: activeSubagents },
  })
})

/**
 * Pull model + usage + last assistant text out of a JSONL assistant record
 * and upsert into the aggregator's sessions table. Claude Code hook
 * payloads don't include model/usage, but the JSONL does. Without this,
 * cards stay blank on model/ctx.
 *
 * Emits a `session-update` observer frame only when model or context_tokens
 * actually changed, to avoid chattiness from the 500ms polling observer.
 */
function harvestAssistantMetadata(
  db: Database,
  agg: Aggregator,
  sb: ReturnType<typeof createSwitchboard>,
  u: { session_id: string; file_path: string; entry: Record<string, unknown> },
): void {
  const e = u.entry
  if (e.type !== 'assistant' || !e.message) return
  const msg = e.message as {
    model?: string
    usage?: {
      input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      output_tokens?: number
    }
    content?: Array<{ type?: string; text?: string }>
  }
  // Synthetic records (retries, injected system) have model '<synthetic>' —
  // skip so we don't clobber the real model.
  if (!msg.model || msg.model === '<synthetic>') return
  const usage = msg.usage || {}
  const ctx =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  let lastText: string | null = null
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        lastText = b.text.slice(0, 500)
        break
      }
    }
  }

  const prev = agg.getSession(u.session_id)
  if (!prev) return
  const modelChanged = prev.model !== msg.model
  const ctxChanged = prev.context_tokens !== ctx
  const textChanged = lastText !== null && prev.last_text !== lastText

  upsertSession(db, {
    session_id: prev.session_id,
    machine_id: prev.machine_id,
    name: prev.name,
    last_seen: typeof e.timestamp === 'string' ? e.timestamp : new Date().toISOString(),
    model: msg.model,
    context_tokens: ctx || null,
    last_text: lastText,
    source: prev.source,
  })

  if (!modelChanged && !ctxChanged && !textChanged) return

  const fresh = agg.getSession(u.session_id)
  if (!fresh) return
  const subs = db
    .query<
      { n: number },
      { $s: string }
    >("SELECT count(*) AS n FROM subagents WHERE session_id = $s AND status = 'running'")
    .get({ $s: fresh.session_id })
  sb.broadcastObserverFrame({
    type: 'session-update',
    data: { ...fresh, active_subagents: subs ? subs.n : 0 },
  })
}

/**
 * One-time scan on dashboard startup: for each known session, read the tail
 * of its JSONL and harvest the latest assistant record's metadata. Sessions
 * that were idle across the restart otherwise stay blank until they emit
 * their next message.
 */
function seedAssistantMetadata(): void {
  const projects = join(process.env.HOME ?? '/home/claude', '.claude', 'projects')
  let files: string[] = []
  try {
    for (const cwdDir of require('fs').readdirSync(projects, { withFileTypes: true })) {
      if (!cwdDir.isDirectory) continue
      const inner = join(projects, cwdDir.name)
      for (const f of require('fs').readdirSync(inner)) {
        if (f.endsWith('.jsonl')) files.push(join(inner, f))
      }
    }
  } catch {
    return
  }
  let hits = 0
  for (const path of files) {
    try {
      const raw = require('fs').readFileSync(path, 'utf-8') as string
      const lines = raw.split('\n').filter(Boolean)
      // Walk backwards to find the last real assistant record with a model.
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 50; i--) {
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(lines[i]!) as Record<string, unknown>
        } catch {
          continue
        }
        if (entry.type !== 'assistant') continue
        const msg = entry.message as { model?: string } | undefined
        if (!msg || !msg.model || msg.model === '<synthetic>') continue
        const sessionId = path.split('/').pop()!.replace('.jsonl', '')
        harvestAssistantMetadata(db, aggregator, switchboard, {
          session_id: sessionId,
          file_path: path,
          entry,
        })
        hits++
        break
      }
    } catch {
      /* unreadable — skip */
    }
  }
  if (hits > 0) console.log(`  Metadata:  seeded ${hits} sessions from JSONL tails`)
}

jsonlObserver.on((u) => {
  switchboard.broadcastObserverFrame({ type: 'jsonl', data: u })

  // Harvest model + usage + last-text from assistant JSONL records and roll
  // them into the aggregator's session row. Hook payloads don't carry these
  // fields, but they live in every real assistant message. Without this,
  // card "Model" / "ctx %" / last-text stays null forever.
  harvestAssistantMetadata(db, aggregator, switchboard, u)

  // Detect Claude Code API errors (overloaded/rate-limit/5xx). These don't
  // fire a Stop hook, so the session state stays "working" forever. Flip
  // to "errored" and emit an api-error observer frame so the dashboard
  // can surface a notification.
  const err = classifyApiError(u.entry)
  if (!err) return
  const session = aggregator.getSession(u.session_id)
  if (!session) return
  upsertSession(db, {
    session_id: session.session_id,
    machine_id: session.machine_id,
    name: session.name,
    last_seen: new Date().toISOString(),
    state: 'errored',
    source: session.source,
  })
  const ts =
    u.entry &&
    typeof u.entry === 'object' &&
    typeof (u.entry as { timestamp?: unknown }).timestamp === 'string'
      ? (u.entry as { timestamp: string }).timestamp
      : new Date().toISOString()
  switchboard.broadcastObserverFrame({
    type: 'api-error',
    data: {
      session_id: session.session_id,
      session_name: session.name,
      file_path: u.file_path,
      ts,
      status: err.status,
      errorType: err.errorType,
      message: err.message,
    },
  })
  // Also broadcast an updated session-update so cards flip to 'errored'
  // immediately, without waiting for the next aggregator event.
  const freshRow = aggregator.getSession(u.session_id)
  if (freshRow) {
    const subRow = db
      .query<
        { n: number },
        { $s: string }
      >("SELECT count(*) AS n FROM subagents WHERE session_id = $s AND status = 'running'")
      .get({ $s: freshRow.session_id })
    const activeSubagents = subRow ? subRow.n : 0
    switchboard.broadcastObserverFrame({
      type: 'session-update',
      data: { ...freshRow, active_subagents: activeSubagents },
    })
  }
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
// Read asset paths, but serve via Bun.file() at request time so edits to
// index.html / dashboard.js / dashboard.css / notifications.js are picked
// up without restarting the server. Previously these were cached as strings
// at startup, which silently served stale content through dev iterations.
const indexHtmlPath = join(__dirname, 'index.html')
const dashboardCssPath = join(__dirname, 'dashboard.css')
const dashboardJsPath = join(__dirname, 'dashboard.js')
const notificationsJsPath = join(__dirname, 'notifications.js')

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

/**
 * Resolve the uploader identity for /api/upload + /api/attachment.
 * Returns a session name on success, or null when no valid auth is present.
 *   - X-Party-Line-Token: looks up the session row → returns its name.
 *   - Dashboard cookie: returns 'dashboard' as a pseudo-uploader.
 */
function resolveUploader(req: Request, db: import('bun:sqlite').Database): string | null {
  const token = req.headers.get('x-party-line-token')
  if (token) {
    const row = getCcplSessionByToken(db, token)
    if (row) return row.name
  }
  if (isAuthed(req)) return 'dashboard'
  return null
}

const ATTACHMENTS_DIR = join(CONFIG_DIR, 'attachments')
mkdirSync(ATTACHMENTS_DIR, { recursive: true })
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024 // 20 MB per file
const ATTACHMENT_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

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

    if (url.pathname === '/dashboard.css') {
      return new Response(Bun.file(dashboardCssPath), {
        headers: { 'Content-Type': 'text/css' },
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

          // Self-heal ccpl_sessions when the plugin's uuid-rotate frame
          // missed a /clear or /resume. Hook payloads carry session_id
          // from Claude Code itself, so they are canonical. When it
          // differs from the stored cc_session_uuid for this name,
          // archive the stale uuid and adopt the new one.
          if (ev.session_id && ev.session_name) {
            switchboard.reconcileCcSessionUuid(ev.session_name, ev.session_id, 'hook_drift')
          }

          // Live-inject user prompts into the session-detail transcript
          // without waiting for JSONL write/poll. JSONL remains the canonical
          // source; the client dedupes when the canonical entry arrives.
          const userPromptFrame = buildUserPromptFrame(ev)
          if (userPromptFrame) switchboard.broadcastObserverFrame(userPromptFrame)
        },
      })
    }

    // PWA shell assets (sw.js, manifest.json, icons, favicon) must be
    // reachable without auth so iOS/Android can install the app + register
    // the Service Worker from a logged-out state. These files leak no
    // session data.
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
    if (url.pathname === '/favicon.ico') {
      return new Response(Bun.file(resolve(__dirname, 'favicon.ico')), {
        headers: {
          'Content-Type': 'image/x-icon',
          'Cache-Control': 'public, max-age=86400',
        },
      })
    }
    if (url.pathname.startsWith('/icons/')) {
      const rel = url.pathname.slice(1)
      if (rel.includes('..')) return new Response('Not found', { status: 404 })
      return new Response(Bun.file(resolve(__dirname, rel)), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      })
    }

    // Routes below run their own token-or-cookie auth via resolveUploader,
    // so skip the blanket cookie gate for them. (Plugins + CLI call these
    // with X-Party-Line-Token, not a dashboard cookie.)
    const isSelfAuthedRoute =
      (url.pathname === '/api/upload' && req.method === 'POST') ||
      (url.pathname.startsWith('/api/attachment/') && req.method === 'GET')
    if (!isSelfAuthedRoute) {
      const authFail = requireAuth(req)
      if (authFail) return authFail
    }

    // Dashboard-cookie-authed session mutations: archive current UUID or
    // remove the session row outright. The actual logic lives in
    // src/server/ccpl-api.ts so it can be unit-tested without spinning up a
    // real HTTP server; here we just inject serve.ts's switchboard + auth.
    const sessionMutationDeps = {
      isAuthed,
      broadcastObserverFrame: (frame: unknown) => switchboard.broadcastObserverFrame(frame),
      closeSession: (name: string) => switchboard.closeSession(name, 4401, 'removed'),
      deleteTokenFile: defaultDeleteTokenFile,
    }
    if (url.pathname === '/api/session/archive' && req.method === 'POST') {
      return handleDashboardArchive(req, db, sessionMutationDeps)
    }
    if (url.pathname === '/api/session/remove' && req.method === 'DELETE') {
      return handleDashboardRemove(req, db, sessionMutationDeps)
    }

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
        const body = (await req.json()) as {
          to?: string
          message?: string
          type?: string
          attachment_ids?: string[]
        }
        if (!body.to) {
          return Response.json({ error: '"to" required' }, { status: 400 })
        }
        // Accept empty message when at least one attachment is included — a
        // generated image can be a standalone reply.
        const attIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : []
        if (!body.message && attIds.length === 0) {
          return Response.json(
            { error: '"message" or non-empty "attachment_ids" required' },
            { status: 400 },
          )
        }
        // Resolve + validate attachment ids. Non-existent ids → 400 so the
        // client learns about stale references instead of silently sending.
        const atts: Attachment[] = []
        for (const id of attIds) {
          const row = getAttachment(db, id)
          if (!row) {
            return Response.json({ error: `unknown attachment: ${id}` }, { status: 400 })
          }
          atts.push(attachmentRowToMeta(row))
        }
        const envelope = {
          id: randomBytes(8).toString('hex'),
          ts: Date.now(),
          from: NAME,
          to: body.to,
          envelope_type: (body.type as string) ?? 'message',
          body: body.message ?? '',
          callback_id: null,
          response_to: null,
          ...(atts.length > 0 ? { attachments: atts } : {}),
        }
        if (atts.length > 0) linkAttachmentsToEnvelope(db, envelope.id, attIds)
        switchboard.routeEnvelope(envelope)
        return Response.json({ ok: true, id: envelope.id })
      })()
    }

    // REST API: upload an attachment. Accepts multipart/form-data with a
    // "file" part. Auth: dashboard cookie (browser) OR X-Party-Line-Token
    // (MCP plugin). Returns Attachment metadata for the caller to include
    // in a subsequent /api/send (or the MCP plugin's party_line_send frame).
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      return (async () => {
        const uploader = resolveUploader(req, db)
        if (!uploader) return new Response('Unauthorized', { status: 401 })
        const form = await req.formData().catch(() => null)
        if (!form) {
          return Response.json({ error: 'multipart body required' }, { status: 400 })
        }
        const file = form.get('file')
        if (!(file instanceof Blob)) {
          return Response.json({ error: '"file" part required' }, { status: 400 })
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          return Response.json(
            { error: `file too large (${file.size} > ${MAX_ATTACHMENT_BYTES})` },
            { status: 413 },
          )
        }
        // Bun's FormData returns File (Blob subclass) with a `name`; use
        // duck typing because lib.dom's File symbol isn't always in scope.
        const fileName = (file as unknown as { name?: unknown }).name
        const name =
          (typeof fileName === 'string' && fileName) ||
          String(form.get('name') ?? '') ||
          'attachment'
        const media_type =
          String(form.get('media_type') ?? '') || file.type || 'application/octet-stream'
        const id = randomBytes(16).toString('hex')
        const storedDir = join(ATTACHMENTS_DIR, id)
        mkdirSync(storedDir, { recursive: true })
        const storedPath = join(storedDir, 'file')
        writeFileSync(storedPath, Buffer.from(await file.arrayBuffer()))
        const expires = Date.now() + ATTACHMENT_TTL_MS
        insertAttachment(db, {
          id,
          uploader_session: uploader,
          name,
          media_type,
          size: file.size,
          stored_path: storedPath,
          expires_at: expires,
        })
        const row = getAttachment(db, id)!
        return Response.json(attachmentRowToMeta(row))
      })()
    }

    // REST API: fetch an attachment. Auth: dashboard cookie OR token.
    // Optional `?thumb=<px>` returns a downscaled image (images only).
    if (url.pathname.startsWith('/api/attachment/') && req.method === 'GET') {
      const id = url.pathname.slice('/api/attachment/'.length)
      if (!/^[a-f0-9]{8,64}$/.test(id)) {
        return new Response('Not found', { status: 404 })
      }
      const viewer = resolveUploader(req, db) || (isAuthed(req) ? 'dashboard' : null)
      if (!viewer) return new Response('Unauthorized', { status: 401 })
      const row = getAttachment(db, id)
      if (!row) return new Response('Not found', { status: 404 })
      return new Response(Bun.file(row.stored_path), {
        headers: {
          'Content-Type': row.media_type,
          'Content-Disposition': `inline; filename="${row.name.replace(/"/g, '')}"`,
          'Cache-Control': 'private, max-age=86400',
        },
      })
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
      // Prefer the currently-registered ccpl session UUID (authoritative for
      // "which session is live right now") over aggregator's most-recent-row
      // heuristic, which can latch onto stale rows from past cc_session_uuids.
      const ccpl = getCcplSessionByName(db, sidParam)
      const resolved = aggregator.getSession(sidParam)
      const sessionUuid = ccpl?.cc_session_uuid ?? resolved?.session_id ?? sidParam
      const sessionName = ccpl?.name ?? resolved?.name ?? sidParam
      const agentId = url.searchParams.get('agent_id') ?? undefined
      const limit = parseInt(url.searchParams.get('limit') ?? '200', 10)
      const afterUuid = url.searchParams.get('after_uuid') ?? undefined
      const projectsRoot = join(process.env.HOME ?? '/home/claude', '.claude', 'projects')
      // Surface party-line envelopes to/from this session alongside the JSONL
      // transcript so they survive a page refresh. Without this, the user's
      // sent messages render once via the live observer broadcast and then
      // disappear when the dashboard re-fetches the transcript.
      const messageRows = messagesForSession(db, sessionName, limit)
      const envelopes = messageRows.map((r) => {
        const atts = attachmentsForEnvelope(db, r.id)
        return {
          id: r.id,
          from: r.from_name,
          to: r.to_name,
          type: r.type,
          body: r.body ?? '',
          ts: new Date(r.ts).toISOString(),
          callback_id: r.callback_id,
          response_to: r.response_to,
          ...(atts.length > 0 ? { attachments: atts } : {}),
        }
      })
      const all = buildTranscript({
        projectsRoot,
        sessionId: sessionUuid,
        sessionName,
        agentId,
        limit,
        envelopes,
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

    // Static assets — served via Bun.file() so edits land without a restart.
    if (url.pathname === '/dashboard.js') {
      return new Response(Bun.file(dashboardJsPath), {
        headers: { 'Content-Type': 'application/javascript' },
      })
    }
    if (url.pathname === '/notifications.js') {
      return new Response(Bun.file(notificationsJsPath), {
        headers: { 'Content-Type': 'application/javascript' },
      })
    }

    // Dashboard HTML
    return new Response(Bun.file(indexHtmlPath), {
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
  // Backfill: sessions that haven't emitted a new JSONL line since the
  // dashboard started would otherwise show blank model/ctx until their next
  // message. Walk each live ccpl session's JSONL, read the last few lines,
  // and feed them through harvestAssistantMetadata once.
  try {
    seedAssistantMetadata()
  } catch (err) {
    console.error('  Warning: metadata backfill failed:', err)
  }

  await jsonlObserver.start()
  await geminiObserver.start()
  startQuotaPoller(300_000) // poll every 5 minutes

  // Retention + daily metrics rollup
  try {
    const deleted = pruneOldEvents(db, 30)
    if (deleted > 0) console.log(`  Retention: pruned ${deleted} old events`)
    const rolled = rollupDailyMetrics(db)
    if (rolled > 0) console.log(`  Metrics:   rolled up ${rolled} daily rows`)
    const attPruned = pruneExpiredAttachments(db)
    if (attPruned > 0) console.log(`  Retention: pruned ${attPruned} expired attachments`)
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
