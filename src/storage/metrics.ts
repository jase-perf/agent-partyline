import type { Database } from 'bun:sqlite'

export interface DailyMetrics {
  day: string            // YYYY-MM-DD (UTC)
  session_id: string
  tool_calls: number
  subagents_spawned: number
  turns: number
}

/**
 * Roll up metrics for every day between the latest rolled-up day and yesterday.
 * Idempotent — re-running on the same day is a no-op once that day is rolled up.
 * Today is never rolled up (still active).
 */
export function rollupDailyMetrics(db: Database, today: Date = new Date()): number {
  const todayStr = today.toISOString().slice(0, 10)
  // Find the latest day we've already rolled up
  const latestRow = db
    .query<{ day: string | null }, []>('SELECT MAX(day) as day FROM metrics_daily')
    .get()
  const earliestEventRow = db
    .query<{ ts: string | null }, []>('SELECT MIN(ts) as ts FROM events')
    .get()
  if (!earliestEventRow?.ts) return 0

  let startDay: string
  if (latestRow?.day) {
    // Start from the day after the latest rolled-up day
    const next = new Date(latestRow.day + 'T00:00:00Z')
    next.setUTCDate(next.getUTCDate() + 1)
    startDay = next.toISOString().slice(0, 10)
  } else {
    startDay = earliestEventRow.ts.slice(0, 10)
  }

  let rowsInserted = 0
  let cursor = startDay
  while (cursor < todayStr) {
    const nextDay = new Date(cursor + 'T00:00:00Z')
    nextDay.setUTCDate(nextDay.getUTCDate() + 1)
    const nextStr = nextDay.toISOString().slice(0, 10)
    const windowStart = `${cursor}T00:00:00Z`
    const windowEnd = `${nextStr}T00:00:00Z`

    const rows = db.query<
      { session_id: string; tool_calls: number; subagents_spawned: number; turns: number },
      { $start: string; $end: string }
    >(
      `SELECT
         session_id,
         SUM(CASE WHEN hook_event='PostToolUse' THEN 1 ELSE 0 END) AS tool_calls,
         SUM(CASE WHEN hook_event='SubagentStart' THEN 1 ELSE 0 END) AS subagents_spawned,
         SUM(CASE WHEN hook_event='UserPromptSubmit' THEN 1 ELSE 0 END) AS turns
       FROM events
       WHERE ts >= $start AND ts < $end
       GROUP BY session_id`,
    ).all({ $start: windowStart, $end: windowEnd })

    for (const r of rows) {
      db.query(
        `INSERT INTO metrics_daily (day, session_id, tool_calls, subagents_spawned, turns)
         VALUES ($day, $sid, $tc, $ss, $tu)
         ON CONFLICT(day, session_id) DO UPDATE SET
           tool_calls = excluded.tool_calls,
           subagents_spawned = excluded.subagents_spawned,
           turns = excluded.turns`,
      ).run({
        $day: cursor,
        $sid: r.session_id,
        $tc: r.tool_calls,
        $ss: r.subagents_spawned,
        $tu: r.turns,
      })
      rowsInserted++
    }

    cursor = nextStr
  }

  return rowsInserted
}

/**
 * Hourly tool-call counts for the last 24 hours (live from events, no rollup).
 * Accepts either the session UUID or the session name.
 */
export function hourlyToolCalls(db: Database, sessionKey: string): number[] {
  const now = new Date()
  const buckets = new Array<number>(24).fill(0)
  const rows = db.query<
    { ts: string },
    { $key: string; $cutoff: string }
  >(
    `SELECT ts FROM events
     WHERE (session_id = $key OR session_name = $key)
       AND hook_event = 'PostToolUse' AND ts >= $cutoff`,
  ).all({
    $key: sessionKey,
    $cutoff: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
  })
  for (const { ts } of rows) {
    const hoursAgo = Math.floor((now.getTime() - new Date(ts).getTime()) / (60 * 60 * 1000))
    if (hoursAgo >= 0 && hoursAgo < 24) buckets[23 - hoursAgo]! += 1
  }
  return buckets
}
