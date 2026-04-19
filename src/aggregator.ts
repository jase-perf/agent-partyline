import type { Database } from 'bun:sqlite'
import type { HookEvent } from './events.js'
import { upsertSession, type SessionRow } from './storage/queries.js'

export interface SubagentRow {
  agent_id: string
  session_id: string
  agent_type: string | null
  description: string | null
  started_at: string
  ended_at: string | null
  status: string
}

type Listener = (s: SessionRow) => void

const WORKING_EVENTS = new Set(['PostToolUse', 'PreToolUse', 'UserPromptSubmit'])
const IDLE_EVENTS = new Set(['Stop', 'SessionEnd', 'SessionStart'])

export class Aggregator {
  private listeners: Listener[] = []
  constructor(private db: Database) {}

  onUpdate(l: Listener): void {
    this.listeners.push(l)
  }

  ingest(ev: HookEvent): void {
    const state =
      ev.hook_event === 'SessionEnd'
        ? 'ended'
        : WORKING_EVENTS.has(ev.hook_event)
          ? 'working'
          : IDLE_EVENTS.has(ev.hook_event)
            ? 'idle'
            : undefined

    upsertSession(this.db, {
      session_id: ev.session_id || `${ev.machine_id}:${ev.session_name}`,
      machine_id: ev.machine_id,
      name: ev.session_name,
      cwd: (ev.payload as { cwd?: string }).cwd ?? null,
      last_seen: ev.ts,
      state: state ?? null,
      started_at: ev.hook_event === 'SessionStart' ? ev.ts : null,
    })

    if (ev.hook_event === 'SubagentStart' && ev.agent_id) {
      this.db
        .query(
          `INSERT INTO subagents (agent_id, session_id, agent_type, description, started_at, status)
           VALUES ($a, $s, $t, $d, $ts, 'running')
           ON CONFLICT(agent_id) DO UPDATE SET status='running', started_at=excluded.started_at`,
        )
        .run({
          $a: ev.agent_id,
          $s: ev.session_id,
          $t: ev.agent_type ?? (ev.payload as { agent_type?: string }).agent_type ?? null,
          $d: (ev.payload as { description?: string }).description ?? null,
          $ts: ev.ts,
        })
    } else if (ev.hook_event === 'SubagentStop' && ev.agent_id) {
      this.db
        .query(`UPDATE subagents SET status='completed', ended_at=$ts WHERE agent_id=$a`)
        .run({ $a: ev.agent_id, $ts: ev.ts })
    }

    if (ev.hook_event === 'PostToolUse') {
      const p = ev.payload as {
        tool_name?: string
        tool_response?: { success?: boolean; isError?: boolean; error?: unknown }
      }
      const tr = p.tool_response
      const success =
        tr && (tr.success === false || tr.isError === true || tr.error != null) ? 0 : 1
      this.db
        .query(
          `INSERT INTO tool_calls (session_id, agent_id, tool_name, started_at, ended_at, success)
           VALUES ($s, $a, $t, $ts, $ts, $ok)`,
        )
        .run({
          $s: ev.session_id,
          $a: ev.agent_id ?? null,
          $t: p.tool_name ?? 'unknown',
          $ts: ev.ts,
          $ok: success,
        })
    }

    const current = this.getSession(ev.session_id)
    if (current) {
      for (const l of this.listeners) l(current)
    }
  }

  /** Look up a session by UUID or by human-readable name. */
  getSession(key: string): SessionRow | null {
    const byId = this.db
      .query<SessionRow, { $id: string }>('SELECT * FROM sessions WHERE session_id=$id')
      .get({ $id: key })
    if (byId) return byId
    const byName = this.db
      .query<SessionRow, { $name: string }>(
        'SELECT * FROM sessions WHERE name=$name ORDER BY last_seen DESC LIMIT 1',
      )
      .get({ $name: key })
    return byName ?? null
  }

  /** Accept either the session UUID or the session name. */
  getSubagents(sessionKey: string): SubagentRow[] {
    const resolved = this.getSession(sessionKey)
    const uuid = resolved?.session_id ?? sessionKey
    return this.db
      .query<SubagentRow, { $s: string }>(
        'SELECT * FROM subagents WHERE session_id=$s ORDER BY started_at DESC',
      )
      .all({ $s: uuid })
  }

  listSessions(): SessionRow[] {
    return this.db
      .query<SessionRow, []>('SELECT * FROM sessions ORDER BY last_seen DESC')
      .all()
  }
}
