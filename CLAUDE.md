# Claude Party Line

Inter-session messaging for Claude Code via a central WebSocket switchboard.

## Project Context

Claude Code channel plugin (MCP server with `claude/channel` capability) that lets multiple Claude Code sessions on the same machine send messages to each other. Version 2 (post-2026-04) uses a **hub-and-spoke** architecture: every session opens an authenticated WebSocket to the dashboard, which routes, persists, and broadcasts. Earlier versions used UDP multicast; that path is gone.

See `SPEC.md`, `docs/superpowers/specs/2026-04-20-hub-and-spoke-design.md`, and `MIGRATION.md` for design and migration notes.

## Current Status

Project is **functional and tested**. Hub-and-spoke transport (Phase C) shipped 2026-04-21. 173 tests pass.

- Dashboard + switchboard — `bun dashboard/serve.ts` serves HTTPS/WSS, routes envelopes, persists to SQLite, runs password + signed-cookie auth
- `ccpl` Bun CLI — registers named sessions, stores tokens at `~/.config/party-line/sessions/<name>.token` (0600), launches Claude Code with `PARTY_LINE_TOKEN` in env
- MCP plugin — dials `wss://.../ws/session`, authenticates via token, holds connection for life of process. Wake-on-message works when loaded with `--dangerously-load-development-channels server:party-line`
- Dashboard UI — observer WS on `/ws/observer` with `sessions-snapshot` + `session-delta` + `envelope` frames. Single monotonic revision per session prevents flicker
- PWA — installable to home screen; Service Worker delivers notifications on mobile Chrome/iOS Safari
- Hook-based event ingest (`POST /ingest`) with shared-secret auth — unchanged
- SQLite persistence at `~/.config/party-line/dashboard.db` — v4 schema with `ccpl_sessions`, `ccpl_archives`, `messages`, `dashboard_sessions` alongside the original Mission Control tables
- JSONL transcript + Gemini observers — unchanged, poll `~/.claude/projects/**/*.jsonl`
- Mission Control dashboard UI — 4 tabs (Overview, Session Detail, Machines, History)

## Tech Stack

- TypeScript on Bun runtime
- `@modelcontextprotocol/sdk` for MCP server + channel API
- Native `WebSocket` (Bun) for transport; no external WS library
- `bun:sqlite` for persistence, `bun:test` for tests
- Dashboard: `Bun.serve` for HTTP + WebSocket

## Key Reference

- **Discord plugin** (reference channel implementation): `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts`
- **Channel API research notes**: `~/Claude_Main/memory/project_custom_channels.md`
- **Channels docs**: https://code.claude.com/docs/en/channels-reference
- **Plugins docs**: https://code.claude.com/docs/en/plugins-reference

## Architecture

