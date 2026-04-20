# Party Line v2 — Phase B: Notifications + PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild browser notifications on a Service Worker so they fire on mobile Chrome, and lay the PWA groundwork so the dashboard can be installed on a phone home screen.

**Architecture:** One new Service Worker file (`dashboard/sw.js`) registered at page bootstrap. The `notifications.js` factory's `NotificationCtor` dep is replaced with a `swRegistration` dep, and every `new Notification()` becomes `registration.showNotification()`. Permission flow moves off the auto-banner onto a per-bell gesture. A `manifest.json` + three icon PNGs + a handful of meta tags complete the installable PWA. Push API / VAPID stay out of scope.

**Tech Stack:** Browser Service Worker API, Web App Manifest, TypeScript on Bun for the server-side changes, `bun:test` with dependency injection for the updated notification tests.

**Prerequisite:** Phase A complete (A6's try/catch around `notif.*` calls is required before B4).

**Part of:** Party Line v2 rebuild. Spec: `docs/superpowers/specs/2026-04-20-hub-and-spoke-design.md` §7 and §8. Audit: `docs/audit/2026-04-20-notifications.md`.

---

## File Structure

| File                                    | Responsibility                                            | Change                                                  |
| --------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `dashboard/sw.js`                       | Service Worker (install/activate/fetch/notificationclick) | Create                                                  |
| `dashboard/manifest.json`               | Web App Manifest                                          | Create                                                  |
| `dashboard/icons/icon-192.png`          | PWA icon 192×192                                          | Create                                                  |
| `dashboard/icons/icon-512.png`          | PWA icon 512×512                                          | Create                                                  |
| `dashboard/icons/icon-maskable-512.png` | Maskable PWA icon                                         | Create                                                  |
| `dashboard/serve.ts`                    | HTTP server (adds static routes + headers)                | Modify                                                  |
| `dashboard/dashboard.js`                | Page bootstrap, WS handler, bell UI                       | Modify                                                  |
| `dashboard/notifications.js`            | Notification factory                                      | Modify (dep shape + internals)                          |
| `dashboard/notifications.d.ts`          | Type defs                                                 | Modify to reflect new dep                               |
| `dashboard/index.html`                  | Shell HTML                                                | Add manifest + meta tags + install button slot          |
| `tests/notifications.test.ts`           | Tests                                                     | Migrate off FakeNotification onto mock `swRegistration` |

---

## Task B1: Create the Service Worker

**Files:**

- Create: `dashboard/sw.js`

- [ ] **Step 1: Create `dashboard/sw.js` with install/activate/fetch/notificationclick**

```js
// Party Line Dashboard Service Worker.
// Caches the app shell, serves it offline, and handles notification clicks.

const CACHE_NAME = 'party-line-shell-v1'

const SHELL = [
  '/',
  '/index.html',
  '/dashboard.css',
  '/dashboard.js',
  '/notifications.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Only serve shell from cache. Everything else (API, /ws, /login) hits network.
  if (event.request.method === 'GET' && SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)))
  }
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const sessionName = data.sessionName
  const url = sessionName ? '/#/session/' + encodeURIComponent(sessionName) : '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.endsWith(url) && 'focus' in client) {
          return client.focus()
        }
      }
      // No window currently on that route — focus any existing client or open one.
      const first = list[0]
      if (first && 'focus' in first && 'navigate' in first) {
        return first.focus().then(() => first.navigate(url))
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url)
      }
    }),
  )
})
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/sw.js
git commit -m "feat(pwa): add Service Worker for shell caching + notification click routing

Caches the dashboard shell for PWA install; notificationclick routes
to /#/session/<name> in an existing client or opens one."
```

---

## Task B2: Serve `/sw.js` and `/manifest.json` with correct headers

**Files:**

- Modify: `dashboard/serve.ts`

**Background:** The Service Worker has to be served from the root path (`/sw.js`) with `Service-Worker-Allowed: /` so it can claim the whole site as its scope. The manifest needs `Content-Type: application/manifest+json`. Icons are ordinary images.

- [ ] **Step 1: Locate the static file serving code**

Read `dashboard/serve.ts`. Find where `/` serves `index.html` and where other static assets (JS/CSS) are served. Note the file-serving pattern in use.

- [ ] **Step 2: Add `/sw.js`, `/manifest.json`, and `/icons/*` routes**

Inside the route-dispatch section of `Bun.serve`'s `fetch` handler, add cases for:

```ts
// --- Static PWA assets ---
if (url.pathname === '/sw.js') {
  const path = resolve(import.meta.dir, 'sw.js')
  return new Response(Bun.file(path), {
    headers: {
      'Content-Type': 'application/javascript',
      'Service-Worker-Allowed': '/',
      // No caching — we want SW updates to pick up fast.
      'Cache-Control': 'no-cache',
    },
  })
}

if (url.pathname === '/manifest.json') {
  const path = resolve(import.meta.dir, 'manifest.json')
  return new Response(Bun.file(path), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}

if (url.pathname.startsWith('/icons/')) {
  const rel = url.pathname.slice(1) // strip leading /
  const path = resolve(import.meta.dir, rel)
  // Light path-traversal guard — no .. or leading slashes in rel.
  if (rel.includes('..')) {
    return new Response('Not found', { status: 404 })
  }
  const file = Bun.file(path)
  if (!(await file.exists())) {
    return new Response('Not found', { status: 404 })
  }
  return new Response(file, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
```

Place these before any catch-all 404. Ensure `resolve` from `node:path` is imported at the top of the file if not already.

- [ ] **Step 3: Manual smoke check**

With the dashboard running, open in a browser:

- `GET /sw.js` → should return the SW source, status 200, `Service-Worker-Allowed: /` in response headers.
- `GET /manifest.json` → 404 at this point (file doesn't exist yet, will be created in B9). That's expected.
- `GET /icons/icon-192.png` → 404 at this point (file doesn't exist yet, B10).

- [ ] **Step 4: Commit**

```bash
git add dashboard/serve.ts
git commit -m "feat(dashboard): serve /sw.js, /manifest.json, /icons/* with correct headers

Service-Worker-Allowed: / is required for SW to claim root scope.
Content-Type application/manifest+json is required for the manifest."
```

---

## Task B3: Register the Service Worker at page bootstrap

**Files:**

- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Add a `swRegistration` promise near the top of the file**

Below the other top-level `let` declarations, add:

```js
// Service Worker registration promise. Used by notifications.js to call
// registration.showNotification(). Null if SW isn't supported (e.g. non-secure
// context on older browsers).
let swRegistration = null

if ('serviceWorker' in navigator) {
  swRegistration = navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((reg) => {
      console.log('[sw] registered scope:', reg.scope)
      return reg
    })
    .catch((err) => {
      console.error('[sw] registration failed:', err)
      return null
    })
}
```

- [ ] **Step 2: Pass `swRegistration` into `createNotifications` deps**

Find the `const notif = createNotifications({ ... })` call (moved in Phase A Task A5 above the initial `applyRoute`). Replace its deps object with:

```js
const notif = createNotifications({
  swRegistration,
  NotificationPermission: typeof Notification !== 'undefined' ? Notification : undefined,
  localStorage: window.localStorage,
  doc: document,
  win: window,
  sendWsFrame: (frame) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
  },
  getCurrentRoute: () => window.location.pathname,
  navigate: (route) => {
    // Accept '/#/session/foo' or '/session/foo'
    const cleaned = route.replace(/^\/#/, '')
    const m = cleaned.match(/^\/session\/(.+)$/)
    if (m) navigate({ view: 'session-detail', sessionName: decodeURIComponent(m[1]) })
    else navigate({ view: 'switchboard' })
  },
  fetch: window.fetch.bind(window),
})
```

Note: `NotificationPermission` is a small deps surface used only for reading `Notification.permission` and `Notification.requestPermission()`. The actual `showNotification` now goes through `swRegistration`.

- [ ] **Step 3: Manual test**

Load the dashboard in Chrome. Open devtools → Application tab → Service Workers. Expected: one SW registered with scope `/`, activated.

- [ ] **Step 4: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "feat(dashboard): register Service Worker at bootstrap + inject into notifications factory

swRegistration resolves to the ServiceWorkerRegistration (or null if
SW unsupported). Passed as a new dep into createNotifications."
```

---

## Task B4: Refactor `notifications.js` to use `swRegistration.showNotification()`

**Files:**

- Modify: `dashboard/notifications.js`
- Modify: `dashboard/notifications.d.ts`

**Background:** Every `new Notification()` becomes `registration.showNotification(title, options)`. The instance cache (`activeNotifications: Map<string, Notification>`) goes away — cross-session dismiss uses `registration.getNotifications({ tag })` instead.

- [ ] **Step 1: Rewrite `notifications.js` — new deps shape and `fire` function**

Replace the full factory:

```js
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
    const ns = await reg.getNotifications({ tag: sessionName })
    for (const n of ns) n.close()
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
    dispatchSessionViewed(sessionName) {
      if (!sessionName) return
      deps.sendWsFrame({ type: 'session-viewed', session: sessionName })
    },
  }
}
```

- [ ] **Step 2: Update `notifications.d.ts`**

Replace the existing type export with:

```ts
export interface NotificationDeps {
  swRegistration: Promise<ServiceWorkerRegistration | null> | null
  NotificationPermission:
    | {
        permission: NotificationPermission
        requestPermission: () => Promise<NotificationPermission>
      }
    | undefined
  localStorage: Storage
  doc: Document
  win: Window
  sendWsFrame: (frame: unknown) => void
  getCurrentRoute: () => string
  navigate: (route: string) => void
  fetch?: typeof fetch
}

export interface NotificationModule {
  isEnabled(sessionName: string): boolean
  setEnabled(sessionName: string, enabled: boolean): void
  getPermissionState(): NotificationPermission | 'unsupported'
  requestPermission(): Promise<NotificationPermission | 'unsupported'>
  onSessionUpdate(update: unknown): Promise<void>
  onPartyLineMessage(envelope: unknown): Promise<void>
  onPermissionRequest(frame: unknown): Promise<void>
  onPermissionResolved(frame: unknown): Promise<void>
  onNotificationDismiss(frame: unknown): Promise<void>
  dispatchSessionViewed(sessionName: string): void
}

export function createNotifications(deps: NotificationDeps): NotificationModule
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: passes (or any failures are in files you didn't change — fix those separately if they surface).

- [ ] **Step 4: Commit (tests are updated in Task B8; this intermediate commit may have a temporarily broken test suite)**

```bash
git add dashboard/notifications.js dashboard/notifications.d.ts
git commit -m "refactor(notifications): migrate to Service Worker showNotification API

Replaces new Notification() with swRegistration.showNotification() so
mobile Chrome works. Dismiss uses registration.getNotifications({tag})
instead of holding instance refs. Tests will be updated in B8.
Closes audit N1 + N5."
```

---

## Task B5: Gesture-tied permission request in bell click handler

**Files:**

- Modify: `dashboard/dashboard.js`

**Background:** `Notification.requestPermission()` must be called synchronously (no `await` before the call) from inside a user gesture to survive Safari's strict activation rules and to avoid Chromium's abuse heuristic.

- [ ] **Step 1: Locate both bell click handlers**

Find:

- `document.getElementById('overview-grid')?.addEventListener('click', ...)` — handles switchboard card bell clicks.
- `document.getElementById('detail-bell')?.addEventListener('click', ...)` — handles session detail bell.

- [ ] **Step 2: Rewrite the switchboard bell click handler**

Replace the existing overview-grid click handler with:

```js
document.getElementById('overview-grid')?.addEventListener('click', (ev) => {
  const target = ev.target
  if (!(target instanceof HTMLElement)) return
  const bell = target.closest('.notif-bell')
  if (!bell) return
  ev.stopPropagation()

  const session = bell.getAttribute('data-session')
  if (!session) return

  handleBellClick(bell, session)
})
```

Add a new `handleBellClick` function near the other bell-related helpers:

```js
function handleBellClick(bellEl, session) {
  const state = notif.getPermissionState()

  if (state === 'default') {
    // SYNCHRONOUS requestPermission — no await before this call.
    // Don't flip the bell until permission resolves.
    const p = notif.requestPermission()
    p.then((result) => {
      if (result === 'granted') {
        notif.setEnabled(session, true)
      }
      // Re-render the bell on this card and the detail header.
      updateBellUIEverywhere(session)
      updateBanner()
    })
    return
  }

  if (state === 'granted') {
    const next = !notif.isEnabled(session)
    notif.setEnabled(session, next)
    updateBellUIEverywhere(session)
    return
  }

  // state === 'denied' or 'unsupported': clicks do nothing beyond visual feedback.
  updateBellUIEverywhere(session)
}

function updateBellUIEverywhere(session) {
  const on = notif.isEnabled(session)
  const state = notif.getPermissionState()
  const disabled = state !== 'granted'
  const sel = `.notif-bell[data-session="${CSS.escape(session)}"]`
  document.querySelectorAll(sel).forEach((bell) => {
    bell.classList.toggle('notif-bell-on', on)
    bell.classList.toggle('notif-bell-off', !on)
    bell.classList.toggle('notif-bell-disabled', disabled)
    bell.textContent = on ? '🔔' : '🔕'
    bell.setAttribute('aria-label', 'Notifications for ' + session + ': ' + (on ? 'on' : 'off'))
  })
}
```

- [ ] **Step 3: Rewrite the detail-bell click handler**

Replace its body with a call to the shared helper:

```js
document.getElementById('detail-bell')?.addEventListener('click', (ev) => {
  const bell = ev.currentTarget
  if (!(bell instanceof HTMLElement)) return
  const session = bell.getAttribute('data-session')
  if (!session) return
  handleBellClick(bell, session)
})
```

- [ ] **Step 4: Manual test on desktop Chrome**

Load the dashboard. Check `Notification.permission` in devtools console — reset it if needed via `chrome://settings/content/notifications`.

Click a bell on a session card when permission is `'default'`.
Expected: the native permission prompt appears. If the user grants it, the bell turns ON. If denied, the bell stays off and shows the disabled style.

Click a bell when permission is already granted.
Expected: no prompt, bell toggles immediately.

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "feat(notifications): gesture-tied permission request on bell click

Clicking a bell when permission is 'default' synchronously triggers
requestPermission() inside the click handler (no await before). Bell
state flips only after permission resolves. Kills the abuse-heuristic
auto-deny symptom. Closes audit N3."
```

---

## Task B6: Live permission-state refresh via visibilitychange / focus / permissions.onchange

**Files:**

- Modify: `dashboard/dashboard.js`

**Background:** `Notification.permission` is a cached read; changing the site setting in another tab does not re-read it here automatically. Three listeners cover the cases: tab regains visibility, window regains focus, and (when supported) the Permissions API's `onchange` event.

- [ ] **Step 1: Add a `refreshNotifState` helper**

Near `updateBanner()` and `updateBellUIEverywhere`, add:

```js
function refreshNotifState() {
  updateBanner()
  // Re-render every bell — the disabled class depends on permission state.
  document.querySelectorAll('.notif-bell').forEach((bell) => {
    const session = bell.getAttribute('data-session')
    if (session) updateBellUIEverywhere(session)
  })
}
```

- [ ] **Step 2: Register the three listeners at bootstrap**

Near the other top-level DOM event hookups (towards the end of `dashboard.js`), add:

```js
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshNotifState()
})
window.addEventListener('focus', refreshNotifState)

