import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildTranscript, filterAfterUuid } from '../src/transcript.js'

describe('buildTranscript', () => {
  let projectsRoot: string

  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), 'pl-transcript-'))
  })

  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true })
  })

  test('renders user + assistant-text + tool-use entries with tool_result merged', () => {
    const cwdDir = join(projectsRoot, '-home-x')
    mkdirSync(cwdDir, { recursive: true })

    const records = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt\n' },
        ],
      },
    ]

    writeFileSync(
      join(cwdDir, 'sess-1.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const entries = buildTranscript({ projectsRoot, sessionId: 'sess-1', limit: 100 })

    expect(entries.length).toBe(3)

    expect(entries[0]!.type).toBe('user')
    expect(entries[0]!.text).toBe('hi')

    expect(entries[1]!.type).toBe('assistant-text')
    expect(entries[1]!.text).toBe('Let me check.')

    expect(entries[2]!.type).toBe('tool-use')
    expect(entries[2]!.tool_name).toBe('Bash')
    expect((entries[2]!.tool_response as { content: string }).content).toBe('file.txt\n')
  })

  test('subagent-spawn marker', () => {
    const cwdDir = join(projectsRoot, '-home-x')
    const sessionSubDir = join(cwdDir, 'sess-1', 'subagents')
    mkdirSync(sessionSubDir, { recursive: true })

    const records = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu2',
            name: 'Agent',
            input: { subagent_type: 'Explore', prompt: 'find auth middleware' },
          },
        ],
      },
    ]

    writeFileSync(
      join(cwdDir, 'sess-1.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    writeFileSync(
      join(sessionSubDir, 'agent-abc.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'find auth middleware' }),
    )

    const entries = buildTranscript({ projectsRoot, sessionId: 'sess-1', limit: 100 })

    expect(entries.length).toBe(1)
    expect(entries[0]!.type).toBe('subagent-spawn')
    expect(entries[0]!.agent_type).toBe('Explore')
    expect(entries[0]!.description).toBe('find auth middleware')
  })

  test('reads subagent transcript when agentId is provided', () => {
    const cwdDir = join(projectsRoot, '-home-x')
    const sessionSubDir = join(cwdDir, 'sess-1', 'subagents')
    mkdirSync(sessionSubDir, { recursive: true })

    // Parent transcript (can be empty)
    writeFileSync(join(cwdDir, 'sess-1.jsonl'), '')

    // Subagent transcript
    const subRecords = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'subagent reply' }],
      },
    ]
    writeFileSync(
      join(sessionSubDir, 'agent-abc.jsonl'),
      subRecords.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const entries = buildTranscript({
      projectsRoot,
      sessionId: 'sess-1',
      agentId: 'abc',
      limit: 100,
    })

    expect(entries.length).toBe(1)
    expect(entries[0]!.type).toBe('assistant-text')
    expect(entries[0]!.text).toBe('subagent reply')
  })

  test('returns empty array when session file not found', () => {
    const entries = buildTranscript({ projectsRoot, sessionId: 'missing', limit: 100 })
    expect(entries).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // after_uuid filtering
  // ---------------------------------------------------------------------------

  test('after_uuid: returns only entries after the matching uuid', () => {
    const cwdDir = join(projectsRoot, '-home-x')
    mkdirSync(cwdDir, { recursive: true })

    const records = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      { role: 'user', content: 'third' },
    ]
    writeFileSync(
      join(cwdDir, 'sess-uuid.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const all = buildTranscript({ projectsRoot, sessionId: 'sess-uuid', limit: 100 })
    expect(all.length).toBe(3)

    // Filter after the 2nd entry
    const cutUuid = all[1]!.uuid
    const filtered = filterAfterUuid(all, cutUuid)
    expect(filtered.length).toBe(1)
    expect(filtered[0]!.text).toBe('third')
  })

  test('after_uuid: unknown uuid returns full transcript (graceful fallback)', () => {
    const cwdDir = join(projectsRoot, '-home-x')
    mkdirSync(cwdDir, { recursive: true })

    const records = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    ]
    writeFileSync(
      join(cwdDir, 'sess-fallback.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const all = buildTranscript({ projectsRoot, sessionId: 'sess-fallback', limit: 100 })
    const filtered = filterAfterUuid(all, 'does-not-exist')
    // Unknown uuid → return full transcript (same as all)
    expect(filtered.length).toBe(all.length)
  })

  test('after_uuid: matching last entry returns empty array', () => {
    const cwdDir = join(projectsRoot, '-home-x')
    mkdirSync(cwdDir, { recursive: true })

    const records = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]
    writeFileSync(
      join(cwdDir, 'sess-last.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const all = buildTranscript({ projectsRoot, sessionId: 'sess-last', limit: 100 })
    const lastUuid = all[all.length - 1]!.uuid
    const filtered = filterAfterUuid(all, lastUuid)
    expect(filtered.length).toBe(0)
  })

  test('after_uuid: envelopes past the cutoff are interleaved correctly', () => {
    const cwdSlug = '-home-x'
    const sessionId = 'sess-env-cut'
    const cwdDir = join(projectsRoot, cwdSlug)
    mkdirSync(cwdDir, { recursive: true })

    const records = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    ]
    writeFileSync(
      join(cwdDir, `${sessionId}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    // Envelopes need timestamps that sort *after* the JSONL entries.
    // buildTranscript assigns `ts = new Date().toISOString()` to JSONL records,
    // so use far-future timestamps to ensure envelopes sort last.
    const futureA = new Date(Date.now() + 60_000).toISOString()  // +1 minute
    const futureB = new Date(Date.now() + 120_000).toISOString() // +2 minutes

    const all = buildTranscript({
      projectsRoot,
      sessionId,
      sessionName: 'mySession',
      limit: 100,
      envelopes: [
        { id: 'env-a', from: 'mySession', to: 'other', type: 'message',
          body: 'hello', ts: futureA },
        { id: 'env-b', from: 'other', to: 'mySession', type: 'message',
          body: 'reply', ts: futureB },
      ],
    })
    // We have 2 JSONL entries + 2 envelopes = 4 (envelopes at the end)
    expect(all.some((e) => e.envelope_id === 'env-a')).toBe(true)
    expect(all.some((e) => e.envelope_id === 'env-b')).toBe(true)
    expect(all.length).toBe(4)

    // Cut after the 2nd JSONL entry (assistant-text) — both envelopes come after
    const cutUuid = all.find((e) => e.type === 'assistant-text')!.uuid
    const filtered = filterAfterUuid(all, cutUuid)
    // Should contain both envelopes (they're in positions 2 and 3 — after JSONL entries)
    expect(filtered.some((e) => e.envelope_id === 'env-a')).toBe(true)
    expect(filtered.some((e) => e.envelope_id === 'env-b')).toBe(true)
  })

  test('interleaves party-line send/receive entries when envelopes provided', () => {
    const cwdSlug = '-home-x'
    const sessionId = 'sess-1'
    const cwdDir = join(projectsRoot, cwdSlug)
    mkdirSync(cwdDir)
    writeFileSync(join(cwdDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-20T00:00:02Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }) + '\n',
    )

    const entries = buildTranscript({
      projectsRoot,
      sessionId,
      sessionName: 'work',
      limit: 100,
      envelopes: [
        { id: 'e1', from: 'work', to: 'research', type: 'request',
          body: 'find thing', ts: '2026-04-20T00:00:03Z', callback_id: 'cb1' },
        { id: 'e2', from: 'research', to: 'work', type: 'response',
          body: 'found', ts: '2026-04-20T00:00:05Z', response_to: 'cb1' },
      ],
    })

    expect(entries.some((e) => e.type === 'party-line-send' && e.other_session === 'research')).toBe(true)
    expect(entries.some((e) => e.type === 'party-line-receive' && e.other_session === 'research')).toBe(true)
  })
})
