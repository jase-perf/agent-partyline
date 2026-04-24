import { describe, test, expect } from 'bun:test'
import {
  groupSequentialToolCalls,
  summarizeToolGroup,
  shouldExtendToolRun,
  TOOL_GROUP_MIN_RUN,
  type GroupedItem,
  type TranscriptEntryLike,
} from '../dashboard/transcript-grouping.js'

const tool = (name: string): TranscriptEntryLike => ({ type: 'tool-use', tool_name: name })
const text = (kind: 'user' | 'assistant-text', body = 'hi'): TranscriptEntryLike => ({
  type: kind,
  text: body,
})
const spawn = (id = 'a1'): TranscriptEntryLike => ({ type: 'subagent-spawn', agent_id: id })
const plSend = (): TranscriptEntryLike => ({ type: 'party-line-send', body: 'x' })
const plRecv = (): TranscriptEntryLike => ({ type: 'party-line-receive', body: 'y' })

describe('groupSequentialToolCalls', () => {
  test('empty / non-array input returns empty array', () => {
    expect(groupSequentialToolCalls([])).toEqual([])
    // @ts-expect-error — test runtime tolerance for bad input
    expect(groupSequentialToolCalls(null)).toEqual([])
    // @ts-expect-error
    expect(groupSequentialToolCalls(undefined)).toEqual([])
  })

  test('single tool call is NOT wrapped (no value in hiding one)', () => {
    const res = groupSequentialToolCalls([text('user'), tool('Bash'), text('assistant-text')])
    expect(res.map((g) => g.kind)).toEqual(['entry', 'entry', 'entry'])
    expect((res[1] as { kind: 'entry'; entry: TranscriptEntryLike }).entry.type).toBe('tool-use')
  })

  test('a run of 2 tool calls IS wrapped (matches TOOL_GROUP_MIN_RUN)', () => {
    expect(TOOL_GROUP_MIN_RUN).toBe(2)
    const res = groupSequentialToolCalls([tool('Bash'), tool('Read')])
    expect(res).toHaveLength(1)
    const first = res[0]!
    expect(first.kind).toBe('tool-group')
    if (first.kind === 'tool-group') {
      expect(first.entries.map((e: TranscriptEntryLike) => e.tool_name)).toEqual(['Bash', 'Read'])
    }
  })

  test('a run of 5 tool calls is wrapped as one group', () => {
    const res = groupSequentialToolCalls([
      tool('Bash'),
      tool('Read'),
      tool('Edit'),
      tool('Read'),
      tool('Bash'),
    ])
    expect(res).toHaveLength(1)
    const first = res[0]!
    expect(first.kind).toBe('tool-group')
    if (first.kind === 'tool-group') {
      expect(first.entries).toHaveLength(5)
    }
  })

  test('user / assistant-text break a run', () => {
    const res = groupSequentialToolCalls([
      tool('Bash'),
      tool('Read'),
      text('assistant-text'),
      tool('Edit'),
      tool('Glob'),
    ])
    expect(res.map((g) => g.kind)).toEqual(['tool-group', 'entry', 'tool-group'])
  })

  test('subagent-spawn breaks a run', () => {
    const res = groupSequentialToolCalls([tool('Bash'), tool('Read'), spawn(), tool('Edit')])
    expect(res.map((g) => g.kind)).toEqual(['tool-group', 'entry', 'entry'])
  })

  test('party-line entries break a run', () => {
    const res = groupSequentialToolCalls([
      tool('Bash'),
      tool('Read'),
      plSend(),
      tool('Edit'),
      tool('Glob'),
      plRecv(),
      tool('Bash'),
    ])
    expect(res.map((g) => g.kind)).toEqual(['tool-group', 'entry', 'tool-group', 'entry', 'entry'])
  })

  test('preserves entry order within and across groups', () => {
    const entries: TranscriptEntryLike[] = [
      text('user', 'hello'),
      text('assistant-text', 'thinking'),
      tool('Bash'),
      tool('Read'),
      tool('Edit'),
      text('assistant-text', 'done'),
    ]
    const res = groupSequentialToolCalls(entries)
    expect(res).toHaveLength(4)
    // Entries 0, 1: plain
    expect(res[0]).toEqual({ kind: 'entry', entry: entries[0]! })
    expect(res[1]).toEqual({ kind: 'entry', entry: entries[1]! })
    // Group of 3
    const grouped = res[2]!
    expect(grouped.kind).toBe('tool-group')
    if (grouped.kind === 'tool-group') {
      expect(grouped.entries).toEqual([entries[2]!, entries[3]!, entries[4]!])
    }
    // Trailing assistant
    expect(res[3]).toEqual({ kind: 'entry', entry: entries[5]! })
  })

  test('does not mutate input array', () => {
    const entries: TranscriptEntryLike[] = [tool('Bash'), tool('Read')]
    const before = JSON.stringify(entries)
    groupSequentialToolCalls(entries)
    expect(JSON.stringify(entries)).toBe(before)
  })

  test('trailing tool-run is flushed', () => {
    const res = groupSequentialToolCalls([text('user'), tool('Bash'), tool('Read')])
    expect(res.map((g) => g.kind)).toEqual(['entry', 'tool-group'])
  })

  test('leading tool-run is wrapped', () => {
    const res = groupSequentialToolCalls([tool('Bash'), tool('Read'), text('assistant-text')])
    expect(res.map((g) => g.kind)).toEqual(['tool-group', 'entry'])
  })
})

describe('summarizeToolGroup', () => {
  test('joins names with comma+space', () => {
    expect(summarizeToolGroup([tool('Bash'), tool('Read'), tool('Edit')])).toBe('Bash, Read, Edit')
  })

  test('falls back to ? for entries with no tool_name', () => {
    expect(summarizeToolGroup([tool('Bash'), { type: 'tool-use' }])).toBe('Bash, ?')
  })

  test('truncates long lists with ellipsis', () => {
    const many = new Array(12).fill(0).map((_, i) => tool('T' + i))
    const res = summarizeToolGroup(many, 5)
    expect(res).toBe('T0, T1, T2, T3, T4, …')
  })

  test('empty input returns empty string', () => {
    expect(summarizeToolGroup([])).toBe('')
  })
})

describe('shouldExtendToolRun', () => {
  test('returns true when tail and new entries are both tool-use', () => {
    expect(shouldExtendToolRun(tool('Bash'), tool('Read'))).toBe(true)
  })

  test('returns false when tail is not tool-use', () => {
    expect(shouldExtendToolRun(text('assistant-text'), tool('Bash'))).toBe(false)
    expect(shouldExtendToolRun(spawn(), tool('Bash'))).toBe(false)
    expect(shouldExtendToolRun(plRecv(), tool('Bash'))).toBe(false)
  })

  test('returns false when new entry is not tool-use', () => {
    expect(shouldExtendToolRun(tool('Bash'), text('user'))).toBe(false)
  })

  test('returns false for null / undefined tail', () => {
    expect(shouldExtendToolRun(null, tool('Bash'))).toBe(false)
    expect(shouldExtendToolRun(undefined, tool('Bash'))).toBe(false)
  })
})

// Smoke check that GroupedItem narrowing works in TS.
const _typecheck: GroupedItem[] = groupSequentialToolCalls([tool('Bash'), tool('Read')])
void _typecheck
