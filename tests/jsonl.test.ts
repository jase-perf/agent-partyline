import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlObserver } from '../src/observers/jsonl'

describe('JsonlObserver in-flight guard', () => {
  test('concurrent scan() calls do not double-emit lines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jsonl-test-'))
    const slug = 'abc123'
    mkdirSync(join(root, slug))
    const file = join(root, slug, 'sess1.jsonl')
    writeFileSync(file, '')

    const obs = new JsonlObserver(root, 5000) // long interval, we call scan manually
    const emitted: string[] = []
    obs.on((u) => emitted.push(JSON.stringify(u.entry)))

    await obs.start()

    // Seed the offset: first scan sees empty file, sets offset=0
    // eslint-disable-next-line @typescript-eslint/dot-notation
    obs['scan']()

    // Now write a line and call scan twice — simulates interval overlap
    writeFileSync(file, '{"type":"user","ts":"2024-01-01T00:00:00Z"}\n')
    // eslint-disable-next-line @typescript-eslint/dot-notation
    obs['scan']()
    // eslint-disable-next-line @typescript-eslint/dot-notation
    obs['scan']()

    expect(emitted).toHaveLength(1)
    obs.stop()
  })
})
