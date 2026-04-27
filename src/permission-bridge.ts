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

const PENDING_TTL_MS = 5 * 60 * 1000 // 5 min — Claude Code permission timeout
const PENDING_CAP = 256

interface PendingEntry {
  params: PermissionRequestParams
  expiresAt: number
}

export function createPermissionBridge(deps: PermissionBridgeDeps): PermissionBridge {
  const pending = new Map<string, PendingEntry>()

  function evictExpired(): void {
    const now = Date.now()
    for (const [id, entry] of pending) {
      if (entry.expiresAt < now) pending.delete(id)
    }
  }

  function evictToCap(): void {
    if (pending.size <= PENDING_CAP) return
    // Drop oldest entries until under cap.
    const sorted = [...pending.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    const drop = pending.size - PENDING_CAP
    for (let i = 0; i < drop; i++) pending.delete(sorted[i]![0])
  }

  return {
    handlePermissionRequest(params) {
      evictExpired()
      pending.set(params.request_id, { params, expiresAt: Date.now() + PENDING_TTL_MS })
      evictToCap()
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
      const entry = pending.get(parsed.request_id)
      if (!entry) return
      pending.delete(parsed.request_id)
      // Even if the entry has expired, the user has explicitly clicked
      // allow/deny — honor the decision.
      deps.sendMcpNotification(parsed)
    },

    hasPending(requestId) {
      const entry = pending.get(requestId)
      if (!entry) return false
      if (entry.expiresAt < Date.now()) {
        pending.delete(requestId)
        return false
      }
      return true
    },
  }
}
