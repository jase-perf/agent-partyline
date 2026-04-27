import { EventEmitter } from 'node:events'

export interface HelloPayload {
  type: 'hello'
  token: string
  name: string
  cc_session_uuid: string | null
  pid: number
  machine_id: string | null
  version: string
}

export interface WsClientOpts {
  url: string
  /**
   * Hello payload to send on every (re)connect. Accept a factory so the
   * caller can freshen dynamic fields like cc_session_uuid at connect time
   * instead of sending a stale snapshot captured at module-load.
   */
  helloPayload: HelloPayload | (() => HelloPayload)
  pingIntervalMs?: number
  pongTimeoutMs?: number
  reconnectInitialMs?: number
  reconnectMaxMs?: number
  logger?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export interface WsClient extends EventEmitter {
  start(): void
  stop(): void
  send(frame: unknown): void
  isConnected(): boolean
}

export function createWsClient(opts: WsClientOpts): WsClient {
  const emitter = new EventEmitter() as WsClient
  let ws: WebSocket | null = null
  let pingTimer: Timer | null = null
  let pongCheckTimer: Timer | null = null
  let reconnectTimer: Timer | null = null
  let reconnectDelay = opts.reconnectInitialMs ?? 100
  let stopped = false
  let lastPongAt = 0
  const log = opts.logger ?? (() => {})

  function setPingTimer(): void {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
        } catch {
          /* ignore send errors on closing socket */
        }
      }
    }, opts.pingIntervalMs ?? 20_000)
  }

  function setPongCheckTimer(): void {
    if (pongCheckTimer) clearInterval(pongCheckTimer)
    const timeout = opts.pongTimeoutMs ?? 60_000
    pongCheckTimer = setInterval(
      () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        if (Date.now() - lastPongAt > timeout) {
          log('warn', `pong timeout (${timeout}ms since last frame); force-close`)
          try {
            ws.close(4000, 'pong_timeout')
          } catch {
            /* ignore */
          }
        }
      },
      Math.min(opts.pingIntervalMs ?? 20_000, 10_000),
    )
  }

  function scheduleReconnect(): void {
    if (stopped) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, opts.reconnectMaxMs ?? 30_000)
  }

  function isLocalhost(url: string): boolean {
    try {
      const h = new URL(url).hostname
      return h === 'localhost' || h === '127.0.0.1' || h === '::1'
    } catch {
      return false
    }
  }

  function connect(): void {
    if (stopped) return
    try {
      // For localhost WSS, accept self-signed certs. Token auth + local-only
      // listener already gate access; NODE_TLS_REJECT_UNAUTHORIZED does not
      // propagate reliably from claude CLI to MCP children.
      if (opts.url.startsWith('wss:') && isLocalhost(opts.url)) {
        const WS = WebSocket as unknown as new (url: string, opts: unknown) => WebSocket
        ws = new WS(opts.url, { tls: { rejectUnauthorized: false } })
      } else {
        ws = new WebSocket(opts.url)
      }
    } catch (err) {
      log('error', `ws construct failed: ${String(err)}`)
      scheduleReconnect()
      return
    }

    ws.addEventListener('open', () => {
      log('info', `ws open to ${opts.url}`)
      reconnectDelay = opts.reconnectInitialMs ?? 100
      lastPongAt = Date.now()
      try {
        const payload =
          typeof opts.helloPayload === 'function' ? opts.helloPayload() : opts.helloPayload
        ws!.send(JSON.stringify(payload))
      } catch (err) {
        log('error', `hello send failed: ${String(err)}`)
      }
      setPingTimer()
      setPongCheckTimer()
      emitter.emit('open')
    })

    ws.addEventListener('message', (e) => {
      lastPongAt = Date.now() // ANY frame from the server proves liveness
      let data: { type?: string }
      try {
        data = JSON.parse(e.data as string) as { type?: string }
      } catch {
        log('warn', 'non-JSON frame dropped')
        return
      }
      emitter.emit('frame', data)
      if (typeof data.type === 'string') emitter.emit(data.type, data)
    })

    ws.addEventListener('close', (e) => {
      log('warn', `ws close code=${e.code} reason=${e.reason}`)
      if (pingTimer) {
        clearInterval(pingTimer)
        pingTimer = null
      }
      if (pongCheckTimer) {
        clearInterval(pongCheckTimer)
        pongCheckTimer = null
      }
      emitter.emit('close', e.code, e.reason)
      // Permanent failures: don't reconnect.
      if (e.code === 4401 || e.code === 4408) {
        log('error', `permanent ws close, not reconnecting (code ${e.code})`)
        stopped = true
        return
      }
      scheduleReconnect()
    })

    ws.addEventListener('error', (e) => {
      log('warn', `ws error: ${String(e)}`)
    })
  }

  emitter.start = () => {
    stopped = false
    connect()
  }
  emitter.stop = () => {
    stopped = true
    if (pingTimer) clearInterval(pingTimer)
    if (pongCheckTimer) clearInterval(pongCheckTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (ws) ws.close()
  }
  emitter.send = (frame: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('ws not open')
    }
    ws.send(JSON.stringify(frame))
  }
  emitter.isConnected = () => ws !== null && ws.readyState === WebSocket.OPEN

  return emitter
}
