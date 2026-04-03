# Claude Party Line

A shared-bus channel plugin for Claude Code — inter-session messaging via SQLite.

## Project Context

This is a Claude Code channel plugin (MCP server with `claude/channel` capability). It enables multiple Claude Code sessions on the same machine to send messages to each other using a shared SQLite database as the transport.

See `SPEC.md` for the full design spec, architecture, and goals.

## Tech Stack

- TypeScript on Bun runtime
- `@modelcontextprotocol/sdk` for MCP server + channel API
- `better-sqlite3` for SQLite access (WAL mode)
- No framework — single-purpose, minimal dependencies

## Key Reference

- **Discord plugin** (reference implementation): `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts`
- **Channel API notes**: `~/Claude_Main/memory/project_custom_channels.md`
- **Channels docs**: https://code.claude.com/docs/en/channels-reference

## Conventions

- Strict TypeScript — no `any`, explicit return types
- All SQL in `src/bus.ts` — nowhere else touches the database directly
- MCP server setup and tool handlers in `src/server.ts`
- Keep dependencies minimal — if you can do it without a library, do it without a library
