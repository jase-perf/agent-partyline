import { test, expect, describe } from 'bun:test'
import { createEnvelope } from '../src/protocol.js'
import {
  buildPermissionRequestFrame,
  validatePermissionResponseBody,
  buildPermissionResponseEnvelope,
  buildDismissFrame,
} from '../dashboard/serve-helpers.js'

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

describe('permission response validation', async () => {
  test('accepts valid allow body', async () => {
    const result = validatePermissionResponseBody({
      session: 'research',
      request_id: 'abc12',
      behavior: 'allow',
    })
    expect(result.ok).toBe(true)
  })

  test('accepts valid deny body', async () => {
    const result = validatePermissionResponseBody({
      session: 'research',
      request_id: 'abc12',
      behavior: 'deny',
    })
    expect(result.ok).toBe(true)
  })

  test('rejects missing session', async () => {
    const result = validatePermissionResponseBody({ request_id: 'a', behavior: 'allow' })
    expect(result.ok).toBe(false)
  })

  test('rejects invalid behavior', async () => {
    const result = validatePermissionResponseBody({
      session: 'r',
      request_id: 'a',
      behavior: 'maybe',
    })
    expect(result.ok).toBe(false)
  })
})

describe('buildPermissionResponseEnvelope', async () => {
  test('constructs UDP envelope addressed to the target session', async () => {
    const env = buildPermissionResponseEnvelope({
      from: 'dashboard',
      session: 'research',
      request_id: 'abc12',
      behavior: 'allow',
    })
    expect(env.type).toBe('permission-response')
    expect(env.from).toBe('dashboard')
    expect(env.to).toBe('research')
    expect(JSON.parse(env.body)).toEqual({ request_id: 'abc12', behavior: 'allow' })
  })
})

describe('buildDismissFrame', async () => {
  test('formats a notification-dismiss frame', async () => {
    const frame = buildDismissFrame('research')
    expect(frame).toEqual({
      type: 'notification-dismiss',
      data: { session: 'research' },
    })
  })
})
