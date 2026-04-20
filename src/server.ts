/**
 * server.ts — Party Line MCP channel server.
 *
 * Main entry point. Sets up the MCP server with channel capability,
 * dials the party-line switchboard over WebSocket, and registers tools
 * for inter-session messaging.
 *
 * In Phase C, the plugin is a thin WS client to the switchboard. The
 * session name is pinned at registration (via `ccpl new <name>`), and
 * the `PARTY_LINE_TOKEN` env var authenticates the connection.
 */

import { basename } from 'node:path'
import { readFileSync } from 'fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createWsClient } from './transport/ws-client.js'
import { generateId, generateCallbackId } from './protocol.js'
import { getSessionStatus } from './introspect.js'
import { createPermissionBridge } from './permission-bridge.js'
import { getMachineId } from './machine-id.js'
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
      const isClaude = args.some((arg) => arg.endsWith('/claude') || arg === 'claude')
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

const sessionName = resolveSessionName()

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

// --- Switchboard connection (WS client) ---

const PARTY_LINE_VERSION = '0.1.0'
const SWITCHBOARD_URL = process.env.PARTY_LINE_SWITCHBOARD_URL || 'wss://localhost:3400/ws/session'
const token = process.env.PARTY_LINE_TOKEN || null

function ccplBaseUrl(): string {
  return SWITCHBOARD_URL.replace(/^wss?:\/\//, (m) =>
    m === 'wss://' ? 'https://' : 'http://',
  ).replace(/\/ws\/.*$/, '')
}

// Best-effort machine_id for the hello payload (ignore failures).
let machineId: string | null = null
try {
  const mpath = (process.env.HOME ?? '/home/claude') + '/.config/party-line/machine-id'
  machineId = getMachineId(mpath)
} catch {
  /* ignore — hello payload accepts null */
}

/** Cached Claude Code session UUID from JSONL introspection (may be null). */
function currentCcUuid(): string | null {
  return getSessionStatus()?.sessionId ?? null
}

const ws = token
  ? createWsClient({
      url: SWITCHBOARD_URL,
      helloPayload: {
        type: 'hello',
        token,
        name: sessionName,
        cc_session_uuid: currentCcUuid(),
        pid: process.pid,
        machine_id: machineId,
        version: PARTY_LINE_VERSION,
      },
      logger: (lvl, msg) => {
        if (lvl === 'error' || DEBUG) {
          process.stderr.write(`[party-line:ws:${lvl}] ${msg}\n`)
        }
      },
    })
  : null

if (!ws) {
  debug('PARTY_LINE_TOKEN not set — running in degraded mode (tools will error)')
}

// --- MCP Server ---

const mcp = new Server(
  { name: 'party-line', version: PARTY_LINE_VERSION },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: [
      `The party-line channel connects this session to other Claude Code sessions on the same machine via the party-line switchboard.`,
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

// --- Permission bridge (MCP ↔ WS for claude/channel/permission) ---

const permissionBridge = createPermissionBridge({
  sessionName,
  sendEnvelope: (envelope) => {
    // Forward permission envelopes to the switchboard as `send` frames so
    // they reach the dashboard/observer surface. Silently drop if we have
    // no live WS (no token or not yet connected).
    if (!ws || !ws.isConnected()) return
    try {
      ws.send({
        type: 'send',
        to: envelope.to,
        frame_type: envelope.type,
        body: envelope.body,
        callback_id: envelope.callback_id ?? undefined,
        response_to: envelope.response_to ?? undefined,
        client_ref: envelope.id,
      })
    } catch {
      /* ignore — socket raced a close */
    }
  },
  sendMcpNotification: ({ request_id, behavior }) => {
    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior },
    })
  },
})

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    permissionBridge.handlePermissionRequest(params)
  },
)

// --- Handle inbound envelope frames from the switchboard ---

interface InboundEnvelopeFrame {
  type: 'envelope'
  id: string
  ts: number
  from: string
  to: string
  envelope_type: string
  body: string | null
  callback_id: string | null
  response_to: string | null
}

