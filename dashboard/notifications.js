// @ts-check
/**
 * Browser notification module for Party Line dashboard.
 * Factory pattern: dependencies injected via createNotifications(deps) so
 * the module is unit-testable without a DOM.
 */

const STORAGE_KEY = 'partyLineNotifications'

/**
 * @typedef {Object} NotificationDeps
 * @property {typeof Notification | undefined} NotificationCtor
 * @property {Storage} localStorage
 * @property {Document} doc
 * @property {Window} win
 * @property {(frame: unknown) => void} sendWsFrame
 * @property {() => string} getCurrentRoute
 * @property {(route: string) => void} navigate
 * @property {typeof fetch} [fetch]
 */

/**
 * @param {NotificationDeps} deps
 */
export function createNotifications(deps) {
  function loadSettings(storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY)
      if (!raw) return new Map()
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return new Map()
      const m = new Map()
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'boolean' && v) m.set(k, true)
      }
      return m
    } catch {
      return new Map()
    }
  }

  function persistSettings() {
    const obj = {}
    for (const [k, v] of settings) obj[k] = v
    deps.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
  }

  const settings = loadSettings(deps.localStorage)
  const activeNotifications = new Map()
  const lastAssistantText = new Map()
  const lastKnownState = new Map()
  const resolvedPermissions = new Set()

  function shouldFire(sessionName) {
    if (!settings.get(sessionName)) return false
    if (!deps.NotificationCtor) return false
    if (deps.NotificationCtor.permission !== 'granted') return false
    if (deps.doc.hidden) return true
    const route = deps.getCurrentRoute()
    return route !== '/session/' + sessionName
  }

  function fire(sessionName, title, body) {
    const NC = deps.NotificationCtor
    if (!NC) return
    const n = new NC(title, {
      body,
      tag: sessionName,
      data: { sessionName },
    })
    activeNotifications.set(sessionName, n)
    n.onclick = () => {
      try {
        deps.win.focus()
      } catch {}
      deps.navigate('/#/session/' + sessionName)
      n.close()
    }
  }

  return {
    isEnabled(sessionName) {
      return settings.get(sessionName) === true
    },
    setEnabled(sessionName, enabled) {
      if (enabled) settings.set(sessionName, true)
      else settings.delete(sessionName)
      persistSettings()
    },
    getPermissionState() {
      if (!deps.NotificationCtor) return 'unsupported'
      return deps.NotificationCtor.permission
    },
    async requestPermission() {
      if (!deps.NotificationCtor) return 'unsupported'
      return await deps.NotificationCtor.requestPermission()
    },
    async onSessionUpdate(update) {
      if (!update || !update.name) return
      const prev = lastKnownState.get(update.name)
      lastKnownState.set(update.name, update.state)
      if (prev === 'working' && update.state === 'idle' && shouldFire(update.name)) {
        let body = 'Claude is waiting'
        try {
          const sid = update.session_id
          if (sid && deps.fetch) {
            const res = await deps.fetch(
              '/api/transcript?session_id=' + encodeURIComponent(sid) + '&limit=5',
            )
            if (res.ok) {
              const entries = await res.json()
              if (Array.isArray(entries)) {
                for (let i = entries.length - 1; i >= 0; i--) {
                  const e = entries[i]
                  if (
                    e &&
                    e.type === 'assistant-text' &&
                    typeof e.text === 'string' &&
                    e.text.trim()
                  ) {
                    const t = e.text.trim()
                    body = t.length > 120 ? t.slice(0, 120) + '…' : t
                    lastAssistantText.set(update.name, body)
                    break
                  }
                }
              }
            }
          }
        } catch {
          // fall back to generic body
        }
        fire(update.name, update.name, body)
      }
    },
    onPartyLineMessage(envelope) {
      if (!envelope || envelope.type !== 'message') return
      for (const [sessionName] of settings) {
        const isDirectedHere = envelope.to === sessionName || envelope.to === 'all'
        // Messages addressed to "dashboard" aren't a real delivery target — the dashboard
        // only observes. Surface them as a notification on the sender's session so the
        // user can see (and the conversation isn't silently dropped).
        const isMyOutboundToDashboard = envelope.to === 'dashboard' && envelope.from === sessionName
        if (!isDirectedHere && !isMyOutboundToDashboard) continue
        if (isDirectedHere && envelope.from === sessionName) continue
        if (!shouldFire(sessionName)) continue
        const bodyText = String(envelope.body || '')
        const preview = bodyText.length > 120 ? bodyText.slice(0, 120) + '…' : bodyText
        const prefix = isMyOutboundToDashboard ? 'to dashboard: ' : (envelope.from || '?') + ': '
        fire(sessionName, sessionName, prefix + preview)
      }
    },
    onPermissionRequest(frame) {
      if (!frame || !frame.session || !frame.request_id) return
      if (resolvedPermissions.has(frame.request_id)) return
      if (!shouldFire(frame.session)) return
      const title = 'Permission needed: ' + (frame.tool_name || '?')
      const descr = String(frame.description || '')
      const body = descr.length > 120 ? descr.slice(0, 120) + '…' : descr
      fire(frame.session, title, body)
    },
    onPermissionResolved(frame) {
      if (!frame || !frame.request_id) return
      resolvedPermissions.add(frame.request_id)
      const active = activeNotifications.get(frame.session)
      if (active) {
        active.close()
        activeNotifications.delete(frame.session)
      }
    },
    onNotificationDismiss(frame) {
      if (!frame || !frame.session) return
      const active = activeNotifications.get(frame.session)
      if (active) {
        active.close()
        activeNotifications.delete(frame.session)
      }
    },
    dispatchSessionViewed(sessionName) {
      if (!sessionName) return
      deps.sendWsFrame({ type: 'session-viewed', session: sessionName })
    },
  }
}
