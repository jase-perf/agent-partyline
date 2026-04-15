/** Message types on the party line. */
export type MessageType = 'message' | 'request' | 'response' | 'status' | 'heartbeat' | 'announce'

/** The wire format for all party line messages. */
export interface Envelope {
  id: string
  seq: number
  from: string
  to: string // session name, or "all" for broadcast
  type: MessageType
  body: string
  callback_id: string | null
  response_to: string | null
  ts: string // ISO 8601
}

/** A known session on the party line (tracked via heartbeats). */
export interface KnownSession {
  name: string
  lastSeen: number // Date.now() timestamp
  metadata?: SessionMetadata
}

/** Optional metadata a session can announce about itself. */
export interface SessionMetadata {
  description?: string
  capabilities?: string[]
  /** Live session status from JSONL introspection. */
  status?: {
    state: 'idle' | 'working' | 'unknown'
    lastActivity: string
    lastText: string
    currentTool: string | null
    gitBranch: string | null
    cwd: string | null
    model: string | null
    uptimeMs: number
    turnDurationMs: number | null
    messageCount: number | null
    contextTokens: number | null
    outputTokens: number | null
  }
}

/** Configuration for the UDP multicast transport. */
export interface TransportConfig {
  multicastAddress: string
  port: number
  ttl: number
  loopback: boolean
  sendTwiceDelayMs: number
}

export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  multicastAddress: '239.77.76.10',
  port: 47100,
  ttl: 1, // same-subnet only (TTL 0 is ideal but Bun's setsockopt rejects it)
  loopback: true,
  sendTwiceDelayMs: 50,
}

export const HEARTBEAT_INTERVAL_MS = 30_000
export const SESSION_TIMEOUT_MS = 75_000 // ~2.5 heartbeat intervals
export const DEDUP_WINDOW_MS = 60_000
