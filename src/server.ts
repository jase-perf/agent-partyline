/**
 * server.ts — Party Line MCP channel server.
 *
 * Main entry point. Sets up the MCP server with channel capability,
 * starts the UDP multicast transport, and registers tools for
 * inter-session messaging.
 */

import { basename } from 'node:path'
import { readFileSync } from 'fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { UdpMulticastTransport } from './transport/udp-multicast.js'
import { PresenceTracker } from './presence.js'
import { createEnvelope, generateCallbackId } from './protocol.js'
import { getSessionStatus } from './introspect.js'
import type { Envelope, MessageType } from './types.js'

// --- Session name resolution ---

/** Walk up the process tree to find the Claude Code process and extract --name. */
function resolveNameFromProcessTree(): string | null {
  try {
    let pid = process.ppid
    // Walk up at most 5 levels to find the claude process
    for (let i = 0; i < 5; i++) {
      const cmdlineRaw = readFileSync(`/proc/${pid}/cmdline`).toString()
      const args = cmdlineRaw.split('\0').filter(Boolean)

      // Check if this is a claude process
      const isClaude = args.some(arg => arg.endsWith('/claude') || arg === 'claude')
      if (isClaude) {
        // Look for --name or -n flag
        for (let j = 0; j < args.length - 1; j++) {
          if (args[j] === '--name' || args[j] === '-n') {
            const name = args[j + 1]
            if (name && !name.startsWith('-')) return name
          }
        }
        // Found claude but no --name flag
        return null
      }

      // Get parent PID from /proc/PID/stat (field 4)
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const ppid = parseInt(stat.split(' ')[3]!, 10)
      if (ppid <= 1) break // reached init
      pid = ppid
    }
  } catch {
    // /proc not available (non-Linux) or permission denied — fall through
  }
  return null
}

function resolveSessionName(): string {
  // 1. Explicit env var (highest priority)
  if (process.env.PARTY_LINE_NAME) return process.env.PARTY_LINE_NAME
  if (process.env.CLAUDE_SESSION_NAME) return process.env.CLAUDE_SESSION_NAME

  // 2. Auto-detect from parent Claude Code process tree
  const treeResolved = resolveNameFromProcessTree()
  if (treeResolved) return treeResolved

  // 3. Fallback: use working directory name + PID for a meaningful default
  const dir = basename(process.cwd())
  return `${dir}-${process.pid}`
}

let sessionName = resolveSessionName()

// --- Debug logging ---

