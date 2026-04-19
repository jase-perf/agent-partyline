/**
 * serve.ts — Web dashboard + WebSocket bridge for the party line.
 *
 * Runs a Bun HTTP server that serves the dashboard UI and bridges
 * multicast traffic to connected browsers via WebSocket.
 *
 * Usage:
 *   bun dashboard/serve.ts [--port 3400] [--name dashboard]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { PartyLineMonitor } from './monitor.js'
import { startQuotaPoller, stopQuotaPoller, getQuota } from './quota.js'
import type { Envelope } from '../src/types.js'
import type { ServerWebSocket } from 'bun'
import { openDb } from '../src/storage/db.js'
import { Aggregator } from '../src/aggregator.js'
import { handleIngest } from '../src/ingest/http.js'
import { loadOrCreateToken } from '../src/ingest/auth.js'
import { getMachineId } from '../src/machine-id.js'
import { JsonlObserver } from '../src/observers/jsonl.js'
import { GeminiTranscriptObserver } from '../src/observers/gemini-transcript.js'
import { recentEvents } from '../src/storage/queries.js'
import { buildTranscript } from '../src/transcript.js'
import { pruneOldEvents } from '../src/storage/retention.js'
import { rollupDailyMetrics, hourlyToolCalls } from '../src/storage/metrics.js'

// --- Args ---

const args = process.argv.slice(2)
function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] ? args[idx + 1]! : fallback
}

const PORT = parseInt(getArg('--port', '3400'), 10)
const NAME = getArg('--name', 'dashboard')

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

// --- Monitor ---

const monitor = new PartyLineMonitor(NAME)
const wsClients = new Set<ServerWebSocket<unknown>>()

// --- Mission Control: hook event ingest + storage ---

const CONFIG_DIR = resolve(process.env.HOME ?? '/home/claude', '.config/party-line')
const DB_PATH = join(CONFIG_DIR, 'dashboard.db')
const TOKEN_PATH = join(CONFIG_DIR, 'ingest-token')
const MACHINE_ID_PATH = join(CONFIG_DIR, 'machine-id')

mkdirSync(CONFIG_DIR, { recursive: true })
const db = openDb(DB_PATH)
const token = loadOrCreateToken(TOKEN_PATH)
const machineId = getMachineId(MACHINE_ID_PATH)
const aggregator = new Aggregator(db)

aggregator.onUpdate((session) => {
  const json = JSON.stringify({ type: 'session-update', data: session })
  for (const ws of wsClients) ws.send(json)
})

const jsonlObserver = new JsonlObserver(
  join(process.env.HOME ?? '/home/claude', '.claude', 'projects'),
)
jsonlObserver.on((u) => {
  const json = JSON.stringify({ type: 'jsonl', data: u })
  for (const ws of wsClients) ws.send(json)
})

const geminiObserver = new GeminiTranscriptObserver(
  join(process.env.HOME ?? '/home/claude', '.gemini', 'tmp'),
)
geminiObserver.on((u) => {
  const json = JSON.stringify({ type: 'gemini-transcript', data: u })
  for (const ws of wsClients) ws.send(json)
})

monitor.onMessage((envelope) => {
  const json = JSON.stringify({ type: 'message', data: envelope })
  for (const ws of wsClients) {
    ws.send(json)
  }

  if (
    envelope.from !== envelope.to &&
    envelope.to !== 'all' &&
    (envelope.type === 'message' || envelope.type === 'request' || envelope.type === 'response')
  ) {
    const crossJson = JSON.stringify({
      type: 'cross-call',
      data: {
        from: envelope.from,
        to: envelope.to,
        envelope_type: envelope.type,
        message_id: envelope.id,
        ts: envelope.ts,
      },
    })
    for (const ws of wsClients) ws.send(crossJson)
  }
})

// Periodic session list push
setInterval(() => {
  const sessions = monitor.getSessions()
  const json = JSON.stringify({ type: 'sessions', data: sessions })
  for (const ws of wsClients) {
    ws.send(json)
  }
}, 5000)

// Periodic quota push (every 30s — data only refreshes every 5min from API)
setInterval(() => {
  const quota = getQuota()
  if (!quota) return
  const json = JSON.stringify({ type: 'quota', data: quota })
  for (const ws of wsClients) {
    ws.send(json)
  }
}, 30_000)

// --- HTML ---

const __dirname = dirname(fileURLToPath(import.meta.url))
const indexHtml = readFileSync(join(__dirname, 'index.html'), 'utf-8')
const dashboardCss = readFileSync(join(__dirname, 'dashboard.css'), 'utf-8')
const dashboardJs = readFileSync(join(__dirname, 'dashboard.js'), 'utf-8')

// --- Server ---

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    // REST API: list sessions
    if (url.pathname === '/api/sessions') {
      return Response.json(monitor.getSessions())
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
        return Response.json({ ok: true })
      })()
    }

    // REST API: quota status
    if (url.pathname === '/api/quota') {
      return Response.json(getQuota() ?? { error: 'no data yet' })
    }

    // REST API: message history
    if (url.pathname === '/api/history') {
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10)
      return Response.json(monitor.getHistory({ limit }))
    }

    // REST API: send message
    if (url.pathname === '/api/send' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as { to?: string; message?: string; type?: string }
        if (!body.to || !body.message) {
          return Response.json({ error: '"to" and "message" required' }, { status: 400 })
        }
        const envelope = await monitor.send(
          body.to,
          body.message,
          (body.type as 'message') ?? 'message',
        )
        return Response.json({ ok: true, id: envelope.id })
      })()
    }

    // REST API: ingest hook events
    if (url.pathname === '/ingest') {
      return handleIngest(req, {
        db,
        token,
        onEvent: (ev) => aggregator.ingest(ev),
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
    if (url.pathname === '/api/transcript') {
      const sidParam = url.searchParams.get('session_id')
      if (!sidParam) return Response.json({ error: 'session_id required' }, { status: 400 })
      const resolved = aggregator.getSession(sidParam)
      const sessionUuid = resolved?.session_id ?? sidParam
      const agentId = url.searchParams.get('agent_id') ?? undefined
      const limit = parseInt(url.searchParams.get('limit') ?? '200', 10)
      const projectsRoot = join(process.env.HOME ?? '/home/claude', '.claude', 'projects')
      return Response.json(buildTranscript({
        projectsRoot, sessionId: sessionUuid, agentId, limit,
      }))
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
        .query<{ id: string; hostname: string; first_seen: string; last_seen: string }, []>(
          'SELECT * FROM machines ORDER BY last_seen DESC',
        )
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

    // Dashboard HTML
    return new Response(indexHtml, {
      headers: { 'Content-Type': 'text/html' },
    })
  },
  websocket: {
    open(ws) {
      wsClients.add(ws)
      // Send current state
      ws.send(JSON.stringify({ type: 'sessions', data: monitor.getSessions() }))
      const quota = getQuota()
      if (quota) ws.send(JSON.stringify({ type: 'quota', data: quota }))
      ws.send(JSON.stringify({ type: 'overrides', data: loadOverrides() }))
      const history = monitor.getHistory({ limit: 100 })
      for (const msg of history) {
        ws.send(JSON.stringify({ type: 'message', data: msg }))
      }
    },
    message(ws, data) {
      // Handle send commands from the browser
      try {
        const parsed = JSON.parse(String(data)) as {
          action?: string
          to?: string
          message?: string
          type?: string
          callback_id?: string
        }
        if (parsed.action === 'send' && parsed.to && parsed.message) {
          void monitor.send(parsed.to, parsed.message, (parsed.type as 'message') ?? 'message')
        } else if (
          parsed.action === 'respond' &&
          parsed.to &&
          parsed.callback_id &&
          parsed.message
        ) {
          void monitor.respond(parsed.to, parsed.callback_id, parsed.message)
        }
      } catch {
        // Ignore malformed messages
      }
    },
    close(ws) {
      wsClients.delete(ws)
    },
  },
})

// --- Start ---

async function main(): Promise<void> {
  await monitor.start()
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

  console.log(`Party Line Dashboard`)
  console.log(`  Web UI:   http://localhost:${PORT}`)
  console.log(`  Ingest:   http://localhost:${PORT}/ingest`)
  console.log(`  Token:    ${TOKEN_PATH}`)
  console.log(`  DB:       ${DB_PATH}`)
  console.log(`  Machine:  ${machineId}`)
  console.log(`  Multicast: 239.77.76.10:47100`)
  console.log(`  Name:     ${NAME}`)
  console.log(`  Quota:    polling every 5 min`)
  console.log()
}

function shutdown(): void {
  jsonlObserver.stop()
  geminiObserver.stop()
  db.close()
  stopQuotaPoller()
  monitor.stop()
  server.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

void main()
