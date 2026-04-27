/**
 * permission-bridge.test.ts — TTL + cap behavior for the pending map.
 *
 * The pending map is bounded by:
 *   - PENDING_CAP (256) entries; oldest evicted on overflow
 *   - PENDING_TTL_MS (5 min) per-entry; lazy eviction on insert + on read
 *
 * The cap is verified directly. The TTL is documented but not tested via
 * sleep (would be fragile and slow); manipulating Date.now globally is also
 * unsafe in the bun:test runner because parallel suites share process time.
 */

import { expect, test } from 'bun:test'
import { createPermissionBridge } from '../src/permission-bridge.js'

test('cap evicts oldest entries beyond 256', () => {
  const bridge = createPermissionBridge({
    sessionName: 'alice',
    sendEnvelope: () => {},
    sendMcpNotification: () => {},
  })
  for (let i = 0; i < 300; i++) {
    bridge.handlePermissionRequest({
      request_id: `r${i}`,
      tool_name: 'Bash',
      description: '',
      input_preview: '',
    })
  }
  // First 44 entries (300 - 256) should have been evicted.
  expect(bridge.hasPending('r0')).toBe(false)
  expect(bridge.hasPending('r43')).toBe(false)
  // Cap boundary — r44 is the oldest survivor.
  expect(bridge.hasPending('r44')).toBe(true)
  // Newest entry survives.
  expect(bridge.hasPending('r299')).toBe(true)
})

test('hasPending returns true for a fresh entry', () => {
  const bridge = createPermissionBridge({
    sessionName: 'alice',
    sendEnvelope: () => {},
    sendMcpNotification: () => {},
  })
  bridge.handlePermissionRequest({
    request_id: 'r1',
    tool_name: 'Bash',
    description: 'list files',
    input_preview: '{"command":"ls"}',
  })
  expect(bridge.hasPending('r1')).toBe(true)
  expect(bridge.hasPending('nonexistent')).toBe(false)
})

// TTL behavior is documented above. Intentionally not tested with sleep —
// see the file header for rationale.
