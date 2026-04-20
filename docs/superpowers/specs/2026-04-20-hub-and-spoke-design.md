# Party Line v2 — Hub-and-Spoke Architecture + Notifications Rebuild

**Date:** 2026-04-20
**Status:** Approved by user — ready for plan
**Supersedes:** UDP multicast transport (`src/transport/udp-multicast.ts`), heartbeat-based presence (`src/presence.ts`), Phase-1 foreground-only notifications

## Goal

Replace the UDP-multicast peer-to-peer transport with a central switchboard-mediated
hub-and-spoke model, and rebuild the browser notifications feature on a Service
Worker. This also lays the groundwork for installing the dashboard as a PWA on
mobile. The restructuring addresses concrete audit findings (four critical bugs
in the current transport, notifications broken on mobile, flickery realtime from
four racing update channels) and positions the system for multi-machine and
authenticated operation later.

## Context

A four-agent audit (`docs/audit/2026-04-20-*.md`) identified 12 critical and ~25
important issues across the codebase. The audit confirmed that:

- The UDP multicast transport has unfixable structural bugs (dedup is GC-only,
  `send-twice` is racey, `seq` is dead weight, no auth).
- `new Notification()` throws `TypeError: Illegal constructor` on Chrome Android
  and has been that way for a decade; Phase 1's foreground-only design was
  never viable on mobile.
- Four independent update channels race to refresh the same UI state with no
  revision tag, producing the "realtime feels inconsistent" symptom.

The user has confirmed a hard pivot (no backwards compatibility needed — the
system is pre-1.0 and single-user).

## Out of Scope (explicit)

- **Push API / VAPID / server-side push.** Closed-tab notification delivery
  stays a real Phase 2. This spec's notifications rebuild assumes a running
  page or installed PWA as the notification origin.
- **Multi-user / role-based access control.** Dashboard gets a single shared
  password; per-user identity is a future concern.
- **Multi-machine deployment.** The design is multi-machine-ready (switchboard
  URL is configurable, sessions dial outbound, auth is per-session-token) but
  this spec ships with localhost-only defaults. Cross-machine bootstrap
  (initial token provisioning over untrusted network) is deferred.
- **Restoring Claude Code sessions from switchboard DB.** Not feasible —
  switchboard captures party-line envelopes + hook events, not the structured
  JSONL CC consumes on `--resume`. Old sessions are archived, not
  reinstantiated.

## 1. Architecture Overview

**Switchboard** is a single Bun process (the existing dashboard binary) that owns:

- The `ccpl_sessions` registry — authoritative source for every named session's
  identity, token, working directory, and current Claude Code UUID.
- Two authenticated WebSocket endpoints:
  - `/ws/session` — for Claude Code MCP plugins (one WS per live CC process).
  - `/ws/observer` — for the browser dashboard + CLI tool.
- An HTTP control API under `/api/*` and `/ccpl/*` for registration, commands,
  and dashboard data.
- All persistent state in SQLite (existing DB file, new tables added).
- TLS via the existing mkcert path.

**Claude sessions** connect outbound from the MCP plugin to switchboard via WS
using their session token. The plugin owns the connection for the lifetime of
the CC process. Tool calls (`party_line_send`, `party_line_request`,
`party_line_respond`) become sends over that WS. Inbound envelopes arrive as
WS frames, trigger MCP notifications to Claude Code (same wake-on-message
behavior).

**ccpl wrapper** is a small Bun CLI tool. It talks to switchboard over HTTP
for registration/list/forget/rotate, reads tokens from disk, injects
`PARTY_LINE_TOKEN` into the environment at launch, and renames the tmux window.

**Dashboard browser UI** is an authenticated observer client. It reads via
`/ws/observer` (password-authenticated session cookie), issues commands
(send message, approve permission, dismiss notification) via HTTP POST.
Installable as a PWA on mobile with Service Worker + manifest.

