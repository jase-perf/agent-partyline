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
  helloPayload: HelloPayload
  pingIntervalMs?: number
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
  let reconnectTimer: Timer | null = null
  let reconnectDelay = opts.reconnectInitialMs ?? 100
  let stopped = false
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

  function scheduleReconnect(): void {
    if (stopped) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, opts.reconnectMaxMs ?? 30_000)
  }

  function connect(): void {
    if (stopped) return
    try {
      ws = new WebSocket(opts.url)
    } catch (err) {
      log('error', `ws construct failed: ${String(err)}`)
      scheduleReconnect()
      return
    }

    ws.addEventListener('open', () => {
      log('info', `ws open to ${opts.url}`)
      reconnectDelay = opts.reconnectInitialMs ?? 100
      try {
        ws!.send(JSON.stringify(opts.helloPayload))
      } catch (err) {
        log('error', `hello send failed: ${String(err)}`)
      }
      setPingTimer()
      emitter.emit('open')
    })

    ws.addEventListener('message', (e) => {
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
