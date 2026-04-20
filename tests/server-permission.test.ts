import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createPermissionBridge } from '../src/permission-bridge.js'
import { createEnvelope } from '../src/protocol.js'
import type { Envelope } from '../src/types.js'

describe('MCP server capabilities', async () => {
  test('server.ts declares claude/channel/permission capability', async () => {
    const source = readFileSync(resolve(import.meta.dir, '../src/server.ts'), 'utf8')
    expect(source).toContain("'claude/channel/permission': {}")
  })
})

describe('permission bridge — incoming request', async () => {
  test('handlePermissionRequest stashes the request and emits a permission-request envelope', async () => {
    const sent: Envelope[] = []
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: (env) => void sent.push(env),
      sendMcpNotification: () => {},
    })

    bridge.handlePermissionRequest({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"command":"bun test"}',
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]!.type).toBe('permission-request')
    expect(sent[0]!.from).toBe('research')
    expect(sent[0]!.to).toBe('dashboard')
    const body = JSON.parse(sent[0]!.body)
    expect(body).toEqual({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"command":"bun test"}',
    })

    expect(bridge.hasPending('abc12')).toBe(true)
  })
})

describe('permission bridge — incoming response', async () => {
  test('matching permission-response envelope triggers MCP notification and clears pending', async () => {
    const notifications: Array<{ request_id: string; behavior: string }> = []
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: () => {},
      sendMcpNotification: (params) => void notifications.push(params),
    })
    bridge.handlePermissionRequest({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'x',
      input_preview: '{}',
    })

    const response = createEnvelope(
      'dashboard',
      'research',
      'permission-response',
      JSON.stringify({ request_id: 'abc12', behavior: 'allow' }),
    )
    bridge.handlePermissionResponseEnvelope(response)

    expect(notifications).toEqual([{ request_id: 'abc12', behavior: 'allow' }])
    expect(bridge.hasPending('abc12')).toBe(false)
  })

  test('unknown request_id is silently ignored', async () => {
    const notifications: Array<unknown> = []
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: () => {},
      sendMcpNotification: (params) => void notifications.push(params),
    })
    const response = createEnvelope(
      'dashboard',
      'research',
      'permission-response',
      JSON.stringify({ request_id: 'never-requested', behavior: 'allow' }),
    )
    bridge.handlePermissionResponseEnvelope(response)
    expect(notifications).toEqual([])
  })

  test('non-permission-response envelope type is ignored', async () => {
    const notifications: Array<unknown> = []
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: () => {},
      sendMcpNotification: (params) => void notifications.push(params),
    })
    const msg = createEnvelope('dashboard', 'research', 'message', 'hello')
    bridge.handlePermissionResponseEnvelope(msg)
    expect(notifications).toEqual([])
  })

  test('invalid JSON body does not throw', async () => {
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: () => {},
      sendMcpNotification: () => {},
    })
    const env = createEnvelope('dashboard', 'research', 'permission-response', '{not json')
    expect(() => bridge.handlePermissionResponseEnvelope(env)).not.toThrow()
  })
})
