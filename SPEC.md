# Claude Party Line

**A transport-agnostic messaging protocol and channel plugin for Claude Code that enables inter-session communication.**

## Concept

Inspired by the "party line" telephone systems of the early 20th century: multiple listeners share a single communication line. Every message is broadcast to all listeners, but each one only "picks up the phone" when the message is addressed to it — identified by a distinctive "ring pattern" (the session name in the message envelope).

The core insight: **the party line pattern is transport-agnostic**. The same "everyone hears everything, filter by name" convention works over UDP multicast, Discord threads, email, webhooks, or any broadcast-capable medium. A session doesn't need to know about the transport — it just knows its own name.

## Problem

Claude Code sessions are isolated. Each runs in its own process with no awareness of other sessions on the same machine. This creates friction:

- **No cross-session communication.** A Discord-connected session can't check on a long-running project session's progress.
- **Single-channel limitation.** Discord can only connect to one session. Interacting with multiple sessions means multiple bots or manual terminal switching.
- **No delegation.** One session can't ask another to do something and get results back.

## Architecture: Three Layers

### Layer 1: Party Line Protocol

The protocol defines the message format, naming convention, and reliability mechanisms. It is independent of any specific transport.

**Message envelope:**

```json
{
  "id": "unique-message-id",
  "seq": 42,
  "from": "discord",
  "to": "research",
  "type": "message|request|response|status|heartbeat|announce",
  "body": "the actual content",
  "callback_id": null,
  "response_to": null,
  "ts": "2026-04-03T10:00:00.000Z"
}
```

**Session identity:** Each listener has a unique name (e.g., `"discord"`, `"research"`, `"presentation"`). Messages with `to: "all"` are broadcast. Messages with a specific name are only delivered to that session.

**Reliability — send-twice:**
Every message is transmitted twice, ~50ms apart. Receivers deduplicate by message `id`. This is simple, adds near-zero complexity, and on localhost handles the only realistic failure mode (receiver buffer momentarily full). No sequence tracking, no sliding windows, no retransmission protocol.

**Heartbeat + announce:**

- Sessions send a `heartbeat` message every 30 seconds to `"all"`.
- On startup, sessions send an `announce` message with their name and capabilities.
- The dashboard (and other sessions) use heartbeats to track who's online. A session with no heartbeat for 2+ intervals is considered offline.

**Request/response:**

- `type: "request"` messages include a `callback_id`.
- Recipient responds with `type: "response"` and `response_to: <callback_id>`.
- Requester can timeout if no response within a configurable window.

### Layer 2: Transport Adapters

Each adapter implements the party line protocol over a specific medium. The MCP channel plugin uses one or more adapters.

**UDP Multicast (primary — local machine):**

- All processes join multicast group `239.77.76.10` port `47100` on localhost.
- Messages are JSON-encoded UDP datagrams.
- Zero dependencies — uses Bun's native `node:dgram` or `Bun.udpSocket()`.
- Latency: ~200-400μs. Cross-platform (Linux, macOS, Windows).
- Discovery is implicit: join the group, hear all heartbeats.

**Future adapters (not in MVP):**

- **Discord threads** — bot in a server, each session owns a thread. Filter by thread ID. Enables remote inter-session messaging via Discord.
- **Email** — custom From addresses (e.g., `session-discord@domain.com`). All channels see incoming email, filter by recipient address. Async transport for non-urgent communication.
- **Webhooks** — single endpoint, route by payload field.

### Layer 3: Dashboard & Monitor

A lightweight web UI that joins the party line as a passive listener.

- **Bun HTTP server** serving a single-page app.
- **WebSocket** bridge: browser connects via WebSocket, server relays multicast traffic.
- **Features:**
  - Live session status (online/offline based on heartbeats)
  - Message activity feed (all bus traffic)
  - Send messages to any session by name
  - Session metadata display (capabilities, uptime)
- **Also a testing tool:** easiest way to verify the protocol works during development.

## Goals (Priority Order)

### P0 — UDP Transport + MCP Channel (MVP)

1. **UDP multicast transport**: join/leave group, send/receive datagrams.
2. **Party line protocol**: message envelope, send-twice reliability, deduplication.
3. **Heartbeat + announce**: session presence tracking.
4. **MCP channel plugin**: register as a Claude Code channel, deliver inbound messages as `<channel>` notifications, expose `send` / `list_sessions` / `respond` tools.
5. **Session name resolution**: env var → config file → fallback.