if (navigator.permissions && navigator.permissions.query) {
  navigator.permissions
    .query({ name: 'notifications' })
    .then((status) => {
      status.onchange = refreshNotifState
    })
    .catch(() => {
      // Some Safari versions throw on name: 'notifications'. Fine — fall through.
    })
}
```

- [ ] **Step 3: Manual test**

Load the dashboard. Open site settings in a different tab, change notification permission for this site. Switch back to the dashboard tab.
Expected: within ~1s of tab focus, the banner copy and bells reflect the new state (e.g., bells become clickable after granting; banner disappears).

- [ ] **Step 4: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "feat(notifications): live permission state refresh

Re-read Notification.permission on visibilitychange, focus, and
permissions.onchange. Fixes 'stuck at blocked forever' symptom after
user flips the site setting. Closes audit N2."
```

---

## Task B7: Replace auto-banner with inline denied-notice

**Files:**

- Modify: `dashboard/dashboard.js`
- Modify: `dashboard/index.html`
- Modify: `dashboard/dashboard.css`

**Background:** The auto-showing permission banner is what triggers Chromium's quiet-UI abuse heuristic. Replace with a contextual banner that only appears when permission is `denied` (not `default`), with a link to the browser's site-settings page.

- [ ] **Step 1: Update `updateBanner`**

