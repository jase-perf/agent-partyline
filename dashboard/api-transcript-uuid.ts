import type { Database } from 'bun:sqlite'
import { transcriptForUuid } from '../src/storage/transcript-entries.js'
import {
  recordsToTranscript,
  type TranscriptEntry,
  type PartyLineEnvelope,
} from '../src/transcript.js'

/**
 * Build the transcript response shape for /api/transcript when invoked with
 * an explicit `uuid` param. Reads transcript_entries (parsed from body_json)
 * + messages rows, and folds them into TranscriptEntry[] using the same
 * recordsToTranscript helper that the live JSONL path uses. Returning an
 * array makes the archive viewer reuse renderStream/renderEntry with zero
 * client-side conversion.
 */
export function buildArchiveTranscriptResponse(
  db: Database,
  sessionName: string,
  uuid: string,
  limit: number,
): TranscriptEntry[] {
  // Records from transcript_entries — body_json is the raw JSONL line.
  const rows = transcriptForUuid(db, uuid, limit)
  const records: Record<string, unknown>[] = []
  for (const r of rows) {
    try {
      records.push(JSON.parse(r.body_json) as Record<string, unknown>)
    } catch {
      // Skip unparseable rows defensively — they shouldn't exist, but the
      // viewer must not crash on a single bad row.
    }
  }

  // Envelopes from messages WHERE cc_session_uuid = uuid.
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
  const envelopes: PartyLineEnvelope[] = messageRows.map((r) => ({
    id: r.id,
    from: r.from_name,
    to: r.to_name,
    type: r.type,
    body: r.body ?? '',
    ts: new Date(r.ts).toISOString(),
    callback_id: r.callback_id,
    response_to: r.response_to,
  }))

  // recordsToTranscript needs a projectsRoot + cwdSlug for tool-use file
  // resolution. The archive viewer is read-only and never resolves tool
  // outputs from disk, so empty strings are safe — recordToEntries only uses
  // these for non-essential file paths in tool-use entries.
  return recordsToTranscript(records, '', '', uuid, sessionName, envelopes, limit)
}
