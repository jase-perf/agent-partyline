import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createPermissionBridge } from '../src/permission-bridge.js'
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