Replace the existing `updateBanner` function body with:

```js
function updateBanner() {
  const banner = document.getElementById('notif-banner')
  if (!banner) return
  const text = banner.querySelector('.notif-banner-text')
  const btn = document.getElementById('notif-banner-btn')
  if (!text || !btn) return

  const dismissed = localStorage.getItem('partyLineNotifBannerDismissed') === '1'
  const insecure = !window.isSecureContext
  const state = notif.getPermissionState()

  // Hide banner entirely when permission is granted OR user dismissed it (for
  // default state only) OR we're on 'default' (no more auto-nag).
  if (state === 'granted') {
    banner.hidden = true
    return
  }
  if (state === 'default' && dismissed) {
    banner.hidden = true
    return
  }
  if (state === 'default') {
    // Quiet hint only, no button. User enables via clicking a bell.
    banner.hidden = false
    text.textContent = '🔔 Click a session bell to enable notifications for that session.'
    btn.hidden = true
    return
  }

  // state === 'denied' OR insecure context
  banner.hidden = false
  if (insecure) {
    text.textContent =
      '🔔 Notifications require HTTPS. Reach the dashboard at https:// (or via a tunnel) to enable.'
    btn.hidden = true
  } else {
    // denied
    text.textContent =
      "🔔 Notifications blocked. Re-enable in your browser's site settings for this page."
    btn.hidden = true
  }
}
```

