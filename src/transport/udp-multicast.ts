/**
 * udp-multicast.ts — UDP multicast transport adapter.
 *
 * Handles joining/leaving the multicast group, sending datagrams
 * (with send-twice reliability), and receiving messages.
 */

import { createSocket, type Socket } from 'node:dgram'
import type { Envelope, TransportConfig } from '../types.js'
import { DEFAULT_TRANSPORT_CONFIG } from '../types.js'
import { serialize, deserialize, Deduplicator } from '../protocol.js'

export type MessageHandler = (envelope: Envelope) => void

export class UdpMulticastTransport {
  private socket: Socket | null = null
  private config: TransportConfig
  private sessionName: string
  private dedup = new Deduplicator()
  private onMessage: MessageHandler | null = null
  private pruneTimer: ReturnType<typeof setInterval> | null = null

  constructor(sessionName: string, config: Partial<TransportConfig> = {}) {
    this.sessionName = sessionName
    this.config = { ...DEFAULT_TRANSPORT_CONFIG, ...config }
  }

  /** Start listening on the multicast group. */
  async start(handler: MessageHandler): Promise<void> {
    this.onMessage = handler

    return new Promise((resolve, reject) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true })
      this.socket = socket

      socket.on('error', (err) => {
        process.stderr.write(`[party-line:transport] Socket error: ${err.message}\n`)
        reject(err)
      })

      socket.on('message', (data: Buffer) => {
        const envelope = deserialize(data)
        if (!envelope) return

        // Deduplicate (send-twice means we'll see each message twice)
        if (this.dedup.isDuplicate(envelope.id)) return

        // Don't deliver our own messages back to ourselves
        if (envelope.from === this.sessionName) return

        this.onMessage?.(envelope)
      })

      socket.bind(this.config.port, () => {
        socket.addMembership(this.config.multicastAddress)
        socket.setMulticastTTL(this.config.ttl)
        socket.setMulticastLoopback(this.config.loopback)

        // Prune dedup set periodically
        this.pruneTimer = setInterval(() => this.dedup.prune(), 30_000)

        resolve()
      })
    })
  }

  /** Send a message to the multicast group (with send-twice reliability). */
  async send(envelope: Envelope): Promise<void> {
    if (!this.socket) throw new Error('Transport not started')

    const buf = serialize(envelope)
    const { multicastAddress, port, sendTwiceDelayMs } = this.config

    // First send
    await this.sendDatagram(buf, multicastAddress, port)

    // Second send after delay
    setTimeout(() => {
      this.sendDatagram(buf, multicastAddress, port).catch(() => {
        // Best-effort retry — if this fails too, we've done what we can
      })
    }, sendTwiceDelayMs)
  }

  /** Update the session name (used when session renames itself). */
  rename(newName: string): void {
    this.sessionName = newName
  }

  /** Stop listening and leave the multicast group. */
  stop(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    if (this.socket) {
      try {
        this.socket.dropMembership(this.config.multicastAddress)
      } catch {
        // May fail if already dropped
      }
      this.socket.close()
      this.socket = null
    }
  }

  private sendDatagram(buf: Buffer, address: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket?.send(buf, 0, buf.length, port, address, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}
