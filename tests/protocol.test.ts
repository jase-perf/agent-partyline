import { test, expect, describe } from 'bun:test'
import { createEnvelope, deserialize, serialize } from '../src/protocol.js'

describe('permission envelope types', async () => {
  test('permission-request envelope round-trips through serialize/deserialize', async () => {
    const body = JSON.stringify({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"command":"bun test"}',
    })
    const env = createEnvelope('research', 'dashboard', 'permission-request', body)
    const wire = serialize(env)
    const decoded = deserialize(wire)
    expect(decoded).not.toBeNull()
    expect(decoded!.type).toBe('permission-request')
    expect(decoded!.body).toBe(body)
  })

  test('permission-response envelope round-trips through serialize/deserialize', async () => {
    const body = JSON.stringify({ request_id: 'abc12', behavior: 'allow' })
    const env = createEnvelope('dashboard', 'research', 'permission-response', body)
    const wire = serialize(env)
    const decoded = deserialize(wire)
    expect(decoded).not.toBeNull()
    expect(decoded!.type).toBe('permission-response')
    expect(decoded!.body).toBe(body)
  })
})
