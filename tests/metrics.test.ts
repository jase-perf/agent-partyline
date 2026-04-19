import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync } from 'fs'
import { openDb } from '../src/storage/db.js'
import { insertEvent } from '../src/storage/queries.js'
import { rollupDailyMetrics, hourlyToolCalls } from '../src/storage/metrics.js'

const DB = '/tmp/party-line-metrics-test.db'

describe('metrics rollup', () => {
  beforeEach(() => { try { rmSync(DB) } catch { /* no-op */ } })

  test('rollupDailyMetrics aggregates past days', () => {
    const db = openDb(DB)
    // Events on 2026-04-18 (two days ago relative to 2026-04-20)
    insertEvent(db, { machine_id: 'm', session_name: 'a', session_id: 's1', hook_event: 'PostToolUse', ts: '2026-04-18T10:00:00Z', payload: {} })
    insertEvent(db, { machine_id: 'm', session_name: 'a', session_id: 's1', hook_event: 'PostToolUse', ts: '2026-04-18T11:00:00Z', payload: {} })
    insertEvent(db, { machine_id: 'm', session_name: 'a', session_id: 's1', hook_event: 'SubagentStart', ts: '2026-04-18T12:00:00Z', payload: {}, agent_id: 'a1' })
    insertEvent(db, { machine_id: 'm', session_name: 'a', session_id: 's1', hook_event: 'UserPromptSubmit', ts: '2026-04-18T12:30:00Z', payload: {} })
    // Event today should be excluded
    insertEvent(db, { machine_id: 'm', session_name: 'a', session_id: 's1', hook_event: 'PostToolUse', ts: '2026-04-20T10:00:00Z', payload: {} })

    const rowsInserted = rollupDailyMetrics(db, new Date('2026-04-20T12:00:00Z'))
    expect(rowsInserted).toBe(1) // one row for 2026-04-18, session s1

    const metrics = db.query<{ tool_calls: number; subagents_spawned: number; turns: number }, []>(
      "SELECT tool_calls, subagents_spawned, turns FROM metrics_daily WHERE day='2026-04-18'"
    ).all()
    expect(metrics.length).toBe(1)
    expect(metrics[0]!.tool_calls).toBe(2)
    expect(metrics[0]!.subagents_spawned).toBe(1)
    expect(metrics[0]!.turns).toBe(1)
    db.close()
  })

  test('rollupDailyMetrics idempotent — second run adds zero rows', () => {
    const db = openDb(DB)
    insertEvent(db, { machine_id: 'm', session_name: 'a', session_id: 's1', hook_event: 'PostToolUse', ts: '2026-04-18T10:00:00Z', payload: {} })
    rollupDailyMetrics(db, new Date('2026-04-20T12:00:00Z'))
    const second = rollupDailyMetrics(db, new Date('2026-04-20T12:00:00Z'))
    expect(second).toBe(0)
    db.close()
  })

  test('hourlyToolCalls returns 24-slot array with recent events', () => {
    const db = openDb(DB)
    const now = new Date()
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()
    insertEvent(db, { machine_id: 'm', session_name: 'a', session_id: 's1', hook_event: 'PostToolUse', ts: oneHourAgo, payload: {} })
    insertEvent(db, { machine_id: 'm', session_name: 'a', session_id: 's1', hook_event: 'PostToolUse', ts: oneHourAgo, payload: {} })
    insertEvent(db, { machine_id: 'm', session_name: 'a', session_id: 's1', hook_event: 'PostToolUse', ts: twoHoursAgo, payload: {} })
    const buckets = hourlyToolCalls(db, 's1')
    expect(buckets.length).toBe(24)
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(3)
    db.close()
  })
})