Removed: UDP multicast, `seq`, `Deduplicator`, `send-twice`, heartbeat-based
presence liveness, peer-to-peer discovery. Connection state IS presence.

## 2. Session Lifecycle & Auth

### 2.1 Registration

```
ccpl new <name> [--cwd DIR] [--force]
  → POST /ccpl/register  body: {name, cwd}
  → server validates name uniqueness (409 if taken unless --force forgets old)
  → server generates 256-bit token (crypto.randomBytes), inserts row
  → server returns {token}
  → wrapper writes ~/.config/party-line/sessions/<name>.token
      (file mode 0600; parent dir 0700)
  → wrapper prints: "Registered. Run `ccpl <name>` to launch."
```

### 2.2 Launching

```
ccpl <name>
  → wrapper reads ~/.config/party-line/sessions/<name>.token
  → if missing: exit 1 with "no session named <name>. Use `ccpl new <name>`."
  → GET /ccpl/session/<name>  header: X-Party-Line-Token: <token>
  → server returns {cwd, cc_session_uuid, created_at, last_active_at}
  → wrapper: process.chdir(cwd)
  → branch on cc_session_uuid state:
      A) cc_session_uuid is null (first-ever launch):
         exec claude --name <name> (env: PARTY_LINE_TOKEN=<token>)

      B) cc_session_uuid present, JSONL at ~/.claude/projects/<cwd-enc>/<uuid>.jsonl exists:
         exec claude --resume <uuid> --name <name> (env: PARTY_LINE_TOKEN)

      C) cc_session_uuid present, JSONL missing:
         prompt (stdin tty): "No resumable CC session for '<name>' (UUID <uuid>
         not found). Archive prior history and start fresh? [Y/n] "
         on Y: POST /ccpl/archive body: {name, reason: "jsonl_missing"}
                exec claude --name <name> (env: PARTY_LINE_TOKEN)
         on N: exit 0 without launching
  → if process.env.TMUX is set: run `tmux rename-window <name>` (best-effort, non-fatal)
```

### 2.3 MCP plugin handshake

On CC startup, the MCP plugin:

1. Reads `process.env.PARTY_LINE_TOKEN`. If missing, logs a warning and runs
   in degraded mode (tool calls fail with "not registered"). CC itself runs
   fine.
2. Reads its own session name from `--name` in the parent process tree (existing
   `resolveNameFromProcessTree` logic).
3. Reads its own CC session UUID from CC's session file (existing
   `introspect.ts` logic).
4. Opens WS to `${PARTY_LINE_SWITCHBOARD_URL:-wss://localhost:3400}/ws/session`.
5. Sends first frame:
   ```json
   {
     "type": "hello",
     "token": "<token>",
     "name": "<name>",
     "cc_session_uuid": "<uuid>",
     "pid": <process.pid>,
     "machine_id": "<machine-id>",
     "version": "<plugin-version>"
   }
   ```
6. Server validates token → looks up session by token, confirms name matches,
   updates `cc_session_uuid` / `pid` / `last_active_at`, sets `online=true`.
   Returns:
   ```json
   {
     "type": "accepted",
     "server_time": <epoch_ms>,
     "switchboard_version": "<version>"
   }
   ```
7. On validation failure (unknown token, name mismatch):

   ```json
   { "type": "error", "code": "invalid_token" | "name_mismatch", "message": "..." }
   ```

   followed by `ws.close(4401)`. Plugin logs, exits with non-zero (no recovery —
   user must `ccpl rotate` or `ccpl forget`/`ccpl new`).

8. If a second `hello` arrives with a valid token while another WS is already
   active for that session: server closes the old WS with
   `{type: "error", code: "superseded"}` + `ws.close(4408)`, then accepts the
   new one. The displaced plugin logs "superseded" and exits without
   reconnecting. This cleanly recovers from a stale connection that survived
   after a CC crash without a TCP FIN.