- [ ] **Step 2: Remove the old banner Enable button behavior**

Find and delete the existing `document.getElementById('notif-banner-btn')?.addEventListener('click', ...)` handler (its behavior — calling `notif.requestPermission()` from a non-bell-gesture — is now explicitly disallowed).

Keep the `notif-banner-dismiss` handler:

```js
document.getElementById('notif-banner-dismiss')?.addEventListener('click', () => {
  localStorage.setItem('partyLineNotifBannerDismissed', '1')
  updateBanner()
})
```

- [ ] **Step 3: Keep the HTML button element but hide it by default**

`updateBanner` sets `btn.hidden = true` in every branch now. The button can stay in `index.html` as dead DOM for future use; it won't be displayed.

- [ ] **Step 4: Manual test**

Reset notification permission. Load the dashboard.
Expected (permission='default'): "Click a session bell to enable notifications for that session." with the dismiss ×.

Click a bell → permission prompt → grant.
Expected: banner hides.

Use site settings to block notifications.
Expected: banner shows "Notifications blocked. Re-enable in your browser's site settings…"

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "refactor(notifications): banner no longer auto-prompts

Default state shows a quiet 'click a bell' hint. Denied state gives
a settings nudge. Removing the auto-permission-request-on-click
eliminates the remaining surface area for Chromium's abuse heuristic.
Closes audit N3 followup."
```

---

## Task B8: Update `notifications.test.ts` for the SW API

**Files:**

- Modify: `tests/notifications.test.ts`

**Background:** The existing tests inject `NotificationCtor: FakeNotification`. That dep is gone. The new tests inject `swRegistration` + `NotificationPermission` separately.

- [ ] **Step 1: Read the current test file**

Read `tests/notifications.test.ts` to see the exact shape of the existing `makeCtx` helper and test cases.

- [ ] **Step 2: Rewrite `makeCtx` helper**

Replace `makeCtx` (and `FakeNotification`) with:

```ts
import { createNotifications } from '../dashboard/notifications'

