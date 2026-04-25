// Party Line Dashboard Service Worker.
// Caches the app shell, serves it offline, and handles notification clicks.

const CACHE_NAME = 'party-line-shell-v5'

const SHELL = [
  '/',
  '/index.html',
  '/dashboard.css',
  '/dashboard.js',
  '/notifications.js',
  '/tabs-state.js',
  '/transcript-grouping.js',
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

// Network-first for shell files: always try network, fall back to cache only
// if offline. Cache-first was silently serving stale JS/HTML forever, making
// dashboard updates invisible until CACHE_NAME was bumped.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET') return
  if (!SHELL.includes(url.pathname)) return
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Refresh the cache in the background so offline mode has latest shell.
        if (res && res.ok) {
          const clone = res.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
        }
        return res
      })
      .catch(() => caches.match(event.request).then((cached) => cached || Response.error())),
  )
})

// Derive the in-app route from a notification's `data` payload. This logic
// is mirrored in dashboard/sw-routes.js where it's covered by unit tests;
// keep the two in sync. Using PATH routes (not hash routes) because
// dashboard.js parseUrl() matches `/session/<name>` — a `/#/session/...`
// would never trigger the router (this was the previous bug).
function notificationRouteFromData(data) {
  const sessionName = data && data.sessionName
  if (!sessionName) return '/'
  return '/session/' + encodeURIComponent(sessionName)
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const url = notificationRouteFromData(data)

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Same-origin match. `client.url` is absolute (includes origin), so we
      // compare pathname + search against our relative target.
      for (const client of list) {
        try {
          const u = new URL(client.url)
          if (u.pathname + u.search === url && 'focus' in client) {
            return client.focus()
          }
        } catch {
          // client.url parse failed — skip.
        }
      }
      // No window on that route yet. If one is open, focus+navigate it;
      // otherwise open a new one. Both paths need the URL that the
      // dashboard's client-side router will parse on load.
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