### P1 — Dashboard + Request/Response

6. **Dashboard web UI**: live session status, message feed, send capability.
7. **Request/response pattern**: callback IDs, response matching, timeouts.
8. **Message history**: in-memory ring buffer of recent messages (queryable via tool).

### P2 — Polish & Robustness

9. **Session metadata**: register capabilities/descriptions alongside name.
10. **Multicast addressing**: `to` field accepts an array of session names.
11. **Structured message types**: beyond plain text — status requests, task updates, file references.
12. **Permission relay**: forward permission prompts from headless sessions to an interactive one.

### P3 — Additional Transports

13. **Discord thread adapter**: remote inter-session messaging.
14. **Email adapter**: async message delivery.
15. **Transport multiplexing**: a session can listen on multiple transports simultaneously.

## Non-Goals

- **Guaranteed delivery.** Messages are best-effort with send-twice redundancy. Not a message queue.
- **Large payloads.** UDP datagrams are limited to ~65KB. This is for control messages and text, not file transfer.
- **Cross-machine networking (MVP).** UDP multicast is localhost-only in the MVP. Future adapters (Discord, email) handle remote communication.
- **Replacing MCP.** This is an MCP channel plugin, not a competing protocol.

## Transport: UDP Multicast Details

```
┌─────────────────────────────────────────────────────────────────┐
│              UDP Multicast Group 239.77.76.10:47100              │
│                                                                  │
│    ╔══════════════╗  ╔══════════════╗  ╔══════════════╗         │
│    ║  Party Line  ║  ║  Party Line  ║  ║  Dashboard   ║         │
│    ║  (discord)   ║  ║  (research)  ║  ║  (monitor)   ║         │
│    ╚══════╦═══════╝  ╚══════╦═══════╝  ╚══════╦═══════╝         │
│           │                  │                  │                 │
└───────────┼──────────────────┼──────────────────┼────────────────┘
            │ stdio            │ stdio            │ WebSocket
   ┌────────┴────────┐ ┌──────┴────────┐  ┌──────┴────────┐
   │  Claude Code    │ │  Claude Code  │  │  Browser UI   │
   │  + Discord ch.  │ │  (SSH term)   │  │               │
   └─────────────────┘ └───────────────┘  └───────────────┘
```

