import type { Database } from 'bun:sqlite'
import { verifyToken } from './auth.js'
import { validateHookEvent, type HookEvent } from '../events.js'
import { insertEvent } from '../storage/queries.js'

export interface IngestOptions {
  db: Database
  token: string
  onEvent: (ev: HookEvent) => void
}

export async function handleIngest(req: Request, opts: IngestOptions): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const received = req.headers.get('X-Party-Line-Token')
  if (!verifyToken(opts.token, received)) {
    return new Response('Unauthorized', { status: 401 })
  }
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }
  let ev: HookEvent
  try {
    ev = validateHookEvent(raw)
  } catch (err) {
    return new Response(`Invalid event: ${(err as Error).message}`, { status: 400 })
  }
  try {
    insertEvent(opts.db, ev)
    opts.onEvent(ev)
  } catch (err) {
    return new Response(`Storage error: ${(err as Error).message}`, { status: 500 })
  }
  return Response.json({ ok: true })
}
