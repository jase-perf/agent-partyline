/**
 * permission-bridge.ts — Bridge between MCP permission notifications and UDP envelopes.
 *
 * When Claude Code issues an MCP `notifications/claude/channel/permission_request`,
 * we stash the pending request and emit a `permission-request` envelope to the
 * dashboard. When the dashboard replies with a `permission-response` envelope,
 * we forward the decision back to Claude Code via an MCP notification.
 */

import { createEnvelope } from './protocol.js'
import type { Envelope } from './types.js'

export interface PermissionRequestParams {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export interface PermissionResponseBody {
  request_id: string
  behavior: 'allow' | 'deny'
}

export interface PermissionBridgeDeps {
  sessionName: string
  sendEnvelope: (envelope: Envelope) => void
  sendMcpNotification: (params: PermissionResponseBody) => void
}

export interface PermissionBridge {
  handlePermissionRequest: (params: PermissionRequestParams) => void
  handlePermissionResponseEnvelope: (envelope: Envelope) => void
  hasPending: (requestId: string) => boolean
}

export function createPermissionBridge(deps: PermissionBridgeDeps): PermissionBridge {
  const pending = new Map<string, PermissionRequestParams>()

  return {
    handlePermissionRequest(params) {
      pending.set(params.request_id, params)
      const body = JSON.stringify(params)
      const envelope = createEnvelope(deps.sessionName, 'dashboard', 'permission-request', body)
      deps.sendEnvelope(envelope)
    },

    handlePermissionResponseEnvelope(envelope) {
      if (envelope.type !== 'permission-response') return
      let parsed: PermissionResponseBody
      try {
        parsed = JSON.parse(envelope.body) as PermissionResponseBody
      } catch {
        return
      }
      if (parsed.behavior !== 'allow' && parsed.behavior !== 'deny') return
      if (!pending.has(parsed.request_id)) return
      pending.delete(parsed.request_id)
      deps.sendMcpNotification(parsed)
    },

    hasPending(requestId) {
      return pending.has(requestId)
    },
  }
}