const DEBUG = process.env.PARTY_LINE_DEBUG === '1'
function debug(msg: string): void {
  if (DEBUG) {
    process.stderr.write(`[party-line:${sessionName}] ${msg}\n`)
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

const transport = new UdpMulticastTransport(sessionName)
const presence = new PresenceTracker(transport, sessionName, {
  description: `Claude Code session: ${sessionName}`,
})

// Enrich heartbeats with live session status from JSONL introspection
presence.setStatusProvider(() => {
  const status = getSessionStatus()
  return status ?? undefined
})

// --- MCP Server ---

const mcp = new Server(
  { name: 'party-line', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: [
      `The party-line channel connects this session to other Claude Code sessions on the same machine via UDP multicast.`,
      `This session is registered as "${sessionName}".`,
      ``,
      `Messages from other sessions arrive as <channel source="party-line" from="..." to="..." type="...">body</channel> tags.`,
      ``,
      `When you receive a channel message:`,
      `- If type="request" (meta includes callback_id): you MUST reply via party_line_respond with that callback_id. The requesting session is waiting.`,
      `- If type="message": informational. No reply required. Continue your current work. A dashboard captures your output via hooks, so you do not need to acknowledge on the channel.`,
      `- If type="response": a reply to a request you sent earlier. Use the content as you need.`,
      `- Broadcasts (to="all") never require a reply.`,
      ``,
      `Available tools:`,
      `- party_line_send: Send a message to another session by name (or "all" for broadcast). Fire-and-forget.`,
      `- party_line_request: Send a request and expect a response. Returns a callback_id so the other end can reply.`,
      `- party_line_respond: Reply to a request using its callback_id (REQUIRED when you receive a type=request).`,
      `- party_line_list_sessions: See which sessions are currently connected.`,
      `- party_line_history: View recent messages on the bus.`,
    ].join('\n'),
  },
)

// --- Handle inbound messages ---

function handleInbound(envelope: Envelope): void {
  // Track presence from all messages
  presence.handleMessage(envelope)

  // Record all traffic for history
  recordMessage(envelope)

  // Only deliver user-initiated messages — filter out presence protocol traffic
  if (envelope.type === 'heartbeat' || envelope.type === 'announce') return

  const isForUs =
    envelope.to === sessionName ||
    envelope.to === 'all' ||
    envelope.to.split(',').map((s) => s.trim()).includes(sessionName)

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
      name: 'party_line_set_name',
      description:
        'Set a human-readable name for this session on the party line. Choose a short, descriptive name based on your role (e.g. "discord", "research", "project-myapp").',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: {
            type: 'string',
            description: 'The new session name (short, lowercase, descriptive)',
          },
        },
        required: ['name'],
      },
    },
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

      const envelope = createEnvelope(sessionName, to, 'message', message)
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
      const envelope = createEnvelope(sessionName, to, 'request', message, callbackId)
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

      const envelope = createEnvelope(sessionName, to, 'response', message, null, callbackId)
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
        const isSelf = s.name === sessionName ? ' (this session)' : ''
        const status = s.metadata?.status
        if (status) {
          const stateIcon = status.state === 'working' ? '🔄' : status.state === 'idle' ? '💤' : '❓'
          const branch = status.gitBranch ? ` [${status.gitBranch}]` : ''
          const tool = status.currentTool ? ` running ${status.currentTool}` : ''
          const modelShort = status.model ? ` (${status.model.replace('claude-', '')})` : ''
          const ctx = status.contextTokens !== null
            ? ` ctx:${Math.round((status.contextTokens ?? 0) / 1000)}k`
            : ''
          const msgs = status.messageCount ? ` msgs:${status.messageCount}` : ''
          const lastText = status.lastText ? `\n    "${status.lastText.slice(0, 80)}"` : ''
          return `- ${stateIcon} ${s.name}${isSelf}${modelShort}${branch}${tool}${ctx}${msgs}${lastText}`
        }
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

    case 'party_line_set_name': {
      const newName = String(args?.name ?? '').trim().toLowerCase()
      if (!newName || newName.length > 30) {
        return { content: [{ type: 'text', text: 'Error: name must be 1-30 characters.' }] }
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(newName)) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: name must be lowercase alphanumeric with hyphens (e.g. "discord", "project-foo").',
            },
          ],
        }
      }

      const oldName = sessionName
      sessionName = newName
      transport.rename(newName)
      await presence.rename(newName)
      debug(`renamed: ${oldName} → ${newName}`)
      return {
        content: [
          {
            type: 'text',
            text: `Session renamed from "${oldName}" to "${newName}". Other sessions will see the new name.`,
          },
        ],
      }
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

// --- Periodic name re-check ---
// The parent Claude Code process might get --name set after we start
// (e.g. session resumed with a name). Re-check on each heartbeat cycle.

function startNameRecheck(): void {
  setInterval(() => {
    // Only re-check if we're still on the fallback name
    const envName = process.env.PARTY_LINE_NAME ?? process.env.CLAUDE_SESSION_NAME
    if (envName) return // explicit env var — don't override

    const treeName = resolveNameFromProcessTree()
    if (treeName && treeName !== sessionName) {
      const oldName = sessionName
      sessionName = treeName
      transport.rename(treeName)
      void presence.rename(treeName)
      debug(`auto-renamed: ${oldName} → ${treeName} (detected from process tree)`)
    }
  }, 30_000) // same interval as heartbeats
}

// --- Start ---

async function main(): Promise<void> {
  debug('Starting party line...')

  // Start UDP transport
  await transport.start(handleInbound)
  debug('UDP multicast transport started')

  // Start presence (announce + heartbeat)
  await presence.start()
  debug('Presence tracker started')

  // Periodically re-check parent process for name changes
  startNameRecheck()

  // Connect MCP server
  const stdio = new StdioServerTransport()
  await mcp.connect(stdio)
  debug('MCP server connected via stdio')
}

void main()
