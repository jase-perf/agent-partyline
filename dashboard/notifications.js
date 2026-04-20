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
  }
}
