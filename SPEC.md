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
- **No database, no native bindings, no external dependencies beyond MCP SDK**

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

## Current Status (2026-04-03)

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

**Known constraints:**
- Must use `--dangerously-load-development-channels server:party-line` for full channel behavior (including wake-on-message notifications). Using `--channels plugin:name@marketplace` only registers tools, not notifications, for non-Anthropic-allowlisted plugins.
- The `server:` format loads `.mcp.json` from the working directory. Use `--mcp-config <path>` if the session runs from a different directory.
- `.mcp.json` must use absolute paths (not `${CLAUDE_PLUGIN_ROOT}`) when loaded as `server:` format.
- Plugin cache doesn't auto-update when source changes — bump version in `plugin.json` to force re-cache.
- TTL must be 1 (not 0) — Bun's `setMulticastTTL(0)` throws `EINVAL`.

**Remaining work / future improvements (P2+):**
- Permission relay — forward tool approval prompts from headless sessions via party line
- Structured message types — beyond plain text (status updates, task references, file paths)
- Multi-address `to` field — array of session names for targeted broadcasts
- Request/response timeout handling — currently fire-and-forget with no deadline enforcement
- Unit and integration tests
- Publishing to a real marketplace to avoid requiring `--dangerously-load-development-channels`

## Open Questions

1. **Max message size**: UDP limit is ~65KB. For inter-session text messages this is plenty, but document the limit and keep messages small to avoid fragmentation.
2. **Multicast on macOS**: Linux confirmed working. macOS `addMembership` behavior with `node:dgram` under Bun hasn't been verified — may need testing for portability.
3. **Notifications for marketplace plugins**: Claude Code currently does not register channel notifications (`<channel>` delivery to Claude's context) for non-Anthropic-allowlisted plugins loaded via `--channels plugin:name@marketplace`. This is the key blocker for removing `--dangerously-load-development-channels`. No known workaround short of getting the plugin allowlisted by Anthropic or waiting for policy change.
4. **Session resume by name**: `~/.claude/sessions/*.json` files contain name and sessionId. A future enhancement could let sessions find a previously-named session and resume it, rather than starting fresh with auto-naming.
5. **Permission relay design**: forwarding tool approval prompts across sessions requires careful design — what's the right UX? Block the requesting session while waiting? Timeout and auto-deny? Currently unresolved.

## Resolved Questions

1. **Does Claude Code expose `--name` to MCP server subprocesses?** No — Claude Code does not pass `--name` as an env var to MCP subprocess. Resolved by reading `/proc/<ppid>/cmdline` to find the parent Claude Code process and extract its `--name` argument.
2. **Bun.udpSocket vs node:dgram**: `node:dgram` works correctly for multicast under Bun. `Bun.udpSocket()` is an alternative but not needed.
3. **Channel plugin loading**: `--dangerously-load-development-channels server:party-line` is the correct approach for full channel behavior (tools + notifications). Marketplace loading only provides tools.
4. **Dashboard port**: configurable via `--port` flag, defaults to 3400.

## Design Decisions Made

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