interface MockShown {
  title: string
  options: NotificationOptions
}

function makeCtx(
  opts: Partial<{
    permission: 'default' | 'granted' | 'denied'
    hidden: boolean
    route: string
  }> = {},
) {
  const shown: MockShown[] = []
  const closed: string[] = []

  const fakeRegistration = {
    showNotification: (title: string, options: NotificationOptions) => {
      shown.push({ title, options })
      return Promise.resolve()
    },
    getNotifications: async ({ tag }: { tag: string }) => {
      // Return one mock notification per previously-shown with that tag.
      return shown
        .filter((s) => s.options.tag === tag)
        .map((s) => ({
          tag: s.options.tag,
          close: () => closed.push(s.options.tag as string),
        }))
    },
  }

  let perm: NotificationPermission = opts.permission ?? 'granted'
  const NotificationPermission = {
    get permission() {
      return perm
    },
    async requestPermission() {
      // Tests mutate this via the returned helper.
      return perm
    },
  }

  const storage = new Map<string, string>()
  const localStorage: Storage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => void storage.set(k, v),
    removeItem: (k) => void storage.delete(k),
    clear: () => storage.clear(),
    key: (i) => [...storage.keys()][i] ?? null,
    get length() {
      return storage.size
    },
  }

  const sent: unknown[] = []
  let currentRoute = opts.route ?? '/'

  const ctx = {
    notif: createNotifications({
      swRegistration: Promise.resolve(fakeRegistration as unknown as ServiceWorkerRegistration),
      NotificationPermission,
      localStorage,
      doc: { hidden: opts.hidden ?? false } as Document,
      win: {} as Window,
      sendWsFrame: (f: unknown) => sent.push(f),
      getCurrentRoute: () => currentRoute,
      navigate: () => {},
      fetch: (async () =>
        new Response(JSON.stringify([{ type: 'assistant-text', text: 'hi' }]), {
          status: 200,
        })) as typeof fetch,
    }),
    shown,
    closed,
    sent,
    setPermission: (p: NotificationPermission) => {
      perm = p
    },
    setRoute: (r: string) => {
      currentRoute = r
    },
  }
  return ctx
}
```

- [ ] **Step 3: Migrate existing test cases**

For each existing test:

- Replace `ctx.fired` with `ctx.shown`.
- Assertions like `expect(ctx.fired.length).toBe(1)` become `expect(ctx.shown.length).toBe(1)`.
- Body assertions like `expect(ctx.fired[0].options.body).toBe(...)` stay the same shape (options includes body, tag, data).
- Tests that previously called `new FakeNotification()` directly — delete them, not relevant anymore.
- Add `await` before `ctx.notif.onXxx(...)` calls — every handler is async now.

- [ ] **Step 4: Add a new test — async dispatch through SW registration**

Append a new describe block:

```ts
describe('createNotifications — SW dispatch path', () => {
  test('fires notification via swRegistration.showNotification with correct tag + data', async () => {
    const ctx = makeCtx({ hidden: true })
    ctx.notif.setEnabled('research', true)
    await ctx.notif.onSessionUpdate({ name: 'research', state: 'working' })
    await ctx.notif.onSessionUpdate({ name: 'research', state: 'idle' })
    expect(ctx.shown.length).toBe(1)
    expect(ctx.shown[0].title).toBe('research')
    expect(ctx.shown[0].options.tag).toBe('research')
    expect(ctx.shown[0].options.data).toEqual({ sessionName: 'research' })
  })

  test('dismiss by tag closes every notification with that tag', async () => {
    const ctx = makeCtx({ hidden: true })
    ctx.notif.setEnabled('research', true)
    await ctx.notif.onSessionUpdate({ name: 'research', state: 'working' })
    await ctx.notif.onSessionUpdate({ name: 'research', state: 'idle' })
    await ctx.notif.onNotificationDismiss({ session: 'research' })
    expect(ctx.closed).toContain('research')
  })

  test('permission denied → no fire', async () => {
    const ctx = makeCtx({ permission: 'denied', hidden: true })
    ctx.notif.setEnabled('research', true)
    await ctx.notif.onSessionUpdate({ name: 'research', state: 'working' })
    await ctx.notif.onSessionUpdate({ name: 'research', state: 'idle' })
    expect(ctx.shown.length).toBe(0)
  })
})
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/notifications.test.ts`
Expected: all pass.

Run: `bun test`
Expected: full suite passes.

- [ ] **Step 6: Commit**

```bash
git add tests/notifications.test.ts
git commit -m "test(notifications): migrate to mock swRegistration + async handlers

