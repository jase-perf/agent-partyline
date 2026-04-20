# Browser Notifications — Design

## Goal

Add per-session browser notifications to the Party Line dashboard so a user can be alerted to events in Claude Code sessions they aren't actively watching. Include Discord-parity permission request handling via the MCP channel permission protocol.

## Scope

**In scope (this spec, "Phase 1 — Foreground notifications"):**
- Three notification triggers:
  - **A.** Claude turn finished (session state transition `working → idle`).
  - **B.** Party-line message addressed to, or broadcast to, a session.
  - **C.** `permission_request` from the MCP channel protocol.
- Per-session on/off toggle, stored in browser `localStorage`.
- Fires only when the dashboard tab is hidden OR the user is not currently viewing that session's detail route.
- Cross-device dismiss: when any connected client navigates into a session, all other clients close matching notifications.
- Permission approve/deny UI lives in the dashboard session detail view. The browser notification is awareness-only — click navigates the user to the session so they can review full context before approving.
- Server-side cross-client coordination via new WebSocket frames and new UDP envelope types.

**Out of scope (deferred to Phase 2):**
- Progressive Web App shell, `manifest.json`, installability.
- Service Worker registration.
- Web Push with VAPID keys (closed-PWA / killed-tab notifications).
- HTTPS strategy for LAN mobile use.

**Out of scope (deferred to a separate "remote control" spec):**
- Slash-command injection from dashboard (e.g. trigger `/compact`).
- Action buttons embedded directly in notifications (inline Allow/Deny).
- Any feature that relies on `tmux send-keys` or other terminal keystroke injection.

## Architecture

### Process boundaries

| Component | Runs inside | Responsibility |
| --- | --- | --- |
| `src/server.ts` (party-line MCP) | Each Claude Code session | Declares `claude/channel/permission` capability; translates MCP permission notifications ↔ UDP envelopes. |
| `dashboard/serve.ts` | Dashboard process | Terminates WebSocket clients; routes new `session-viewed`, `permission-response` messages; broadcasts `notification-dismiss`, `permission-resolved`. |
| `dashboard/notifications.js` (new) | Browser | Owns all browser notification logic: subscriptions, decisions, tag management, click routing. |
| `dashboard/dashboard.js` | Browser | Adds permission request card rendering; bell UI wired to localStorage. |

### Transport layers

| Channel | Direction | Purpose |
| --- | --- | --- |
| MCP notifications | Claude Code ⇄ `src/server.ts` | Native permission_request / permission response protocol. |
| UDP multicast envelope `permission-request` | Session's `src/server.ts` → dashboard | Session reports an incoming MCP permission_request. |
| UDP multicast envelope `permission-response` | Dashboard → session's `src/server.ts` | Dashboard user's allow/deny answer. |
| WebSocket frame `permission-request` | Dashboard → browsers | Mirror of incoming UDP envelope for UI rendering. |
| WebSocket frame `session-viewed` | Browser → dashboard | A browser tab navigated into a session detail view. |
| WebSocket frame `notification-dismiss` | Dashboard → browsers | Fan-out of `session-viewed`: other tabs close matching notifications. |
| WebSocket frame `permission-resolved` | Dashboard → browsers | Permission request was answered; other tabs clear their card and close their notification. |

### Client module layout (`dashboard/notifications.js`)

Single file. Initialized from `dashboard.js` on page load after the WebSocket connects. Exports a small surface:

```js
export function initNotifications(ctx) { ... }
// ctx: { ws, getCurrentRoute, navigate, getLastAssistantText }

export function isEnabled(sessionName) { ... }
export function setEnabled(sessionName, enabled) { ... }
export function getPermissionState() { ... } // 'default' | 'granted' | 'denied' | 'unsupported'
export async function requestPermission() { ... }
```

Internal state:
- `settings: Map<string, boolean>` — mirror of localStorage. A missing entry means **off**; users must explicitly opt in per session.
- `activeNotifications: Map<string, Notification>` — keyed by session name (tag), most recent wins.
- `lastAssistantText: Map<string, string>` — fed from `jsonl` WS frames.
- `lastKnownState: Map<string, string>` — previous state per session, used to detect working→idle transitions.
- `resolvedPermissions: Set<string>` — `request_id`s the client has seen `permission-resolved` for. Consulted before firing Trigger C so that a late-arriving `permission-request` (e.g. after reconnect, where another tab already answered) does not produce a stale notification.

