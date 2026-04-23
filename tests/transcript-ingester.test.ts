import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import { JsonlObserver } from '../src/observers/jsonl'
import { TranscriptIngester } from '../src/observers/transcript-ingester'
import {
  insertEntry,
  transcriptForUuid,
  attributeSessionName,
} from '../src/storage/transcript-entries'

describe('TranscriptIngester', () => {
  let db: Database
  let dir: string
  let projectsRoot: string
  let observer: JsonlObserver

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pl-ti-'))
    db = openDb(join(dir, 't.db'))
    projectsRoot = join(dir, 'projects')
    mkdirSync(projectsRoot, { recursive: true })
    observer = new JsonlObserver(projectsRoot, 50)
  })

  afterEach(async () => {
    observer.stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('streams new jsonl lines into transcript_entries', async () => {
    const cwd = join(projectsRoot, 'p1')
    mkdirSync(cwd, { recursive: true })
    const jsonl = join(cwd, 'uuid-1.jsonl')
    writeFileSync(jsonl, '')
    const ingester = new TranscriptIngester(db, projectsRoot)
    ingester.subscribe(observer)
    await observer.start()
    await new Promise((r) => setTimeout(r, 100))

    appendFileSync(
      jsonl,
      JSON.stringify({ type: 'user', uuid: 'e1', timestamp: '2026-04-22T00:00:00Z' }) +
        '\n' +
        JSON.stringify({ type: 'assistant', uuid: 'e2', timestamp: '2026-04-22T00:00:01Z' }) +
        '\n',
    )
    await new Promise((r) => setTimeout(r, 200))

    const rows = transcriptForUuid(db, 'uuid-1', 100)
    expect(rows.length).toBe(2)
    expect(rows[0]!.kind).toBe('user')
    expect(rows[1]!.kind).toBe('assistant-text')
    expect(rows[0]!.uuid).toBe('e1')
    expect(rows[1]!.uuid).toBe('e2')
  })

  test('seq monotonically increments per uuid across polls', async () => {
    const cwd = join(projectsRoot, 'p2')
    mkdirSync(cwd, { recursive: true })
    const jsonl = join(cwd, 'uuid-2.jsonl')
    writeFileSync(jsonl, '')
    const ingester = new TranscriptIngester(db, projectsRoot)
    ingester.subscribe(observer)
    await observer.start()
    await new Promise((r) => setTimeout(r, 100))

    appendFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'a' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    appendFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'b' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))

    const rows = transcriptForUuid(db, 'uuid-2', 100)
    expect(rows.map((r) => r.seq)).toEqual([0, 1])
  })

  test('reset (file shrink) deletes existing rows so re-ingest is clean', async () => {
    const cwd = join(projectsRoot, 'p3')
    mkdirSync(cwd, { recursive: true })
    const jsonl = join(cwd, 'uuid-3.jsonl')
    writeFileSync(jsonl, '')
    const ingester = new TranscriptIngester(db, projectsRoot)
    ingester.subscribe(observer)
    await observer.start()
    await new Promise((r) => setTimeout(r, 100))

    // Pad the first entry so the post-reset file is strictly smaller — the
    // JsonlObserver only fires onReset when stat size < previous size.
    appendFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'a', pad: 'x'.repeat(200) }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    expect(transcriptForUuid(db, 'uuid-3', 10).length).toBe(1)

    // Truncate to empty — observer detects shrink, fires reset (deletes rows).
    writeFileSync(jsonl, '')
    await new Promise((r) => setTimeout(r, 150))
    // Now append the replacement content; observer treats it as a normal append.
    appendFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'b' }) + '\n')
    await new Promise((r) => setTimeout(r, 200))

    const rows = transcriptForUuid(db, 'uuid-3', 10)
    expect(rows.length).toBe(1)
    expect(rows[0]!.uuid).toBe('b')
  })

  test('attributes session_name when ccpl_sessions has the uuid', async () => {
    db.query(
      `INSERT INTO ccpl_sessions
        (name, token, cwd, cc_session_uuid, online, revision, created_at, last_active_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('foo', 'tok-foo', '/tmp', 'uuid-4', Date.now(), Date.now())
    const cwd = join(projectsRoot, 'p4')
    mkdirSync(cwd, { recursive: true })
    const jsonl = join(cwd, 'uuid-4.jsonl')
    writeFileSync(jsonl, '')
    const ingester = new TranscriptIngester(db, projectsRoot)
    ingester.subscribe(observer)
    await observer.start()
    await new Promise((r) => setTimeout(r, 100))

    appendFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'x' }) + '\n')
    await new Promise((r) => setTimeout(r, 200))

    const rows = transcriptForUuid(db, 'uuid-4', 10)
    expect(rows[0]!.session_name).toBe('foo')
  })

  test('backfillFromUuid bulk-inserts the entire jsonl file when no rows exist', async () => {
    const cwd = join(projectsRoot, 'p5')
    mkdirSync(cwd, { recursive: true })
    const jsonl = join(cwd, 'stranger-uuid.jsonl')
    writeFileSync(
      jsonl,
      JSON.stringify({ type: 'user', uuid: 'h1', text: 'past 1' }) +
        '\n' +
        JSON.stringify({ type: 'assistant', uuid: 'h2', text: 'past 2' }) +
        '\n' +
        JSON.stringify({ type: 'user', uuid: 'h3', text: 'past 3' }) +
        '\n',
    )
    const ingester = new TranscriptIngester(db, projectsRoot)
    const inserted = ingester.backfillFromUuid('stranger-uuid')
    expect(inserted).toBe(3)
    const rows = transcriptForUuid(db, 'stranger-uuid', 100)
    expect(rows.length).toBe(3)
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2])
    expect(rows.map((r) => r.kind)).toEqual(['user', 'assistant-text', 'user'])
  })

  test('backfillFromUuid is a no-op when entries already exist for that uuid', async () => {
    insertEntry(db, {
      cc_session_uuid: 'already',
      seq: 0,
      session_name: null,
      ts: new Date().toISOString(),
      kind: 'user',
      uuid: 'pre',
      body_json: '{}',
      created_at: Date.now(),
    })
    const cwd = join(projectsRoot, 'p6')
    mkdirSync(cwd, { recursive: true })
    const jsonl = join(cwd, 'already.jsonl')
    writeFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'x' }) + '\n')
    const ingester = new TranscriptIngester(db, projectsRoot)
    const inserted = ingester.backfillFromUuid('already')
    expect(inserted).toBe(0)
    const rows = transcriptForUuid(db, 'already', 10)
    expect(rows.length).toBe(1)
    expect(rows[0]!.uuid).toBe('pre')
  })

  test('backfillFromUuid returns 0 when no jsonl file is found anywhere under projectsRoot', () => {
    const ingester = new TranscriptIngester(db, projectsRoot)
    expect(ingester.backfillFromUuid('does-not-exist')).toBe(0)
    expect(transcriptForUuid(db, 'does-not-exist', 10).length).toBe(0)
  })
})
