# Claude Party Line

A transport-agnostic messaging protocol for Claude Code inter-session communication.

## Project Context

This is a Claude Code channel plugin (MCP server with `claude/channel` capability) that enables multiple Claude Code sessions on the same machine to send messages to each other via UDP multicast. Designed with the "party line" pattern: everyone hears everything, each listener filters for its own name.

See `SPEC.md` for the full design spec, architecture, goals, current status, and open questions.

## Current Status

Project is **functional and tested**, including Mission Control observability (Phase 2). The following all work end-to-end:

- UDP multicast transport (send-twice, join/leave, deduplication)
- Dashboard — web UI at `localhost:3400` and CLI (`watch`, `send`, `request`, `sessions`)
- MCP channel server with Claude Code — tools delivered, messages received and sent
- Wake-on-message — incoming messages interrupt Claude when loaded with `--dangerously-load-development-channels server:party-line`
- Auto-naming — session name read from parent process tree (`/proc` walk finds `--name` flag on the parent `claude` process)
- Marketplace install — plugin published as `plugin:party-line@agent-partyline` (repo: https://github.com/Argonaut-Creations/agent-partyline)
- Hook-based event ingest (`POST /ingest`) with shared-secret auth
- SQLite persistence at `~/.config/party-line/dashboard.db` — schema versioning, migrations, 30-day retention
- JSONL transcript observer — polls `~/.claude/projects/**/*.jsonl` + subagent transcripts
- State aggregator — derives per-session, per-subagent, per-tool-call state from events
- Mission Control dashboard UI — 4 tabs (Overview, Session Detail, Machines, History)
- Remote host emitters (macOS/Linux/Windows) via `hooks/remote/`

## Tech Stack

- TypeScript on Bun runtime
- `@modelcontextprotocol/sdk` for MCP server + channel API
- `node:dgram` for UDP multicast (zero native dependencies)
- Dashboard: `Bun.serve` for HTTP + WebSocket

## Key Reference

- **Discord plugin** (reference channel implementation): `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts`
- **Channel API research notes**: `~/Claude_Main/memory/project_custom_channels.md`
- **Channels docs**: https://code.claude.com/docs/en/channels-reference
- **Plugins docs**: https://code.claude.com/docs/en/plugins-reference

## Architecture

```
src/
  types.ts              — Shared types, constants, config defaults
  protocol.ts           — Envelope creation, serialization, deduplication
  events.ts             — HookEvent type definitions and validation
  machine-id.ts         — Stable machine ID read/write (~/.config/party-line/machine-id)
  aggregator.ts         — Folds hook events into session/subagent/tool-call state
  transport/
    udp-multicast.ts    — UDP multicast adapter (send-twice, join/leave)
  presence.ts           — Heartbeat, announce, session timeout tracking
  server.ts             — MCP channel server (entry point for Claude Code)
  ingest/
    http.ts             — POST /ingest handler, envelope validation
    auth.ts             — Shared-secret token management
  observers/
    jsonl.ts            — Polling tailer for ~/.claude/projects/**/*.jsonl + subagent transcripts
  storage/
    db.ts               — SQLite open, migration runner, schema versioning
    schema.sql          — machines, sessions, events, tool_calls, subagents, metrics_daily
    queries.ts          — Prepared statements and typed query helpers
    metrics.ts          — Daily metrics rollup (sparkline data)
    retention.ts        — 30-day event pruning on startup

dashboard/
  monitor.ts            — Shared multicast listener (used by both web + CLI)
  serve.ts              — Web dashboard (HTTP + WebSocket bridge to browser)
  cli.ts                — CLI tool (watch, send, request, sessions, history)
  index.html            — Dashboard web UI (shell; loads view fragments)
  dashboard.js          — Router, view manager, WebSocket client
  dashboard.css         — Dashboard styles
  views/
    overview.html       — Session cards with live state + sparklines
    session-detail.html — Event timeline + subagent tree for one session
    machines.html       — Per-host cards
    history.html        — Filterable event feed

hooks/
  emit.sh               — Local hook emitter (POSTs to /ingest)
  install.sh            — Merges hook entries into ~/.claude/settings.json
  uninstall.sh          — Removes party-line hook entries
  remote/
    emit.sh             — POSIX emitter for remote hosts
    emit.ps1            — PowerShell emitter for Windows
    README.md           — Remote host setup guide

bin/
  ccpl                  — Launcher script for party-line Claude Code sessions
```

## Running

```bash
# Dashboard (web + multicast listener)
bun dashboard/serve.ts [--port 3400] [--name dashboard] \
  [--cert cert.pem --key key.pem]   # optional: speak HTTPS/WSS. Also via PARTY_LINE_TLS_CERT/KEY env.

# CLI
bun dashboard/cli.ts watch              # tail messages
bun dashboard/cli.ts watch --json       # JSON output for piping
bun dashboard/cli.ts sessions           # list online sessions
bun dashboard/cli.ts send <to> <msg>    # send a message
bun dashboard/cli.ts request <to> <msg> # send request, wait for response

# Recommended: launch a party-line Claude Code session via the launcher script
ccpl [name]

# For the Discord/always-on session — watchdog uses --mcp-config + wake-on-message flag:
claude --mcp-config /path/to/mcp-config.json --dangerously-load-development-channels server:party-line --name discord

# Note: --channels plugin:party-line@agent-partyline gives tools but NOT wake-on-message.
# Wake requires the server: format with --dangerously-load-development-channels.

# Install/uninstall hooks (captures events from every Claude Code session on this machine)
bun run hooks:install
bun run hooks:uninstall
```

## Conventions

- Strict TypeScript — no `any`, explicit return types
- Zero native dependencies — only MCP SDK and Bun built-ins
- Transport logic stays in `src/transport/` — server.ts uses transport through abstraction
- All messages go through protocol layer for consistent envelope format
- Dashboard code in `dashboard/` imports from `src/` but `src/` never imports from `dashboard/`
- Session names should be short, human-readable, lowercase (e.g., "discord", "research", "presentation")
- SQLite schema changes always come with a migration entry in `src/storage/db.ts` and a bumped `SCHEMA_VERSION`
- `fs.watch({ recursive: true })` is broken on Bun/Linux — observers use polling instead (confirmed via spike)
- Hook emitters are fire-and-forget with a 1-2s curl timeout so they never block a Claude Code session

## Key Design Decisions

- UDP multicast (not SQLite, not WebSocket hub) — real-time, decentralized, zero deps
- Send-twice reliability — simplest redundancy, no ACK/NACK protocol needed on localhost
- Heartbeat-based presence — no registry file, passive discovery via multicast
- Transport-agnostic protocol — envelope format works over any broadcast medium
- Dashboard is also the testing platform — web, CLI, and JSON output modes
- Auto-naming via `/proc` process tree walk — reads `--name` flag from parent `claude` process, so `ccpl myname` just works without extra config
- Wake-on-message requires `server:` format with `--dangerously-load-development-channels` — `plugin:` format delivers tools only, no channel interrupts
- Dashboard sees its own messages via `includeSelf` transport flag — useful for testing send/receive without a second session
- **Hooks over stdin injection** — originally researched ways to inject messages into running sessions (tmux paste-buffer, prompt queues). Landed on a passive-capture model: hooks emit events, the dashboard observes, no injection needed
- **Session-name OR UUID lookups** — dashboard UI identifies sessions by name (from multicast presence), hook events are keyed by session UUID; backend queries accept either
