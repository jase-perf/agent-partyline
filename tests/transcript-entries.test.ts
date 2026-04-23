import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import {
  insertEntry,
  transcriptForUuid,
  listArchivesForSession,
  archiveLabel,
  lastAssistantText,
  entryCount,
  deleteEntriesForUuid,
  attributeSessionName,
  type TranscriptEntryRow,
} from '../src/storage/transcript-entries'
import {
  registerSession,
  archiveSession,
  updateSessionOnConnect,
} from '../src/storage/ccpl-queries'

const mk = (
  uuid: string,
  seq: number,
  kind: string,
  body: Record<string, unknown> = {},
  sessionName: string | null = 'foo',
): TranscriptEntryRow => ({
  cc_session_uuid: uuid,
  seq,
  session_name: sessionName,
  ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  kind,
  uuid: `entry-${seq}`,
  body_json: JSON.stringify(body),
  created_at: Date.now(),
})

describe('transcript-entries queries', () => {
  let db: Database
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-te-'))
    db = openDb(join(dir, 't.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('insertEntry then transcriptForUuid round-trips and orders by seq ASC', () => {
    insertEntry(db, mk('u1', 2, 'assistant-text', { text: 'second' }))
    insertEntry(db, mk('u1', 0, 'user', { text: 'first' }))
    insertEntry(db, mk('u1', 1, 'tool-use', { name: 'Bash' }))
    const rows = transcriptForUuid(db, 'u1', 100)
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2])
  })

  test('insertEntry is idempotent on (cc_session_uuid, seq) PK conflict', () => {
    insertEntry(db, mk('u1', 0, 'user', { text: 'a' }))
    insertEntry(db, mk('u1', 0, 'user', { text: 'b' }))
    const rows = transcriptForUuid(db, 'u1', 100)
    expect(rows.length).toBe(1)
    expect(JSON.parse(rows[0]!.body_json).text).toBe('a')
  })

  test('deleteEntriesForUuid removes only that uuid', () => {
    insertEntry(db, mk('u1', 0, 'user'))
    insertEntry(db, mk('u2', 0, 'user'))
    deleteEntriesForUuid(db, 'u1')
    expect(transcriptForUuid(db, 'u1', 10).length).toBe(0)
    expect(transcriptForUuid(db, 'u2', 10).length).toBe(1)
  })

  test('lastAssistantText returns the highest-seq assistant-text body', () => {
    insertEntry(db, mk('u1', 0, 'user', { text: 'hi' }))
    insertEntry(db, mk('u1', 1, 'assistant-text', { text: 'first reply' }))
    insertEntry(db, mk('u1', 2, 'tool-use', { name: 'Bash' }))
    insertEntry(db, mk('u1', 3, 'assistant-text', { text: 'second reply' }))
    expect(lastAssistantText(db, 'u1')).toBe('second reply')
  })

  test('lastAssistantText returns null when no assistant-text entries exist', () => {
    insertEntry(db, mk('u1', 0, 'user'))
    expect(lastAssistantText(db, 'u1')).toBeNull()
  })

  test('archiveLabel returns last-assistant-text truncated to maxLen', () => {
    insertEntry(db, mk('u1', 0, 'assistant-text', { text: 'a'.repeat(80) }))
    expect(archiveLabel(db, 'u1', 32)?.length).toBe(32)
    expect(archiveLabel(db, 'u1', 32)?.endsWith('…')).toBe(true)
    expect(archiveLabel(db, 'u1', 200)?.length).toBe(80)
  })

  test('entryCount returns total rows for the uuid', () => {
    insertEntry(db, mk('u1', 0, 'user'))
    insertEntry(db, mk('u1', 1, 'assistant-text'))
    expect(entryCount(db, 'u1')).toBe(2)
    expect(entryCount(db, 'never')).toBe(0)
  })

  test('listArchivesForSession returns archived uuids and excludes the live one', () => {
    registerSession(db, 'foo', '/tmp')
    updateSessionOnConnect(db, 'foo', 'live-uuid', 1, 'm')
    archiveSession(db, 'foo', 'old-uuid', 'clear')
    insertEntry(db, mk('live-uuid', 0, 'assistant-text', { text: 'live label' }))
    insertEntry(db, mk('old-uuid', 0, 'assistant-text', { text: 'old label' }))

    const result = listArchivesForSession(db, 'foo', 32)
    expect(result.live?.uuid).toBe('live-uuid')
    expect(result.live?.label).toBe('live label')
    expect(result.live?.entry_count).toBe(1)
    expect(result.archives).toHaveLength(1)
    expect(result.archives[0]!.uuid).toBe('old-uuid')
    expect(result.archives[0]!.label).toBe('old label')
    expect(result.archives[0]!.entry_count).toBe(1)
  })

  test('listArchivesForSession folds duplicate archive rows to most-recent archived_at', () => {
    registerSession(db, 'foo', '/tmp')
    archiveSession(db, 'foo', 'u1', 'clear')
    archiveSession(db, 'foo', 'u1', 'rotate_uuid_drift')
    archiveSession(db, 'foo', 'u2', 'clear')
    insertEntry(db, mk('u1', 0, 'assistant-text'))
    insertEntry(db, mk('u2', 0, 'assistant-text'))
    const { archives } = listArchivesForSession(db, 'foo', 32)
    expect(archives.length).toBe(2)
    expect(archives.filter((a) => a.uuid === 'u1').length).toBe(1)
  })

  test('attributeSessionName fills in NULL session_name for a uuid', () => {
    insertEntry(db, mk('u1', 0, 'user', {}, null))
    insertEntry(db, mk('u1', 1, 'user', {}, null))
    insertEntry(db, mk('u2', 0, 'user', {}, 'other'))
    attributeSessionName(db, 'u1', 'foo')
    const u1 = transcriptForUuid(db, 'u1', 10)
    expect(u1.every((r) => r.session_name === 'foo')).toBe(true)
    const u2 = transcriptForUuid(db, 'u2', 10)
    expect(u2[0]!.session_name).toBe('other')
  })
})
