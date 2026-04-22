import type { Database } from 'bun:sqlite'
import type { Attachment } from '../types.js'

export interface AttachmentRow {
  id: string
  envelope_id: string | null
  uploader_session: string
  name: string
  media_type: string
  size: number
  stored_path: string
  created_at: number
  expires_at: number
}

export interface InsertAttachmentInput {
  id: string
  uploader_session: string
  name: string
  media_type: string
  size: number
  stored_path: string
  expires_at: number
}

export function insertAttachment(db: Database, input: InsertAttachmentInput): void {
  db.query(
    `INSERT INTO attachments
      (id, envelope_id, uploader_session, name, media_type, size, stored_path, created_at, expires_at)
     VALUES ($id, NULL, $up, $name, $mt, $sz, $path, $ca, $ea)`,
  ).run({
    $id: input.id,
    $up: input.uploader_session,
    $name: input.name,
    $mt: input.media_type,
    $sz: input.size,
    $path: input.stored_path,
    $ca: Date.now(),
    $ea: input.expires_at,
  })
}

export function getAttachment(db: Database, id: string): AttachmentRow | null {
  return (
    db
      .query<AttachmentRow, { $id: string }>('SELECT * FROM attachments WHERE id = $id')
      .get({ $id: id }) ?? null
  )
}

/**
 * Link uploaded attachments to the envelope that carries them. Called from
 * the /api/send and switchboard routing paths once an envelope ID exists.
 */
export function linkAttachmentsToEnvelope(
  db: Database,
  envelopeId: string,
  attachmentIds: string[],
): void {
  if (attachmentIds.length === 0) return
  const placeholders = attachmentIds.map(() => '?').join(',')
  db.query(`UPDATE attachments SET envelope_id = ? WHERE id IN (${placeholders})`).run(
    envelopeId,
    ...attachmentIds,
  )
}

export function attachmentRowToMeta(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    kind: row.media_type.startsWith('image/') ? 'image' : 'file',
    name: row.name,
    media_type: row.media_type,
    size: row.size,
    url: `/api/attachment/${row.id}`,
  }
}

/** Return IDs + paths of attachments past their expiry. */
export function listExpiredAttachments(
  db: Database,
  now: number,
): Array<{ id: string; stored_path: string }> {
  return db
    .query<
      { id: string; stored_path: string },
      { $now: number }
    >('SELECT id, stored_path FROM attachments WHERE expires_at <= $now')
    .all({ $now: now })
}

export function deleteAttachment(db: Database, id: string): void {
  db.query('DELETE FROM attachments WHERE id = ?').run(id)
}
