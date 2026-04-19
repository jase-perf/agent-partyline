import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync, existsSync, statSync } from 'fs'
import { loadOrCreateToken, verifyToken } from '../src/ingest/auth.js'

const TEST_PATH = '/tmp/party-line-token-test'

describe('ingest auth', () => {
  beforeEach(() => {
    if (existsSync(TEST_PATH)) rmSync(TEST_PATH)
  })

  test('token persists across calls', () => {
    const a = loadOrCreateToken(TEST_PATH)
    const b = loadOrCreateToken(TEST_PATH)
    expect(a).toBe(b)
    expect(a.length).toBe(64) // 32 bytes hex-encoded
  })

  test('verifyToken accepts matching and rejects otherwise', () => {
    const t = loadOrCreateToken(TEST_PATH)
    expect(verifyToken(t, t)).toBe(true)
    expect(verifyToken(t, 'wrong')).toBe(false)
    expect(verifyToken(t, null)).toBe(false)
  })

  test('token file is created with 0600 perms', () => {
    loadOrCreateToken(TEST_PATH)
    const mode = statSync(TEST_PATH).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
