import type { Database } from 'bun:sqlite'

export interface TranscriptEntryRow {
  cc_session_uuid: string
  seq: number
  session_name: string | null
  ts: string
  kind: string
  uuid: string | null
  body_json: string
  created_at: number
}

export interface ArchiveEntry {
  uuid: string
  archived_at: number
  label: string | null
  entry_count: number
}

export interface LiveEntry {
  uuid: string
  last_active_at: number
  label: string | null
  entry_count: number
}

export interface ArchivesResult {
  live: LiveEntry | null
  archives: ArchiveEntry[]
}

/**
 * Insert one transcript entry. Idempotent on (cc_session_uuid, seq) — duplicate
 * inserts are silently ignored, NOT updated. The first insert wins.
 */
export function insertEntry(db: Database, row: TranscriptEntryRow): void {
  db.query(
    `INSERT OR IGNORE INTO transcript_entries
       (cc_session_uuid, seq, session_name, ts, kind, uuid, body_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.cc_session_uuid,
    row.seq,
    row.session_name,
    row.ts,
    row.kind,
    row.uuid,
    row.body_json,
    row.created_at,
  )
}

/** Return all rows for a given cc_session_uuid ordered by seq ASC, capped. */
export function transcriptForUuid(db: Database, uuid: string, limit: number): TranscriptEntryRow[] {
  return db
    .query(
      `SELECT * FROM transcript_entries
       WHERE cc_session_uuid = ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(uuid, limit) as TranscriptEntryRow[]
}

/** Delete every entry for a uuid (used on file-shrink / reset). */
export function deleteEntriesForUuid(db: Database, uuid: string): void {
  db.query(`DELETE FROM transcript_entries WHERE cc_session_uuid = ?`).run(uuid)
}

/** Last assistant-text entry's `text` field, or null if none. */
export function lastAssistantText(db: Database, uuid: string): string | null {
  const row = db
    .query(
      `SELECT body_json FROM transcript_entries
       WHERE cc_session_uuid = ? AND kind = 'assistant-text'
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(uuid) as { body_json: string } | null
  if (!row) return null
  try {
    const parsed = JSON.parse(row.body_json) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text : null
  } catch {
    return null
  }
}

/**
 * Compact label for the History list. Returns lastAssistantText truncated
 * to maxLen-1 chars + "…" suffix when truncation occurs. Null if no label.
 */
export function archiveLabel(db: Database, uuid: string, maxLen: number): string | null {
  const text = lastAssistantText(db, uuid)
  if (text === null) return null
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '…'
}

/** Number of entries for this uuid. */
export function entryCount(db: Database, uuid: string): number {
  const row = db
    .query(`SELECT COUNT(*) AS n FROM transcript_entries WHERE cc_session_uuid = ?`)
    .get(uuid) as { n: number }
  return row.n
}

/**
 * Build the /api/archives response shape. The currently-live uuid (if any)
 * is returned in `live`; every other distinct cc_session_uuid that has been
 * archived for this name appears once in `archives`, ordered by most recent
 * archived_at DESC. A uuid that is currently live is NEVER also in archives.
 */
export function listArchivesForSession(
  db: Database,
  name: string,
  labelMaxLen: number,
): ArchivesResult {
  const sessionRow = db
    .query(`SELECT cc_session_uuid, last_active_at FROM ccpl_sessions WHERE name = ?`)
    .get(name) as { cc_session_uuid: string | null; last_active_at: number } | null

  const liveUuid = sessionRow?.cc_session_uuid ?? null
  const live: LiveEntry | null = liveUuid
    ? {
        uuid: liveUuid,
        last_active_at: sessionRow!.last_active_at,
        label: archiveLabel(db, liveUuid, labelMaxLen),
        entry_count: entryCount(db, liveUuid),
      }
    : null

  const rows = db
    .query<{ uuid: string; archived_at: number }, [string, string | null]>(
      `SELECT old_uuid AS uuid, MAX(archived_at) AS archived_at
       FROM ccpl_archives
       WHERE name = ? AND old_uuid != COALESCE(?, '')
       GROUP BY old_uuid
       ORDER BY archived_at DESC`,
    )
    .all(name, liveUuid)

  const archives: ArchiveEntry[] = rows.map((r) => ({
    uuid: r.uuid,
    archived_at: r.archived_at,
    label: archiveLabel(db, r.uuid, labelMaxLen),
    entry_count: entryCount(db, r.uuid),
  }))

  return { live, archives }
}

/**
 * Backfill session_name on all rows for a given cc_session_uuid where
 * session_name IS NULL. Called when reconcileCcSessionUuid adopts a uuid
 * we'd previously been ingesting as a stranger.
 */
export function attributeSessionName(db: Database, uuid: string, name: string): void {
  db.query(
    `UPDATE transcript_entries
     SET session_name = ?
     WHERE cc_session_uuid = ? AND session_name IS NULL`,
  ).run(name, uuid)
}
