import type { Envelope } from '../src/types.js'
import { createEnvelope } from '../src/protocol.js'

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
