import type { Database } from 'bun:sqlite'
import type { HookEvent } from '../events.js'

export interface SessionRow {
  session_id: string
  machine_id: string
  name: string
  cwd: string | null
  state: string | null
  model: string | null
  git_branch: string | null
  context_tokens: number | null
  message_count: number | null
  last_text: string | null
  last_seen: string
  started_at: string | null
}

export interface EventRow {
  id: number
  machine_id: string
  session_id: string
  session_name: string
  hook_event: string
  ts: string
  agent_id: string | null
  agent_type: string | null
  payload: Record<string, unknown>
}

export interface UpsertSessionInput {
  session_id: string
  machine_id: string
  name: string
  cwd?: string | null
  last_seen: string
  state?: string | null
  model?: string | null
  git_branch?: string | null
  context_tokens?: number | null
  message_count?: number | null
  last_text?: string | null
  started_at?: string | null
}

export function insertEvent(db: Database, ev: HookEvent): void {
  db.query(
    `INSERT INTO events (machine_id, session_id, session_name, hook_event, ts, agent_id, agent_type, payload_json)
     VALUES ($machine_id, $session_id, $session_name, $hook_event, $ts, $agent_id, $agent_type, $payload_json)`,
  ).run({
    $machine_id: ev.machine_id,
    $session_id: ev.session_id,
    $session_name: ev.session_name,
    $hook_event: ev.hook_event,
    $ts: ev.ts,
    $agent_id: ev.agent_id ?? null,
    $agent_type: ev.agent_type ?? null,
    $payload_json: JSON.stringify(ev.payload),
  })
}

export function upsertSession(db: Database, s: UpsertSessionInput): void {
  db.query(
    `INSERT INTO sessions (session_id, machine_id, name, cwd, last_seen, state, model, git_branch, context_tokens, message_count, last_text, started_at)
     VALUES ($session_id, $machine_id, $name, $cwd, $last_seen, $state, $model, $git_branch, $context_tokens, $message_count, $last_text, $started_at)
     ON CONFLICT(session_id) DO UPDATE SET
       name = excluded.name,
       cwd = COALESCE(excluded.cwd, sessions.cwd),
       last_seen = excluded.last_seen,
       state = COALESCE(excluded.state, sessions.state),
       model = COALESCE(excluded.model, sessions.model),
       git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
       context_tokens = COALESCE(excluded.context_tokens, sessions.context_tokens),
       message_count = COALESCE(excluded.message_count, sessions.message_count),
       last_text = COALESCE(excluded.last_text, sessions.last_text),
       started_at = COALESCE(excluded.started_at, sessions.started_at)`,
  ).run({
    $session_id: s.session_id,
    $machine_id: s.machine_id,
    $name: s.name,
    $cwd: s.cwd ?? null,
    $last_seen: s.last_seen,
    $state: s.state ?? null,
    $model: s.model ?? null,
    $git_branch: s.git_branch ?? null,
    $context_tokens: s.context_tokens ?? null,
    $message_count: s.message_count ?? null,
    $last_text: s.last_text ?? null,
    $started_at: s.started_at ?? null,
  })
}

/**
 * Look up a session by either its UUID (session_id) or its human-readable name.
 * When matching by name, returns the most recently seen row.
 */
export function sessionState(db: Database, key: string): SessionRow | null {
  const byId = db
    .query<SessionRow, { $id: string }>('SELECT * FROM sessions WHERE session_id = $id')
    .get({ $id: key })
  if (byId) return byId
  const byName = db
    .query<SessionRow, { $name: string }>(
      'SELECT * FROM sessions WHERE name = $name ORDER BY last_seen DESC LIMIT 1',
    )
    .get({ $name: key })
  return byName ?? null
}

export function recentEvents(
  db: Database,
  opts: { sessionId?: string; limit?: number },
): EventRow[] {
  const limit = opts.limit ?? 50
  // Match on either session_id (UUID) or session_name — the dashboard UI identifies
  // sessions by name (from multicast presence) while ingested hook events are keyed
  // by UUID. Accepting either lets us surface the timeline from a name-keyed card.
  const rows = opts.sessionId
    ? db
        .query<
          Omit<EventRow, 'payload'> & { payload_json: string },
          { $key: string; $limit: number }
        >(
          `SELECT * FROM events
           WHERE session_id = $key OR session_name = $key
           ORDER BY ts DESC LIMIT $limit`,
        )
        .all({ $key: opts.sessionId, $limit: limit })
    : db
        .query<Omit<EventRow, 'payload'> & { payload_json: string }, { $limit: number }>(
          'SELECT * FROM events ORDER BY ts DESC LIMIT $limit',
        )
        .all({ $limit: limit })
  return rows.map(({ payload_json, ...rest }) => ({
    ...rest,
    payload: JSON.parse(payload_json) as Record<string, unknown>,
  }))
}
