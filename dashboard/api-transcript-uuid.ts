import type { Database } from 'bun:sqlite'
import { transcriptForUuid, type TranscriptEntryRow } from '../src/storage/transcript-entries.js'

export interface ArchiveTranscriptResponse {
  uuid: string
  session_name: string
  entries: TranscriptEntryRow[]
  envelopes: Array<{
    id: string
    from: string
    to: string
    type: string
    body: string
    ts: string
    callback_id: string | null
    response_to: string | null
  }>
}

/**
 * Build the transcript response shape for /api/transcript when invoked with
 * an explicit `uuid` param. Reads exclusively from DB — `transcript_entries`
 * for turns and `messages` for party-line envelopes — so the archive viewer
 * never depends on JSONL files.
 */
export function buildArchiveTranscriptResponse(
  db: Database,
  sessionName: string,
  uuid: string,
  limit: number,
): ArchiveTranscriptResponse {
  const entries = transcriptForUuid(db, uuid, limit)
  const messageRows = db
    .query(`SELECT * FROM messages WHERE cc_session_uuid = ? ORDER BY ts ASC LIMIT ?`)
    .all(uuid, limit) as Array<{
    id: string
    ts: number
    from_name: string
    to_name: string
    type: string
    body: string | null
    callback_id: string | null
    response_to: string | null
  }>
  const envelopes = messageRows.map((r) => ({
    id: r.id,
    from: r.from_name,
    to: r.to_name,
    type: r.type,
    body: r.body ?? '',
    ts: new Date(r.ts).toISOString(),
    callback_id: r.callback_id,
    response_to: r.response_to,
  }))
  return { uuid, session_name: sessionName, entries, envelopes }
}
