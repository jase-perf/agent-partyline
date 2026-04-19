import type { Database } from 'bun:sqlite'

/** Delete events older than `days` days. Returns number of rows deleted. */
export function pruneOldEvents(db: Database, days: number): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const result = db
    .query<{ changes: number }, { $cutoff: string }>(
      `DELETE FROM events WHERE ts < $cutoff`,
    )
    .run({ $cutoff: cutoff }) as unknown as { changes: number }
  return result.changes
}
