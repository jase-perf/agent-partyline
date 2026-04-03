# Claude Party Line

A transport-agnostic messaging protocol for Claude Code inter-session communication.

## Project Context

This is a Claude Code channel plugin (MCP server with `claude/channel` capability) that enables multiple Claude Code sessions on the same machine to send messages to each other via UDP multicast. Designed with the "party line" pattern: everyone hears everything, each listener filters for its own name.

See `SPEC.md` for the full design spec, architecture, and goals.

## Tech Stack

- TypeScript on Bun runtime
- `@modelcontextprotocol/sdk` for MCP server + channel API
- `node:dgram` for UDP multicast (zero native dependencies)
- Dashboard: `Bun.serve` for HTTP + WebSocket

## Key Reference

- **Discord plugin** (reference implementation): `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts`
- **Channel API notes**: `~/Claude_Main/memory/project_custom_channels.md`
- **Channels docs**: https://code.claude.com/docs/en/channels-reference

## Architecture

- `src/types.ts` — shared types and constants
- `src/protocol.ts` — message envelope creation, serialization, deduplication
- `src/transport/udp-multicast.ts` — UDP multicast adapter (send-twice reliability)
- `src/presence.ts` — heartbeat + announce + session tracking
- `src/server.ts` — MCP channel server (tools + notification delivery)
- `dashboard/` — web UI + CLI for monitoring and testing

## Conventions

- Strict TypeScript — no `any`, explicit return types
- Zero native dependencies — only MCP SDK and Bun built-ins
- Transport logic stays in `src/transport/` — server.ts doesn't know about UDP directly
- All messages go through the protocol layer for consistent envelope format