### 2.4 UUID rotation (on `/clear` or `/new`)

When the CC session's UUID changes mid-process (via `/clear` or `/new`), the
MCP plugin detects it via its JSONL observer and sends:

```json
{
  "type": "uuid-rotate",
  "old_uuid": "<prev>",
  "new_uuid": "<current>"
}
```

Server:

1. Inserts row into `ccpl_archives` (`name`, `old_uuid`, `archived_at`, `reason="clear"`).
2. Updates `ccpl_sessions.cc_session_uuid` to `new_uuid`, bumps `revision`.
3. Broadcasts `session-delta` to observers.

No user prompt — `/clear` is itself an explicit user action. Token stays the same.

### 2.5 Management commands

- `ccpl list [--json]` — GET `/ccpl/sessions` → tabular output: name, cwd, state
  (`live`/`offline`), last_active, cc_session_uuid, age, archive_count.
- `ccpl forget <name>` — DELETE `/ccpl/session/<name>` (auth via token). Server
  deletes row + all archive rows for that name. Wrapper deletes token file.
- `ccpl rotate <name>` — POST `/ccpl/session/<name>/rotate` (auth via existing
  token OR localhost-only carve-out if token is missing but the DB row exists
  and UID matches switchboard's runtime UID). Returns new token. Wrapper
  overwrites local token file.
- `ccpl cleanup [--older-than DURATION] [--dry-run]` — POST `/ccpl/cleanup`
  with duration. Server deletes rows where `last_active_at < cutoff` AND
  no live WS. Reports what was removed.

### 2.6 Dashboard auth

Login at `/login`. Password is `PARTY_LINE_DASHBOARD_PASSWORD` env var (server
reads on startup; unset = auth disabled; warn loudly in server log if unset
over public interface). On success, server sets a signed cookie `pl_dash`
(signed with `PARTY_LINE_DASHBOARD_SECRET` env var, 32-byte random, 24h
expiry). WS handshake and every API call check the cookie. `/login` and
`/manifest.json` / static assets are the only unauthenticated routes.

## 3. WebSocket Protocol

### 3.1 Frame envelope

All frames are JSON objects:

```json
{ "type": "<string>", "id": "<server-assigned-opaque>", "ts": <epoch_ms>, ...payload }
```

`id` is server-assigned for outbound envelopes; client-submitted sends include
a `client_ref` for echo-matching, server assigns the authoritative `id`.

### 3.2 `/ws/session` — MCP plugin ↔ switchboard

Client → server:

- `hello` — initial handshake (§2.3).
- `uuid-rotate` — UUID change (§2.4).
- `send` — `{ type, to, body, client_ref, callback_id?, response_to? }`. Server
  assigns `id`, inserts into `messages` table, fans out to recipients. Echoes
  back to sender with `{ type: "sent", client_ref, id }`.
- `respond` — same as send but always carries `response_to` + `callback_id`.
- `permission-response` — `{ request_id, decision, reason? }`.
- `ping` — `{}`. Server responds `{ type: "pong", ts }`.

Server → client:

- `accepted` — post-hello (§2.3).
- `error` — `{ code, message }`, may close the connection.
- `envelope` — `{ id, from, to, type, body, callback_id?, response_to?, ts }`
  when this session is the recipient (or `to: "all"`).
- `permission-request` — bridge forwarded, expects `permission-response` back.
- `pong` — response to `ping`.

No heartbeats. Liveness via WebSocket native ping/pong (`ws.ping()` every
20s; Bun auto-pongs); any frame exchange resets the `idleTimeout`. If
`idleTimeout: 30` elapses, server closes, `close` handler marks session
offline and bumps `revision`.

### 3.3 `/ws/observer` — dashboard/CLI ↔ switchboard

Client → server:

- `subscribe` — optional scope narrowing (currently unused; observer gets all
  events by default after the next phase reduces fan-out volume).
- `session-viewed` — `{ session }` — triggers cross-tab notification dismiss.
- `ping` / `pong` — same as above.

Server → client:

- `session-delta` — **unified session state update** with monotonic `revision`
  per session:
  ```json
  {
    "type": "session-delta",
    "session": "<name>",
    "revision": <int>,
    "changes": {
      "state"?: "idle|working|errored|offline",
      "current_tool"?: "<string>|null",
      "last_text"?: "<string>",
      "cc_session_uuid"?: "<string>",
      "context_tokens"?: <int>,
      "online"?: <bool>,
      ...
    }
  }
  ```
  Clients keep a revision-per-session map and drop any delta with a lower
  revision than the one they've already applied. This eliminates the flicker
  root cause from the server audit.
- `envelope` — same shape as on `/ws/session` but observer sees all, not just
  its own mail.
- `permission-request` — forwarded for observer UI.
- `notification-dismiss` — cross-tab dismiss coordination.
- `quota` — subscription/quota status updates.
- `archive-created` — `{ name, old_uuid, archived_at, reason }`.

### 3.4 Staleness handling

- Plugin sends `ping` every 20s (well below 30s idle timeout).
- Server `idleTimeout: 30` on both endpoints.
- On WS `close` (either side): server marks session `online=false`, inserts a
  `ccpl_session_events` row (`kind: "offline"`), broadcasts `session-delta`.
- On successful reconnect (`hello` accepted again): `online=true`,
  `kind: "online"` event, broadcast.
- Precise transitions replace the current "hasn't heartbeat'd in 30s" heuristic.

## 4. Persistence

### 4.1 New tables

```sql
CREATE TABLE ccpl_sessions (
  name TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  cwd TEXT NOT NULL,
  cc_session_uuid TEXT,
  pid INTEGER,
  machine_id TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX idx_ccpl_sessions_token ON ccpl_sessions(token);
CREATE INDEX idx_ccpl_sessions_last_active ON ccpl_sessions(last_active_at);

CREATE TABLE ccpl_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  old_uuid TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX idx_ccpl_archives_name ON ccpl_archives(name);
CREATE INDEX idx_ccpl_archives_uuid ON ccpl_archives(old_uuid);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  from_name TEXT NOT NULL,
  to_name TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT,
  callback_id TEXT,
  response_to TEXT,
  cc_session_uuid TEXT
);
CREATE INDEX idx_messages_ts ON messages(ts);
CREATE INDEX idx_messages_from ON messages(from_name, ts);
CREATE INDEX idx_messages_to ON messages(to_name, ts);
CREATE INDEX idx_messages_uuid ON messages(cc_session_uuid, ts);

CREATE TABLE dashboard_sessions (
  cookie TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_dashboard_sessions_expires ON dashboard_sessions(expires_at);
```

### 4.2 Schema version bump

- Bump `SCHEMA_VERSION` to 4.
- Migration v3→v4: `CREATE TABLE IF NOT EXISTS` for all four above.
- Remove `PRAGMA user_version = 3` from `schema.sql` (Phase A carryover).
- Wrap each migration in `db.transaction(() => {...})()`.

### 4.3 Retention

- `messages` prunes at 30 days (existing retention pattern).
- `ccpl_archives` never auto-pruned (manual `ccpl cleanup --archives`).
- `dashboard_sessions` prunes rows where `expires_at < now`.

## 5. Failure Modes

| Failure                                   | Behavior                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Switchboard not running at plugin startup | Plugin retries WS with exponential backoff (100ms → 30s cap). Tool calls return `{error: "switchboard_unreachable"}`. CC runs fine.         |
| Switchboard goes down mid-session         | WS close → plugin enters reconnect loop. Sends queued during disconnect are rejected (no plugin-side queue in this phase).                  |
| Token invalid/revoked                     | Server closes WS with `invalid_token` code 4401. Plugin logs error + exits reconnect loop. Requires `ccpl rotate` or re-register.           |
| Two processes with same token             | Second `hello` closes first WS with `already_connected`, accepts new. Protects against stale sessions surviving after CC crash without FIN. |
| Dashboard password wrong                  | HTTP 401, login page re-rendered. No rate-limiting in this phase (single-user, trusted network).                                            |
| Wifi drop / laptop sleep                  | `idleTimeout: 30` closes WS → plugin reconnects when network returns. Dashboard flickers offline briefly.                                   |
| `ccpl new <name>` when name exists        | HTTP 409. Requires `ccpl forget <name>` + retry, or `ccpl new <name> --force`.                                                              |
| Token file present but DB row gone        | GET `/ccpl/session/<name>` returns 404. Wrapper prints "session gone from switchboard — register again."                                    |
| Token file missing but DB row present     | `ccpl <name>` fails with instruction to run `ccpl rotate <name>` (localhost-UID-auth carve-out).                                            |

## 6. Migration — what gets deleted vs kept

### Delete entirely

- `src/transport/udp-multicast.ts`
- `src/protocol.ts` `Deduplicator` class, `generateId` (moved to server-only),
  `sequenceCounter`, `seq` field from envelope type.
- `src/presence.ts` heartbeat loop and `HeartbeatOptions`. Session enumeration
  logic moves to switchboard-side `/ccpl/sessions` query; presence module
  becomes a thin client for that query.
- Multicast-specific logic in `dashboard/monitor.ts` (the monitor becomes an
  `/ws/observer` client).
- All UDP-specific tests (`tests/transport/udp-*.test.ts` if any exist).
- Hook-install scripts that reference multicast config (none should — hooks
  use HTTP `/ingest`).

### Keep (with minor surgery)

- Envelope shape (`id`, `from`, `to`, `type`, `body`, `callback_id`,
  `response_to`, `ts`) — but `seq` removed, `id` server-assigned.
- `src/aggregator.ts` — still folds hook events into session state. Output
  now routes to `session-delta` instead of `session-update`.
- `src/observers/jsonl.ts` — unchanged. Still polls JSONLs.
- `src/ingest/*` — unchanged. Hooks stay HTTP + shared secret.
- `src/storage/*` — keeps everything; adds new tables + fixes migration bug.
- `src/server.ts` (MCP server) — tool handlers stay, but internal
  send-via-UDP replaced with send-via-WS.
- Dashboard HTML + CSS + quota.ts — unchanged.
- `notifications.js` structure — refactored for SW (§7) but same API shape.
- CLI tool — rewritten to use `/ws/observer` instead of UDP.

### Add

- `src/transport/ws-client.ts` — WS client for MCP plugin and CLI.
- `src/server/switchboard.ts` — the orchestration layer that routes
  `/ws/session` ↔ `/ws/observer` + persists messages.
- `bin/ccpl` — new Bun-based CLI (current `ccpl` is a shell wrapper; replace).
- `dashboard/auth.ts` — login page, cookie sign/verify.
- `dashboard/sw.js` — Service Worker (§7).
- `dashboard/manifest.json` + `dashboard/icons/` — PWA assets (§8).

## 7. Notifications — Service Worker rebuild

### 7.1 Service Worker

New file `dashboard/sw.js`, served at `/sw.js` with header
`Service-Worker-Allowed: /`:

```js
const CACHE_NAME = 'party-line-v1'
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

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // Only serve shell from cache; everything else (API, WS upgrades) hits network.
  if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)))
  }
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const sessionName = e.notification.data && e.notification.data.sessionName
  const url = sessionName ? '/#/session/' + encodeURIComponent(sessionName) : '/'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.endsWith(url) && 'focus' in client) return client.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow(url)
    }),
  )
})
```

### 7.2 notifications.js refactor

- Replace `new deps.NotificationCtor(title, options)` with
  `(await deps.swRegistration).showNotification(title, options)`.
- Replace `activeNotifications: Map<string, Notification>` with tag-based
  lookups: `registration.getNotifications({ tag })` returns the live list.
- `fire(sessionName, title, body)` becomes
  `registration.showNotification(title, { body, tag: sessionName, data: { sessionName } })`.
- Dismiss: `registration.getNotifications({ tag: sessionName }).then(ns => ns.forEach(n => n.close()))`.
- Deps change: `NotificationCtor` → `swRegistration: Promise<ServiceWorkerRegistration>`,
  allowing tests to inject a mock registration with stub `showNotification` /
  `getNotifications`.

### 7.3 Permission flow

- **Remove** the auto-show banner. Replace its role with two surfaces:
  - A **small "enable notifications" chip** next to the bell toggle, shown
    only when the bell is being turned on while `Notification.permission ===
'default'`.
  - A **persistent inline notice** in the settings area of each card when
    `Notification.permission === 'denied'`: "Enable in browser settings"
    with a link to the browser-specific help (`chrome://settings/content/notifications`,
    etc.) — the browser will not show its prompt after denial.
- Permission request is triggered **synchronously inside the bell click handler**
  — no `await` before calling `Notification.requestPermission()`:
  ```js
  bell.addEventListener('click', () => {
    if (Notification.permission === 'default') {
      const p = Notification.requestPermission() // SYNC call, no await
      p.then((r) => {
        if (r === 'granted') setEnabled(session, true)
        updateBellUI()
      })
    } else if (Notification.permission === 'granted') {
      setEnabled(session, !isEnabled(session))
      updateBellUI()
    }
  })
  ```
- **Live permission state refresh**: add listeners at page bootstrap:
  ```js
  document.addEventListener('visibilitychange', updateNotifState)
  window.addEventListener('focus', updateNotifState)
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'notifications' }).then((status) => {
      status.onchange = updateNotifState
    })
  }
  ```
  Kills the "stuck at blocked forever" symptom when the user flips permission
  in browser settings.

### 7.4 Error handling in WS handlers

Wrap every `notif.onXxx(frame)` call in `dashboard.js`'s WS `onmessage` handler
in a `try/catch` — one throw in the notification path must not stop later
frames from being processed for other purposes (message feed, session cards,
stream updates). Log to console.

### 7.5 Tests

Update `tests/notifications.test.ts` to:

- Inject a mock `swRegistration` with stub methods instead of `FakeNotification`.
- Assert `showNotification(title, { tag, data })` is called with the right args.
- Cover `getNotifications({ tag })` dismiss path.
- Add a test for the permission-state refresh listeners (simulate
  `visibilitychange` → `updateNotifState` called → bell UI updates).
- Test the sync-permission-call path: assert `requestPermission` is called
  without an intervening await.

## 8. PWA Groundwork

### 8.1 manifest.json

File at `dashboard/manifest.json`, served at `/manifest.json` with
`Content-Type: application/manifest+json`:

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

### 8.2 Icons

Three PNG files under `dashboard/icons/`:

- `icon-192.png` — 192×192, used for Android home screen.
- `icon-512.png` — 512×512, used for splash screen + install prompt.
- `icon-maskable-512.png` — 512×512 with safe zone for Android adaptive icons.

Initial version: generated from a simple text SVG ("PL" on dark background)
via a build-time script. Not a graphic-design task — placeholders are fine;
user can swap them later.

### 8.3 index.html additions

```html
<link rel="manifest" href="/manifest.json" />
<meta name="theme-color" content="#0d1117" />
<link rel="apple-touch-icon" href="/icons/icon-192.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Party Line" />
```

### 8.4 Install prompts

- **Android/Chrome**: listen for `beforeinstallprompt`, stash the event, show
  a small "Install" button in the dashboard header. Click calls
  `event.prompt()`, logs outcome.
- **iOS Safari**: check `'standalone' in navigator` + iOS UA. If iOS and not
  standalone, show a one-time dismissible hint: "Tap Share → Add to Home
  Screen to install." Store dismissal in localStorage (key
  `pl-install-hint-dismissed`).

