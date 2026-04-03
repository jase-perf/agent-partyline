/**
 * bus.ts — SQLite transport layer for the party line.
 *
 * All database access is isolated here. The bus handles:
 * - Session registration/deregistration
 * - Writing messages
 * - Polling for new messages addressed to this session
 * - Cleanup of old messages and stale sessions
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { BusMessage, MessageType, Session } from './types.js'

const DEFAULT_DB_PATH = `${process.env.HOME}/.claude/channels/party-line/bus.db`
const PRUNE_AGE_HOURS = 24
const STALE_SESSION_MINUTES = 5

export class Bus {
  private db: Database.Database
  private sessionName: string
  private lastSeenId: number = 0

  constructor(sessionName: string, dbPath: string = DEFAULT_DB_PATH) {
    this.sessionName = sessionName

    // Ensure the directory exists
    mkdirSync(dirname(dbPath), { recursive: true })

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 3000')

    this.initSchema()
    this.pruneOldMessages()
    this.pruneStaleSessionsExceptSelf()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        name TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        registered_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'message',
        body TEXT NOT NULL,
        callback_id TEXT,
        response_to TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages("to");
      CREATE INDEX IF NOT EXISTS idx_messages_callback ON messages(callback_id);
      CREATE INDEX IF NOT EXISTS idx_messages_response ON messages(response_to);
    `)
  }

  /** Register this session on the bus. */
  register(): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions (name, pid, registered_at)
      VALUES (?, ?, datetime('now'))
    `).run(this.sessionName, process.pid)

    // Set lastSeenId to current max so we don't replay old messages
    const row = this.db.prepare('SELECT MAX(id) as max_id FROM messages').get() as
      | { max_id: number | null }
      | undefined
    this.lastSeenId = row?.max_id ?? 0
  }

  /** Deregister this session from the bus. */
  deregister(): void {
    this.db.prepare('DELETE FROM sessions WHERE name = ?').run(this.sessionName)
  }

  /** Heartbeat — update registration timestamp so others know we're alive. */
  heartbeat(): void {
    this.db.prepare(`
      UPDATE sessions SET registered_at = datetime('now') WHERE name = ?
    `).run(this.sessionName)
  }

  /** List all registered sessions. */
  listSessions(): Session[] {
    return this.db.prepare('SELECT name, pid, registered_at FROM sessions').all() as Session[]
  }

  /** Write a message to the bus. */
  send(
    to: string,
    body: string,
    type: MessageType = 'message',
    callbackId: string | null = null,
    responseTo: string | null = null,
  ): number {
    const result = this.db.prepare(`
      INSERT INTO messages ("from", "to", type, body, callback_id, response_to)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(this.sessionName, to, type, body, callbackId, responseTo)

    return Number(result.lastInsertRowid)
  }

  /** Poll for new messages addressed to this session. */
  poll(): BusMessage[] {
    const rows = this.db.prepare(`
      SELECT id, "from", "to", type, body, callback_id, response_to, created_at
      FROM messages
      WHERE id > ?
        AND ("to" = ? OR "to" = 'all' OR "to" LIKE '%' || ? || '%')
        AND "from" != ?
      ORDER BY id ASC
    `).all(this.lastSeenId, this.sessionName, this.sessionName, this.sessionName) as BusMessage[]

    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1]
      if (lastRow) {
        this.lastSeenId = lastRow.id
      }
    }

    return rows
  }

  /** Get recent message history (for context). */
  recentMessages(limit: number = 50): BusMessage[] {
    return this.db.prepare(`
      SELECT id, "from", "to", type, body, callback_id, response_to, created_at
      FROM messages
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as BusMessage[]
  }

  /** Remove messages older than PRUNE_AGE_HOURS. */
  private pruneOldMessages(): void {
    this.db.prepare(`
      DELETE FROM messages
      WHERE created_at < datetime('now', ?)
    `).run(`-${PRUNE_AGE_HOURS} hours`)
  }

  /** Remove sessions that haven't heartbeated recently (but not ourselves). */
  private pruneStaleSessionsExceptSelf(): void {
    this.db.prepare(`
      DELETE FROM sessions
      WHERE registered_at < datetime('now', ?)
        AND name != ?
    `).run(`-${STALE_SESSION_MINUTES} minutes`, this.sessionName)
  }

  /** Get the path to the SQLite WAL file (for fs.watch). */
  get walPath(): string {
    return this.db.name + '-wal'
  }

  /** Get the path to the database file. */
  get dbPath(): string {
    return this.db.name
  }

  /** Close the database connection. */
  close(): void {
    this.deregister()
    this.db.close()
  }
}
