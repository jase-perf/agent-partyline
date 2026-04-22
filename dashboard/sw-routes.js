// @ts-check
// Pure helpers for Service Worker URL handling.
// Lives in its own module so unit tests can import it without booting a
// real Service Worker, and so sw.js can importScripts() it.

/**
 * Derive the in-app route from a notification's `data` payload.
 *
 * Dashboard uses PATH routes (e.g. `/session/<name>` — see dashboard.js
 * parseUrl()), NOT hash routes. A previous version of sw.js used
 * `/#/session/...` which never matched the router.
 *
 * @param {{ sessionName?: string } | null | undefined} data
 * @returns {string}
 */
export function notificationRouteFromData(data) {
  const sessionName = data && data.sessionName
  if (!sessionName) return '/'
  return '/session/' + encodeURIComponent(sessionName)
}