### 8.5 Runtime caching behavior

- SW precaches only the **shell**: HTML, JS, CSS, manifest, icons.
- API calls (`/api/*`), WebSocket upgrades (`/ws/*`), and login endpoints
  (`/login`, `/logout`) are **never** cached — always hit network.
- When offline, the shell renders, the WS shows "reconnecting", and
  navigation between already-visited session routes uses the in-memory router.
  No stale data is shown.

## 9. Observer + CLI changes

### 9.1 Dashboard web client

- `WebSocket(wss://.../ws/observer)` replaces `wss://.../ws`.
- `cookies: pl_dash=...` sent automatically by browser on WS handshake.
- Frame handler adopts `session-delta` as the sole per-session update
  channel. `updateSessions` / `handleSessionUpdate` collapse into a single
  `applyDelta(delta)` that checks revision + patches the store + schedules
  a render.
- Removes: direct consumption of `sessions`, `jsonl`, `hook-event` frames at
  the client. Those are server-internal now.

### 9.2 CLI

`dashboard/cli.ts`:

- `ccpl watch` → opens `/ws/observer` (requires password via
  `PARTY_LINE_DASHBOARD_PASSWORD` env or `--password` flag).
- `ccpl sessions` → GET `/ccpl/sessions` with dashboard cookie.
- `ccpl send <to> <msg>` → POST `/api/send` with dashboard cookie.
- Deprecates UDP multicast binding entirely.

