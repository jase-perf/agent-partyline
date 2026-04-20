import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'

export interface CcplSessionRow {
  name: string
  token: string
  cwd: string
  cc_session_uuid: string | null
  pid: number | null
  machine_id: string | null
  online: boolean
  revision: number
  created_at: number
  last_active_at: number
}

export interface CcplArchiveRow {
  id: number
  name: string
  old_uuid: string
  archived_at: number
  reason: string
}

export interface MessageRow {
  id: string
  ts: number
  from_name: string
  to_name: string
  type: string
  body: string | null
  callback_id: string | null
  response_to: string | null
  cc_session_uuid: string | null
}

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

function rowToSession(row: any): CcplSessionRow {
  return {
    name: row.name,
    token: row.token,
    cwd: row.cwd,
    cc_session_uuid: row.cc_session_uuid,
    pid: row.pid,
    machine_id: row.machine_id,
    online: row.online === 1,
    revision: row.revision,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
  }
}

export function registerSession(db: Database, name: string, cwd: string): CcplSessionRow {
  const token = generateToken()
  const now = Date.now()
  db.query(
    `INSERT INTO ccpl_sessions
      (name, token, cwd, cc_session_uuid, pid, machine_id, online, revision, created_at, last_active_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, 0, 0, ?, ?)`,
  ).run(name, token, cwd, now, now)
  return getSessionByName(db, name)!
}

export function getSessionByName(db: Database, name: string): CcplSessionRow | null {
  const row = db.query(`SELECT * FROM ccpl_sessions WHERE name = ?`).get(name)
  return row ? rowToSession(row) : null
}

export function getSessionByToken(db: Database, token: string): CcplSessionRow | null {
  const row = db.query(`SELECT * FROM ccpl_sessions WHERE token = ?`).get(token)
  return row ? rowToSession(row) : null
}

export function listSessions(db: Database): CcplSessionRow[] {
  const rows = db
    .query(`SELECT * FROM ccpl_sessions ORDER BY online DESC, last_active_at DESC`)
    .all() as any[]
  return rows.map(rowToSession)
}

export function updateSessionOnConnect(
  db: Database,
  name: string,
  ccUuid: string | null,
  pid: number | null,
  machineId: string | null,
): void {
  db.query(
    `UPDATE ccpl_sessions
     SET cc_session_uuid = ?, pid = ?, machine_id = ?, online = 1,
         revision = revision + 1, last_active_at = ?
     WHERE name = ?`,
  ).run(ccUuid, pid, machineId, Date.now(), name)
}

export function markSessionOffline(db: Database, name: string): void {
  db.query(`UPDATE ccpl_sessions SET online = 0, revision = revision + 1 WHERE name = ?`).run(name)
}

export function archiveSession(db: Database, name: string, oldUuid: string, reason: string): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO ccpl_archives (name, old_uuid, archived_at, reason)
       VALUES (?, ?, ?, ?)`,
    ).run(name, oldUuid, Date.now(), reason)
    db.query(
      `UPDATE ccpl_sessions
       SET cc_session_uuid = NULL, revision = revision + 1 WHERE name = ?`,
    ).run(name)
  })()
}

export function rotateToken(db: Database, name: string): string {
  const token = generateToken()
  db.query(`UPDATE ccpl_sessions SET token = ? WHERE name = ?`).run(token, name)
  return token
}

export function deleteSession(db: Database, name: string): void {
  db.transaction(() => {
    db.query(`DELETE FROM ccpl_sessions WHERE name = ?`).run(name)
    db.query(`DELETE FROM ccpl_archives WHERE name = ?`).run(name)
  })()
}

export function pruneInactive(db: Database, cutoff: number): number {
  const res = db
    .query(
      `DELETE FROM ccpl_sessions
       WHERE online = 0 AND last_active_at < ?
       RETURNING name`,
    )
    .all(cutoff) as { name: string }[]
  for (const r of res) {
    db.query(`DELETE FROM ccpl_archives WHERE name = ?`).run(r.name)
  }
  return res.length
}

export function insertMessage(db: Database, row: MessageRow): void {
  db.query(
    `INSERT INTO messages
      (id, ts, from_name, to_name, type, body, callback_id, response_to, cc_session_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.ts,
    row.from_name,
    row.to_name,
    row.type,
    row.body,
    row.callback_id,
    row.response_to,
    row.cc_session_uuid,
  )
}

export function recentMessages(db: Database, limit: number): MessageRow[] {
  return db.query(`SELECT * FROM messages ORDER BY ts DESC LIMIT ?`).all(limit) as MessageRow[]
}
