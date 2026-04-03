/**
 * protocol.ts — Message creation, serialization, and deduplication.
 */

import { randomBytes } from 'crypto'
import type { Envelope, MessageType } from './types.js'
import { DEDUP_WINDOW_MS } from './types.js'

let sequenceCounter = 0

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
    seq: sequenceCounter++,
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

/**
 * Deduplication tracker. Keeps a set of recently seen message IDs
 * and prunes them periodically.
 */
export class Deduplicator {
  private seen = new Map<string, number>() // id → timestamp

  /** Returns true if this message has already been seen. */
  isDuplicate(id: string): boolean {
    if (this.seen.has(id)) return true
    this.seen.set(id, Date.now())
    return false
  }

  /** Remove entries older than the dedup window. */
  prune(): void {
    const cutoff = Date.now() - DEDUP_WINDOW_MS
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id)
    }
  }
}
