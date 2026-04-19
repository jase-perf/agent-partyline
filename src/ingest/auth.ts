import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { dirname } from 'path'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) return readFileSync(path, 'utf-8').trim()
  const token = randomBytes(32).toString('hex')
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, token + '\n', { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another caller beat us — read their token instead.
      return readFileSync(path, 'utf-8').trim()
    }
    throw err
  }
  chmodSync(path, 0o600)
  return token
}

export function verifyToken(expected: string, received: string | null | undefined): boolean {
  if (typeof received !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
