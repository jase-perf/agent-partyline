import type { Database } from 'bun:sqlite'
import type { ServerWebSocket } from 'bun'
import { randomBytes } from 'node:crypto'
import {
  getSessionByToken,
  getSessionByName,
  updateSessionOnConnect,
  markSessionOffline,
  archiveSession,
  insertMessage,
  listSessions,
  type CcplSessionRow,
} from '../storage/ccpl-queries'

type SessionWsData = { kind: 'session'; name?: string; token?: string }
type ObserverWsData = { kind: 'observer' }
type SessionSocket = ServerWebSocket<SessionWsData>
type ObserverSocket = ServerWebSocket<ObserverWsData>

export interface HelloFrame {
  token: string
  name: string
  cc_session_uuid: string | null
  pid: number
  machine_id: string | null
}

export interface HelloResult {
  ok: boolean
  error?: string
  code?: number
}

export interface Envelope {
  id: string
  ts: number
  from: string
  to: string
  type: string
  body: string | null
  callback_id: string | null
  response_to: string | null
}

export interface Switchboard {
  handleSessionHello(ws: SessionSocket, frame: HelloFrame): HelloResult
  handleSessionFrame(ws: SessionSocket, frame: { type?: string; [k: string]: unknown }): void
  handleSessionClose(ws: SessionSocket): void
  handleObserverOpen(ws: ObserverSocket): void
  handleObserverFrame(ws: ObserverSocket, frame: { type?: string; [k: string]: unknown }): void
  handleObserverClose(ws: ObserverSocket): void
  broadcastObserverFrame(frame: unknown): void
  routeEnvelope(envelope: Envelope): void
}