```
src/
  types.ts               — Shared types (Envelope, MessageType, SessionMetadata)
  protocol.ts            — Envelope helpers (generateId, generateCallbackId, createEnvelope)
  events.ts              — HookEvent type definitions and validation
  machine-id.ts          — Stable machine ID read/write (~/.config/party-line/machine-id)
  aggregator.ts          — Folds hook events into session/subagent/tool-call state
  introspect.ts          — Reads Claude Code JSONL tail for live session status
  transcript.ts          — Builds session transcript from JSONL + envelopes
  presence.ts            — Thin HTTP client for /ccpl/sessions (reads switchboard state)
  permission-bridge.ts   — MCP ↔ switchboard permission request/response bridge
  server.ts              — MCP channel plugin entry point; dials /ws/session
  transport/
    ws-client.ts         — Outbound WS client (reconnect, ping, hello-on-open)
  server/
    auth.ts              — Dashboard password + HMAC-signed cookie module
    ccpl-api.ts          — HTTP handlers for /ccpl/* (register/session/rotate/etc.)
    switchboard.ts       — Routing layer: sessions + observers maps, envelope routing
  ingest/
    http.ts              — POST /ingest handler, envelope validation
    auth.ts              — Shared-secret token management for hooks
  observers/
    jsonl.ts             — Polling tailer for ~/.claude/projects/**/*.jsonl + subagent transcripts
    gemini-transcript.ts — Gemini CLI transcript observer
  storage/
    db.ts                — SQLite open, migration runner (SCHEMA_VERSION=4)
    schema.sql           — All tables
    queries.ts           — Prepared statements and typed query helpers (Mission Control)
    ccpl-queries.ts      — Typed helpers for ccpl_sessions/archives/messages
    metrics.ts           — Daily metrics rollup (sparkline data)
    retention.ts         — 30-day event pruning on startup

dashboard/
  serve.ts               — Web dashboard: HTTP + WebSocket, mounts auth + ccpl-api + /ws/session + /ws/observer
  cli.ts                 — CLI (watch, sessions, send) using ws-client + HTTP
  login.html / login.js  — Login page
  index.html             — Dashboard web UI (shell; loads view fragments)
  dashboard.js           — Router, view manager, observer WS client
  dashboard.css          — Dashboard styles
  notifications.js       — Service Worker-based browser notifications
  sw.js                  — Service Worker (install, fetch, notificationclick)
  manifest.json          — PWA manifest
  icons/                 — PWA icons (192, 512, maskable-512)
  quota.ts               — Polls claude quota API
  serve-helpers.ts       — Permission envelope helpers
  views/
    overview.html        — Session cards with live state + sparklines
    session-detail.html  — Event timeline + subagent tree for one session
    machines.html        — Per-host cards
    history.html         — Filterable event feed

hooks/
  emit.sh                — Local hook emitter (POSTs to /ingest)
  install.sh             — Merges hook entries into ~/.claude/settings.json
  uninstall.sh           — Removes party-line hook entries
  remote/
    emit.sh              — POSIX emitter for remote hosts
    emit.ps1             — PowerShell emitter for Windows
    README.md            — Remote host setup guide

bin/
  ccpl                   — Shim that runs ccpl.ts via bun
  ccpl.ts                — Bun CLI (new / list / forget / rotate / launch)
```

## Running

```bash
# Dashboard + switchboard (set password!)
PARTY_LINE_DASHBOARD_PASSWORD=<pw> \
PARTY_LINE_DASHBOARD_SECRET=$(openssl rand -hex 32) \
bun dashboard/serve.ts [--port 3400] \
  [--cert cert.pem --key key.pem]   # optional: speak HTTPS/WSS. Also via PARTY_LINE_TLS_CERT/KEY env.

# Register + launch a session (preferred)
ccpl new myname --cwd /path/to/project
ccpl myname                              # launches claude with PARTY_LINE_TOKEN in env

# Session management
ccpl list                                # needs PARTY_LINE_DASHBOARD_PASSWORD
ccpl rotate myname
ccpl forget myname

# CLI (requires PARTY_LINE_DASHBOARD_PASSWORD)
bun dashboard/cli.ts watch               # tail observer stream
bun dashboard/cli.ts watch --json        # JSON output for piping
bun dashboard/cli.ts sessions            # list registered sessions
bun dashboard/cli.ts send <to> <msg>     # send a message via /api/send

# Install/uninstall hooks (captures events from every Claude Code session)
bun run hooks:install
bun run hooks:uninstall
```

## Conventions

