import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdtempSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDb } from '../src/storage/db.js'
import {
  insertAttachment,
  getAttachment,
  linkAttachmentsToEnvelope,
  attachmentRowToMeta,
  listExpiredAttachments,
  deleteAttachment,
} from '../src/storage/attachments.js'
import { pruneExpiredAttachments } from '../src/storage/retention.js'

const DB_PATH = '/tmp/party-line-attachments-test.db'

describe('attachments storage', () => {
  let tempRoot: string
  beforeEach(() => {
    try {
      rmSync(DB_PATH)
    } catch {
      /* no-op */
    }
    tempRoot = mkdtempSync(join(tmpdir(), 'pl-att-'))
  })
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('insert + getAttachment roundtrip', () => {
    const db = openDb(DB_PATH)
    insertAttachment(db, {
      id: 'att1',
      uploader_session: 'alice',
      name: 'chart.png',
      media_type: 'image/png',
      size: 1024,
      stored_path: '/tmp/foo/file',
      expires_at: Date.now() + 1_000_000,
    })
    const row = getAttachment(db, 'att1')
    expect(row).not.toBeNull()
    expect(row!.id).toBe('att1')
    expect(row!.name).toBe('chart.png')
    expect(row!.media_type).toBe('image/png')
    expect(row!.size).toBe(1024)
    expect(row!.uploader_session).toBe('alice')
    expect(row!.envelope_id).toBeNull()
    db.close()
  })

  test('attachmentRowToMeta marks image vs file by media_type prefix', () => {
    const db = openDb(DB_PATH)
    insertAttachment(db, {
      id: 'img',
      uploader_session: 'a',
      name: 'x.png',
      media_type: 'image/png',
      size: 1,
      stored_path: '/t',
      expires_at: Date.now() + 1000,
    })
    insertAttachment(db, {
      id: 'doc',
      uploader_session: 'a',
      name: 'x.pdf',
      media_type: 'application/pdf',
      size: 1,
      stored_path: '/t',
      expires_at: Date.now() + 1000,
    })
    const img = attachmentRowToMeta(getAttachment(db, 'img')!)
    const doc = attachmentRowToMeta(getAttachment(db, 'doc')!)
    expect(img.kind).toBe('image')
    expect(img.url).toBe('/api/attachment/img')
    expect(doc.kind).toBe('file')
    expect(doc.url).toBe('/api/attachment/doc')
    db.close()
  })

  test('linkAttachmentsToEnvelope stamps envelope_id on multiple rows', () => {
    const db = openDb(DB_PATH)
    for (const id of ['a', 'b', 'c']) {
      insertAttachment(db, {
        id,
        uploader_session: 'u',
        name: id,
        media_type: 'text/plain',
        size: 1,
        stored_path: '/t',
        expires_at: Date.now() + 1000,
      })
    }
    linkAttachmentsToEnvelope(db, 'env-99', ['a', 'c'])
    expect(getAttachment(db, 'a')!.envelope_id).toBe('env-99')
    expect(getAttachment(db, 'b')!.envelope_id).toBeNull()
    expect(getAttachment(db, 'c')!.envelope_id).toBe('env-99')
    db.close()
  })

  test('listExpiredAttachments returns only rows past cutoff', () => {
    const db = openDb(DB_PATH)
    const now = Date.now()
    insertAttachment(db, {
      id: 'past',
      uploader_session: 'u',
      name: 'p',
      media_type: 'text/plain',
      size: 1,
      stored_path: '/t/p',
      expires_at: now - 10_000,
    })
    insertAttachment(db, {
      id: 'future',
      uploader_session: 'u',
      name: 'f',
      media_type: 'text/plain',
      size: 1,
      stored_path: '/t/f',
      expires_at: now + 10_000,
    })
    const expired = listExpiredAttachments(db, now)
    expect(expired.map((x) => x.id).sort()).toEqual(['past'])
    db.close()
  })

  test('deleteAttachment removes the row', () => {
    const db = openDb(DB_PATH)
    insertAttachment(db, {
      id: 'gone',
      uploader_session: 'u',
      name: 'g',
      media_type: 'text/plain',
      size: 1,
      stored_path: '/t',
      expires_at: Date.now() + 1000,
    })
    expect(getAttachment(db, 'gone')).not.toBeNull()
    deleteAttachment(db, 'gone')
    expect(getAttachment(db, 'gone')).toBeNull()
    db.close()
  })
})

describe('pruneExpiredAttachments', () => {
  let tempRoot: string
  beforeEach(() => {
    try {
      rmSync(DB_PATH)
    } catch {
      /* no-op */
    }
    tempRoot = mkdtempSync(join(tmpdir(), 'pl-prune-'))
  })
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('deletes rows past expiry and removes the file on disk', () => {
    const db = openDb(DB_PATH)
    const filePath = join(tempRoot, 'expired.bin')
    writeFileSync(filePath, 'data')
    expect(existsSync(filePath)).toBe(true)

    const now = Date.now()
    insertAttachment(db, {
      id: 'expired',
      uploader_session: 'u',
      name: 'expired.bin',
      media_type: 'application/octet-stream',
      size: 4,
      stored_path: filePath,
      expires_at: now - 1000,
    })
    insertAttachment(db, {
      id: 'alive',
      uploader_session: 'u',
      name: 'alive.bin',
      media_type: 'application/octet-stream',
      size: 4,
      stored_path: join(tempRoot, 'alive.bin'),
      expires_at: now + 60_000,
    })

    const pruned = pruneExpiredAttachments(db, now)
    expect(pruned).toBe(1)
    expect(existsSync(filePath)).toBe(false)
    expect(getAttachment(db, 'expired')).toBeNull()
    expect(getAttachment(db, 'alive')).not.toBeNull()
    db.close()
  })

  test('returns 0 when nothing is expired', () => {
    const db = openDb(DB_PATH)
    insertAttachment(db, {
      id: 'x',
      uploader_session: 'u',
      name: 'x',
      media_type: 'text/plain',
      size: 1,
      stored_path: join(tempRoot, 'x'),
      expires_at: Date.now() + 60_000,
    })
    expect(pruneExpiredAttachments(db, Date.now())).toBe(0)
    db.close()
  })

  test('does not throw when the on-disk file is already missing', () => {
    const db = openDb(DB_PATH)
    insertAttachment(db, {
      id: 'orphan',
      uploader_session: 'u',
      name: 'o',
      media_type: 'text/plain',
      size: 1,
      stored_path: join(tempRoot, 'never-existed'),
      expires_at: Date.now() - 1000,
    })
    expect(pruneExpiredAttachments(db, Date.now())).toBe(1)
    db.close()
  })
})