export function createSwitchboard(db: Database): Switchboard {
  const sessionsByName = new Map<string, SessionSocket>()
  const observers = new Set<ObserverSocket>()

  function serverId(): string {
    return randomBytes(8).toString('hex')
  }

  function toObservers(frame: unknown): void {
    const payload = JSON.stringify(frame)
    for (const o of observers) {
      try {
        o.send(payload)
      } catch {
        /* ignore broken sockets */
      }
    }
  }

  function emitSessionDelta(row: CcplSessionRow, changes: Record<string, unknown>): void {
    toObservers({
      type: 'session-delta',
      session: row.name,
      revision: row.revision,
      changes,
    })
  }

  function routeEnvelope(envelope: Envelope): void {
    insertMessage(db, {
      id: envelope.id,
      ts: envelope.ts,
      from_name: envelope.from,
      to_name: envelope.to,
      type: envelope.type,
      body: envelope.body,
      callback_id: envelope.callback_id,
      response_to: envelope.response_to,
      cc_session_uuid: null,
    })

    const payload = JSON.stringify({ ...envelope, type: 'envelope' })

    if (envelope.to === 'all') {
      for (const [name, sock] of sessionsByName) {
        if (name === envelope.from) continue
        try {
          sock.send(payload)
        } catch {
          /* ignore */
        }
      }
    } else {
      for (const part of envelope.to.split(',').map((s) => s.trim())) {
        if (!part) continue
        const target = sessionsByName.get(part)
        if (target) {
          try {
            target.send(payload)
          } catch {
            /* ignore */
          }
        }
      }
    }

    toObservers({ ...envelope, type: 'envelope' })
  }

  return {
    handleSessionHello(ws, frame) {
      const row = getSessionByToken(db, frame.token)
      if (!row) return { ok: false, error: 'invalid_token', code: 4401 }
      if (row.name !== frame.name) return { ok: false, error: 'name_mismatch', code: 4401 }

      // Supersede any existing connection for this name.
      const existing = sessionsByName.get(row.name)
      if (existing && existing !== ws) {
        try {
          existing.send(JSON.stringify({ type: 'error', code: 'superseded' }))
          existing.close(4408, 'superseded')
        } catch {
          /* ignore */
        }
      }

      // UUID drift: archive the prior UUID if it differs from the incoming hello.
      if (
        row.cc_session_uuid &&
        frame.cc_session_uuid &&
        row.cc_session_uuid !== frame.cc_session_uuid
      ) {
        archiveSession(db, row.name, row.cc_session_uuid, 'reconnect_different_uuid')
      }

      updateSessionOnConnect(db, row.name, frame.cc_session_uuid, frame.pid, frame.machine_id)
      ws.data.name = row.name
      ws.data.token = row.token
      sessionsByName.set(row.name, ws)

      const fresh = getSessionByName(db, row.name)!
      emitSessionDelta(fresh, {
        online: true,
        cc_session_uuid: fresh.cc_session_uuid,
      })

      return { ok: true }
    },

    handleSessionFrame(ws, frame) {
      const name = ws.data.name
      if (!name) return // Hello must succeed first.

      switch (frame.type) {
        case 'ping':
          try {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
          } catch {
            /* ignore */
          }
          return
        case 'uuid-rotate': {
          const row = getSessionByName(db, name)
          if (!row) return
          const oldUuid = frame['old_uuid']
          const newUuid = frame['new_uuid']
          if (row.cc_session_uuid && oldUuid && row.cc_session_uuid === oldUuid) {
            archiveSession(db, name, String(oldUuid), 'clear')
          }
          updateSessionOnConnect(
            db,
            name,
            newUuid ? String(newUuid) : null,
            row.pid,
            row.machine_id,
          )
          const fresh = getSessionByName(db, name)!
          emitSessionDelta(fresh, { cc_session_uuid: fresh.cc_session_uuid })
          return
        }
        case 'send':
        case 'respond': {
          const id = serverId()
          const envelope: Envelope = {
            id,
            ts: Date.now(),
            from: name,
            to: String(frame['to'] ?? ''),
            type: String(frame['frame_type'] ?? 'message'),
            body: frame['body'] == null ? null : String(frame['body']),
            callback_id: frame['callback_id'] == null ? null : String(frame['callback_id']),
            response_to: frame['response_to'] == null ? null : String(frame['response_to']),
          }
          routeEnvelope(envelope)
          try {
            ws.send(
              JSON.stringify({
                type: 'sent',
                client_ref: frame['client_ref'] ?? null,
                id,
              }),
            )
          } catch {
            /* ignore */
          }
          return
        }
        case 'permission-response': {
          toObservers({
            type: 'permission-resolved',
            session: name,
            request_id: frame['request_id'],
            decision: frame['decision'],
          })
          return
        }
        default:
          // Unknown frames are silently dropped.
          return
      }
    },

    handleSessionClose(ws) {
      const name = ws.data.name
      if (!name) return
      const current = sessionsByName.get(name)
      if (current === ws) {
        sessionsByName.delete(name)
        markSessionOffline(db, name)
        const fresh = getSessionByName(db, name)
        if (fresh) emitSessionDelta(fresh, { online: false })
      }
    },

    handleObserverOpen(ws) {
      observers.add(ws)
      const rows = listSessions(db)
      try {
        ws.send(
          JSON.stringify({
            type: 'sessions-snapshot',
            sessions: rows.map((r) => ({
              name: r.name,
              cwd: r.cwd,
              cc_session_uuid: r.cc_session_uuid,
              online: r.online,
              revision: r.revision,
            })),
          }),
        )
      } catch {
        /* ignore */
      }
    },

    handleObserverFrame(_ws, frame) {
      if (frame.type === 'ping') {
        try {
          _ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
        } catch {
          /* ignore */
        }
      } else if (frame.type === 'session-viewed') {
        toObservers({ type: 'notification-dismiss', session: frame['session'] })
      }
    },

    handleObserverClose(ws) {
      observers.delete(ws)
    },

    broadcastObserverFrame(frame) {
      toObservers(frame)
    },

    routeEnvelope,
  }
}