function handleInbound(envelope: Envelope): void {
  // Record all inbound traffic for the history tool.
  recordMessage(envelope)

  // Permission envelopes use a dedicated MCP notification path, not claude/channel.
  if (envelope.type === 'permission-response' && envelope.to === sessionName) {
    permissionBridge.handlePermissionResponseEnvelope(envelope)
    return
  }
  if (envelope.type === 'permission-request') {
    // permission-request envelopes are for the dashboard, not other sessions.
    return
  }

  // The switchboard routes only envelopes addressed to us (or broadcast),
  // but double-check so we don't surface stray frames.
  const isForUs =
    envelope.to === sessionName ||
    envelope.to === 'all' ||
    envelope.to
      .split(',')
      .map((s) => s.trim())
      .includes(sessionName)

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

ws?.on('envelope', (frame: InboundEnvelopeFrame) => {
  // Adapt the switchboard wire frame (envelope_type) to the internal
  // Envelope shape (type) so downstream code can stay as-is.
  const adapted: Envelope = {
    id: frame.id,
    from: frame.from,
    to: frame.to,
    type: frame.envelope_type as MessageType,
    body: frame.body ?? '',
    callback_id: frame.callback_id,
    response_to: frame.response_to,
    ts: new Date(frame.ts).toISOString(),
  }
  handleInbound(adapted)
})

// --- Tool definitions ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'party_line_set_name',
      description:
        'Set a human-readable name for this session on the party line. NOTE: Disabled under the switchboard model — session names are pinned at ccpl registration.',
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
      description: 'Send a message to another Claude Code session by name. Use "all" to broadcast.',
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
      description: 'List Claude Code sessions currently connected to the party line.',
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

/** Fetch the caller's own session row from the switchboard.
 *
 * Until the switchboard exposes a token-authed listing endpoint, the plugin
 * can only authenticate itself for its own name. Returns an empty array if
 * the request fails or no token is set.
 */
async function fetchSessions(): Promise<
  Array<{ name: string; online: boolean; cc_session_uuid: string | null; cwd: string }>
> {
  if (!token) return []
  try {
    const res = await fetch(ccplBaseUrl() + '/ccpl/session/' + encodeURIComponent(sessionName), {
      headers: { 'X-Party-Line-Token': token },
    })
    if (!res.ok) return []
    const row = (await res.json()) as {
      name: string
      cwd: string
      cc_session_uuid: string | null
      online: boolean
    }
    return [row]
  } catch {
    return []
  }
}

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  switch (name) {
    case 'party_line_send': {
      const to = String(args?.to ?? '')
      const message = String(args?.message ?? '')
      if (!to || !message) {
        return { content: [{ type: 'text', text: 'Error: "to" and "message" are required.' }] }
      }
      if (!ws) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: PARTY_LINE_TOKEN not set. Use ccpl to launch this session.',
            },
          ],
        }
      }
      if (!ws.isConnected()) {
        return { content: [{ type: 'text', text: 'Error: switchboard unreachable.' }] }
      }

      const clientRef = generateId()
      ws.send({
        type: 'send',
        to,
        frame_type: 'message',
        body: message,
        client_ref: clientRef,
      })
      // Optimistic local history entry so party_line_history reflects sends.
      recordMessage({
        id: clientRef,
        from: sessionName,
        to,
        type: 'message',
        body: message,
        callback_id: null,
        response_to: null,
        ts: new Date().toISOString(),
      })
      debug(`send: to=${to} client_ref=${clientRef}`)
      return {
        content: [{ type: 'text', text: `Sent message to "${to}" (client_ref: ${clientRef}).` }],
      }
    }

    case 'party_line_request': {
      const to = String(args?.to ?? '')
      const message = String(args?.message ?? '')
      if (!to || !message) {
        return { content: [{ type: 'text', text: 'Error: "to" and "message" are required.' }] }
      }
      if (!ws) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: PARTY_LINE_TOKEN not set. Use ccpl to launch this session.',
            },
          ],
        }
      }
      if (!ws.isConnected()) {
        return { content: [{ type: 'text', text: 'Error: switchboard unreachable.' }] }
      }

      const callbackId = generateCallbackId()
      const clientRef = generateId()
      ws.send({
        type: 'send',
        to,
        frame_type: 'request',
        body: message,
        callback_id: callbackId,
        client_ref: clientRef,
      })
      recordMessage({
        id: clientRef,
        from: sessionName,
        to,
        type: 'request',
        body: message,
        callback_id: callbackId,
        response_to: null,
        ts: new Date().toISOString(),
      })
      debug(`request: to=${to} callback=${callbackId} client_ref=${clientRef}`)
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
      if (!ws) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: PARTY_LINE_TOKEN not set. Use ccpl to launch this session.',
            },
          ],
        }
      }
      if (!ws.isConnected()) {
        return { content: [{ type: 'text', text: 'Error: switchboard unreachable.' }] }
      }

      const clientRef = generateId()
      ws.send({
        type: 'respond',
        to,
        frame_type: 'response',
        body: message,
        callback_id: callbackId,
        response_to: callbackId,
        client_ref: clientRef,
      })
      recordMessage({
        id: clientRef,
        from: sessionName,
        to,
        type: 'response',
        body: message,
        callback_id: callbackId,
        response_to: callbackId,
        ts: new Date().toISOString(),
      })
      debug(`respond: to=${to} callback=${callbackId} client_ref=${clientRef}`)
      return { content: [{ type: 'text', text: `Response sent to "${to}".` }] }
    }

    case 'party_line_list_sessions': {
      if (!token) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: PARTY_LINE_TOKEN not set. Use ccpl to launch this session.',
            },
          ],
        }
      }
      const rows = await fetchSessions()
      if (rows.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No session info available. The plugin can only introspect its own session via the switchboard right now — full discovery requires the dashboard.',
            },
          ],
        }
      }
      const lines = rows.map((s) => {
        const isSelf = s.name === sessionName ? ' (this session)' : ''
        const state = s.online ? 'online' : 'offline'
        const uuid = s.cc_session_uuid ? ` uuid=${s.cc_session_uuid.slice(0, 8)}…` : ''
        return `- ${s.name}${isSelf} [${state}] cwd=${s.cwd}${uuid}`
      })
      lines.push(
        '',
        'Note: full session discovery requires the dashboard. The plugin sees only its own switchboard row.',
      )
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
      return {
        content: [
          {
            type: 'text',
            text: 'Error: session names are pinned at ccpl registration. Use `ccpl new <name>` to create a new session or `ccpl forget <old>` then register a new one.',
          },
        ],
      }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
  }
})