Replaces FakeNotification with a stub ServiceWorkerRegistration that
records showNotification calls. Adds dismiss-by-tag and permission-denied
coverage. Closes audit notifications-test follow-up."
```

---

## Task B9: Create `dashboard/manifest.json`

**Files:**

- Create: `dashboard/manifest.json`

- [ ] **Step 1: Create the manifest**

```json
{
  "name": "Party Line Switchboard",
  "short_name": "Party Line",
  "description": "Real-time Claude Code session switchboard",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "theme_color": "#0d1117",
  "background_color": "#0d1117",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    {
      "src": "/icons/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
```

- [ ] **Step 2: Verify it serves**

With the dashboard running, `curl -sk https://localhost:3400/manifest.json | jq .name`
Expected: `"Party Line Switchboard"`.

- [ ] **Step 3: Commit**

```bash
git add dashboard/manifest.json
git commit -m "feat(pwa): add Web App Manifest for install-to-home-screen"
```

---

## Task B10: Generate placeholder icon PNGs

**Files:**

- Create: `dashboard/icons/icon-192.png`
- Create: `dashboard/icons/icon-512.png`
- Create: `dashboard/icons/icon-maskable-512.png`

**Background:** PWAs require actual PNG assets — the manifest references them and Chrome's install prompt checks they exist. Placeholder "PL" logos on dark background are fine initially; user can swap later.

- [ ] **Step 1: Create the icons directory**

```bash
mkdir -p dashboard/icons
```

- [ ] **Step 2: Write a generator script**

Create `scripts/generate-pwa-icons.ts`:

```ts
// Generate placeholder PWA icons as PNG files.
// Uses an SVG → PNG pipeline via Bun's subprocess + rsvg-convert (falls back to
// a minimal pre-rasterized PNG if rsvg-convert isn't installed).

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SVG = (size: number, padding: number) =>
  `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#0d1117"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
        font-family="system-ui, sans-serif" font-weight="700"
        font-size="${Math.floor(size * 0.5)}" fill="#3fb950">PL</text>
</svg>
`.trim()

async function renderSvgToPng(svg: string, outPath: string) {
  // Try rsvg-convert (part of librsvg; installed on most Linux VMs).
  const tmp = `/tmp/pwa-icon-${Math.random().toString(36).slice(2)}.svg`
  writeFileSync(tmp, svg)
  const proc = Bun.spawn(['rsvg-convert', '-o', outPath, tmp], { stderr: 'pipe' })
  const exit = await proc.exited
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(
      `rsvg-convert failed: ${err.trim()}\nInstall with: sudo apt install librsvg2-bin`,
    )
  }
}

const outDir = resolve(import.meta.dir, '..', 'dashboard', 'icons')

await renderSvgToPng(SVG(192, 16), resolve(outDir, 'icon-192.png'))
await renderSvgToPng(SVG(512, 40), resolve(outDir, 'icon-512.png'))
// Maskable: larger padding so the safe zone fits inside Android's circular mask.
await renderSvgToPng(SVG(512, 100), resolve(outDir, 'icon-maskable-512.png'))

console.log('Icons generated in', outDir)
```

- [ ] **Step 3: Run the generator**

Run: `bun run scripts/generate-pwa-icons.ts`
Expected: "Icons generated in …/dashboard/icons".

If `rsvg-convert` is not installed, run `sudo apt install -y librsvg2-bin` then retry.

- [ ] **Step 4: Verify file sizes look reasonable**

Run: `ls -la dashboard/icons/`
Expected: three PNG files, each > 1KB and < 50KB.

- [ ] **Step 5: Commit**

```bash
git add dashboard/icons/ scripts/generate-pwa-icons.ts
git commit -m "feat(pwa): placeholder PWA icons + generator script

'PL' on dark background at 192 and 512, plus a maskable 512 with
extra padding. User can swap in real artwork later; the script
regenerates from the SVG template."
```

---

## Task B11: Update `index.html` with manifest + mobile meta tags

**Files:**

- Modify: `dashboard/index.html`

- [ ] **Step 1: Add meta tags inside `<head>`**

Inside the existing `<head>` block, add (near the existing charset/viewport tags):

```html
<link rel="manifest" href="/manifest.json" />
<meta name="theme-color" content="#0d1117" />
<link rel="apple-touch-icon" href="/icons/icon-192.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Party Line" />
```

- [ ] **Step 2: Add an install-button slot in the header**

Find the header / nav area of `index.html` where the tabs live. Add:

```html
<button id="pwa-install-btn" class="pwa-install-btn" hidden>Install</button>
```

- [ ] **Step 3: Add CSS for the install button**

Append to `dashboard/dashboard.css`:

```css
.pwa-install-btn {
  margin-left: auto;
  padding: 4px 12px;
  background: var(--accent, #3fb950);
  color: #0d1117;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.pwa-install-btn:hover {
  background: var(--accent-hover, #4cc962);
}
```

- [ ] **Step 4: Verify**

Load the dashboard in Chrome. In devtools Application → Manifest, expect "Party Line Switchboard" with the icons listed and no errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/index.html dashboard/dashboard.css
git commit -m "feat(pwa): link manifest + mobile meta + install button slot"
```

---

## Task B12: `beforeinstallprompt` handler + iOS hint

**Files:**

- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Add `beforeinstallprompt` handler**

Near the bottom of `dashboard.js` (alongside other bootstrap), add:

```js
// --- PWA install prompt ---

let deferredInstallPrompt = null
const installBtn = document.getElementById('pwa-install-btn')

window.addEventListener('beforeinstallprompt', (e) => {
  // Chrome fires this when criteria are met; we stash it and show our own button.
  e.preventDefault()
  deferredInstallPrompt = e
  if (installBtn) installBtn.hidden = false
})

installBtn?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return
  deferredInstallPrompt.prompt()
  const { outcome } = await deferredInstallPrompt.userChoice
  console.log('[pwa] install outcome:', outcome)
  deferredInstallPrompt = null
  installBtn.hidden = true
})

