import type { Envelope } from '../src/types.js'

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
  const p = parsed as Record<string, string>
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