- **Multicast group**: `239.77.76.10` (mnemonic: 77=M, 76=L — "ML"), port `47100`.
- **Loopback**: `setMulticastLoopback(true)` so senders receive their own messages (useful for dashboard monitoring; filtered out by dedup for self-delivery).
- **TTL**: `setMulticastTTL(1)` — localhost only in practice (TTL=1 won't survive a router hop). Note: TTL=0 would be ideal but Bun's `setMulticastTTL(0)` throws `EINVAL`; TTL=1 is the safe minimum.
- **Message framing**: one JSON object per datagram. No streaming, no fragmentation.
- **Send-twice**: transmit each message, wait 50ms, transmit again with same `id`. Receiver keeps a Set of recently seen IDs (pruned every 60s) for deduplication.

### Message Flow Example

1. Claude in "discord" session calls `party_line_send(to: "research", message: "status update?")`.
2. Plugin serializes envelope JSON, sends UDP datagram to multicast group. Sends again after 50ms.
3. All listeners receive the datagram. "research" plugin sees `to` matches its name → delivers via `mcp.notification()`. "discord" plugin sees it's from itself → ignores. Dashboard sees it → displays in feed.
4. Claude in "research" responds via `party_line_respond(callback_id: "abc123", message: "80% done")`.
5. Response datagram goes to multicast group. "discord" plugin sees `response_to` matches a pending callback → delivers.

## Tech Stack

- **Language**: TypeScript (Bun runtime)
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Transport**: `node:dgram` (Bun-compatible, zero native deps)
- **Dashboard**: `Bun.serve` (HTTP + WebSocket, zero deps)
- **Storage**: `bun:sqlite` (built-in, zero native deps) — used by Mission Control observability layer
- **Hook emitters**: Bash (`curl` + `jq`) for local and remote hosts; PowerShell for Windows

## Phase 2: Mission Control Observability

Beyond the agent-to-agent channel, the dashboard also passively captures activity from every Claude Code session on the machine via hooks, regardless of whether the session is connected to the party-line channel.

### Data flow

1. A Claude Code session fires a hook (`PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStart`/`Stop`, etc.).
2. The hook script (`~/.config/party-line/emit.sh`) wraps the hook payload in an envelope with `machine_id`, `session_name`, `hook_event`, `ts`, and the original payload — then POSTs to the dashboard's `/ingest` endpoint with a shared-secret header.
3. The dashboard validates the envelope, stores it in SQLite, and broadcasts a `session-update` message over WebSocket to connected browsers.
4. In parallel, the dashboard polls `~/.claude/projects/**/*.jsonl` transcripts and `<session>/subagents/*.jsonl` files, re-emitting appended entries over WebSocket.
5. The browser renders live session cards, event timelines, and subagent trees.

### Ingest API

`POST /ingest` — accepts a JSON envelope:

```json
{
  "machine_id": "uuid",
  "session_name": "discord",
  "session_id": "uuid-from-claude-code",
  "hook_event": "PostToolUse",
  "ts": "2026-04-19T12:00:00.000Z",
  "payload": {
    "tool_name": "Bash",
    "tool_input": { "...": "..." },
    "tool_response": { "...": "..." }
  },
  "agent_id": "optional-subagent-id",
  "agent_type": "optional-subagent-type"
}
```

Headers: `X-Party-Line-Token: <token>` — must match `~/.config/party-line/ingest-token` on the dashboard host. Responses: `200 {ok:true}`, `400` (bad body), `401` (bad token), `405` (non-POST), `500` (storage error).

### Storage

SQLite at `~/.config/party-line/dashboard.db` (WAL mode). Tables: `machines`, `sessions`, `events`, `tool_calls`, `subagents`, `metrics_daily`. Schema versioned via `PRAGMA user_version`; migrations run on dashboard startup. Events older than 30 days are pruned automatically on startup. A daily metrics rollup table provides sparkline data without scanning raw events.

### Remote hosts

The `/ingest` endpoint is designed for localhost + LAN. A remote machine (e.g. a Windows dev box) can emit events to the dashboard over HTTP by copying the ingest token and setting `PARTY_LINE_INGEST` to the dashboard URL. Remote emitters live in `hooks/remote/`. Each remote host generates its own `machine_id` so events can be grouped by host.

### Dashboard UI (4 tabs)

- **Overview** — session cards with live state, current tool, subagent count, and 24h tool-call sparkline
- **Session Detail** — event timeline for a single session, subagent tree with nested tool calls
- **Machines** — one card per host reporting events, with last-seen and session counts
- **History** — filterable event feed across all sessions and machines

### Incremental transcript strategy (SB-26)

Session detail live updates previously did a full `/api/transcript?limit=300` fetch on every JSONL append or hook event. For long sessions this means re-reading and re-parsing the entire file on every poll tick.

**Server side** (`src/transcript.ts`, `dashboard/serve.ts`):

- `GET /api/transcript?session_id=X&after_uuid=<uuid>` — `buildTranscript` builds the full list as before (preserving all tool_use + tool_result merge logic), then `filterAfterUuid()` slices to entries after the given uuid's position. O(n) but avoids network overhead on large responses.
- If `after_uuid` is not found in the current list (stale uuid after compaction), `filterAfterUuid` returns the full list as a graceful fallback — the client gets a complete resync without a separate error path.

**Client side** (`dashboard/dashboard.js`):

- `lastRenderedUuid` tracks the uuid of the most recently rendered transcript entry.
- `handleJsonlEvent` and the `session-update` path call `renderStream({ incremental: true })`, which adds `&after_uuid=<lastRenderedUuid>` to the fetch when a prior cursor exists.
- `renderStream` appends new entries from the response (using the existing `renderedEntryKeys` dedup set), then updates `lastRenderedUuid` to the newest appended entry.
- `lastRenderedUuid` is reset to `null` on every full rebuild (new session, force refetch), so the first load always fetches everything.

**Truncation / compaction recovery**:

- The JSONL observer's `poll()` detects file shrinks (`newSize < prevOffset`) and uses a fingerprint (first 64 bytes) to confirm the file content changed. On shrink, it resets the offset and fires `onReset(filePath)`.
- `serve.ts` listens to `onReset` and broadcasts a `stream-reset` WebSocket event to all clients.
- Clients matching the reset file to the current view call `renderStream({ force: true })`, which wipes `lastRenderedUuid` and fetches fresh.
- Independently, a `SessionStart` hook event with `payload.source === 'compact'` (Claude Code's compaction signal) triggers the same force refetch via `maybeHandleCompactForCurrentView()`.

### Gemini CLI support

Gemini CLI has a near-parity hooks system (configured in `~/.gemini/settings.json`) and auto-saves per-session transcripts at `~/.gemini/tmp/<project_hash>/chats/session-*.json` as a single JSON file (not JSONL). Mission Control supports both:

- `bun run hooks:install-gemini` — registers hook entries in `~/.gemini/settings.json` pointing at a copy of our emit script at `~/.config/party-line/gemini-emit.sh`. Gemini event names are mapped to our `HookEventName` union inside the emitter (e.g. `BeforeTool` → `PreToolUse`, `AfterAgent` → `Stop`).
- The dashboard also runs a `GeminiTranscriptObserver` that polls `~/.gemini/tmp/*/chats/session-*.json` and diffs `messages[]` on modification, so Gemini activity surfaces in the dashboard even without hooks registered.
- Events from Gemini sessions carry `source: "gemini-cli"` in the `events` and `sessions` tables, and the dashboard renders a small `GEM` badge on Gemini session cards.

**Known gap — Gemini sessions are read-only in Mission Control.** Gemini CLI has no equivalent of Claude Code's `channels` feature and no wake-on-message. A Gemini session cannot receive a message from the party-line bus, and it cannot respond to an `party_line_request`. If bidirectional support becomes necessary, options are (in order of complexity):

1. **A2A (Agent-to-Agent) adapter.** Gemini supports calling remote A2A agents over HTTP. A side process could expose the party-line as an A2A agent a Gemini session calls explicitly. This is an outbound-from-Gemini pattern — Gemini queries, doesn't receive pushes.
2. **ACP mode.** `gemini --acp` exposes the session over the Agent Client Protocol. Still an outbound pattern.
3. **Stdin injection.** Write to the Gemini CLI's tmux pane via `tmux load-buffer` / `paste-buffer`. This was the approach we rejected for Claude Code; same drawbacks apply. Last resort.

None of these are in scope for this plan. Mission Control observes Gemini; it does not talk to it.

## File Structure

```
claude-party-line/
├── .claude-plugin/
│   └── plugin.json            # Plugin manifest for Claude Code
├── .mcp.json                  # MCP server registration
├── src/
│   ├── server.ts              # MCP channel server (tools + notification delivery)
│   ├── protocol.ts            # Message types, envelope creation, deduplication
│   ├── transport/
│   │   └── udp-multicast.ts   # UDP multicast adapter (send/receive/join/leave)
│   ├── presence.ts            # Heartbeat + announce + session tracking
│   └── types.ts               # Shared TypeScript types
├── dashboard/
│   ├── monitor.ts             # Shared multicast listener + presence + history
│   ├── serve.ts               # Web dashboard (Bun HTTP + WebSocket bridge)
│   ├── cli.ts                 # CLI: watch, send, request, sessions, history
│   └── index.html             # Single-page dashboard UI
├── CLAUDE.md                  # Project instructions
├── SPEC.md                    # This file
├── package.json
├── tsconfig.json
└── .gitignore
```

## Session Name Resolution

The plugin needs to know its own name. Resolution order:

1. **`PARTY_LINE_NAME` env var** — explicit override, highest priority.
2. **`/proc/<ppid>/cmdline`** — reads the parent Claude Code process's command line and extracts the `--name` argument. Re-checked every 30s so late-set names are picked up.
3. **Fallback** — `<working-directory-basename>-<pid>` (e.g., `my-project-12345`). Unique and location-aware but not human-friendly.
4. **`party_line_set_name` tool** — Claude can rename the session at any time during a conversation. Name change broadcasts an `announce` message to update peers.

Note: Claude Code does not expose `--name` via env var to MCP subprocesses. The `/proc` approach is Linux-specific; macOS would need an alternative (e.g., `ps` parsing).

## Development & Testing

- **Dev mode**: `--dangerously-load-development-channels server:party-line`
- **Dashboard**: `bun dashboard/serve.ts` — opens a web UI showing live bus traffic.
- **Two-session test**: open two terminals, each running Claude Code with `--name` and the party-line channel loaded. Send messages between them via the dashboard or MCP tools.
- **Debug logging**: `PARTY_LINE_DEBUG=1` writes to stderr.

## Current Status (2026-04-20)

**Fully working:**

- All code compiles cleanly — TypeScript errors fixed (including @types/bun, tsconfig, TTL issue)
- UDP multicast transport — cross-process messaging tested and confirmed working
- Web dashboard — HTTP server, REST API, WebSocket bridge, live session/message feed
- CLI — all commands working: watch, send, request, sessions, history (with --json and color output)
- MCP channel server — tools registered, stdio handshake correct, Claude Code integration tested
- End-to-end multi-session communication — sessions can send/receive messages via the party line
- Session discovery — announce-triggered heartbeat response for faster peer discovery
- Auto-naming — reads session name from parent Claude Code process tree via `/proc/<ppid>/cmdline`
- Fallback naming — uses working directory + PID (e.g. `my-project-12345`)
- `party_line_set_name` tool — manual rename within a running session
- Periodic name re-check — re-reads name from process tree every 30s
- Local marketplace — set up for prompt-free plugin installation
- Dashboard self-visibility — `includeSelf` flag on transport so dashboard sees its own messages
- Wake-on-message — sessions wake from idle when receiving party-line messages
- **Hook-based event ingest via `POST /ingest`** — shared-secret token auth, envelope validation
- **SQLite persistence** — schema versioning + migrations via `PRAGMA user_version`
- **JSONL transcript observer** — polling-based (Bun/Linux `fs.watch` recursive is broken); tails main session transcripts and `<session>/subagents/*.jsonl` files
- **State aggregator** — folds hook events into per-session, per-subagent, per-tool-call state
- **Mission Control dashboard UI** — 4-tab interface (Overview, Session Detail, Machines, History)
- **Sparkline** — 24h tool-call count per session, derived from daily metrics rollup
- **Retention + daily metrics rollup** — events pruned after 30 days on dashboard startup
- **Remote host emitters** — macOS/Linux (`hooks/remote/emit.sh`) and Windows (`hooks/remote/emit.ps1`)

**Known constraints:**

- Must use `--dangerously-load-development-channels server:party-line` for full channel behavior (including wake-on-message notifications). Using `--channels plugin:name@marketplace` only registers tools, not notifications, for non-Anthropic-allowlisted plugins.
- The `server:` format loads `.mcp.json` from the working directory. Use `--mcp-config <path>` if the session runs from a different directory.
- `.mcp.json` must use absolute paths (not `${CLAUDE_PLUGIN_ROOT}`) when loaded as `server:` format.
- Plugin cache doesn't auto-update when source changes — bump version in `plugin.json` to force re-cache.
- TTL must be 1 (not 0) — Bun's `setMulticastTTL(0)` throws `EINVAL`.
- `fs.watch({ recursive: true })` is broken on Bun/Linux — JSONL observer uses polling instead.

**Remaining work / future improvements:**

- Permission relay — forward tool approval prompts from headless sessions via party line
- Structured message types — beyond plain text (status updates, task references, file paths)
- Multi-address `to` field — array of session names for targeted broadcasts
- Request/response timeout handling — currently fire-and-forget with no deadline enforcement
- Publishing to a real marketplace to avoid requiring `--dangerously-load-development-channels`

## Open Questions

1. **Max message size**: UDP limit is ~65KB. For inter-session text messages this is plenty, but document the limit and keep messages small to avoid fragmentation.
2. **Multicast on macOS**: Linux confirmed working. macOS `addMembership` behavior with `node:dgram` under Bun hasn't been verified — may need testing for portability.
3. **Notifications for marketplace plugins**: Claude Code currently does not register channel notifications (`<channel>` delivery to Claude's context) for non-Anthropic-allowlisted plugins loaded via `--channels plugin:name@marketplace`. This is the key blocker for removing `--dangerously-load-development-channels`. No known workaround short of getting the plugin allowlisted by Anthropic or waiting for policy change.
4. **Session resume by name**: `~/.claude/sessions/*.json` files contain name and sessionId. A future enhancement could let sessions find a previously-named session and resume it, rather than starting fresh with auto-naming.
5. **Permission relay design**: forwarding tool approval prompts across sessions requires careful design — what's the right UX? Block the requesting session while waiting? Timeout and auto-deny? Currently unresolved.
6. **Tool-call success detection** — `PostToolUse.tool_response` shape is tool-specific. Currently we heuristically detect failure via `tool_response.success === false`, `isError === true`, or `error` presence. A proper taxonomy per tool type would be more reliable.
7. **Hook propagation into subagents** — not empirically verified whether `PreToolUse`/`PostToolUse` hooks configured in `~/.claude/settings.json` fire for tool calls originating in a subagent. We shipped with `SubagentStop` + subagent-transcript fallback (`<session>/subagents/agent-<id>.jsonl` tailing), but the parent-hook propagation path has **not been empirically confirmed**. If hooks do propagate into subagents, events will arrive with an `agent_id` field; if they don't, we rely entirely on the JSONL tail for subagent activity.

### Compaction handling (resolved design, 2026-04-20)

When Claude Code compact-mode rewrites a session JSONL, the file is replaced with a shorter summary file. The JSONL observer detects this via size comparison: if `newSize < prevOffset`, it resets the file offset and emits a synthetic `stream-reset` event to the client. The client then forces a full `/api/transcript` refetch, discarding the stale incremental cursor (`lastRenderedUuid`).

For hook events: a `SessionStart` event with `payload.source === 'compact'` is the canonical signal that compaction occurred. The dashboard client's `maybeHandleCompactForCurrentView()` catches this and calls `renderStream({ force: true })` for the currently-viewed session.

Both paths converge on a clean re-render without requiring manual refresh from the user.

## Resolved Questions

1. **Does Claude Code expose `--name` to MCP server subprocesses?** No — Claude Code does not pass `--name` as an env var to MCP subprocess. Resolved by reading `/proc/<ppid>/cmdline` to find the parent Claude Code process and extract its `--name` argument.
2. **Bun.udpSocket vs node:dgram**: `node:dgram` works correctly for multicast under Bun. `Bun.udpSocket()` is an alternative but not needed.
3. **Channel plugin loading**: `--dangerously-load-development-channels server:party-line` is the correct approach for full channel behavior (tools + notifications). Marketplace loading only provides tools.
4. **Dashboard port**: configurable via `--port` flag, defaults to 3400.

## Design Decisions Made

- **At-most-once envelope delivery** — the switchboard inserts each envelope into SQLite (`messages`) before fanning out to recipient WebSocket clients. If the dashboard process dies, restarts, or a recipient is mid-disconnect, the envelope persists in the table but is not retried — the recipient will not see it via WebSocket on reconnect. Sessions can query `/ccpl/history` (or the dashboard `/api/transcript`) to backfill missed envelopes by id. This trade-off was made because (a) the dashboard rarely restarts in practice and (b) inter-agent messaging is a small fraction of dashboard traffic. If higher reliability becomes important, the natural extension is per-session `last_seen_id` tracking with a SELECT-and-replay step inside the `hello` handler.
- **UDP multicast over SQLite** — real-time, decentralized, zero dependencies. No polling.
- **Send-twice for reliability** — simplest possible redundancy. On localhost, this handles the only realistic failure mode (buffer overflow). No sequence numbers, no ACK/NACK, no sliding windows.
- **Heartbeat + announce for presence** — no registry file, no database. Sessions discover each other passively through multicast traffic.
- **Protocol is transport-agnostic** — the envelope format and naming convention work over any broadcast medium. UDP is just the first adapter.
- **Dashboard as testing platform** — three interfaces (web, CLI, log-tail JSON) so we can both visually monitor and programmatically test.

## Future Vision

The party line pattern extends naturally beyond local UDP:

- **Discord as a transport**: each session gets a thread in a Discord channel. The bot broadcasts to all threads; each session's plugin filters for its thread. Enables remote inter-session communication with zero infrastructure.
- **Email as a transport**: custom addresses per session (e.g., `session-discord@argonautcreations.com`). Async, resilient, works across networks.
- **Mixed transports**: a session could listen on both UDP (fast local) and Discord (remote). The protocol is the same; only the wire changes.
- **Non-Claude listeners**: the dashboard is already a non-Claude participant. Any process that speaks the protocol can join — monitoring tools, CI/CD pipelines, home automation, etc.
- **Centralized presence for remote transports**: local UDP gets free discovery via multicast. Remote transports (Discord, email) may need a lightweight presence server or convention (e.g., a pinned "registry" message in the Discord channel).