Note the naming: the existing `dashboard/cli.ts` becomes the watch/send CLI.
The new `bin/ccpl` is the session-lifecycle CLI. Two separate tools.

## 10. Design Rationale Recap

- **Why hub, not mesh?** Auth, multi-machine, reliable delivery, easier
  monitoring, removes entire categories of bugs (dedup, seq, send-twice).
  Single process already exists; giving it ownership of message routing
  costs nothing new.
- **Why per-session tokens?** Revocation, per-session ACLs later, stable
  across `/clear`, no chicken-and-egg bootstrap. Dropped file-on-disk is
  a credential — same security model as SSH private keys.
- **Why Service Worker, not foreground-only?** Mobile Chrome throws on
  `new Notification()`; there is no foreground-only path that works on mobile.
  SW is one small file and unlocks PWA install too.
- **Why unified `session-delta` stream?** Eliminates the four-channel race
  that produces flickery realtime. Monotonic revision per session gives
  clients an unambiguous last-writer-wins rule.
- **Why no backwards compat?** System is pre-1.0, single user, pre-shipped.
  Carrying old code is net negative.

## 11. Success Criteria

The v2 rebuild is complete when:

- [ ] A fresh VM with only `bun` installed can install the plugin, run the
      switchboard, register a ccpl session, launch it, and send/receive
      messages through the dashboard — all over HTTPS with password auth,
      no multicast.
- [ ] Opening the dashboard on Chrome Android and toggling a session's bell
      results in a real OS-level notification when that session receives a
      message.
- [ ] `ccpl list` shows live/offline state accurately within 30s of a session
      crashing or a wifi drop.
- [ ] Direct navigation to `https://.../session/<name>` renders the session
      detail view (no "not known" placeholder) on first load.
- [ ] `Notification.permission` flipping in browser settings while the
      dashboard is open is reflected in the UI within 1s.
- [ ] Installing the dashboard as a PWA on an Android phone works via
      Chrome's install prompt.
- [ ] All audit CRITICAL items (12) are closed.
- [ ] All audit IMPORTANT items that the plan touches are closed; remaining
      ones are explicitly deferred with rationale.
- [ ] Tests pass including a new MCP-handshake integration test, a
      switchboard WS round-trip test, and a Playwright smoke test that
      covers notifications with granted permission.
