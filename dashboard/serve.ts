/**
 * serve.ts — Web dashboard + WebSocket bridge for the party line.
 *
 * Runs a Bun HTTP server that serves the dashboard UI and bridges
 * multicast traffic to connected browsers via WebSocket.
 *
 * Usage:
 *   bun dashboard/serve.ts [--port 3400] [--name dashboard]
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { PartyLineMonitor } from './monitor.js'
import type { Envelope } from '../src/types.js'
import type { ServerWebSocket } from 'bun'

// --- Args ---

const args = process.argv.slice(2)
function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] ? args[idx + 1]! : fallback
}

const PORT = parseInt(getArg('--port', '3400'), 10)
const NAME = getArg('--name', 'dashboard')

// --- Monitor ---

const monitor = new PartyLineMonitor(NAME)
const wsClients = new Set<ServerWebSocket<unknown>>()

monitor.onMessage((envelope) => {
  const json = JSON.stringify({ type: 'message', data: envelope })
  for (const ws of wsClients) {
    ws.send(json)
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

// --- HTML ---

const __dirname = dirname(fileURLToPath(import.meta.url))
const indexHtml = readFileSync(join(__dirname, 'index.html'), 'utf-8')

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
  console.log(`Party Line Dashboard`)
  console.log(`  Web UI:  http://localhost:${PORT}`)
  console.log(`  WS:     ws://localhost:${PORT}/ws`)
  console.log(`  Name:    ${NAME}`)
  console.log(`  Multicast: 239.77.76.10:47100`)
  console.log()
}

function shutdown(): void {
  monitor.stop()
  server.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

void main()
