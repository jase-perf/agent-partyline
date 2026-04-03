/**
 * server.ts — Party Line MCP channel server.
 *
 * Main entry point. Sets up the MCP server with channel capability,
 * registers tools for sending messages and listing sessions, and
 * runs the poll loop to deliver inbound messages.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { watch } from 'fs'
import { Bus } from './bus.js'
import type { MessageType } from './types.js'

// --- Session name resolution ---

function resolveSessionName(): string {
  // Priority: explicit env var > fallback
  if (process.env.PARTY_LINE_NAME) return process.env.PARTY_LINE_NAME
  if (process.env.CLAUDE_SESSION_NAME) return process.env.CLAUDE_SESSION_NAME
  // Fallback: hostname-pid (ugly but unique)
  const hostname = process.env.HOSTNAME ?? 'unknown'
  return `${hostname}-${process.pid}`
}

const SESSION_NAME = resolveSessionName()
const POLL_INTERVAL_MS = 500
const HEARTBEAT_INTERVAL_MS = 60_000

// --- Debug logging ---

const DEBUG = process.env.PARTY_LINE_DEBUG === '1'
function debug(msg: string): void {
  if (DEBUG) {
    process.stderr.write(`[party-line:${SESSION_NAME}] ${msg}\n`)
  }
}

// --- Bus + MCP setup ---

const bus = new Bus(SESSION_NAME)
bus.register()
debug(`Registered as "${SESSION_NAME}"`)

const mcp = new Server(
  { name: 'party-line', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
      },
      tools: {},
    },
    instructions: [
      `The party-line channel connects this session to other Claude Code sessions on the same machine.`,
      `This session is registered as "${SESSION_NAME}".`,
      ``,
      `Messages from other sessions arrive as <channel source="party-line" from="..." to="..." type="...">body</channel> tags.`,
      ``,
      `Available tools:`,
      `- party_line_send: Send a message to another session by name (or "all" for broadcast)`,
      `- party_line_list_sessions: See which sessions are currently connected`,
      `- party_line_history: View recent messages on the bus`,
      ``,
      `When you receive a message with type="request" and a callback_id, you should respond using party_line_respond with that callback_id.`,
    ].join('\n'),
  },
)

// --- Tool definitions ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'party_line_send',
      description:
        'Send a message to another Claude Code session by name. Use "all" to broadcast to every session.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: {
            type: 'string',
            description: 'Target session name, comma-separated list, or "all"',
          },
          message: {
            type: 'string',
            description: 'The message body',
          },
          type: {
            type: 'string',
            enum: ['message', 'request', 'status'],
            description: 'Message type (default: "message"). Use "request" to expect a response.',
          },
        },
        required: ['to', 'message'],
      },
    },
    {
      name: 'party_line_respond',
      description: 'Respond to a request from another session (matches by callback_id).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          callback_id: {
            type: 'string',
            description: 'The callback_id from the original request',
          },
          message: {
            type: 'string',
            description: 'The response body',
          },
        },
        required: ['callback_id', 'message'],
      },
    },
    {
      name: 'party_line_list_sessions',
      description: 'List all Claude Code sessions currently connected to the party line.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'party_line_history',
      description: 'View recent messages on the party line bus.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Number of recent messages to return (default: 20)',
          },
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  switch (name) {
    case 'party_line_send': {
      const to = String(args?.to ?? '')
      const message = String(args?.message ?? '')
      const type = (args?.type as MessageType) ?? 'message'

      if (!to || !message) {
        return { content: [{ type: 'text', text: 'Error: "to" and "message" are required.' }] }
      }

      // Generate callback_id for requests
      const callbackId = type === 'request' ? generateCallbackId() : null
      const msgId = bus.send(to, message, type, callbackId)

      const response = callbackId
        ? `Sent request #${msgId} to "${to}" (callback_id: ${callbackId}). Waiting for response.`
        : `Sent message #${msgId} to "${to}".`

      debug(`send: ${type} to=${to} id=${msgId}`)
      return { content: [{ type: 'text', text: response }] }
    }

    case 'party_line_respond': {
      const callbackId = String(args?.callback_id ?? '')
      const message = String(args?.message ?? '')

      if (!callbackId || !message) {
        return {
          content: [{ type: 'text', text: 'Error: "callback_id" and "message" are required.' }],
        }
      }

      // Look up the original request to find who sent it
      const history = bus.recentMessages(100)
      const original = history.find((m) => m.callback_id === callbackId)
      if (!original) {
        return {
          content: [{ type: 'text', text: `Error: No request found with callback_id "${callbackId}".` }],
        }
      }

      const msgId = bus.send(original.from, message, 'response', null, callbackId)
      debug(`respond: to=${original.from} callback=${callbackId} id=${msgId}`)
      return { content: [{ type: 'text', text: `Response #${msgId} sent to "${original.from}".` }] }
    }

    case 'party_line_list_sessions': {
      const sessions = bus.listSessions()
      if (sessions.length === 0) {
        return { content: [{ type: 'text', text: 'No sessions currently registered.' }] }
      }
      const lines = sessions.map((s) => {
        const isSelf = s.name === SESSION_NAME ? ' (this session)' : ''
        return `- ${s.name} (pid ${s.pid}, since ${s.registered_at})${isSelf}`
      })
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }

    case 'party_line_history': {
      const limit = Number(args?.limit) || 20
      const messages = bus.recentMessages(limit).reverse()
      if (messages.length === 0) {
        return { content: [{ type: 'text', text: 'No recent messages.' }] }
      }
      const lines = messages.map((m) => {
        const tag = m.callback_id ? ` [callback:${m.callback_id}]` : ''
        const resp = m.response_to ? ` [response_to:${m.response_to}]` : ''
        return `#${m.id} [${m.created_at}] ${m.from} → ${m.to} (${m.type})${tag}${resp}: ${m.body}`
      })
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
  }
})

// --- Poll loop with fs.watch acceleration ---

let pollTimer: ReturnType<typeof setInterval> | null = null
let watchDebounce: ReturnType<typeof setTimeout> | null = null

function deliverMessages(): void {
  const messages = bus.poll()
  for (const msg of messages) {
    debug(`delivering: #${msg.id} from=${msg.from} type=${msg.type}`)

    const meta: Record<string, string> = {
      from: msg.from,
      to: msg.to,
      type: msg.type,
      message_id: String(msg.id),
    }
    if (msg.callback_id) meta.callback_id = msg.callback_id
    if (msg.response_to) meta.response_to = msg.response_to

    void mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: msg.body,
        meta,
      },
    })
  }
}

// Primary: fs.watch on the WAL file for near-instant delivery
try {
  watch(bus.walPath, () => {
    // Debounce rapid writes
    if (watchDebounce) clearTimeout(watchDebounce)
    watchDebounce = setTimeout(deliverMessages, 50)
  })
  debug(`Watching WAL file: ${bus.walPath}`)
} catch {
  debug('fs.watch not available, falling back to polling only')
}

// Fallback: poll every POLL_INTERVAL_MS in case fs.watch misses events
pollTimer = setInterval(deliverMessages, POLL_INTERVAL_MS)

// Heartbeat so other sessions know we're still alive
const heartbeatTimer = setInterval(() => bus.heartbeat(), HEARTBEAT_INTERVAL_MS)

// --- Shutdown ---

function shutdown(): void {
  debug('Shutting down')
  if (pollTimer) clearInterval(pollTimer)
  clearInterval(heartbeatTimer)
  bus.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

// --- Helpers ---

function generateCallbackId(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}

// --- Start ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  debug('MCP server connected via stdio')
}

void main()
