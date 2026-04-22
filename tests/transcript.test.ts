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
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt\n' }],
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
    const futureA = new Date(Date.now() + 60_000).toISOString() // +1 minute
    const futureB = new Date(Date.now() + 120_000).toISOString() // +2 minutes

    const all = buildTranscript({
      projectsRoot,
      sessionId,
      sessionName: 'mySession',
      limit: 100,
      envelopes: [
        {
          id: 'env-a',
          from: 'mySession',
          to: 'other',
          type: 'message',
          body: 'hello',
          ts: futureA,
        },
        {
          id: 'env-b',
          from: 'other',
          to: 'mySession',
          type: 'message',
          body: 'reply',
          ts: futureB,
        },
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
    writeFileSync(
      join(cwdDir, `${sessionId}.jsonl`),
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
        {
          id: 'e1',
          from: 'work',
          to: 'research',
          type: 'request',
          body: 'find thing',
          ts: '2026-04-20T00:00:03Z',
          callback_id: 'cb1',
        },
        {
          id: 'e2',
          from: 'research',
          to: 'work',
          type: 'response',
          body: 'found',
          ts: '2026-04-20T00:00:05Z',
          response_to: 'cb1',
        },
      ],
    })

    expect(
      entries.some((e) => e.type === 'party-line-send' && e.other_session === 'research'),
    ).toBe(true)
    expect(
      entries.some((e) => e.type === 'party-line-receive' && e.other_session === 'research'),
    ).toBe(true)
  })

  test('dashboard-authored envelopes render as "user" turns so pre/post refresh match', () => {
    const cwdDir = join(projectsRoot, '-home-y')
    mkdirSync(cwdDir, { recursive: true })
    writeFileSync(join(cwdDir, 'sess-dash.jsonl'), '')

    const entries = buildTranscript({
      projectsRoot,
      sessionId: 'sess-dash',
      sessionName: 'partyline-dev',
      limit: 100,
      envelopes: [
        {
          id: 'edash1',
          from: 'dashboard',
          to: 'partyline-dev',
          type: 'message',
          body: 'hello from web',
          ts: '2026-04-22T09:00:00Z',
        },
      ],
    })
    expect(entries.length).toBe(1)
    expect(entries[0]!.type).toBe('user')
    expect((entries[0] as { text?: string }).text).toBe('hello from web')
    expect(entries[0]!.uuid).toBe('edash1')
  })

  test('drops JSONL user turns that are wholly a party-line <channel> wrapper', () => {
    const cwdDir = join(projectsRoot, '-home-z')
    mkdirSync(cwdDir, { recursive: true })
    const channelText =
      '<channel source="party-line" from="dashboard" to="me" type="message" message_id="abc">hi</channel>'
    const lines = [
      {
        type: 'user',
        message: { role: 'user', content: channelText },
        uuid: 'u-channel',
        timestamp: '2026-04-22T09:00:01Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: channelText }] },
        uuid: 'u-channel-array',
        timestamp: '2026-04-22T09:00:02Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: 'real user text' },
        uuid: 'u-real',
        timestamp: '2026-04-22T09:00:03Z',
      },
    ]
    writeFileSync(
      join(cwdDir, 'sess-ch.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    )

    const entries = buildTranscript({ projectsRoot, sessionId: 'sess-ch', limit: 100 })
    const userEntries = entries.filter((e) => e.type === 'user')
    expect(userEntries.length).toBe(1)
    expect((userEntries[0] as { text?: string }).text).toBe('real user text')
  })

  // ---------------------------------------------------------------------------
  // Bug 1: synthetic user entries (plugin-injected / tool descriptions) must
  // not render as real user-typed messages. Claude Code marks these with
  // isMeta: true at the top-level of the JSONL line, and some also carry
  // <system-reminder> wrappers in content.
  // ---------------------------------------------------------------------------

  test('filters out isMeta:true user entries (plugin-injected / synthetic)', () => {
    const cwdDir = join(projectsRoot, '-home-x')
    mkdirSync(cwdDir, { recursive: true })

    // Simulate the real Claude Code JSONL shape: top-level type/isMeta + nested message.
    const lines = [
      // Real user message
      {
        type: 'user',
        message: { role: 'user', content: 'What does this plugin do?' },
        uuid: 'u-real-1',
        timestamp: '2026-04-20T00:00:01Z',
      },
      // Assistant text reply (should survive)
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the answer.' }] },
        uuid: 'a-1',
        timestamp: '2026-04-20T00:00:02Z',
      },
      // Synthetic/meta user entry — plugin injecting a big skill description.
      // This should NOT render as a user-typed message.
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Base directory for this skill: /home/claude/.claude/plugins/' +
                'cache/claude-plugins-official/superpowers/5.0.7/skills/writing-plans\n' +
                '# Writing Plans\n## Overview\n' +
                'Write comprehensive implementation plans...' +
                'x'.repeat(5000),
            },
          ],
        },
        isMeta: true,
        uuid: 'u-meta-1',
        timestamp: '2026-04-20T00:00:03Z',
      },
      // Synthetic/meta user entry with a plain-string <system-reminder> content
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<system-reminder>Respond with just the action or changes.</system-reminder>',
        },
        isMeta: true,
        uuid: 'u-meta-2',
        timestamp: '2026-04-20T00:00:04Z',
      },
    ]

    writeFileSync(
      join(cwdDir, 'sess-meta.jsonl'),
      lines.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const entries = buildTranscript({ projectsRoot, sessionId: 'sess-meta', limit: 100 })

    // Only the real user message + assistant text should be rendered as normal.
    const userEntries = entries.filter((e) => e.type === 'user')
    expect(userEntries.length).toBe(1)
    expect(userEntries[0]!.text).toBe('What does this plugin do?')

    // The assistant text must still be present
    expect(
      entries.some((e) => e.type === 'assistant-text' && e.text === 'Here is the answer.'),
    ).toBe(true)

    // The giant skill description and system-reminder must NOT appear as user text.
    const bleed = entries.find(
      (e) => e.type === 'user' && typeof e.text === 'string' && e.text.includes('Writing Plans'),
    )
    expect(bleed).toBeUndefined()
    const sysReminderBleed = entries.find(
      (e) =>
        e.type === 'user' && typeof e.text === 'string' && e.text.includes('<system-reminder>'),
    )
    expect(sysReminderBleed).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // Bug 2: post-compaction ordering / stable identity.
  //
  // The dashboard's incremental-append logic relies on `after_uuid` + a
  // client-side set of rendered uuids. If uuids are randomly regenerated on
  // every buildTranscript call, incremental fetches can't dedup correctly —
  // especially after a compaction-triggered reset — and stale context
  // re-hydrated by plugins lands as "new" entries below the current message.
  //
  // Fix requires uuids (and timestamps) to be STABLE across repeated calls
  // on the same JSONL content.
  // ---------------------------------------------------------------------------

  test('buildTranscript produces stable uuids + timestamps across repeated calls', () => {
    const cwdDir = join(projectsRoot, '-home-x')
    mkdirSync(cwdDir, { recursive: true })

    const lines = [
      {
        type: 'user',
        message: { role: 'user', content: 'hi' },
        uuid: 'line-u1',
        timestamp: '2026-04-20T00:00:01Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        uuid: 'line-a1',
        timestamp: '2026-04-20T00:00:02Z',
      },
    ]
    writeFileSync(
      join(cwdDir, 'sess-stable.jsonl'),
      lines.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const first = buildTranscript({ projectsRoot, sessionId: 'sess-stable', limit: 100 })
    const second = buildTranscript({ projectsRoot, sessionId: 'sess-stable', limit: 100 })

    expect(first.length).toBe(2)
    expect(second.length).toBe(2)
    // uuids must be deterministic so the client's renderedEntryKeys dedup works
    expect(second[0]!.uuid).toBe(first[0]!.uuid)
    expect(second[1]!.uuid).toBe(first[1]!.uuid)
    // timestamps must come from the JSONL record, not Date.now()
    expect(first[0]!.ts).toBe('2026-04-20T00:00:01Z')
    expect(first[1]!.ts).toBe('2026-04-20T00:00:02Z')
  })

  test('after_uuid filtering works across two sequential buildTranscript calls (the incremental-fetch path)', () => {
    // This is the real scenario: client fetches once, remembers lastRenderedUuid,
    // then fetches again with ?after_uuid=<prev>. If uuids aren't stable, every
    // incremental fetch returns the full list and the client duplicates the
    // whole transcript below the existing DOM.
    const cwdDir = join(projectsRoot, '-home-x')
    mkdirSync(cwdDir, { recursive: true })

    const lines = [
      {
        type: 'user',
        message: { role: 'user', content: 'first turn' },
        uuid: 'line-1',
        timestamp: '2026-04-20T00:00:01Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'response' }] },
        uuid: 'line-2',
        timestamp: '2026-04-20T00:00:02Z',
      },
    ]
    writeFileSync(
      join(cwdDir, 'sess-incr.jsonl'),
      lines.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const firstBuild = buildTranscript({ projectsRoot, sessionId: 'sess-incr', limit: 100 })
    const lastRenderedUuid = firstBuild[firstBuild.length - 1]!.uuid

    // Simulate an incremental fetch using the uuid we remembered.
    const secondBuild = buildTranscript({ projectsRoot, sessionId: 'sess-incr', limit: 100 })
    const incremental = filterAfterUuid(secondBuild, lastRenderedUuid)

    // No new content → incremental slice is empty, NOT the full list.
    expect(incremental.length).toBe(0)
  })

  test('after compaction (file rewritten shorter), incremental fetch returns only post-compaction entries', () => {
    // Reporter's symptom: post-compaction, the dashboard sees the current
    // question at top, then 300 older entries re-rendered below. Root cause:
    // after compaction the file is a fresh set of records, and the client's
    // stale lastRenderedUuid from the OLD file is still sent up. The server's
    // filterAfterUuid returns the full list as graceful fallback — which is
    // correct — and the client must then re-render from scratch rather than
    // appending below existing content. This test pins down the server-side
    // contract: when after_uuid is unknown (stale across a rewrite), the
    // server returns the full post-compaction transcript with stable uuids,
    // and the client can safely replace its state with that list.
    const cwdDir = join(projectsRoot, '-home-x')
    mkdirSync(cwdDir, { recursive: true })

    // Pre-compaction transcript
    const preCompactLines = [
      {
        type: 'user',
        message: { role: 'user', content: 'old q1' },
        uuid: 'old-u1',
        timestamp: '2026-04-20T00:00:01Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'old a1' }] },
        uuid: 'old-a1',
        timestamp: '2026-04-20T00:00:02Z',
      },
      {
        type: 'user',
        message: { role: 'user', content: 'old q2' },
        uuid: 'old-u2',
        timestamp: '2026-04-20T00:00:03Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'old a2' }] },
        uuid: 'old-a2',
        timestamp: '2026-04-20T00:00:04Z',
      },
    ]
    writeFileSync(
      join(cwdDir, 'sess-compact.jsonl'),
      preCompactLines.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const preBuild = buildTranscript({ projectsRoot, sessionId: 'sess-compact', limit: 100 })
    const staleUuid = preBuild[preBuild.length - 1]!.uuid

    // Compaction: rewrite file with a fresh summary + current question
    const postCompactLines = [
      {
        type: 'user',
        message: { role: 'user', content: '[summary of previous conversation]' },
        uuid: 'new-summary',
        timestamp: '2026-04-20T00:05:00Z',
        isMeta: true,
      },
      {
        type: 'user',
        message: { role: 'user', content: 'the current question' },
        uuid: 'new-u1',
        timestamp: '2026-04-20T00:05:01Z',
      },
    ]
    writeFileSync(
      join(cwdDir, 'sess-compact.jsonl'),
      postCompactLines.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const postBuild = buildTranscript({ projectsRoot, sessionId: 'sess-compact', limit: 100 })
    // isMeta summary is filtered → only 'the current question' remains
    expect(postBuild.length).toBe(1)
    expect(postBuild[0]!.text).toBe('the current question')

    // Client sends after_uuid=<staleUuid from pre-compaction>. Server falls
    // back to full list (not found). Client MUST receive exactly the post-
    // compaction entries — no pre-compaction content.
    const incremental = filterAfterUuid(postBuild, staleUuid)
    expect(incremental.length).toBe(1)
    expect(incremental[0]!.text).toBe('the current question')

    // Must NOT contain any pre-compaction user text
    expect(incremental.some((e) => e.text === 'old q1' || e.text === 'old q2')).toBe(false)
  })

  test('filters tool_result content whose text is a <system-reminder> (no orphan user render)', () => {
    // Tool_result with <system-reminder> content arrives as a user entry with
    // content array holding a tool_result block. buildTranscript already merges
    // these with the pending tool_use — but we must not render them as a bare
    // user text block if the tool_use was missing (edge case from truncation).
    const cwdDir = join(projectsRoot, '-home-x')
    mkdirSync(cwdDir, { recursive: true })

    const lines = [
      // User entry carrying ONLY a tool_result whose tool_use_id is unknown
      // (orphaned — e.g., after compaction dropped the tool_use half).
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'missing-id',
              content: '<system-reminder>Warning: something happened.</system-reminder>',
            },
          ],
        },
        uuid: 'u-orphan-1',
        timestamp: '2026-04-20T00:00:01Z',
      },
    ]

    writeFileSync(
      join(cwdDir, 'sess-orphan.jsonl'),
      lines.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const entries = buildTranscript({ projectsRoot, sessionId: 'sess-orphan', limit: 100 })

    // Orphan tool_result must NOT leak into a user-typed entry.
    const userEntries = entries.filter((e) => e.type === 'user')
    expect(userEntries.length).toBe(0)
  })
})
