import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GeminiTranscriptObserver } from '../src/observers/gemini-transcript.js'

describe('GeminiTranscriptObserver', () => {
  let dir: string
  let observers: GeminiTranscriptObserver[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-gem-'))
  })
  afterEach(() => {
    for (const obs of observers) obs.stop()
    observers = []
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* no-op */ }
  })

  function makeObserver(pollMs = 50): GeminiTranscriptObserver {
    const obs = new GeminiTranscriptObserver(dir, pollMs)
    observers.push(obs)
    return obs
  }

  function writeTranscript(path: string, sessionId: string, messages: unknown[]): void {
    writeFileSync(
      path,
      JSON.stringify({ sessionId, startTime: '2026-04-20T00:00:00Z', messages }),
    )
  }

  test('emits only new messages appended after first sight', async () => {
    const chatsDir = join(dir, 'proj-hash', 'chats')
    mkdirSync(chatsDir, { recursive: true })
    const f = join(chatsDir, 'session-abc.json')
    writeTranscript(f, 'abc', [{ id: 'm1', type: 'user', content: 'hi' }])

    const obs = makeObserver(50)
    const events: unknown[] = []
    obs.on((e) => events.push(e))
    await obs.start()
    await new Promise((r) => setTimeout(r, 100))

    // Append a new message
    writeTranscript(f, 'abc', [
      { id: 'm1', type: 'user', content: 'hi' },
      { id: 'm2', type: 'gemini', content: 'hello' },
    ])
    await new Promise((r) => setTimeout(r, 150))

    expect(events.length).toBe(1)
    const ev = events[0] as { session_id: string; entry: { type: string }; source: string }
    expect(ev.session_id).toBe('abc')
    expect(ev.entry.type).toBe('gemini')
    expect(ev.source).toBe('gemini-cli')
  })

  test('discovers new session files after start', async () => {
    mkdirSync(join(dir, 'proj-hash', 'chats'), { recursive: true })
    const obs = makeObserver(50)
    const events: unknown[] = []
    obs.on((e) => events.push(e))
    await obs.start()
    await new Promise((r) => setTimeout(r, 100))

    const f = join(dir, 'proj-hash', 'chats', 'session-new.json')
    writeTranscript(f, 'new-session', [{ id: 'm1', type: 'user', content: 'a' }])
    await new Promise((r) => setTimeout(r, 100))
    writeTranscript(f, 'new-session', [
      { id: 'm1', type: 'user', content: 'a' },
      { id: 'm2', type: 'gemini', content: 'b' },
    ])
    await new Promise((r) => setTimeout(r, 150))

    // Only m2 should be emitted — m1 is seed content
    const types = events.map((e) => (e as { entry: { type: string } }).entry.type)
    expect(types).toContain('gemini')
    expect(types).not.toContain('user')
  })

  test('handles malformed JSON without crashing', async () => {
    mkdirSync(join(dir, 'proj-hash', 'chats'), { recursive: true })
    const f = join(dir, 'proj-hash', 'chats', 'session-bad.json')
    writeFileSync(f, 'not json at all')

    const obs = makeObserver(50)
    const events: unknown[] = []
    obs.on((e) => events.push(e))
    await obs.start()
    await new Promise((r) => setTimeout(r, 150))

    // Now write valid content
    writeTranscript(f, 'bad', [
      { id: 'm1', type: 'gemini', content: 'valid' },
    ])
    await new Promise((r) => setTimeout(r, 150))

    // First sight of valid content should seed (no emit); still no crash
    expect(events.length).toBe(0)
  })
})