window.addEventListener('appinstalled', () => {
  console.log('[pwa] installed')
  if (installBtn) installBtn.hidden = true
})

// iOS Safari: no beforeinstallprompt. Detect + show a one-time hint.
function maybeShowIosInstallHint() {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const inStandalone = 'standalone' in navigator && navigator.standalone === true
  const dismissed = localStorage.getItem('pl-install-hint-dismissed') === '1'
  if (!isIos || inStandalone || dismissed) return

  const hint = document.createElement('div')
  hint.className = 'ios-install-hint'
  hint.textContent = 'Tap Share → Add to Home Screen to install Party Line.'
  const close = document.createElement('button')
  close.className = 'ios-install-hint-close'
  close.textContent = '×'
  close.addEventListener('click', () => {
    localStorage.setItem('pl-install-hint-dismissed', '1')
    hint.remove()
  })
  hint.appendChild(close)
  document.body.appendChild(hint)
}

maybeShowIosInstallHint()
```

- [ ] **Step 2: Style the iOS hint**

Append to `dashboard/dashboard.css`:

```css
.ios-install-hint {
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: 12px;
  padding: 10px 40px 10px 12px;
  background: #1f2937;
  color: #e2e8f0;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  z-index: 10000;
}
.ios-install-hint-close {
  position: absolute;
  top: 6px;
  right: 8px;
  background: transparent;
  border: none;
  color: #9ca3af;
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}
```

- [ ] **Step 3: Manual test on Chrome desktop**

In Chrome devtools Application → Manifest, click "Add to homescreen" (devtools trigger for `beforeinstallprompt`). Expected: the Install button appears in the header. Clicking it prompts to install.

- [ ] **Step 4: Manual test on iOS (optional — user-dependent)**

Open the dashboard on an iOS device, not installed. Expected: the hint bar appears at the bottom. Tapping × dismisses it. It does not reappear on subsequent loads.

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(pwa): install button (Android/Chrome) + iOS hint

Stash beforeinstallprompt, show Install button when available.
For iOS Safari (no prompt API), show a one-time dismissible hint."
```

