import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync } from 'fs'
import { openDb } from '../src/storage/db.js'
import { Aggregator } from '../src/aggregator.js'

const DB = '/tmp/party-line-agg-test.db'

describe('Aggregator', () => {
  beforeEach(() => {
    try {
      rmSync(DB)
    } catch {
      /* no-op */
    }
  })

  test('SessionStart event creates a session row with idle state', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm1',
      session_name: 'work',
      session_id: 's1',
      hook_event: 'SessionStart',
      ts: '2026-04-19T12:00:00Z',
      payload: { cwd: '/home/x' },
    })
    const s = agg.getSession('s1')
    expect(s?.name).toBe('work')
    expect(s?.state).toBe('idle')
    db.close()
  })

  test('PostToolUse transitions to working; Stop to idle', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SessionStart',
      ts: 't1',
      payload: {},
    })
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'PostToolUse',
      ts: 't2',
      payload: { tool_name: 'Bash' },
    })
    expect(agg.getSession('s')?.state).toBe('working')
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'Stop',
      ts: 't3',
      payload: {},
    })
    expect(agg.getSession('s')?.state).toBe('idle')
    db.close()
  })

  test('SubagentStart records a subagent row with running status', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SubagentStart',
      ts: 't',
      payload: { description: 'find thing' },
      agent_id: 'a1',
      agent_type: 'Explore',
    })
    const subs = agg.getSubagents('s')
    expect(subs.length).toBe(1)
    expect(subs[0]!.status).toBe('running')
    expect(subs[0]!.agent_type).toBe('Explore')
    expect(subs[0]!.description).toBe('find thing')
    db.close()
  })

  test('SubagentStop marks subagent completed with ended_at', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SubagentStart',
      ts: 't1',
      payload: {},
      agent_id: 'a1',
      agent_type: 'Explore',
    })
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SubagentStop',
      ts: 't2',
      payload: {},
      agent_id: 'a1',
    })
    const subs = agg.getSubagents('s')
    expect(subs[0]!.status).toBe('completed')
    expect(subs[0]!.ended_at).toBe('t2')
    db.close()
  })

  test('PostToolUse records a tool_call with success=1 by default', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'PostToolUse',
      ts: 't',
      payload: { tool_name: 'Bash', tool_response: { stdout: 'ok' } },
    })
    const rows = db
      .query<
        { tool_name: string; success: number; session_id: string },
        []
      >('SELECT tool_name, success, session_id FROM tool_calls')
      .all()
    expect(rows.length).toBe(1)
    expect(rows[0]!.tool_name).toBe('Bash')
    expect(rows[0]!.success).toBe(1)
    db.close()
  })

  test('PostToolUse with tool_response.success=false records failure', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'PostToolUse',
      ts: 't',
      payload: { tool_name: 'Write', tool_response: { success: false, error: 'denied' } },
    })
    const rows = db.query<{ success: number }, []>('SELECT success FROM tool_calls').all()
    expect(rows[0]!.success).toBe(0)
    db.close()
  })

  test('PostToolUse with tool_response.isError=true records failure', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'PostToolUse',
      ts: 't',
      payload: { tool_name: 'Read', tool_response: { isError: true, content: [] } },
    })
    const rows = db.query<{ success: number }, []>('SELECT success FROM tool_calls').all()
    expect(rows[0]!.success).toBe(0)
    db.close()
  })

  test('onUpdate listener fires with the updated session row', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    const updates: unknown[] = []
    agg.onUpdate((s) => updates.push(s))
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SessionStart',
      ts: 't',
      payload: {},
    })
    expect(updates.length).toBe(1)
    expect((updates[0] as { session_id: string }).session_id).toBe('s')
    db.close()
  })

  test('listSessions returns sessions ordered by last_seen desc', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'first',
      session_id: 's1',
      hook_event: 'SessionStart',
      ts: '2026-04-20T10:00:00Z',
      payload: {},
    })
    agg.ingest({
      machine_id: 'm',
      session_name: 'second',
      session_id: 's2',
      hook_event: 'SessionStart',
      ts: '2026-04-20T11:00:00Z',
      payload: {},
    })
    const list = agg.listSessions()
    expect(list.length).toBe(2)
    expect(list[0]!.session_id).toBe('s2') // most recent first
    expect(list[1]!.session_id).toBe('s1')
    db.close()
  })

  test('aggregator reads source from ev.source', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'gem',
      session_id: 'gem-1',
      hook_event: 'Stop',
      ts: 't',
      payload: {},
      source: 'gemini-cli',
    })
    const s = agg.getSession('gem-1')
    expect(s?.source).toBe('gemini-cli')
    db.close()
  })

  test('aggregator reads source from payload.source when ev.source absent', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'gem2',
      session_id: 'gem-2',
      hook_event: 'Stop',
      ts: 't',
      payload: { source: 'gemini-cli' },
    })
    const s = agg.getSession('gem-2')
    expect(s?.source).toBe('gemini-cli')
    db.close()
  })

  test('aggregator defaults source to claude-code when neither present', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'cc',
      session_id: 'cc-1',
      hook_event: 'Stop',
      ts: 't',
      payload: {},
    })
    const s = agg.getSession('cc-1')
    expect(s?.source).toBe('claude-code')
    db.close()
  })

  test('parent UserPromptSubmit cancels running subagents of that session', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SubagentStart',
      ts: 't1',
      payload: {},
      agent_id: 'a1',
      agent_type: 'general-purpose',
    })
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'UserPromptSubmit',
      ts: 't2',
      payload: {},
    })
    const subs = agg.getSubagents('s')
    expect(subs[0]!.status).toBe('cancelled')
    expect(subs[0]!.ended_at).toBe('t2')
    db.close()
  })

  test('parent SessionStart cancels stale running subagents of that session', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SubagentStart',
      ts: 't1',
      payload: {},
      agent_id: 'a1',
      agent_type: 'Explore',
    })
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SessionStart',
      ts: 't2',
      payload: {},
    })
    expect(agg.getSubagents('s')[0]!.status).toBe('cancelled')
    db.close()
  })

  test('parent SessionEnd cancels running subagents of that session', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SubagentStart',
      ts: 't1',
      payload: {},
      agent_id: 'a1',
      agent_type: 'Explore',
    })
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SessionEnd',
      ts: 't2',
      payload: {},
    })
    expect(agg.getSubagents('s')[0]!.status).toBe('cancelled')
    db.close()
  })

  test('subagent-sourced UserPromptSubmit does NOT cancel siblings', () => {
    // A subagent running Claude Code internally fires its own UserPromptSubmit.
    // That event arrives tagged with agent_id — it must not cancel the
    // parent's other running subagents.
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SubagentStart',
      ts: 't1',
      payload: {},
      agent_id: 'a1',
      agent_type: 'general-purpose',
    })
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'SubagentStart',
      ts: 't2',
      payload: {},
      agent_id: 'a2',
      agent_type: 'general-purpose',
    })
    // Inner UserPromptSubmit from subagent a1
    agg.ingest({
      machine_id: 'm',
      session_name: 'w',
      session_id: 's',
      hook_event: 'UserPromptSubmit',
      ts: 't3',
      payload: {},
      agent_id: 'a1',
    })
    const subs = agg.getSubagents('s')
    expect(subs.every((sa) => sa.status === 'running')).toBe(true)
    db.close()
  })

  test('cancellation only touches the session_id that fired, not other sessions', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm',
      session_name: 'a',
      session_id: 's1',
      hook_event: 'SubagentStart',
      ts: 't1',
      payload: {},
      agent_id: 'a1',
      agent_type: 'Explore',
    })
    agg.ingest({
      machine_id: 'm',
      session_name: 'b',
      session_id: 's2',
      hook_event: 'SubagentStart',
      ts: 't1',
      payload: {},
      agent_id: 'a2',
      agent_type: 'Explore',
    })
    agg.ingest({
      machine_id: 'm',
      session_name: 'a',
      session_id: 's1',
      hook_event: 'UserPromptSubmit',
      ts: 't2',
      payload: {},
    })
    expect(agg.getSubagents('s1')[0]!.status).toBe('cancelled')
    expect(agg.getSubagents('s2')[0]!.status).toBe('running')
    db.close()
  })
})
