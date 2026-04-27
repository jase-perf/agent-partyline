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
type Stmt = ReturnType<Database['query']>

const WORKING_EVENTS = new Set(['PostToolUse', 'PreToolUse', 'UserPromptSubmit'])
const IDLE_EVENTS = new Set(['Stop', 'SessionEnd', 'SessionStart'])

/** Subagents started within this window are not cancelled on UserPromptSubmit.
 *  Subagents started recently may not have fired SubagentStop yet (e.g. ESC
 *  mid-task), so cancelling them immediately is too aggressive. */
const CANCEL_GRACE_MS = 10_000

export class Aggregator {
  private listeners: Listener[] = []

  private readonly stmtSubagentStart: Stmt
  private readonly stmtSubagentStop: Stmt
  private readonly stmtCancelSubagents: Stmt
  private readonly stmtInsertToolCall: Stmt
  private readonly stmtGetSessionById: Stmt
  private readonly stmtGetSessionByName: Stmt
  private readonly stmtGetSubagents: Stmt
  private readonly stmtListSessions: Stmt

  constructor(private db: Database) {
    this.stmtSubagentStart = db.query(
      `INSERT INTO subagents (agent_id, session_id, agent_type, description, started_at, status)
       VALUES ($a, $s, $t, $d, $ts, 'running')
       ON CONFLICT(agent_id) DO UPDATE SET status='running', started_at=excluded.started_at`,
    )
    this.stmtSubagentStop = db.query(
      `UPDATE subagents SET status='completed', ended_at=$ts WHERE agent_id=$a`,
    )
    // Cancel orphaned subagents, but skip those started within the grace window.
    // started_at < $grace filters out subagents that may not have fired
    // SubagentStop yet because the ESC/kill happened too recently.
    this.stmtCancelSubagents = db.query(
      `UPDATE subagents SET status='cancelled', ended_at=$ts
       WHERE session_id=$s AND status='running' AND started_at < $grace`,
    )
    this.stmtInsertToolCall = db.query(
      `INSERT INTO tool_calls (session_id, agent_id, tool_name, started_at, ended_at, success)
       VALUES ($s, $a, $t, $ts, $ts, $ok)`,
    )
    this.stmtGetSessionById = db.query(`SELECT * FROM sessions WHERE session_id=$id`)
    this.stmtGetSessionByName = db.query(
      `SELECT * FROM sessions WHERE name=$name ORDER BY last_seen DESC LIMIT 1`,
    )
    this.stmtGetSubagents = db.query(
      `SELECT * FROM subagents WHERE session_id=$s ORDER BY started_at DESC`,
    )
    this.stmtListSessions = db.query(`SELECT * FROM sessions ORDER BY last_seen DESC`)
  }

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

    const source =
      ev.source ??
      (typeof (ev.payload as { source?: unknown }).source === 'string'
        ? (ev.payload as { source: string }).source
        : 'claude-code')

    upsertSession(this.db, {
      session_id: ev.session_id || `${ev.machine_id}:${ev.session_name}`,
      machine_id: ev.machine_id,
      name: ev.session_name,
      cwd: (ev.payload as { cwd?: string }).cwd ?? null,
      last_seen: ev.ts,
      state: state ?? null,
      started_at: ev.hook_event === 'SessionStart' ? ev.ts : null,
      source,
    })

    if (ev.hook_event === 'SubagentStart' && ev.agent_id) {
      this.stmtSubagentStart.run({
        $a: ev.agent_id,
        $s: ev.session_id,
        $t: ev.agent_type ?? (ev.payload as { agent_type?: string }).agent_type ?? null,
        $d: (ev.payload as { description?: string }).description ?? null,
        $ts: ev.ts,
      })
    } else if (ev.hook_event === 'SubagentStop' && ev.agent_id) {
      this.stmtSubagentStop.run({ $a: ev.agent_id, $ts: ev.ts })
    }

    // Cancel orphaned subagents when the parent turn ends without a clean
    // SubagentStop. Claude Code skips SubagentStop when the user hits ESC
    // mid-Task — the subagent process is killed before its hook fires, so
    // the row stays 'running' forever. Detect end-of-turn via the parent's
    // next UserPromptSubmit, or a SessionStart/SessionEnd. Events tagged
    // with an agent_id come from inside a subagent and must not trigger
    // cancellation — those are the subagent's own hook events.
    if (
      !ev.agent_id &&
      (ev.hook_event === 'UserPromptSubmit' ||
        ev.hook_event === 'SessionStart' ||
        ev.hook_event === 'SessionEnd')
    ) {
      const graceCutoff = new Date(new Date(ev.ts).getTime() - CANCEL_GRACE_MS).toISOString()
      this.stmtCancelSubagents.run({ $ts: ev.ts, $s: ev.session_id, $grace: graceCutoff })
    }

    if (ev.hook_event === 'PostToolUse') {
      const p = ev.payload as {
        tool_name?: string
        tool_response?: { success?: boolean; isError?: boolean; error?: unknown }
      }
      const tr = p.tool_response
      const success =
        tr && (tr.success === false || tr.isError === true || tr.error != null) ? 0 : 1
      this.stmtInsertToolCall.run({
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
    const byId = this.stmtGetSessionById.get({ $id: key }) as SessionRow | null
    if (byId) return byId
    return (this.stmtGetSessionByName.get({ $name: key }) as SessionRow | null) ?? null
  }

  /** Accept either the session UUID or the session name. */
  getSubagents(sessionKey: string): SubagentRow[] {
    const resolved = this.getSession(sessionKey)
    const uuid = resolved?.session_id ?? sessionKey
    return this.stmtGetSubagents.all({ $s: uuid }) as SubagentRow[]
  }

  listSessions(): SessionRow[] {
    return this.stmtListSessions.all() as SessionRow[]
  }
}
