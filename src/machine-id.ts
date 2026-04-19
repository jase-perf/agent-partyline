import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'node:crypto'

export function getMachineId(path: string): string {
  if (existsSync(path)) {
    return readFileSync(path, 'utf-8').trim()
  }
  const id = randomUUID()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, id + '\n')
  return id
}
