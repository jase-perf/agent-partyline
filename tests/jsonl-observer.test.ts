import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlObserver } from '../src/observers/jsonl.js'

describe('JsonlObserver', () => {
  let dir: string
  let observers: JsonlObserver[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-jsonl-'))
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

  test('detects appended entries in a session transcript', async () => {
    const cwdDir = join(dir, '-home-test')
    mkdirSync(cwdDir)
    const f = join(cwdDir, 'session-abc.jsonl')
    // Seed file BEFORE start so first-sight offset ignores existing content
    writeFileSync(f, JSON.stringify({ type: 'user', text: 'hi' }) + '\n')

    const obs = makeObserver(50)
    const events: unknown[] = []
    obs.on((e) => events.push(e))
    await obs.start()

    // Wait for first scan to seed offsets
    await new Promise((r) => setTimeout(r, 100))

    // Now append — should be detected
    appendFileSync(f, JSON.stringify({ type: 'assistant', text: 'hello' }) + '\n')

    // Wait for next poll
    await new Promise((r) => setTimeout(r, 150))

    expect(events.length).toBe(1)
    const ev = events[0] as { session_id: string; entry: { type: string } }
    expect(ev.session_id).toBe('session-abc')
    expect(ev.entry.type).toBe('assistant')
  })

  test('discovers new session files appearing after start', async () => {
    const cwdDir = join(dir, '-home-test')
    mkdirSync(cwdDir)

    const obs = makeObserver(50)
    const events: unknown[] = []
    obs.on((e) => events.push(e))
    await obs.start()
    await new Promise((r) => setTimeout(r, 100))

    // Create new file AFTER observer started
    const f = join(cwdDir, 'session-new.jsonl')
    writeFileSync(f, JSON.stringify({ type: 'user', text: 'first' }) + '\n')

    await new Promise((r) => setTimeout(r, 100))
    appendFileSync(f, JSON.stringify({ type: 'assistant', text: 'reply' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))

    // Should have seen 'reply' but not 'first' (first-sight seed skips existing)
    const types = events.map((e) => (e as { entry: { type: string } }).entry.type)
    expect(types).toContain('assistant')
    expect(types).not.toContain('user')
  })

  test('tails subagent transcripts', async () => {
    const cwdDir = join(dir, '-home-test')
    const sessionSubdir = join(cwdDir, 'session-parent')
    const subagentsDir = join(sessionSubdir, 'subagents')
    mkdirSync(subagentsDir, { recursive: true })

    const subF = join(subagentsDir, 'agent-xyz.jsonl')
    writeFileSync(subF, JSON.stringify({ type: 'tool_use', name: 'Read' }) + '\n')

    const obs = makeObserver(50)
    const events: unknown[] = []
    obs.on((e) => events.push(e))
    await obs.start()
    await new Promise((r) => setTimeout(r, 100))

    appendFileSync(subF, JSON.stringify({ type: 'tool_result' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))

    expect(events.length).toBe(1)
    const ev = events[0] as { session_id: string; entry: { type: string } }
    expect(ev.session_id).toBe('agent-xyz')
    expect(ev.entry.type).toBe('tool_result')
  })

  test('handles large appended chunks', async () => {
    const cwdDir = join(dir, '-home-test')
    mkdirSync(cwdDir)
    const f = join(cwdDir, 'session-big.jsonl')
    writeFileSync(f, '')

    const obs = makeObserver(50)
    const events: unknown[] = []
    obs.on((e) => events.push(e))
    await obs.start()
    await new Promise((r) => setTimeout(r, 100))

    const big = 'x'.repeat(5000)
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ idx: i, big })
    ).join('\n') + '\n'
    appendFileSync(f, lines)

    await new Promise((r) => setTimeout(r, 150))
    expect(events.length).toBe(10)
  })

  test('ignores malformed JSONL lines without crashing', async () => {
    const cwdDir = join(dir, '-home-test')
    mkdirSync(cwdDir)
    const f = join(cwdDir, 'session-bad.jsonl')
    writeFileSync(f, '\n')

    const obs = makeObserver(50)
    const events: unknown[] = []
    obs.on((e) => events.push(e))
    await obs.start()
    await new Promise((r) => setTimeout(r, 100))

    appendFileSync(f, 'not json\n' + JSON.stringify({ type: 'ok' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))

    // Only the valid line emitted
    expect(events.length).toBe(1)
    expect((events[0] as { entry: { type: string } }).entry.type).toBe('ok')
  })
})
