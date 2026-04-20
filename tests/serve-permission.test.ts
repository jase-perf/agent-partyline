import { test, expect, describe } from 'bun:test'
import { createEnvelope } from '../src/protocol.js'
import { buildPermissionRequestFrame } from '../dashboard/serve-helpers.js'

describe('buildPermissionRequestFrame', async () => {
  test('formats a permission-request envelope into a WS frame', async () => {
    const body = JSON.stringify({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"cmd":"ls"}',
    })
    const env = createEnvelope('research', 'dashboard', 'permission-request', body)
    const frame = buildPermissionRequestFrame(env)
    expect(frame).toEqual({
      type: 'permission-request',
      data: {
        session: 'research',
        request_id: 'abc12',
        tool_name: 'Bash',
        description: 'Run tests',
        input_preview: '{"cmd":"ls"}',
      },
    })
  })

  test('returns null for non-permission-request envelopes', async () => {
    const env = createEnvelope('a', 'b', 'message', 'hi')
    expect(buildPermissionRequestFrame(env)).toBeNull()
  })

  test('returns null if body is invalid JSON', async () => {
    const env = createEnvelope('a', 'dashboard', 'permission-request', '{bad')
    expect(buildPermissionRequestFrame(env)).toBeNull()
  })

  test('returns null if body is missing required fields', async () => {
    const env = createEnvelope(
      'a',
      'dashboard',
      'permission-request',
      JSON.stringify({ request_id: 'x' }),
    )
    expect(buildPermissionRequestFrame(env)).toBeNull()
  })
})
