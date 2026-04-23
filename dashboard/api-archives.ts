import type { Database } from 'bun:sqlite'
import { listArchivesForSession } from '../src/storage/transcript-entries.js'

const LABEL_MAX_LEN = 32

/**
 * GET /api/archives?session=<name>
 *   → { live: LiveEntry | null, archives: ArchiveEntry[] }
 *
 * The live uuid (if any) is returned in `live`. Distinct archived uuids for
 * this name (excluding live) are returned in `archives`, ordered by most
 * recent archived_at DESC, with last-assistant-text labels truncated to 32
 * chars.
 */
export async function handleApiArchives(req: Request, db: Database): Promise<Response> {
  const url = new URL(req.url)
  const name = url.searchParams.get('session')
  if (!name) {
    return Response.json({ error: 'session param required' }, { status: 400 })
  }
  const result = listArchivesForSession(db, name, LABEL_MAX_LEN)
  return Response.json(result)
}
