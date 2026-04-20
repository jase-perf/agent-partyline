import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlObserver } from '../src/observers/jsonl.js'

describe('JsonlObserver — truncation handling', () => {
  let dir: string
  let observers: JsonlObserver[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-jsonl-trunc-'))
  })

  afterEach(() => {
    for (const obs of observers) obs.stop()
    observers = []
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* no-op */ }
  })

  function makeObserver(pollMs = 50): JsonlObserver {
    const obs = new JsonlObserver(dir, pollMs)
    observers.push(obs)
    return obs
  }

  test('emits stream-reset when file shrinks, then recovers to tail new content', async () => {
    const cwdDir = join(dir, '-home-test')
    mkdirSync(cwdDir)
    const f = join(cwdDir, 'session-trunc.jsonl')

    // Seed file before observer start so first-sight skips existing content.
    // Use a large initial file so a replacement with a shorter one will shrink.
    const bigLine = JSON.stringify({ type: 'old', idx: 1, data: 'x'.repeat(200) }) + '\n'
    writeFileSync(f, bigLine)

    const obs = makeObserver(50)
    const events: unknown[] = []
    const resets: string[] = []

    obs.on((e) => events.push(e))
    obs.onReset((filePath) => resets.push(filePath))
    await obs.start()

    // Wait for first scan to seed offsets
    await new Promise((r) => setTimeout(r, 100))

    // Replace the file with shorter content (simulate compaction)
    writeFileSync(f, JSON.stringify({ type: 'compact' }) + '\n')

    // Wait for the shrink to be detected
    await new Promise((r) => setTimeout(r, 150))

    // Should have emitted a stream-reset signal for this path
    expect(resets.length).toBeGreaterThan(0)
    expect(resets[0]).toBe(f)

    // Now append more content — should be tailed normally
    appendFileSync(f, JSON.stringify({ type: 'appended', idx: 2 }) + '\n')
    await new Promise((r) => setTimeout(r, 150))

    // The appended entry should be picked up
    const appendedEvents = events.filter(
      (e) => (e as { entry: { type: string } }).entry.type === 'appended',
    )
    expect(appendedEvents.length).toBe(1)
  })

  test('normal append after truncation emits new entries without re-emitting old content', async () => {
    const cwdDir = join(dir, '-home-test')
    mkdirSync(cwdDir)
    const f = join(cwdDir, 'session-trunc2.jsonl')

    // Write initial content (5 large lines) so replacement with 1 short line shrinks the file
    const initialLines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ type: 'pre-compact', idx: i, data: 'x'.repeat(100) }),
    ).join('\n') + '\n'
    writeFileSync(f, initialLines)

    const obs = makeObserver(50)
    const events: unknown[] = []
    obs.on((e) => events.push(e))
    await obs.start()

    // Wait for first scan (seeds offset to current size)
    await new Promise((r) => setTimeout(r, 100))

    // Truncate to a single new line (compaction replaced file)
    writeFileSync(f, JSON.stringify({ type: 'compact-summary', idx: 0 }) + '\n')
    await new Promise((r) => setTimeout(r, 150))

    // Append 2 new lines post-truncation
    appendFileSync(f, JSON.stringify({ type: 'post-compact', idx: 1 }) + '\n')
    appendFileSync(f, JSON.stringify({ type: 'post-compact', idx: 2 }) + '\n')
    await new Promise((r) => setTimeout(r, 150))

    // Should have received the post-compact entries (not the pre-compact ones)
    const postCompactEvents = events.filter(
      (e) => (e as { entry: { type: string } }).entry.type === 'post-compact',
    )
    expect(postCompactEvents.length).toBeGreaterThanOrEqual(1)

    // Must NOT re-emit pre-compact content
    const preCompactEvents = events.filter(
      (e) => (e as { entry: { type: string } }).entry.type === 'pre-compact',
    )
    expect(preCompactEvents.length).toBe(0)
  })
})
