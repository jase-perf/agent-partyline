import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { rmSync, mkdtempSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDb } from '../src/storage/db.js'
import {
  insertAttachment,
  getAttachment,
  linkAttachmentsToEnvelope,
  attachmentRowToMeta,
} from '../src/storage/attachments.js'

/**
 * These tests cover the attachment-storage layer and the metadata shape the
 * /api/upload endpoint returns. The endpoint itself is exercised by a
 * Bun.serve fixture that mirrors the relevant slice of dashboard/serve.ts —
 * starting the real dashboard from a test is too heavy.
 */

const DB_PATH = '/tmp/party-line-attachments-api.db'
const TOKEN = 'tkn-att-api'

// Minimal upload handler that mirrors dashboard/serve.ts. Kept in the test
// so changes to the production handler are caught by adjusting this copy.
function buildUploadHandler(
  db: ReturnType<typeof openDb>,
  storageRoot: string,
  maxBytes: number,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.headers.get('x-party-line-token') !== TOKEN) {
      return new Response('Unauthorized', { status: 401 })
    }
    const form = await req.formData().catch(() => null)
    if (!form) return Response.json({ error: 'bad body' }, { status: 400 })
    const file = form.get('file')
    if (!(file instanceof Blob)) return Response.json({ error: 'no file' }, { status: 400 })
    if (file.size > maxBytes) return Response.json({ error: 'too large' }, { status: 413 })
    const name = ((file as unknown as { name?: string }).name as string | undefined) || 'att'
    const media_type = file.type || 'application/octet-stream'
    const id = Math.random().toString(16).slice(2, 18) + Math.random().toString(16).slice(2, 18)
    const storedPath = join(storageRoot, `${id}.bin`)
    writeFileSync(storedPath, Buffer.from(await file.arrayBuffer()))
    insertAttachment(db, {
      id,
      uploader_session: 'testsession',
      name,
      media_type,
      size: file.size,
      stored_path: storedPath,
      expires_at: Date.now() + 60_000,
    })
    return Response.json(attachmentRowToMeta(getAttachment(db, id)!))
  }
}

describe('upload endpoint shape (fixture handler)', () => {
  let db: ReturnType<typeof openDb>
  let storageRoot: string
  const MAX = 1024 * 10

  beforeAll(() => {
    try {
      rmSync(DB_PATH)
    } catch {
      /* no-op */
    }
    db = openDb(DB_PATH)
    storageRoot = mkdtempSync(join(tmpdir(), 'pl-api-'))
  })

  afterAll(() => {
    db.close()
    rmSync(storageRoot, { recursive: true, force: true })
    try {
      rmSync(DB_PATH)
    } catch {
      /* no-op */
    }
  })

  test('POST /api/upload returns Attachment metadata', async () => {
    const handler = buildUploadHandler(db, storageRoot, MAX)
    const form = new FormData()
    form.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'greet.txt')
    const res = await handler(
      new Request('http://x/api/upload', {
        method: 'POST',
        body: form,
        headers: { 'x-party-line-token': TOKEN },
      }),
    )
    expect(res.status).toBe(200)
    const meta = (await res.json()) as {
      id: string
      kind: string
      name: string
      media_type: string
      size: number
      url: string
    }
    expect(meta.name).toBe('greet.txt')
    expect(meta.kind).toBe('file')
    expect(meta.media_type.startsWith('text/plain')).toBe(true)
    expect(meta.size).toBe('hello world'.length)
    expect(meta.url).toBe('/api/attachment/' + meta.id)
    expect(existsSync(getAttachment(db, meta.id)!.stored_path)).toBe(true)
  })

  test('image upload → kind is "image"', async () => {
    const handler = buildUploadHandler(db, storageRoot, MAX)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), 'a.png')
    const res = await handler(
      new Request('http://x/api/upload', {
        method: 'POST',
        body: form,
        headers: { 'x-party-line-token': TOKEN },
      }),
    )
    expect(res.status).toBe(200)
    const meta = (await res.json()) as { kind: string; media_type: string }
    expect(meta.kind).toBe('image')
    expect(meta.media_type).toBe('image/png')
  })

  test('rejects file over size cap with 413', async () => {
    const handler = buildUploadHandler(db, storageRoot, MAX)
    const big = Buffer.alloc(MAX + 1, 0x41)
    const form = new FormData()
    form.append('file', new Blob([big], { type: 'application/octet-stream' }), 'big.bin')
    const res = await handler(
      new Request('http://x/api/upload', {
        method: 'POST',
        body: form,
        headers: { 'x-party-line-token': TOKEN },
      }),
    )
    expect(res.status).toBe(413)
  })

  test('rejects upload without auth token with 401', async () => {
    const handler = buildUploadHandler(db, storageRoot, MAX)
    const form = new FormData()
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt')
    const res = await handler(new Request('http://x/api/upload', { method: 'POST', body: form }))
    expect(res.status).toBe(401)
  })

  test('rejects upload with bogus body with 400', async () => {
    const handler = buildUploadHandler(db, storageRoot, MAX)
    const res = await handler(
      new Request('http://x/api/upload', {
        method: 'POST',
        body: 'not multipart',
        headers: { 'x-party-line-token': TOKEN, 'Content-Type': 'text/plain' },
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('envelope → attachment wiring', () => {
  let db: ReturnType<typeof openDb>
  let storageRoot: string

  beforeEach(() => {
    try {
      rmSync(DB_PATH)
    } catch {
      /* no-op */
    }
    db = openDb(DB_PATH)
    storageRoot = mkdtempSync(join(tmpdir(), 'pl-env-'))
  })

  test('linkAttachmentsToEnvelope + attachmentRowToMeta produce routable metadata', () => {
    for (const id of ['a', 'b']) {
      insertAttachment(db, {
        id,
        uploader_session: 's',
        name: `${id}.bin`,
        media_type: 'image/png',
        size: 10,
        stored_path: join(storageRoot, `${id}.bin`),
        expires_at: Date.now() + 1_000_000,
      })
    }
    linkAttachmentsToEnvelope(db, 'env-abc', ['a', 'b'])
    const aMeta = attachmentRowToMeta(getAttachment(db, 'a')!)
    expect(aMeta.kind).toBe('image')
    expect(aMeta.url).toBe('/api/attachment/a')
    expect(getAttachment(db, 'a')!.envelope_id).toBe('env-abc')
    db.close()
  })
})
