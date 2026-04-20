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
