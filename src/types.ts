/** Message types on the party line. */
export type MessageType =
  | 'message'
  | 'request'
  | 'response'
  | 'status'
  | 'heartbeat'
  | 'announce'
  | 'permission-request'
  | 'permission-response'

/** The wire format for all party line messages. */
export interface Envelope {
  id: string
  from: string
  to: string // session name, or "all" for broadcast
  type: MessageType
  body: string
  callback_id: string | null
  response_to: string | null
  ts: string // ISO 8601
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
