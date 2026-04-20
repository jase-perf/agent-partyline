# Notifications Audit — 2026-04-20

## Summary

The Phase 1 "foreground-only, no Service Worker" design is the root cause of the
Android-Chrome silence, and it was the wrong split. The `Notification()`
constructor has not been a viable primitive on Chrome/Chromium Android since
~2015 — it throws `TypeError: Illegal constructor` and the browser explicitly
directs callers to `ServiceWorkerRegistration.showNotification()`. Our code
path `new deps.NotificationCtor(title, options)` in `dashboard/notifications.js`
will therefore fail silently (the throw is caught nowhere, and the WS handler
in `dashboard.js` has no try/catch around `notif.onPartyLineMessage`, so an
unhandled exception propagates out of the message callback and future frames
may still dispatch — but nothing renders). On desktop Chrome/Edge the
constructor works, so the feature "tested fine locally" and shipped.

The Windows/macOS Edge symptom ("click Enable does nothing, then eventually
flips to blocked") is the permissions-chip quiet UI plus Chrome's engagement-
based auto-deny heuristic: after multiple calls without resolution in a
trusted gesture, Chromium treats the site as abusive and `denied`s the request
without ever showing the prompt. Our banner click handler compounds this by
(a) firing `requestPermission()` from an `async` event listener — the gesture
may already be considered "consumed" by the time the promise microtask runs
in stricter browsers — and (b) the banner stays cached at `denied` forever
because `updateBanner()` is never re-invoked on `visibilitychange`, `focus`,
or any other event that would catch the user flipping the site setting in
another tab.

Phase 1/Phase 2 as specced — "ship foreground-only first, layer SW + Push
later" — treats the Service Worker as an optimization for killed-tab
notifications. In reality, the Service Worker is a **prerequisite** on mobile
and the recommended path on desktop. The correct architecture is a single
path: register a minimal Service Worker, call
`registration.showNotification()` for all three triggers, keep everything
else (WS transport, cross-tab dismiss, permission request cards) exactly as
it is. No VAPID, no Push API, no manifest — that's a genuine Phase 2 once
you want notifications while the tab is closed. The rebuild is small
(maybe 150 lines of diff) and removes all the surface area of the current
bugs at once.

## Architecture Review

### What the current design assumes

`dashboard/notifications.js` and the design spec assume that
`new Notification(title, options)` is a portable primitive: construct it,
hold the instance, call `.close()` later, attach an `onclick`. Everything
in the module (`fire()`, `activeNotifications: Map<string, Notification>`,
`onNotificationDismiss` closing by tag) is built on that instance model.
There is no Service Worker registration, no `manifest.json`, no HTTPS
strategy beyond "user provides mkcert via `--cert/--key`".

### What actually happens per platform

| Platform                                    | `new Notification()`                                                                                                   | `registration.showNotification()` | Our code today                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------- |
| Chrome/Edge desktop (macOS, Windows, Linux) | Works, fires OS toast                                                                                                  | Works                             | Works, subject to engagement heuristic         |
| Firefox desktop                             | Works                                                                                                                  | Works                             | Works                                          |
| Safari desktop 16+                          | Works                                                                                                                  | Works (preferred)                 | Works                                          |
| Chrome Android                              | **Throws `TypeError: Illegal constructor`**                                                                            | Works                             | **Silently broken — this is the reported bug** |
| Firefox Android                             | Throws TypeError                                                                                                       | Works                             | Broken                                         |
| Safari iOS/iPadOS                           | Requires "Add to Home Screen" PWA + SW + Push                                                                          | Works only inside installed PWA   | Does not work at all                           |
| Chromium with quiet permissions UI          | `requestPermission()` may resolve `denied` without showing a prompt if the site accrued low-engagement heuristic marks | Same                              | Hits the heuristic and dead-ends at "blocked"  |

The Android behavior is not a quirk. It is documented on MDN and has been the
steady state for roughly a decade: "The Notification constructor throws a
TypeError when called in nearly all mobile browsers and this is unlikely to
change… If you are targeting mobile devices, you should register a service
worker and use `ServiceWorkerRegistration.showNotification()` instead."

### Was the Phase 1/Phase 2 split correct?

No. The split bundled two independent axes together:

- **Axis 1 — SW required to call `showNotification`?** Yes on mobile, yes as
  best practice everywhere.
- **Axis 2 — Push API / VAPID required for closed-tab delivery?** Only if
  you want notifications when the tab is dead.

Phase 1 dropped the SW (axis 1) together with Push (axis 2), as if they
were one feature. They are not. A Service Worker for foreground
`showNotification()` requires:

- One file, `sw.js`, ~20 lines for install/activate + notificationclick.
- One call site: replace `new Notification(...)` with
  `(await navigator.serviceWorker.ready).showNotification(...)`.
- Nothing else. No VAPID keys, no push subscription, no server.

Push + VAPID + subscription registry is the real Phase 2 and can still be
deferred. But the SW itself is not an optional layer — it is the notification
surface on mobile, and the recommended surface on desktop.

### What a professional web app does in 2026

The conventional shape is:

1. Register a Service Worker on first load (`navigator.serviceWorker.register('/sw.js')`).
2. Gate the permission prompt behind a visible, explicit in-page click — not
   a banner that appears on load.
3. Request permission inside the click handler **without any `await` before
   the call** — Safari/iOS especially treats the user activation as consumed
   across microtask boundaries.
4. For every notification, call `registration.showNotification()` (where
   `registration = await navigator.serviceWorker.ready`). Do not hold
   instances; re-query `registration.getNotifications({ tag })` when you
   need to close one.
5. Handle clicks in the SW via a `notificationclick` event that uses
   `clients.matchAll()` + `focus()` / `openWindow()` to route the user.
6. Re-read `Notification.permission` on `visibilitychange` and `focus`
   because users can change site settings in another tab.
7. Serve over HTTPS (you already do via mkcert) or `http://localhost` (which
   is a secure context). The "https:// required" banner text is correct, but
   the implementation assumption that HTTPS alone is enough is incomplete.

## Bugs Identified

### CRITICAL — `new Notification()` will throw on Chrome Android, no fallback

- Location: `dashboard/notifications.js:66` (`new NC(title, { ... })`)
- Symptom: On Android Chrome, no notification fires for any of the three
  triggers even though the bell is on, permission is granted, and the tab is
  hidden. This is exactly what the user reported.
- Root cause: The `Notification()` constructor throws `TypeError: Illegal
constructor. Use ServiceWorkerRegistration.showNotification() instead.`
  on Chromium-based mobile browsers. The call site has no try/catch, so the
  throw unwinds out of `fire()` into `onSessionUpdate` / `onPartyLineMessage`
  / `onPermissionRequest`. The callers in `dashboard.js:257,274,286,289,292`
  have no try/catch either, so the throw propagates into the raw
  `ws.onmessage` handler and is swallowed by the browser's default event
  error-handling. Nothing logs. Nothing fires. Silent failure.
- Fix sketch: Route every `fire()` through
  `const reg = await navigator.serviceWorker.ready; reg.showNotification(title, options)`.
  Register a minimal `sw.js` that implements `notificationclick` to focus
  an existing client or open a new one at `/session/<name>`. Replace the
  `activeNotifications: Map<string, Notification>` cache with a per-call
  `reg.getNotifications({ tag })` lookup when you need to close.

### CRITICAL — `Notification.permission` is read-once and never refreshed

- Location: `dashboard/notifications.js:57,92` (`deps.NotificationCtor.permission`
  is read at call time but `updateBanner()` is only called on mount and
  directly after `requestPermission()`); `dashboard.js:2038` (only one
  `updateBanner()` call at load); `dashboard.js:2206` (visibilitychange
  handler only dispatches `session-viewed`, does not refresh banner).
- Symptom: After the user flips "Notifications: Allow" in browser site
  settings (e.g. in another tab), the dashboard continues to say "🔔
  Notifications blocked. Re-enable in browser settings" indefinitely. Bells
  stay `notif-bell-disabled`. User reported this exact behavior.
- Root cause: The banner state is computed purely from
  `notif.getPermissionState()` which reads `Notification.permission` at
  call time. There is no listener for `permissions.query({ name: 'notifications' })`
  change events, no refresh on `visibilitychange`, no refresh on `focus`.
  The banner gets locked into whatever state it saw at page load +
  the immediate post-requestPermission result.
- Fix sketch:
  1. Add `document.addEventListener('visibilitychange', () => { if (!document.hidden) updateBanner(); updateAllBells(); })`.
  2. Add `window.addEventListener('focus', ...)` likewise.
  3. Use the Permissions API if available:
     `const p = await navigator.permissions.query({ name: 'notifications' }); p.onchange = () => { updateBanner(); updateAllBells(); };`
     This fires immediately when the user changes the site setting, no
     polling needed.
  4. Extract bell re-rendering into a helper that loops
     `document.querySelectorAll('.notif-bell, #detail-bell')` and
     recomputes disabled state from the current permission.

### CRITICAL — Banner "Enable" button can be consumed by abuse heuristic

- Location: `dashboard/dashboard.js:2027-2032` (banner click handler),
  `dashboard/notifications.js:94-97` (`requestPermission`)
- Symptom: On Edge desktop, clicking Enable "does nothing" for many clicks,
  then the banner suddenly flips to `denied` — classic Chromium quiet-UI
  auto-deny.
- Root cause: Two things working together.
  - (a) `requestPermission()` is called from an `async` handler _after_ `await`
    has not yet occurred, which is OK — but the handler then `await`s the
    permission promise. That's fine on desktop Chrome, but the banner appears
    on page load with no prior engagement signal. Chrome's engagement-based
    heuristic treats low-engagement prompts as abusive. Each unresolved
    prompt pushes the site further into the quiet-UI bucket, and after enough
    bounces the request resolves `denied` without a prompt being shown. The
    user's "many clicks, then blocked" experience is the heuristic doing
    its job.
  - (b) The banner appears automatically on every load if permission is
    `default`. That is exactly the pattern the heuristic penalizes:
    unsolicited notification prompts with no user intent.
- Fix sketch:
  - Do not auto-show the banner. Instead, show a "🔔 Enable" control only
    inline on the bell icon's hover/first-toggle path: when the user clicks
    a bell for a session with `default` permission, _that_ click triggers
    `requestPermission()`. This ties the prompt to a specific user intent
    (enabling for a specific session) and satisfies Chrome's "permission
    was triggered through a user gesture on site" heuristic.
  - Keep a small persistent settings link ("Notification permission: default
    — click to enable") somewhere unobtrusive, not a full-width banner.
  - Once the user has clicked Enable a first time and the prompt resolved
    `default` (dismissed OS prompt), do not auto-prompt again on next load.
    Require another explicit click.

### IMPORTANT — WS frame handlers have no try/catch; one throw kills downstream dispatch

- Location: `dashboard/dashboard.js:250-294` (the entire `ws.onmessage` body)
- Symptom: If any notif method throws (e.g. the `new Notification()`
  constructor-throw above), subsequent handlers in the same frame (`addMessage`,
  `bumpUnread`, `appendEnvelopeToStream`) may or may not run depending on
  ordering, and no error is logged to help diagnose. User sees "nothing
  happens" with no clue why.
- Root cause: Direct method calls with no isolation. `notif.onPartyLineMessage`
  sits between `addMessage` and `appendEnvelopeToStream` in the same
  synchronous path.
- Fix sketch: Wrap every notif call in a try/catch that logs to console:
  `try { notif.onPartyLineMessage(data.data) } catch (err) { console.warn('notif:', err) }`.
  More importantly, the SW rebuild makes `fire()` async and the errors
  become Promise rejections that are observable without crashing the
  WS handler.

### IMPORTANT — `shouldFire` can return true but `fire` silently swallows the failure

- Location: `dashboard/notifications.js:63-79`
- Symptom: No logging when notifications fail to construct. Debugging is
  impossible from the user's side.
- Root cause: `fire()` has no error handling, no console logging, and no way
  for external code to detect that a firing attempt happened at all, let
  alone whether it succeeded.
- Fix sketch: Log at debug level in dev builds. Wrap the constructor call
  with try/catch and surface an inline `console.warn` that says "Falling
  back to SW path" or "Notification unsupported in this context."

### IMPORTANT — The banner HTTPS check is wrong for `http://localhost`

- Location: `dashboard/dashboard.js:2013` (`!window.isSecureContext`)
- Symptom: `localhost:3400` users don't hit this path because `localhost` is
  a secure context, so this is fine there. But the banner's text claims
  notifications require HTTPS, which is misleading — `http://localhost` and
  `http://127.0.0.1` are secure contexts too, and some users may worry.
- Root cause: Cosmetic copy bug, not a functional one. The `isSecureContext`
  check itself is correct.
- Fix sketch: Reword the banner: "🔔 Notifications require a secure context
  (https:// or localhost). Reach the dashboard via https:// or http://localhost
  to enable."

### IMPORTANT — `notification-dismiss` loses effectiveness after an SW rebuild

- Location: `dashboard/notifications.js:171-178`, `dashboard/notifications.js:164-169`
- Symptom: With the current instance-cache, `activeNotifications.get(sessionName).close()`
  works. After an SW rebuild, instances aren't held — `showNotification()`
  returns a Promise<void>, not a Notification object.
- Root cause: API shape differs between `new Notification()` and
  `registration.showNotification()`.
- Fix sketch: Replace the cache with an async lookup:
  ```js
  const reg = await navigator.serviceWorker.ready
  const existing = await reg.getNotifications({ tag: sessionName })
  existing.forEach((n) => n.close())
  ```
  This is the intended API. It works the same across desktop and mobile.

### IMPORTANT — Bell toggle has no permission-upgrade path

- Location: `dashboard/dashboard.js:2041-2068` (overview-grid click handler)
- Symptom: When permission is `default`, the bell is disabled and clicking it
  does nothing. The user must find the banner separately. With the banner
  penalized by the heuristic, the user has no reliable path to grant
  permission.
- Root cause: `bell.classList.contains('notif-bell-disabled')` short-circuits
  at the top of the handler without distinguishing between "denied" and
  "default".
- Fix sketch: If the bell is clicked while permission is `default`, call
  `requestPermission()` from that click (user gesture, site-scoped intent).
  On grant, immediately flip the bell to on for that session. This gives
  you a clean, heuristic-friendly prompt path and removes the need for the
  auto-banner entirely.

### IMPORTANT — Notification `onclick` `navigate('/#/session/...')` does not match the router

- Location: `dashboard/notifications.js:76` (`deps.navigate('/#/session/' + sessionName)`)
- Symptom: Clicking a notification may not land on the session detail view
  correctly depending on router state — the router uses pathname-based
  routing (`/session/<name>`) throughout `dashboard.js`, not hash routing.
- Root cause: The notifications module emits hash-style routes but the
  injected `navigate` wrapper (`dashboard.js:1981-1994`) strips the leading
  `/#/` with a regex before matching. That works, but the test at
  `tests/notifications.test.ts:285` asserts `'/#/session/research'`, locking
  this confusion into the test suite. Works today, but fragile.
- Fix sketch: Pick one convention. If the router is path-based (it is),
  emit path-based routes (`/session/<name>`) from the notifications module
  and update the test. The SW rebuild will need to use `clients.openWindow('/session/<name>')`
  anyway — those paths must be consistent.

### IMPORTANT — Tab-wake and session-viewed dismiss only fires in session-detail view

- Location: `dashboard/dashboard.js:2206-2214`
- Symptom: If the user has a notification for session A and they switch back
  to the dashboard tab while on Switchboard, the notification is _not_
  dismissed even though they can now see live state for A.
- Root cause: The visibilitychange handler checks
  `currentView !== 'session-detail' || !selectedSessionId` and bails. This
  is consistent with the spec ("Fires only when the tab is hidden OR the
  user is not currently viewing that session's detail route") but it means
  returning to Switchboard doesn't clear pre-existing notifications.
- Fix sketch: Debatable whether to fix. Acceptable behavior, but worth
  noting: Switchboard arguably is "viewing all sessions." A lighter change
  is: on tab-visible, dispatch `session-viewed` for every session with an
  active notification (i.e., drain `activeNotifications.keys()`).

### NIT — `lastKnownState` never garbage-collects ended sessions

- Location: `dashboard/notifications.js:51,100-101`
- Symptom: Memory growth over very long runs, each session adds an entry
  that is never removed.
- Root cause: No cleanup on `state === 'ended'`.
- Fix sketch: `if (update.state === 'ended') lastKnownState.delete(update.name)`.

### NIT — `resolvedPermissions` grows unbounded

- Location: `dashboard/notifications.js:52,164`
- Symptom: Same memory-growth concern for very long-running dashboards.
- Root cause: Set is never pruned.
- Fix sketch: Cap at some size with a rolling eviction, or store a
  timestamp and drop entries older than 5 minutes (Claude Code's timeout
  horizon).

### NIT — Banner text "Notifications blocked" is final but user expects recovery

- Location: `dashboard/dashboard.js:2019-2020`
- Symptom: Banner goes to "denied" and hides its button, but the user has
  no way to retry from the dashboard.
- Root cause: Intentional (permission can only be re-granted via browser
  settings). But combined with the caching bug above, it feels like a
  dead end.
- Fix sketch: Add a small "↻ Re-check" link that just calls `updateBanner()`,
  so after the user fixes it in site settings they have a visible way to
  confirm the dashboard picked it up. The Permissions API `change` event
  makes this automatic, but a manual nudge is a cheap belt-and-braces.

### NIT — Test suite misses the whole constructor-throw case

- Location: `tests/notifications.test.ts` — the `FakeNotification` in
  `_notification-helpers.ts` always "succeeds" construction. No test
  forces a throw to exercise the error path.
- Symptom: 100% of tests pass against a fake Notification class, so the
  Android Chrome failure is invisible to CI.
- Fix sketch: Add a test where the fake constructor throws — prove the
  module either routes through the SW fallback or at minimum does not
  crash the caller.

## Recommendation

**Rebuild on a Service Worker.** Do not try to salvage the foreground-only
path. The surface area of "Chrome desktop works, Chrome mobile silently
broken, permission state caches stale, banner triggers abuse heuristic" is
too wide for incremental fixes, and every fix still leaves mobile broken.
The SW path makes all four platforms behave the same.

### Shape of the rebuild

New files:

- `dashboard/sw.js` — single Service Worker, ~30-50 lines:
  - `install` / `activate` with `self.skipWaiting()` + `self.clients.claim()`.
  - `notificationclick` handler:
    - `event.notification.close()`.
    - `clients.matchAll({ type: 'window' })` → if any client's URL matches
      our origin, focus it + postMessage the target route; otherwise
      `clients.openWindow('/session/' + event.notification.data.sessionName)`.
  - No push handler in this phase. Add later when VAPID work lands.

Modified files:

- `dashboard/notifications.js`:
  - Initialize by registering the SW:
    `navigator.serviceWorker.register('/sw.js')` and storing the ready
    registration.
  - `fire()` becomes `async`, calls `reg.showNotification(title, { ...options, tag, data })`.
    No instance cache.
  - `onNotificationDismiss` / `onPermissionResolved` become async:
    `const existing = await reg.getNotifications({ tag }); existing.forEach(n => n.close())`.
  - `requestPermission()` is called from the bell click, not a banner.
  - Drop `activeNotifications` Map entirely.
  - Add Permissions API listener to drive a new `onPermissionChange(cb)`
    exported hook.

- `dashboard/dashboard.js`:
  - Remove the auto-appearing banner. Keep a small status line
    (optional) that says "Notifications: granted / default / denied"
    and exposes a manual re-check.
  - Bell click handler: if `getPermissionState() === 'default'`, call
    `requestPermission()` inside the same handler (synchronous call —
    no `await` before the call). On `'granted'`, toggle bell on.
  - Wire `onPermissionChange` to re-render all bells + status line.
  - Wrap every `notif.*` call in the WS handler with a try/catch that
    `console.warn`s — cheap diagnostic insurance.

- `dashboard/serve.ts`:
  - New static route: `/sw.js` serves `dashboard/sw.js` with
    `Content-Type: application/javascript` and `Service-Worker-Allowed: /`.
  - No other server changes needed. The UDP + WebSocket protocol is
    untouched.

- `dashboard/index.html`:
  - Drop `#notif-banner` and its contents.
  - Add a small status pill alongside the `conn-status` span.

Test changes:

- `tests/notifications.test.ts`:
  - Replace `NotificationCtor` in `mockDeps` with a mock `serviceWorker`
    registration that records `showNotification` calls and supports
    `getNotifications({ tag })`.
  - Add tests for the Permissions API `change` path.
  - Add a test that confirms `requestPermission` is only called
    synchronously from a "user gesture" simulator.

### What stays the same

- UDP envelope types (`permission-request`, `permission-response`).
- WS frames (`permission-request`, `permission-resolved`, `notification-dismiss`,
  `session-viewed`).
- Server-side cross-tab dismiss fan-out.
- Trigger A/B/C decision logic (working→idle, message matching,
  permission request gating).
- `shouldFire()` rules (tab hidden or different route + toggle on +
  permission granted).
- localStorage per-session toggle storage.
- Permission request card UI in Session Detail.

### What Phase 2 really is

After the SW rebuild lands, the remaining Phase 2 work is:

1. `manifest.json` + installability affordance ("Add to Home Screen")
   — needed for Safari iOS to deliver _any_ notifications, and nice on
   Android for a standalone launcher.
2. `PushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
   with VAPID keys generated by `serve.ts` at startup.
3. A `/api/push/subscribe` endpoint that stores subscription objects in
   SQLite, keyed by session or per-client.
4. `push` event handler in `sw.js` that receives payload and calls
   `self.registration.showNotification(...)`.
5. Server-side `web-push` library (Node / Bun npm package) that sends
   to the stored subscriptions on trigger events.

That is the "killed-tab notifications" feature. It is independent of and
orthogonal to the current rebuild. The current rebuild fixes today's
bugs. Phase 2 adds "works when dashboard tab is closed" — a genuinely
different user story that deserves its own spec.

### Estimated effort

The rebuild is maybe a half-day of focused work plus tests. The diff
removes code (the instance cache, the banner logic) at roughly the same
rate that it adds code (the SW, the Permissions API hook, the bell
prompt path). Net line count should be flat or slightly lower.

## Sources

- [MDN: ServiceWorkerRegistration.showNotification](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification)
- [MDN: Notification() constructor](https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification)
- [MDN: Using the Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API)
- [MDN: Notification.requestPermission() static method](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static)
- [MDN: Notification.permission static property](https://developer.mozilla.org/en-US/docs/Web/API/Notification/permission_static)
- [Chromium issue: new Notification() no longer works on Android](https://groups.google.com/a/chromium.org/g/chromium-bugs/c/4gz0S1CSVY0)
- [Chromium Blog: Introducing quieter permission UI for notifications (Chrome 80+)](https://blog.chromium.org/2020/01/introducing-quieter-permission-ui-for.html)
- [Chromium Blog: Reducing notification overload — automatic permission revocation (Oct 2025)](https://blog.chromium.org/2025/10/automatic-notification-permission.html)
- [Chrome for Developers: Permissions request chip (user gesture, engagement)](https://developer.chrome.com/blog/permissions-chip)
- [PushAlert: Chrome Policy Updates 2026 — Rate Limits & Permission Removal](https://pushalert.co/blog/google-chrome-rate-limits-spam-protection-permission-removal/)
- [Pushpad: Notification prompt must be triggered by user gesture](https://pushpad.xyz/blog/the-notification-prompt-can-only-be-triggered-by-a-user-gesture-on-some-browsers)
- [WICG/interventions #49: Require user gesture to request notification permissions](https://github.com/wicg/interventions/issues/49)
- [USENIX Security '21: "Shhh…be quiet!" — Reducing unwanted interruptions of notification permission prompts on Chrome](https://www.usenix.org/system/files/sec21summer_bilogrevic.pdf)
- [web.dev codelab: Use a Service Worker to manage notifications](https://web.dev/articles/codelab-notifications-service-worker)
- [GitHub: notify.js issue #86 — TypeError Illegal constructor on mobile](https://github.com/alexgibson/notify.js/issues/86)
- [Apple Developer Forums: Notification requestPermission on Safari iOS PWA](https://developer.apple.com/forums/thread/725619)
