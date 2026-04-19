import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync, existsSync } from 'fs'
import { getMachineId } from '../src/machine-id.js'

const TEST_PATH = '/tmp/party-line-machine-id-test'

describe('getMachineId', () => {
  beforeEach(() => {
    if (existsSync(TEST_PATH)) rmSync(TEST_PATH)
  })

  test('creates a stable ID on first call', () => {
    const a = getMachineId(TEST_PATH)
    const b = getMachineId(TEST_PATH)
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9-]{36}$/)
  })
})
