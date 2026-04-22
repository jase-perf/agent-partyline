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

/**
 * A file attached to an envelope. Stored on the dashboard's attachment
 * store; the envelope carries metadata + a URL only (no base64) to keep
 * envelopes small and routing costs bounded.
 *
 * Auth on the URL:
 *   GET /api/attachment/<id>  — dashboard cookie OR X-Party-Line-Token.
 * Images may also be requested with `?thumb=<px>` for a resized preview.
 */
export interface Attachment {
  id: string // server-assigned, opaque
  kind: 'image' | 'file'
  name: string // original filename; sanitized before display
  media_type: string // MIME type, e.g. "image/png"
  size: number // bytes
  url: string // absolute path-only URL, e.g. "/api/attachment/abc123"
}

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
  /** Optional attached files (images, logs, etc.) referenced by URL. */
  attachments?: Attachment[]
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
