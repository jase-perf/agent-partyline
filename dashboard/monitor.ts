/**
 * monitor.ts — Shared party line monitor used by both the web dashboard and CLI.
 *
 * Joins the multicast group as a passive listener (with its own session name
 * "dashboard" or custom), tracks presence, records message history, and
 * provides methods for sending messages.
 */

import { UdpMulticastTransport } from '../src/transport/udp-multicast.js'
import { PresenceTracker } from '../src/presence.js'
import { createEnvelope, generateCallbackId } from '../src/protocol.js'
import type { Envelope, KnownSession, MessageType } from '../src/types.js'

export type MessageListener = (envelope: Envelope) => void

export class PartyLineMonitor {
  private transport: UdpMulticastTransport
  private presence: PresenceTracker
  private history: Envelope[] = []
  private maxHistory: number
  private listeners: MessageListener[] = []
  readonly sessionName: string

  constructor(sessionName: string = 'dashboard', maxHistory: number = 500) {
    this.sessionName = sessionName
    this.maxHistory = maxHistory
    this.transport = new UdpMulticastTransport(sessionName, {}, true)
    this.presence = new PresenceTracker(this.transport, sessionName, {
      description: `Party Line Monitor: ${sessionName}`,
    })
  }

  async start(): Promise<void> {
    await this.transport.start((envelope) => {
      this.presence.handleMessage(envelope)
      this.history.push(envelope)
      if (this.history.length > this.maxHistory) this.history.shift()
      for (const listener of this.listeners) {
        listener(envelope)
      }
    })
    await this.presence.start()
  }

  stop(): void {
    this.presence.stop()
    this.transport.stop()
  }

  /** Subscribe to all inbound messages. */
  onMessage(listener: MessageListener): void {
    this.listeners.push(listener)
  }

  /** Remove a message listener. */
  offMessage(listener: MessageListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener)
  }

  /** Send a message to a session or broadcast. */
  async send(to: string, body: string, type: MessageType = 'message'): Promise<Envelope> {
    const callbackId = type === 'request' ? generateCallbackId() : null
    const envelope = createEnvelope(this.sessionName, to, type, body, callbackId)
    await this.transport.send(envelope)
    this.history.push(envelope)
    return envelope
  }

  /** Send a pre-built envelope (e.g. constructed by a helper). */
  async sendEnvelope(envelope: Envelope): Promise<Envelope> {
    await this.transport.send(envelope)
    this.history.push(envelope)
    return envelope
  }

  /** Respond to a request by callback_id. */
  async respond(to: string, callbackId: string, body: string): Promise<Envelope> {
    const envelope = createEnvelope(this.sessionName, to, 'response', body, null, callbackId)
    await this.transport.send(envelope)
    this.history.push(envelope)
    return envelope
  }

  /** Get known sessions. */
  getSessions(): KnownSession[] {
    return this.presence.listSessions()
  }

  /** Get message history (optionally filtered). */
  getHistory(options: { limit?: number; excludeHeartbeats?: boolean } = {}): Envelope[] {
    const { limit = 50, excludeHeartbeats = true } = options
    let filtered = this.history
    if (excludeHeartbeats) {
      filtered = filtered.filter((m) => m.type !== 'heartbeat')
    }
    return filtered.slice(-limit)
  }
}
