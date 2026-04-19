import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildTranscript } from '../src/transcript.js'

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
