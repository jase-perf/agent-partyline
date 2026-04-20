import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('MCP server capabilities', async () => {
  test('server.ts declares claude/channel/permission capability', async () => {
    const source = readFileSync(resolve(import.meta.dir, '../src/server.ts'), 'utf8')
    expect(source).toContain("'claude/channel/permission': {}")
  })
})
