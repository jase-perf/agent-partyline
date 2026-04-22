// Party Line Dashboard Service Worker.
// Caches the app shell, serves it offline, and handles notification clicks.

const CACHE_NAME = 'party-line-shell-v3'

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
