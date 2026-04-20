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

/** Serialize an envelope to a UDP datagram. */
export function serialize(envelope: Envelope): Buffer {
  return Buffer.from(JSON.stringify(envelope))
}

/** Deserialize a UDP datagram to an envelope. Returns null if invalid. */
export function deserialize(data: Buffer): Envelope | null {
  try {
    const parsed = JSON.parse(data.toString()) as Record<string, unknown>
    // Basic validation
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.from !== 'string' ||
      typeof parsed.to !== 'string' ||
      typeof parsed.type !== 'string' ||
      typeof parsed.body !== 'string'
    ) {
      return null
    }
    return parsed as unknown as Envelope
  } catch {
    return null
  }
}
