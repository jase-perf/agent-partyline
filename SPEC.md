# Claude Party Line

**A shared-bus channel plugin for Claude Code that enables inter-session messaging.**

## Concept

Inspired by the "party line" telephone systems of the early 20th century: multiple Claude Code sessions share a single communication line. Every message is broadcast to all listeners, but each session only "picks up the phone" when the message is addressed to it — identified by a distinctive "ring pattern" (the session name in the message envelope).

No central server. No broker process. Just a shared transport and a convention.

## Problem

Claude Code sessions are isolated. Each runs in its own process with no awareness of other sessions on the same machine. This creates friction:

- **No cross-session communication.** A Discord-connected session can't check on a long-running project session's progress.
- **Single-channel limitation.** Discord can only connect to one session. If you want to interact with multiple sessions, you need multiple Discord bots or manual terminal switching.
- **No delegation.** One session can't ask another to do something and get results back.

## Goals

### P0 — Core Bus (MVP)

1. **Shared message transport** using SQLite (WAL mode) as the "party line wire."
2. **Session registration**: each plugin instance registers its session name on startup, deregisters on shutdown.
3. **Addressed messaging**: messages carry a `to` field. Plugin only delivers notifications when `to` matches its session name, or `to` is `"all"` (broadcast).
4. **Send tool**: `send(to, message)` — write a message to the bus addressed to a specific session or `"all"`.
5. **Receive via notification**: inbound messages delivered as `<channel source="party-line" from="..." to="...">message</channel>` tags.
6. **Session discovery**: `list_sessions()` tool — query the registry to see what sessions are currently connected.

### P1 — Request/Response

7. **Callback pattern**: `request(to, message)` returns a `request_id`. Recipient can `respond(request_id, response)`. Original sender receives the response as a notification with the matching `request_id`.
8. **Timeout handling**: requests that aren't answered within a configurable window get a timeout notification.

### P2 — Routing & Integration

9. **Discord bridge routing**: the Discord session can forward messages to other sessions by name (e.g., "ask the presentation session for a status update").
10. **Multicast**: `to` field accepts an array of session names.
11. **Message types**: support structured message types beyond plain text (status requests, task updates, file references).

### P3 — Polish

12. **Message history**: queryable log of recent bus messages (already in SQLite).
13. **Session metadata**: sessions can register capabilities/descriptions alongside their name.
14. **Permission relay**: forward permission prompts from headless sessions to an interactive session (like Discord does with approve/deny buttons).

## Non-Goals

- **Cross-machine communication.** This is a local-machine bus. Network transport is out of scope.
- **Replacing MCP.** This is an MCP server/channel plugin, not a competing protocol.
- **Persistence guarantees.** Messages are fire-and-forget with best-effort delivery. If a session is down, messages to it are missed (though they remain in the SQLite log for later query).

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    SQLite Database                         │
│  ~/.claude/channels/party-line/bus.db                     │
│                                                           │
│  sessions: name, pid, registered_at                       │
│  messages: id, from, to, type, body, callback_id, ts      │
│                                                           │
└──────────────┬───────────────────────────┬────────────────┘
               │ poll/watch                │ poll/watch
    ┌──────────┴──────────┐     ┌──────────┴──────────┐
    │  Party Line Plugin  │     │  Party Line Plugin  │
    │  (session: discord) │     │  (session: research)│
    │                     │     │                     │
    │  MCP Server (stdio) │     │  MCP Server (stdio) │
    └──────────┬──────────┘     └──────────┴──────────┘
               │                           │
    ┌──────────┴──────────┐     ┌──────────┴──────────┐
    │  Claude Code        │     │  Claude Code         │
    │  (Discord channel)  │     │  (SSH terminal)      │
    └─────────────────────┘     └──────────────────────┘
```

Each Claude Code session spawns its own instance of the Party Line plugin as an MCP server subprocess. All instances read/write the same SQLite database. No central process needed.

### Message Flow

1. **Send**: Claude in session A calls `send(to: "research", message: "what's your status?")`.
2. **Write**: Plugin A writes a row to `messages` table with `from: "discord"`, `to: "research"`.
3. **Detect**: Plugin B's poll/watch loop sees a new row where `to` matches its name.
4. **Deliver**: Plugin B calls `mcp.notification()` to inject the message into session B's conversation.
5. **Reply** (if callback): Claude in session B calls `respond(callback_id: "abc", message: "80% done")`.
6. **Route back**: Plugin A picks up the response row matching the callback ID.

### Transport: SQLite + fs.watch

- **SQLite WAL mode**: safe for concurrent reads/writes from multiple processes.
- **`fs.watch()` on the WAL file**: near-instant notification when any process writes. Avoids polling latency.
- **Fallback polling**: if `fs.watch` is unreliable (some filesystems), poll every 500ms.
- **Cleanup**: messages older than 24 hours are pruned on startup and periodically.

### Session Name Resolution

The plugin needs to know its own session name. Options (in priority order):

1. **`CLAUDE_SESSION_NAME` env var** — set explicitly when launching.
2. **`--name` flag** — Claude Code sets this; check if it's exposed to MCP servers via env.
3. **Config file** — `~/.claude/channels/party-line/config.json` with a `name` field.
4. **Fallback** — use hostname + PID as a unique-but-ugly default.

## Tech Stack

- **Language**: TypeScript (Bun runtime, consistent with official Anthropic plugins)
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Database**: `better-sqlite3` (synchronous, simple, well-suited for WAL mode + polling)
- **File watching**: Node `fs.watch` on the SQLite WAL file
- **No other dependencies** — keep it minimal

## File Structure

```
claude-party-line/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── .mcp.json                # MCP server config for Claude Code
├── src/
│   ├── server.ts            # Main MCP server + channel setup
│   ├── bus.ts               # SQLite transport (read/write/watch)
│   ├── registry.ts          # Session registration/discovery
│   └── types.ts             # Shared TypeScript types
├── CLAUDE.md                # Project instructions for Claude Code sessions
├── SPEC.md                  # This file
├── README.md                # Usage instructions
├── package.json
├── tsconfig.json
└── .gitignore
```

## Development & Testing

- **Dev mode**: `--dangerously-load-development-channels server:party-line`
- **Testing**: run two Claude Code sessions side by side, each with `--name` set, both loading the party-line channel. Send messages between them.
- **Logging**: write debug output to `~/.claude/channels/party-line/debug.log` (toggled via env var).

## Open Questions

1. **Does Claude Code expose `--name` to MCP server subprocesses?** Need to check what env vars are available. If not, we'll need another mechanism.
2. **`fs.watch` reliability on ext4/btrfs** — should be fine on Linux, but needs testing with SQLite WAL specifically.
3. **Message ordering guarantees** — SQLite autoincrement + WAL should give us consistent ordering, but concurrent writers could interleave. Probably fine for our use case.
4. **Should the plugin auto-install `better-sqlite3`?** The Discord plugin does `bun install` on startup. We'd do the same.
