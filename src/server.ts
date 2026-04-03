/**
 * server.ts — Party Line MCP channel server.
 *
 * Main entry point. Sets up the MCP server with channel capability,
 * starts the UDP multicast transport, and registers tools for
 * inter-session messaging.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { UdpMulticastTransport } from './transport/udp-multicast.js'
import { PresenceTracker } from './presence.js'
import { createEnvelope, generateCallbackId } from './protocol.js'
import type { Envelope, MessageType } from './types.js'

// --- Session name resolution ---

function resolveSessionName(): string {
  if (process.env.PARTY_LINE_NAME) return process.env.PARTY_LINE_NAME
  if (process.env.CLAUDE_SESSION_NAME) return process.env.CLAUDE_SESSION_NAME
  const hostname = process.env.HOSTNAME ?? 'unknown'
  return `${hostname}-${process.pid}`
}

const SESSION_NAME = resolveSessionName()

// --- Debug logging ---

const DEBUG = process.env.PARTY_LINE_DEBUG === '1'
function debug(msg: string): void {
  if (DEBUG) {
    process.stderr.write(`[party-line:${SESSION_NAME}] ${msg}\n`)
  }
}

// --- In-memory message history (ring buffer) ---

const MESSAGE_HISTORY_SIZE = 200
const messageHistory: Envelope[] = []

function recordMessage(envelope: Envelope): void {
  messageHistory.push(envelope)
  if (messageHistory.length > MESSAGE_HISTORY_SIZE) {
    messageHistory.shift()
  }
}

// --- Transport + Presence ---

const transport = new UdpMulticastTransport(SESSION_NAME)
const presence = new PresenceTracker(transport, SESSION_NAME, {
  description: `Claude Code session: ${SESSION_NAME}`,
})

// --- MCP Server ---

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
      `The party-line channel connects this session to other Claude Code sessions on the same machine via UDP multicast.`,
      `This session is registered as "${SESSION_NAME}".`,
      ``,
      `Messages from other sessions arrive as <channel source="party-line" from="..." to="..." type="...">body</channel> tags.`,
      ``,
      `Available tools:`,
      `- party_line_send: Send a message to another session by name (or "all" for broadcast)`,
      `- party_line_request: Send a request and expect a response (includes a callback_id)`,
      `- party_line_respond: Reply to a request using its callback_id`,
      `- party_line_list_sessions: See which sessions are currently connected`,
      `- party_line_history: View recent messages on the bus`,
    ].join('\n'),
  },
)

// --- Handle inbound messages ---

function handleInbound(envelope: Envelope): void {
  // Track presence from all messages
  presence.handleMessage(envelope)

  // Record all traffic for history
  recordMessage(envelope)

  // Only deliver non-heartbeat messages that are addressed to us (or "all")
  if (envelope.type === 'heartbeat') return

  const isForUs =
    envelope.to === SESSION_NAME ||
    envelope.to === 'all' ||
    envelope.to.split(',').map((s) => s.trim()).includes(SESSION_NAME)

  if (!isForUs) return

  debug(`delivering: #${envelope.id} from=${envelope.from} type=${envelope.type}`)

  const meta: Record<string, string> = {
    from: envelope.from,
    to: envelope.to,
    type: envelope.type,
    message_id: envelope.id,
  }
  if (envelope.callback_id) meta.callback_id = envelope.callback_id
  if (envelope.response_to) meta.response_to = envelope.response_to

  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: envelope.body,
      meta,
    },
  })
}

// --- Tool definitions ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'party_line_send',
      description:
        'Send a message to another Claude Code session by name. Use "all" to broadcast.',
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
        },
        required: ['to', 'message'],
      },
    },
    {
      name: 'party_line_request',
      description:
        'Send a request to another session and expect a response. Returns a callback_id to match the response.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: {
            type: 'string',
            description: 'Target session name',
          },
          message: {
            type: 'string',
            description: 'The request body',
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
            description: 'The callback_id from the inbound request',
          },
          to: {
            type: 'string',
            description: 'The session that sent the original request (from the "from" field)',
          },
          message: {
            type: 'string',
            description: 'The response body',
          },
        },
        required: ['callback_id', 'to', 'message'],
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
      description: 'View recent messages on the party line (excludes heartbeats).',
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
      if (!to || !message) {
        return { content: [{ type: 'text', text: 'Error: "to" and "message" are required.' }] }
      }

      const envelope = createEnvelope(SESSION_NAME, to, 'message', message)
      await transport.send(envelope)
      recordMessage(envelope)
      debug(`send: to=${to} id=${envelope.id}`)
      return { content: [{ type: 'text', text: `Sent message to "${to}" (id: ${envelope.id}).` }] }
    }

    case 'party_line_request': {
      const to = String(args?.to ?? '')
      const message = String(args?.message ?? '')
      if (!to || !message) {
        return { content: [{ type: 'text', text: 'Error: "to" and "message" are required.' }] }
      }

      const callbackId = generateCallbackId()
      const envelope = createEnvelope(SESSION_NAME, to, 'request', message, callbackId)
      await transport.send(envelope)
      recordMessage(envelope)
      debug(`request: to=${to} callback=${callbackId} id=${envelope.id}`)
      return {
        content: [
          {
            type: 'text',
            text: `Request sent to "${to}" (callback_id: ${callbackId}). You'll receive a response notification when they reply.`,
          },
        ],
      }
    }

    case 'party_line_respond': {
      const callbackId = String(args?.callback_id ?? '')
      const to = String(args?.to ?? '')
      const message = String(args?.message ?? '')
      if (!callbackId || !to || !message) {
        return {
          content: [
            { type: 'text', text: 'Error: "callback_id", "to", and "message" are required.' },
          ],
        }
      }

      const envelope = createEnvelope(SESSION_NAME, to, 'response', message, null, callbackId)
      await transport.send(envelope)
      recordMessage(envelope)
      debug(`respond: to=${to} callback=${callbackId} id=${envelope.id}`)
      return { content: [{ type: 'text', text: `Response sent to "${to}".` }] }
    }

    case 'party_line_list_sessions': {
      const sessions = presence.listSessions()
      if (sessions.length === 0) {
        return { content: [{ type: 'text', text: 'No sessions currently registered.' }] }
      }
      const lines = sessions.map((s) => {
        const isSelf = s.name === SESSION_NAME ? ' (this session)' : ''
        const desc = s.metadata?.description ? ` — ${s.metadata.description}` : ''
        return `- ${s.name}${isSelf}${desc} (last seen: ${new Date(s.lastSeen).toISOString()})`
      })
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }

    case 'party_line_history': {
      const limit = Number(args?.limit) || 20
      const filtered = messageHistory.filter((m) => m.type !== 'heartbeat')
      const recent = filtered.slice(-limit)
      if (recent.length === 0) {
        return { content: [{ type: 'text', text: 'No recent messages.' }] }
      }
      const lines = recent.map((m) => {
        const tag = m.callback_id ? ` [callback:${m.callback_id}]` : ''
        const resp = m.response_to ? ` [↩${m.response_to}]` : ''
        return `[${m.ts}] ${m.from} → ${m.to} (${m.type})${tag}${resp}: ${m.body}`
      })
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
  }
})

// --- Shutdown ---

function shutdown(): void {
  debug('Shutting down')
  presence.stop()
  transport.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

// --- Start ---

async function main(): Promise<void> {
  debug('Starting party line...')

  // Start UDP transport
  await transport.start(handleInbound)
  debug('UDP multicast transport started')

  // Start presence (announce + heartbeat)
  await presence.start()
  debug('Presence tracker started')

  // Connect MCP server
  const stdio = new StdioServerTransport()
  await mcp.connect(stdio)
  debug('MCP server connected via stdio')
}

void main()