- Strict TypeScript — no `any` in signatures, explicit return types
- Zero external runtime dependencies — only MCP SDK and Bun built-ins (`bun:sqlite`, `node:crypto`, `node:fs`, `node:child_process`, native WebSocket)
- Transport logic in `src/transport/` — the plugin uses `ws-client.ts`; there is no other transport
- Routing logic in `src/server/switchboard.ts` — the dashboard is the only process that imports it
- Dashboard code in `dashboard/` imports from `src/` but `src/` never imports from `dashboard/`
- Session names must match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$` (server regex, also enforced client-side in `ccpl`)
- SQLite schema changes always come with a migration entry in `src/storage/db.ts` and a bumped `SCHEMA_VERSION`. Fresh DBs run `schema.sql` then stamp `user_version = SCHEMA_VERSION` in a single transaction
- `fs.watch({ recursive: true })` is broken on Bun/Linux — observers use polling instead (confirmed via spike)
- Hook emitters are fire-and-forget with a 1-2s curl timeout so they never block a Claude Code session

## Wire Protocol

**Envelope** (internal + on-wire from switchboard to observers/sessions):

```ts
interface Envelope {
  id: string // server-assigned
  ts: number // epoch ms
  from: string // session name, or 'dashboard'
  to: string // target name, comma-separated list, or 'all'
  envelope_type: string // 'message' | 'request' | 'response' | 'permission-request' | 'permission-response'
  body: string | null
  callback_id: string | null
  response_to: string | null
}
```

**Session → switchboard frames** (over `/ws/session`):

```
{ type: 'hello', token, name, cc_session_uuid, pid, machine_id, version }
{ type: 'send' | 'respond', to, frame_type, body, callback_id?, response_to?, client_ref? }
{ type: 'uuid-rotate', old_uuid, new_uuid }
{ type: 'permission-response', request_id, decision }
{ type: 'ping', ts }
```

**Switchboard → session frames**:

```
{ type: 'accepted', server_time }
{ type: 'error', code }                    // malformed / missing hello / etc.
{ type: 'envelope', ...envelope }          // inbound message for this session
{ type: 'sent', client_ref, id }           // ack of outgoing send
{ type: 'pong', ts }
```

**Switchboard → observers (over `/ws/observer`)**:

```
{ type: 'sessions-snapshot', sessions: [...] }    // sent on connect
{ type: 'session-delta', session, revision, changes: {online?, cc_session_uuid?, state?, ...} }
{ type: 'envelope', ...envelope }                 // every routed envelope
{ type: 'permission-request', data: {...} }       // derived from permission-request envelopes
{ type: 'permission-resolved', data: {...} }      // derived from permission-response envelopes
{ type: 'notification-dismiss', session }
```

## Key Design Decisions (v2)

- **Hub-and-spoke over peer-to-peer** — the switchboard centralizes auth, persistence, presence, and routing. One connection per session; one observer WS per dashboard client. No multicast. No peer discovery.
- **Per-session 256-bit tokens** — generated on `ccpl new`, stored at `~/.config/party-line/sessions/<name>.token` (0600). The MCP plugin reads the token from `PARTY_LINE_TOKEN` env. Names are pinned to tokens; server rejects name-mismatch with close code 4401.
- **Monotonic revision per session** — every state change (connect/disconnect, uuid change) bumps `ccpl_sessions.revision`. Observers apply deltas in revision order and drop stale ones. No flicker.
- **Supersede on duplicate hello** — if a token connects twice (same name), the older socket receives `{type: 'error', code: 'superseded'}` and close code 4408. The client does NOT reconnect on 4408. Clean handoff when `ccpl` relaunches.
- **UUID archival on `/clear`** — the plugin watches `currentCcUuid()` every 30s and sends `uuid-rotate` when Claude Code rotates its session UUID. Switchboard archives the old UUID in `ccpl_archives` with reason `clear` or `rotate_uuid_drift`.
- **Observer-source messages** — `/api/send` constructs an envelope with `from: 'dashboard'` and routes via `switchboard.routeEnvelope`. The CLI uses this endpoint too. Sessions can send from themselves via `/ws/session` frames.
- **Dashboard auth** — `PARTY_LINE_DASHBOARD_PASSWORD` + signed cookie via `PARTY_LINE_DASHBOARD_SECRET`. Auth disables entirely when the password env var is unset (localhost-only dev mode). `/ws/observer` is cookie-authed. `/ccpl/register` is unauthenticated (by design); other `/ccpl/*` endpoints are token-authed.
- **Hooks over stdin injection** — passive-capture model: hooks emit events via `POST /ingest`, the aggregator folds them, the dashboard observes. No injection into running sessions.