// --- UUID rotation watcher ---
// Detects `/clear` and other resets by comparing the cached CC session UUID
// every ~30s. Sends `uuid-rotate` to the switchboard when it changes so the
// backend can archive the prior session.

let lastKnownCcUuid: string | null = currentCcUuid()

function startUuidWatcher(): void {
  setInterval(() => {
    const current = currentCcUuid()
    if (current !== lastKnownCcUuid) {
      const prior = lastKnownCcUuid
      lastKnownCcUuid = current
      if (ws && ws.isConnected()) {
        try {
          ws.send({ type: 'uuid-rotate', old_uuid: prior, new_uuid: current })
          debug(`uuid-rotate: ${prior ?? 'null'} → ${current ?? 'null'}`)
        } catch {
          /* ignore — socket raced a close */
        }
      }
    }
  }, 30_000)
}

// --- Shutdown ---

function shutdown(): void {
  debug('Shutting down')
  ws?.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

// --- Start ---

async function main(): Promise<void> {
  debug('Starting party line...')

  // Kick off the switchboard WS connection (async, non-blocking).
  if (ws) {
    ws.start()
    debug(`WS client dialing ${SWITCHBOARD_URL}`)
  } else {
    debug('No PARTY_LINE_TOKEN — skipping WS connection (tools will error)')
  }

  startUuidWatcher()

  // Connect MCP server — this is the main event-loop anchor.
  const stdio = new StdioServerTransport()
  await mcp.connect(stdio)
  debug('MCP server connected via stdio')
}

void main()
