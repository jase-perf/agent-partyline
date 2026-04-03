# Claude Party Line

A transport-agnostic messaging protocol for Claude Code inter-session communication.

## Project Context

This is a Claude Code channel plugin (MCP server with `claude/channel` capability) that enables multiple Claude Code sessions on the same machine to send messages to each other via UDP multicast. Designed with the "party line" pattern: everyone hears everything, each listener filters for its own name.

See `SPEC.md` for the full design spec, architecture, goals, current status, and open questions.

## Current Status

Code is written but **untested**. First priority is getting it running: `bun install`, verify UDP multicast works, test the dashboard, then test with Claude Code sessions.

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
  transport/
    udp-multicast.ts    — UDP multicast adapter (send-twice, join/leave)
  presence.ts           — Heartbeat, announce, session timeout tracking
  server.ts             — MCP channel server (entry point for Claude Code)

dashboard/
  monitor.ts            — Shared multicast listener (used by both web + CLI)
  serve.ts              — Web dashboard (HTTP + WebSocket bridge to browser)
  cli.ts                — CLI tool (watch, send, request, sessions, history)
  index.html            — Dashboard web UI
```

## Running

```bash
# Dashboard (web + multicast listener)
bun dashboard/serve.ts [--port 3400] [--name dashboard]

# CLI
bun dashboard/cli.ts watch              # tail messages
bun dashboard/cli.ts watch --json       # JSON output for piping
bun dashboard/cli.ts sessions           # list online sessions
bun dashboard/cli.ts send <to> <msg>    # send a message
bun dashboard/cli.ts request <to> <msg> # send request, wait for response

# As Claude Code channel (development mode)
claude --dangerously-load-development-channels server:party-line --name my-session
```

## Conventions

- Strict TypeScript — no `any`, explicit return types
- Zero native dependencies — only MCP SDK and Bun built-ins
- Transport logic stays in `src/transport/` — server.ts uses transport through abstraction
- All messages go through protocol layer for consistent envelope format
- Dashboard code in `dashboard/` imports from `src/` but `src/` never imports from `dashboard/`
- Session names should be short, human-readable, lowercase (e.g., "discord", "research", "presentation")

## Key Design Decisions

- UDP multicast (not SQLite, not WebSocket hub) — real-time, decentralized, zero deps
- Send-twice reliability — simplest redundancy, no ACK/NACK protocol needed on localhost
- Heartbeat-based presence — no registry file, passive discovery via multicast
- Transport-agnostic protocol — envelope format works over any broadcast medium
- Dashboard is also the testing platform — web, CLI, and JSON output modes