### Protocol changes

Two new envelope types added to `src/protocol.ts` type union:
- `permission-request` — body `{ request_id: string, tool_name: string, description: string, input_preview: string }`.
- `permission-response` — body `{ request_id: string, behavior: 'allow' | 'deny' }`.

Both are addressed to specific sessions (no broadcast form). `permission-request` is always `to = 'dashboard'`; `permission-response` is always `to = <session_name>`. Standard envelope fields (`from`, `to`, `id`, `ts`) apply normally.

### Storage

- Browser: `localStorage.partyLineNotifications` — JSON `{ [sessionName]: boolean }`. Written on every toggle.
- Server: in-memory `pendingPermissions: Map<request_id, { session_name, tool_name, description, input_preview, created_at }>` inside `src/server.ts`. Ephemeral. Cleared on `permission-response` arrival or when the permission request times out (handled by Claude Code itself — we don't track timeouts).
- No SQLite changes. No new persistent files.

## Trigger semantics

### Trigger A — Turn finished

**Source:** existing `session-update` WS frames carrying derived `state` from `src/aggregator.ts`.

**Detection:** compare `session-update.data.state` against `lastKnownState[session_id]`.

**Fire when:**
- `lastKnownState[id] === 'working'` AND `newState === 'idle'`.

**Do not fire when:**
- `newState === 'ended'` (SessionEnd should not be a turn-finished signal).
- Fresh connection has no prior state (`lastKnownState[id]` undefined) — silently record the state, no fire.

**Notification body:** cached `lastAssistantText[session_name]` first 120 chars if present. Fallback `"Claude is waiting"`.

### Trigger B — Party-line message

**Source:** existing `message` WS frames carrying the envelope.

**Fire when:**
- `envelope.type === 'message'`
- `envelope.to === sessionName` OR `envelope.to === 'all'`
- `envelope.from !== sessionName`

**Do not fire when:**
- `envelope.type` is `heartbeat`, `announce`, `receipt`, `response`, `request`, or anything else.

**Notification body:** `"<from>: <first 120 chars of envelope.body>"`.

### Trigger C — Permission request

**Source:** new `permission-request` WS frame, which is the dashboard's rebroadcast of the UDP `permission-request` envelope.

**Fire when:**
- `permission-request` arrives AND session has `settings[name] === true`.

**Do not fire when:**
- Permission was already resolved elsewhere (`request_id` is in `resolvedPermissions`). Protects against a late-arriving `permission-request` after a reconnect where another tab already answered.

**Notification title:** `"Permission needed: <tool_name>"`.
**Notification body:** first 120 chars of `description`.
**No action buttons** on the notification. Click routes to the session detail view where the user approves/denies with full context.

## Fire conditions (applies to A, B, C)

All of:
1. `settings[sessionName] === true`.
2. `Notification.permission === 'granted'`.
3. `document.hidden === true` OR current route `!== '/session/' + sessionName`.

## Tag behavior

All notifications use `tag: sessionName`. The browser collapses stacked pings per session — a newer notification replaces an older one in the OS tray. The client also keeps `activeNotifications.get(sessionName)` so it can call `.close()` programmatically.

## Auto-dismiss

**Triggered by any of:**
- Notification clicked by the user (default browser behavior + our click handler also closes explicitly).
- Browser tab navigates into `/session/<name>` (dispatch `session-viewed` → server fan-out → all clients close).
- Browser tab becomes visible AND the current route is `/session/<name>` (dispatch `session-viewed`).
- For permission requests specifically: a `permission-resolved` frame arrives (close the tagged notification and mark the request resolved).

**Server fan-out logic:**
- `session-viewed` from client → server broadcasts `notification-dismiss` with `{ sessionName }` to all clients including the sender.
- Each client calls `activeNotifications.get(sessionName)?.close()`.

## Click behavior

Notification `onclick`:
1. `window.focus()`.
2. `navigate('/#/session/' + sessionName)` (uses existing router).
3. Close this notification.

On devices where `window.focus()` silently fails, the click still navigates so the user lands on the correct view once they switch to the tab manually.

## Permission flow

### Initial enablement

1. First load: if `Notification.permission === 'default'`, show a small banner under the header: `"🔔 Enable browser notifications for Party Line"` with an `[Enable]` button.
2. Click → `Notification.requestPermission()`.
3. Result `granted` → hide banner, enable bell icons.
4. Result `denied` → banner rewrites to `"Notifications blocked. Re-enable in browser settings."`, persists until user dismisses.
5. Result `default` again (user dismissed OS prompt) → leave banner visible.

Bell icons on session cards are permanently dim + disabled with tooltip `"Enable notifications first"` whenever permission is not `granted`.

### Permission request (Discord-parity)

**`src/server.ts` changes:**
- Add `'claude/channel/permission': {}` to `capabilities.experimental`.
- Register handler for `notifications/claude/channel/permission_request` with zod schema `{ request_id, tool_name, description, input_preview }`.
- On receipt:
  - Store `{ request_id → params }` in local `pendingPermissions` map.
  - Emit UDP envelope of new type `permission-request` with `to = 'dashboard'` and body `{ request_id, tool_name, description, input_preview }`.
- Register UDP inbound handler for `permission-response` envelopes:
  - If `body.request_id` matches an entry in `pendingPermissions`:
    - Call `mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id, behavior } })`.
    - Delete from `pendingPermissions`.
  - If no match: silently drop (envelope addressed to a request we don't own, or already resolved).

**`dashboard/serve.ts` changes:**
- Monitor callback recognizes `permission-request` envelopes and broadcasts them to WS clients as `{ type: 'permission-request', data: { session, request_id, tool_name, description, input_preview } }`.
- New HTTP endpoint `POST /api/permission-response` body `{ session, request_id, behavior }`:
  - Validates `behavior` is `'allow'` or `'deny'`.
  - Emits UDP envelope `permission-response` addressed to the named session.
  - Broadcasts `{ type: 'permission-resolved', data: { session, request_id, behavior, resolved_by: 'dashboard' } }` to WS clients so other tabs clear their card.
  - Returns `{ ok: true }` on success.
- New WS frame handler `session-viewed`:
  - Payload: `{ session: string }`.
  - Server immediately broadcasts `{ type: 'notification-dismiss', data: { session } }` to all connected WS clients.

**`dashboard/dashboard.js` changes:**
- New entry type rendered in the session detail stream: `permission-request-card`.
  - Layout:
    ```
    🔐 Permission requested: <tool_name>
    <description>
    ▶ Show input preview  (collapsed)
       <pretty-formatted JSON>
    [✅ Allow]  [❌ Deny]
    ```
  - Both buttons disabled on click (optimistic), POST to `/api/permission-response`.
  - On `permission-resolved` WS frame (for this `request_id`): replace buttons with `"✅ Allowed"` or `"❌ Denied"` status line.
  - On server `POST` error: re-enable buttons, show inline error.
- Bell icon component, used in both Switchboard card and Session Detail header:
  - Reads `isEnabled(sessionName)` from notifications module.
  - Click calls `setEnabled(sessionName, !current)`.
  - Disabled + dim when `getPermissionState() !== 'granted'`.

**`dashboard/notifications.js` (new) responsibilities:**
- Initialize from `initNotifications(ctx)` once WS is connected.
- Subscribe to WS frames: `session-update`, `message`, `jsonl`, `permission-request`, `permission-resolved`, `notification-dismiss`.
- Maintain decision logic per the rules above.
- Expose toggle API consumed by `dashboard.js` bell UI.

## Error handling

| Failure | Behavior |
| --- | --- |
| `Notification` API not available | Module becomes no-op. Bell icons are disabled with tooltip `"Browser does not support notifications"`. |
| `Notification.requestPermission()` resolves `denied` | Banner updates to explain; no repeat prompts. |
| `POST /api/permission-response` network failure | Toast "Failed to send response"; buttons re-enable. |
| Stale `request_id` (no match on session side) | UDP envelope dropped silently by session server. Dashboard UI eventually shows card as expired if Claude Code times out the request. |
| WS disconnect mid-session | On reconnect, state maps are wiped. Fresh `session-update` frames rebuild `lastKnownState` silently. `pendingPermissions` card may reappear if the session re-emits (acceptable). |
| Multiple rapid toggles | Direct localStorage write each time. No debounce needed for a single-user tool. |
| Localhost trust | UDP multicast is localhost-scoped. Any local Claude Code session can emit a `permission-response` envelope. Matches existing trust model. |

## Testing

### Client-side (`tests/notifications.test.ts`)

Pure unit tests with mocked `Notification`, `document.hidden`, `location.hash`, and `localStorage`:

- Toggle off → no fire for any trigger.
- Toggle on + tab hidden → fires A, B, C.
- Toggle on + tab visible + different route → fires.
- Toggle on + tab visible + same route (`/session/<name>`) → does not fire.
- `working → idle` fires A; `idle → idle` or `working → working` does not.
- Heartbeat and announce envelopes filtered for B.
- Envelope from session itself filtered.
- Permission denied → module becomes no-op.
- `notification-dismiss` closes matching tagged notification.
- `permission-resolved` closes matching tagged notification and marks request resolved.
- Click handler navigates to the right route and focuses window.

### Server-side (`tests/server-notifications.test.ts` and `tests/serve-permission.test.ts`)

- `src/server.ts`: `notifications/claude/channel/permission_request` arrives → `permission-request` UDP envelope emitted with correct shape.
- `src/server.ts`: `permission-response` UDP envelope arrives with matching `request_id` → `mcp.notification` called with correct method and params.
- `src/server.ts`: `permission-response` with unknown `request_id` → silently ignored, no error, no duplicate send.
- `dashboard/serve.ts`: `session-viewed` WS frame → `notification-dismiss` broadcast to all connected clients.
- `dashboard/serve.ts`: `POST /api/permission-response` → UDP `permission-response` envelope emitted AND `permission-resolved` broadcast over WS.
- `dashboard/serve.ts`: `POST /api/permission-response` with invalid behavior → 400.

### Integration

Two fake WS clients connected to a single dashboard, plus a simulated party-line MCP session:

- Simulated session emits MCP `permission_request` → both WS clients receive `permission-request` frame with identical payload.
- Client 1 POSTs `permission-response` with `allow`. Session receives `permission-response` envelope and calls `mcp.notification`. Client 2 receives `permission-resolved` frame and clears its card.
- Client 1 navigates into `/session/<name>` → `session-viewed` frame sent → server broadcasts `notification-dismiss` → both clients close matching tagged notifications.

## Non-functional notes

- **No persistence across server restart.** `pendingPermissions` is in-memory. If the session process dies with an outstanding permission prompt, the request is lost. Claude Code would time out and re-ask the user in-terminal — acceptable degradation.
- **No analytics, no telemetry.** Single-user local tool.
- **i18n / localization.** English only. Out of scope.
- **Accessibility.** Bell icon gets `aria-label="Notifications for <session>: on/off"`. Permission card is semantic HTML with proper heading + button elements. No bespoke keyboard shortcuts in this spec.

## Migration / rollout

- No feature flag. Ships with the merge.
- First-run UX: permission banner appears. User does nothing if they don't want notifications; bells stay dim.
- Existing saved Switchboard layouts / URL routes unaffected.
- No breaking changes to WS frame vocabulary — all new frames are additive. Older dashboard builds simply don't subscribe to the new frames.

## Follow-up (not in this spec)

1. **Phase 2:** PWA shell + manifest + Service Worker + Web Push (VAPID + subscriptions + HTTPS story).
2. **Remote Control spec:** dashboard-triggered slash commands via tmux send-keys; per-session pane discovery; optional inline notification action buttons revisited once there's an injection mechanism.
3. **Granular triggers:** if a user finds one trigger type spammy on a particular session, add per-trigger toggles (e.g. mute A but keep B+C). Deferred until someone asks.
4. **Sound customization:** currently defers to OS/browser defaults. Add per-trigger sound selection only if requested.
