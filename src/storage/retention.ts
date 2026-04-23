import type { Database } from 'bun:sqlite'
import { unlinkSync, rmdirSync } from 'fs'
import { dirname } from 'path'
import { deleteAttachment, listExpiredAttachments } from './attachments.js'

/** Delete events older than `days` days. Returns number of rows deleted. */
export function pruneOldEvents(db: Database, days: number): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const result = db
    .query<{ changes: number }, { $cutoff: string }>(`DELETE FROM events WHERE ts < $cutoff`)
    .run({ $cutoff: cutoff }) as unknown as { changes: number }
  return result.changes
}

/**
 * Mark any subagent still 'running' whose started_at is older than
 * maxAgeHours as 'cancelled' with ended_at = now. Safety net for cases the
 * aggregator's inline cancel-on-parent-turn-end path missed (server restart
 * before parent fired UserPromptSubmit, hook emitter dropped, etc.). Returns
 * the number of rows updated.
 */
export function cancelStaleSubagents(
  db: Database,
  maxAgeHours: number,
  now: number = Date.now(),
): number {
  const cutoff = new Date(now - maxAgeHours * 60 * 60 * 1000).toISOString()
  const nowIso = new Date(now).toISOString()
  const result = db
    .query<{ changes: number }, { $now: string; $cutoff: string }>(
      `UPDATE subagents SET status='cancelled', ended_at=$now
       WHERE status='running' AND started_at < $cutoff`,
    )
    .run({ $now: nowIso, $cutoff: cutoff }) as unknown as { changes: number }
  return result.changes
}

/**
 * Delete attachment rows + their on-disk files whose expires_at has passed.
 * Returns the number of attachments pruned. Called from the nightly retention
 * pass alongside pruneOldEvents.
 */
export function pruneExpiredAttachments(db: Database, now: number = Date.now()): number {
  const rows = listExpiredAttachments(db, now)
  for (const r of rows) {
    try {
      unlinkSync(r.stored_path)
    } catch {
      /* already gone — fine */
    }
    try {
      rmdirSync(dirname(r.stored_path))
    } catch {
      /* not empty or missing — fine */
    }
    deleteAttachment(db, r.id)
  }
  return rows.length
}