---

## Phase B Exit Criteria

After all 12 tasks are complete:

- [ ] `bun run test:all` passes.
- [ ] `GET /sw.js` returns 200 with `Service-Worker-Allowed: /`.
- [ ] `GET /manifest.json` returns 200 with `Content-Type: application/manifest+json`.
- [ ] `GET /icons/icon-192.png` returns a 200 PNG.
- [ ] On desktop Chrome, devtools Application tab shows the SW registered and the manifest parsed without errors.
- [ ] On an Android phone, clicking a session bell with `permission='default'` triggers the native permission prompt (not the abuse-heuristic auto-deny).
- [ ] After granting permission on an Android phone, sending a party-line message to a bell-on session produces an OS notification with the session name as title.
- [ ] Tapping the OS notification opens/focuses the dashboard on the `/#/session/<name>` route.
- [ ] With permission granted on Android, switching Chrome to background and receiving a message still fires a notification (because SW-based notifications survive tab-not-focused; closed-tab / killed-tab is still NOT supported — that's Phase 2).
- [ ] Flipping the site permission in Chrome settings while the dashboard is open reflects in the banner within ~1s of returning to the tab.
- [ ] Chrome's "Install" prompt works (button appears once criteria are met).

Phase B is independently shippable — it doesn't depend on Phase C. When exit criteria pass, the notifications and PWA story is solid regardless of what else is going on with the transport.

---

## Notes for the Implementer

- B1–B3 are independent and can be done out of order. B4 depends on B3 (needs the `swRegistration` dep). B5, B6, B7 all edit `dashboard.js` — serialize them.
- B8 will temporarily have a broken test until B4 is committed; that's expected. If doing subagent-driven execution, merge B4 + B8 into a single task or skip the interim commit.
- Run `bun test` between tasks. Even though some tasks are pure-HTML/CSS, any JS change can regress the notifications tests.
- When testing manually, use Chrome's devtools to simulate permission states: `navigator.permissions.query({name:'notifications'}).then(p => console.log(p.state))`.
