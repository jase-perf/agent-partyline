/**
 * protocol.ts — Message creation and serialization.
 */

import { randomBytes } from 'crypto'
import type { Envelope, MessageType } from './types.js'

/** Generate a unique message ID. */
export function generateId(): string {
  return randomBytes(8).toString('hex')
}

/** Generate a short callback ID for request/response patterns. */
export function generateCallbackId(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}

/** Create a message envelope. */
export function createEnvelope(
  from: string,
  to: string,
  type: MessageType,
  body: string,
  callbackId: string | null = null,
  responseTo: string | null = null,
): Envelope {
  return {
    id: generateId(),
    from,
    to,
    type,
    body,
    callback_id: callbackId,
    response_to: responseTo,
    ts: new Date().toISOString(),
  }
}
