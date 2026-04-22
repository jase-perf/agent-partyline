// @ts-check
/**
 * Browser notification module for Party Line dashboard.
 * SW-based: notifications are dispatched via the page's active Service Worker
 * registration, which is the only primitive that works on Chrome Android.
 */

const STORAGE_KEY = 'partyLineNotifications'

/**
 * @typedef {Object} NotificationDeps
 * @property {Promise<ServiceWorkerRegistration|null>|null} swRegistration
 * @property {{ permission: NotificationPermission; requestPermission: () => Promise<NotificationPermission> } | undefined} NotificationPermission
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
  const lastAssistantText = new Map()
  const lastKnownState = new Map()
  const resolvedPermissions = new Set()

  function permissionState() {
    if (!deps.NotificationPermission) return 'unsupported'
    return deps.NotificationPermission.permission
  }

  function shouldFire(sessionName) {
    if (!settings.get(sessionName)) return false
    if (permissionState() !== 'granted') return false
    if (deps.doc.hidden) return true
    const route = deps.getCurrentRoute()
    return route !== '/session/' + sessionName
  }

  async function fire(sessionName, title, body) {
    if (!deps.swRegistration) return
    const reg = await deps.swRegistration
    if (!reg) return
    try {
      await reg.showNotification(title, {
        body,
        tag: sessionName,
        data: { sessionName },
      })
    } catch (err) {
      console.error('[notifications] showNotification threw', err)
    }
  }

  async function dismissByTag(sessionName) {
    if (!deps.swRegistration) return
    const reg = await deps.swRegistration
    if (!reg) return
    try {
      const ns = await reg.getNotifications({ tag: sessionName })
      for (const n of ns) n.close()
    } catch (err) {
      console.error('[notifications] dismissByTag threw', err)
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
      return permissionState()
    },
    // IMPORTANT: callers MUST invoke this synchronously from inside a user
    // gesture handler. Do not await anything before calling.
    requestPermission() {
      if (!deps.NotificationPermission) return Promise.resolve('unsupported')
      return deps.NotificationPermission.requestPermission()
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
        await fire(update.name, update.name, body)
      }
    },
    async onPartyLineMessage(envelope) {
      if (!envelope || envelope.type !== 'message') return
      for (const [sessionName] of settings) {
        const isDirectedHere = envelope.to === sessionName || envelope.to === 'all'
        const isMyOutboundToDashboard = envelope.to === 'dashboard' && envelope.from === sessionName
        if (!isDirectedHere && !isMyOutboundToDashboard) continue
        if (isDirectedHere && envelope.from === sessionName) continue
        if (!shouldFire(sessionName)) continue
        const bodyText = String(envelope.body || '')
        const preview = bodyText.length > 120 ? bodyText.slice(0, 120) + '…' : bodyText
        const prefix = isMyOutboundToDashboard ? 'to dashboard: ' : (envelope.from || '?') + ': '
        await fire(sessionName, sessionName, prefix + preview)
      }
    },
    async onPermissionRequest(frame) {
      if (!frame || !frame.session || !frame.request_id) return
      if (resolvedPermissions.has(frame.request_id)) return
      if (!shouldFire(frame.session)) return
      const title = 'Permission needed: ' + (frame.tool_name || '?')
      const descr = String(frame.description || '')
      const body = descr.length > 120 ? descr.slice(0, 120) + '…' : descr
      await fire(frame.session, title, body)
    },
    async onPermissionResolved(frame) {
      if (!frame || !frame.request_id) return
      resolvedPermissions.add(frame.request_id)
      await dismissByTag(frame.session)
    },
    async onNotificationDismiss(frame) {
      if (!frame || !frame.session) return
      await dismissByTag(frame.session)
    },
    async onApiError(frame) {
      if (!frame || !frame.session_name) return
      if (!shouldFire(frame.session_name)) return
      const title = frame.session_name + ' — API error'
      const status = frame.status ? ' (' + frame.status + ')' : ''
      const body = (frame.message || 'Anthropic API error') + status
      await fire(frame.session_name, title, body)
    },
    dispatchSessionViewed(sessionName) {
      if (!sessionName) return
      deps.sendWsFrame({ type: 'session-viewed', session: sessionName })
    },
  }
}
