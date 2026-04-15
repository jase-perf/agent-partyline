/**
 * presence.ts — Session presence tracking via heartbeats.
 *
 * Tracks which sessions are online based on heartbeat messages.
 * Handles announce (on join) and periodic heartbeat sending.
 */

import type { Envelope, KnownSession, SessionMetadata } from './types.js'
import { HEARTBEAT_INTERVAL_MS, SESSION_TIMEOUT_MS } from './types.js'
import { createEnvelope } from './protocol.js'
import type { UdpMulticastTransport } from './transport/udp-multicast.js'

export class PresenceTracker {
  private sessions = new Map<string, KnownSession>()
  private transport: UdpMulticastTransport
  private sessionName: string
  private metadata: SessionMetadata
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private statusProvider: (() => SessionMetadata['status']) | null = null

  constructor(
    transport: UdpMulticastTransport,
    sessionName: string,
    metadata: SessionMetadata = {},
  ) {
    this.transport = transport
    this.sessionName = sessionName
    this.metadata = metadata
  }

  /** Register a callback that provides live status for heartbeats. */
  setStatusProvider(provider: () => SessionMetadata['status']): void {
    this.statusProvider = provider
  }

  /** Start sending heartbeats and announce our presence. */
  async start(): Promise<void> {
    // Announce ourselves
    await this.sendAnnounce()

    // Periodic heartbeat
    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat()
      this.pruneStale()
    }, HEARTBEAT_INTERVAL_MS)
  }

  /** Stop heartbeats. */
  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
  }

  /** Process an inbound envelope for presence information. */
  handleMessage(envelope: Envelope): void {
    if (envelope.type === 'heartbeat' || envelope.type === 'announce') {
      let meta: SessionMetadata = {}
      try {
        meta = JSON.parse(envelope.body) as SessionMetadata
      } catch {
        // Body might just be a plain string, that's fine
      }

      this.sessions.set(envelope.from, {
        name: envelope.from,
        lastSeen: Date.now(),
        metadata: meta,
      })

      // When we hear a new session announce, respond with our heartbeat
      // so they discover us quickly (instead of waiting up to 30s)
      if (envelope.type === 'announce' && envelope.from !== this.sessionName) {
        const jitter = Math.floor(Math.random() * 400) + 100
        setTimeout(() => void this.sendHeartbeat(), jitter)
      }
    }
  }

  /** Get all known sessions (including ourselves). */
  listSessions(): KnownSession[] {
    // Always include ourselves
    const self: KnownSession = {
      name: this.sessionName,
      lastSeen: Date.now(),
      metadata: this.metadata,
    }

    const others = Array.from(this.sessions.values())
    return [self, ...others.filter((s) => s.name !== this.sessionName)]
  }

  /** Check if a specific session is online. */
  isOnline(name: string): boolean {
    if (name === this.sessionName) return true
    const session = this.sessions.get(name)
    if (!session) return false
    return Date.now() - session.lastSeen < SESSION_TIMEOUT_MS
  }

  /** Rename this session and re-announce to the network. */
  async rename(newName: string): Promise<void> {
    this.sessions.delete(this.sessionName)
    this.sessionName = newName
    this.metadata = { ...this.metadata, description: `Claude Code session: ${newName}` }
    await this.sendAnnounce()
  }

  private async sendHeartbeat(): Promise<void> {
    const meta: SessionMetadata = { ...this.metadata }
    if (this.statusProvider) {
      meta.status = this.statusProvider() ?? undefined
    }
    const envelope = createEnvelope(
      this.sessionName,
      'all',
      'heartbeat',
      JSON.stringify(meta),
    )
    await this.transport.send(envelope).catch(() => {})
  }

  private async sendAnnounce(): Promise<void> {
    const envelope = createEnvelope(
      this.sessionName,
      'all',
      'announce',
      JSON.stringify(this.metadata),
    )
    await this.transport.send(envelope).catch(() => {})
  }

  private pruneStale(): void {
    const cutoff = Date.now() - SESSION_TIMEOUT_MS
    for (const [name, session] of this.sessions) {
      if (session.lastSeen < cutoff) {
        this.sessions.delete(name)
      }
    }
  }
}
