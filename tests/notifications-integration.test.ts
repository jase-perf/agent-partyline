import { test, expect, describe } from 'bun:test'
import { createPermissionBridge } from '../src/permission-bridge.js'
import {
  buildPermissionRequestFrame,
  validatePermissionResponseBody,
  buildPermissionResponseEnvelope,
} from '../dashboard/serve-helpers.js'
import type { Envelope } from '../src/types.js'

describe('notification flow end-to-end (permission)', async () => {
  test('MCP → UDP → WS frame → POST → UDP → MCP', async () => {
    // --- Session side ---
    const mcpNotifications: Array<{ request_id: string; behavior: string }> = []
    const udpFromSession: Envelope[] = []
    const sessionBridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: (env) => udpFromSession.push(env),
      sendMcpNotification: (params) => mcpNotifications.push(params),
    })

    // --- Claude sends permission_request to the session's MCP server ---
    sessionBridge.handlePermissionRequest({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"cmd":"bun test"}',
    })
    expect(udpFromSession).toHaveLength(1)
    const envToDashboard = udpFromSession[0]!
    expect(envToDashboard.type).toBe('permission-request')

    // --- Dashboard side receives UDP envelope, formats as WS frame ---
    const wsFrame = buildPermissionRequestFrame(envToDashboard)
    expect(wsFrame).not.toBeNull()
    expect(wsFrame!.data.session).toBe('research')
    expect(wsFrame!.data.request_id).toBe('abc12')
    expect(wsFrame!.data.tool_name).toBe('Bash')

    // --- Browser clicks Allow → POST /api/permission-response ---
    const validation = validatePermissionResponseBody({
      session: 'research',
      request_id: 'abc12',
      behavior: 'allow',
    })
    expect(validation.ok).toBe(true)

    // --- Dashboard emits UDP response ---
    const envToSession = buildPermissionResponseEnvelope({
      from: 'dashboard',
      session: 'research',
      request_id: 'abc12',
      behavior: 'allow',
    })

    // --- Session receives UDP response, translates back to MCP ---
    sessionBridge.handlePermissionResponseEnvelope(envToSession)
    expect(mcpNotifications).toEqual([{ request_id: 'abc12', behavior: 'allow' }])
    expect(sessionBridge.hasPending('abc12')).toBe(false)
  })

  test('second response for same request is ignored', async () => {
    const mcpNotifications: Array<unknown> = []
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: () => {},
      sendMcpNotification: (params) => mcpNotifications.push(params),
    })
    bridge.handlePermissionRequest({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: '',
      input_preview: '',
    })

    const first = buildPermissionResponseEnvelope({
      from: 'dashboard',
      session: 'research',
      request_id: 'abc12',
      behavior: 'allow',
    })
    bridge.handlePermissionResponseEnvelope(first)

    const second = buildPermissionResponseEnvelope({
      from: 'dashboard',
      session: 'research',
      request_id: 'abc12',
      behavior: 'deny',
    })
    bridge.handlePermissionResponseEnvelope(second)

    expect(mcpNotifications).toHaveLength(1)
    expect(mcpNotifications[0]).toEqual({ request_id: 'abc12', behavior: 'allow' })
  })
})
