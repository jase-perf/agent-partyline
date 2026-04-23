import type { Database } from 'bun:sqlite'
import { basename, join } from 'node:path'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import type { JsonlObserver, JsonlUpdate } from './jsonl'
import { insertEntry, deleteEntriesForUuid } from '../storage/transcript-entries'
import { getSessionByCcUuid } from '../storage/ccpl-queries'

/**
 * Streams Claude Code JSONL entries into `transcript_entries`. Subscribes to
 * a JsonlObserver, inserts one row per emitted update, manages a per-uuid
 * monotonic seq counter, and clears rows on reset (file shrink/replacement).
 *
 * The seq counter starts at MAX(seq)+1 from the DB on first encounter of a
 * uuid (so a dashboard restart resumes correctly), then increments locally
 * per insert. Inserts are INSERT OR IGNORE — duplicate (uuid, seq) PKs are
 * silently dropped, which means a stranger-uuid backfill (Task 5) that
 * partially overlaps with later streaming reuses existing rows safely.
 */
export class TranscriptIngester {
  private nextSeq = new Map<string, number>()

  constructor(
    private db: Database,
    private _projectsRoot: string,
  ) {}

  subscribe(observer: JsonlObserver): void {
    observer.on((u) => this.handleUpdate(u))
    observer.onReset((path) => this.handleReset(path))
  }

  /**
   * One-shot read of the JSONL file for `ccUuid` and bulk-insert every line.
   * No-op if the uuid already has rows in transcript_entries (the streaming
   * path is taking care of it). Returns the number of rows actually inserted.
   *
   * Used by reconcileCcSessionUuid via onUuidAdopted when the resumed uuid
   * is a stranger we've never seen before (Case B in the spec).
   */
  backfillFromUuid(ccUuid: string): number {
    const existing = this.db
      .query(`SELECT COUNT(*) AS n FROM transcript_entries WHERE cc_session_uuid = ?`)
      .get(ccUuid) as { n: number }
    if (existing.n > 0) return 0

    const filePath = this.findJsonlForUuid(ccUuid)
    if (!filePath) return 0

    let raw: string
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch {
      return 0
    }

    const sessionName = this.lookupSessionName(ccUuid)
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    let seq = 0
    const insertMany = this.db.transaction(() => {
      for (const line of lines) {
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        insertEntry(this.db, {
          cc_session_uuid: ccUuid,
          seq,
          session_name: sessionName,
          ts: extractTs(entry),
          kind: deriveKind(entry),
          uuid: extractUuid(entry),
          body_json: JSON.stringify(entry),
          created_at: Date.now(),
        })
        seq++
      }
    })
    insertMany()
    this.nextSeq.set(ccUuid, seq)
    return seq
  }

  /** Walk the projectsRoot for a `<ccUuid>.jsonl` file. */
  private findJsonlForUuid(ccUuid: string): string | null {
    if (!existsSync(this._projectsRoot)) return null
    for (const cwdDir of readdirSync(this._projectsRoot, { withFileTypes: true })) {
      if (!cwdDir.isDirectory()) continue
      const candidate = join(this._projectsRoot, cwdDir.name, `${ccUuid}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  private handleUpdate(u: JsonlUpdate): void {
    const ccUuid = u.session_id
    const seq = this.allocateSeq(ccUuid)
    const sessionName = this.lookupSessionName(ccUuid)
    insertEntry(this.db, {
      cc_session_uuid: ccUuid,
      seq,
      session_name: sessionName,
      ts: extractTs(u.entry),
      kind: deriveKind(u.entry),
      uuid: extractUuid(u.entry),
      body_json: JSON.stringify(u.entry),
      created_at: Date.now(),
    })
  }

  private handleReset(filePath: string): void {
    const ccUuid = basename(filePath, '.jsonl')
    deleteEntriesForUuid(this.db, ccUuid)
    this.nextSeq.delete(ccUuid)
  }

  /** First call for a uuid queries DB for MAX(seq)+1 (or 0). Cached after that. */
  private allocateSeq(ccUuid: string): number {
    let n = this.nextSeq.get(ccUuid)
    if (n === undefined) {
      const row = this.db
        .query(`SELECT MAX(seq) AS m FROM transcript_entries WHERE cc_session_uuid = ?`)
        .get(ccUuid) as { m: number | null }
      n = (row.m ?? -1) + 1
    }
    this.nextSeq.set(ccUuid, n + 1)
    return n
  }

  private lookupSessionName(ccUuid: string): string | null {
    const row = getSessionByCcUuid(this.db, ccUuid)
    return row?.name ?? null
  }
}

function extractTs(entry: Record<string, unknown>): string {
  if (typeof entry.timestamp === 'string') return entry.timestamp
  if (typeof entry.ts === 'string') return entry.ts
  return new Date().toISOString()
}

function extractUuid(entry: Record<string, unknown>): string | null {
  return typeof entry.uuid === 'string' ? entry.uuid : null
}

/**
 * Map JSONL entry types to the `kind` column. Claude Code emits "user",
 * "assistant", "tool_use", "tool_result", "system", "subagent-spawn", and
 * other shapes. Normalise the most useful ones; everything else becomes
 * the raw type string (or 'unknown').
 */
function deriveKind(entry: Record<string, unknown>): string {
  const t = entry.type
  if (typeof t !== 'string') return 'unknown'
  if (t === 'assistant') return 'assistant-text'
  if (t === 'tool_use') return 'tool-use'
  if (t === 'tool_result') return 'tool-result'
  return t
}
