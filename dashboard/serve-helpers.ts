import type { Envelope } from '../src/types.js'
import { createEnvelope } from '../src/protocol.js'
import type { HookEvent } from '../src/events.js'

export interface ApiErrorDetails {
  /** HTTP status from Anthropic ("529", "429", "500", etc.) when available. */
  status: number | null
  /** Canonical error type ("overloaded_error", "rate_limit_error", "api_error"). */
  errorType: string
  /** Short human message, e.g. "Overloaded". */
  message: string
}

/**
 * Classify a JSONL entry as a Claude Code API error, or return null.
 *
 * Claude Code records API errors in two shapes:
 *   1. `{ type: "system", subtype: "api_error", error: { status, headers, ... } }`
 *   2. `{ type: "assistant", isApiErrorMessage: true, message: { content:[{ text: "API Error: {json}" }] } }`
 *
 * Both are silent — Claude Code keeps retrying internally and never emits a
 * Stop hook, so the session's state in the aggregator stays "working" forever
 * unless we detect these records ourselves.
 */
export function classifyApiError(entry: Record<string, unknown>): ApiErrorDetails | null {
  if (entry.type === 'system' && entry.subtype === 'api_error') {
    const err = entry.error as { status?: number; message?: string; type?: string } | undefined
    const status = err && typeof err.status === 'number' ? err.status : null
    return {
      status,
      errorType: (err && typeof err.type === 'string' && err.type) || 'api_error',
      message:
        (err && typeof err.message === 'string' && err.message) ||
        (status === 529
          ? 'Overloaded'
          : status === 429
            ? 'Rate limited'
            : status
              ? `HTTP ${status}`
              : 'API error'),
    }
  }

  if (entry.type === 'assistant' && entry.isApiErrorMessage === true) {
    const msg = entry.message as { content?: Array<{ type?: string; text?: string }> } | undefined
    const content = msg?.content
    const text =
      Array.isArray(content) && content[0]?.type === 'text' && typeof content[0].text === 'string'
        ? content[0].text
        : ''
    // Typical text: `API Error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}...}`
    const m = text.match(/API Error:\s*(\{[\s\S]*\})/)
    type ApiErrorWrapper = { type?: string; error?: { type?: string; message?: string } }
    let parsed: ApiErrorWrapper | null = null
    if (m) {
      try {
        parsed = JSON.parse(m[1]!) as ApiErrorWrapper
      } catch {
        parsed = null
      }
    }
    const inner = parsed?.error
    return {
      status: null,
      errorType: inner?.type || 'api_error',
      message: inner?.message || 'API error',
    }
  }

  return null
}

export interface ApiErrorFrame {
  type: 'api-error'
  data: {
    session_id: string
    session_name: string | null
    file_path: string
    ts: string
    status: number | null
    errorType: string
    message: string
  }
}

export interface UserPromptFrame {
  type: 'user-prompt'
  data: {
    session_name: string
    session_id: string
    ts: string
    prompt: string
  }
}

/**
 * Builds a `user-prompt` observer frame from a UserPromptSubmit hook event,
 * or null if the event is not a UserPromptSubmit with a usable prompt string.
 * Extracted for testability.
 */
const PARTY_LINE_CHANNEL_RE = /^<channel\s+[^>]*\bsource="party-line"[^>]*>[\s\S]*<\/channel>$/

export function buildUserPromptFrame(ev: HookEvent): UserPromptFrame | null {
  if (ev.hook_event !== 'UserPromptSubmit') return null
  const prompt = (ev.payload as { prompt?: unknown }).prompt
  if (typeof prompt !== 'string' || prompt.length === 0) return null
  // Inbound party-line messages are delivered by the plugin as <channel> tags
  // in the recipient's next user turn. The dashboard already renders these
  // via the envelope broadcast, so firing a user-prompt frame would cause a
  // duplicate entry (and show the raw channel markup to the user).
  if (PARTY_LINE_CHANNEL_RE.test(prompt.trim())) return null
  return {
    type: 'user-prompt',
    data: {
      session_name: ev.session_name,
      session_id: ev.session_id,
      ts: ev.ts,
      prompt,
    },
  }
}

export interface PermissionRequestFrame {
  type: 'permission-request'
  data: {
    session: string
    request_id: string
    tool_name: string
    description: string
    input_preview: string
  }
}

export function buildPermissionRequestFrame(envelope: Envelope): PermissionRequestFrame | null {
  if (envelope.type !== 'permission-request') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(envelope.body)
  } catch {
    return null
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).request_id !== 'string' ||
    typeof (parsed as Record<string, unknown>).tool_name !== 'string' ||
    typeof (parsed as Record<string, unknown>).description !== 'string' ||
    typeof (parsed as Record<string, unknown>).input_preview !== 'string'
  ) {
    return null
  }
  const p = parsed as {
    request_id: string
    tool_name: string
    description: string
    input_preview: string
  }
  return {
    type: 'permission-request',
    data: {
      session: envelope.from,
      request_id: p.request_id,
      tool_name: p.tool_name,
      description: p.description,
      input_preview: p.input_preview,
    },
  }
}

export interface PermissionResponseInput {
  session: string
  request_id: string
  behavior: 'allow' | 'deny'
}

export function validatePermissionResponseBody(
  body: unknown,
): { ok: true; value: PermissionResponseInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be object' }
  const b = body as Record<string, unknown>
  if (typeof b.session !== 'string' || !b.session) {
    return { ok: false, error: '"session" required' }
  }
  if (typeof b.request_id !== 'string' || !b.request_id) {
    return { ok: false, error: '"request_id" required' }
  }
  if (b.behavior !== 'allow' && b.behavior !== 'deny') {
    return { ok: false, error: '"behavior" must be "allow" or "deny"' }
  }
  return {
    ok: true,
    value: { session: b.session, request_id: b.request_id, behavior: b.behavior },
  }
}

export function buildPermissionResponseEnvelope(args: {
  from: string
  session: string
  request_id: string
  behavior: 'allow' | 'deny'
}): Envelope {
  return createEnvelope(
    args.from,
    args.session,
    'permission-response',
    JSON.stringify({ request_id: args.request_id, behavior: args.behavior }),
  )
}

export function buildDismissFrame(session: string): {
  type: 'notification-dismiss'
  data: { session: string }
} {
  return { type: 'notification-dismiss', data: { session } }
}
