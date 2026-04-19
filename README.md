# Claude Party Line

**Inter-session messaging for Claude Code via UDP multicast.**

Multiple Claude Code sessions on the same machine can send messages to each other by name. Built on the "party line" telephone pattern: everyone hears everything, each listener filters for its own name.

```
discord → research: what's the status on the API refactor?
research → discord: 80% done, tests passing. Should be ready in an hour.
```

## What It Does

- Any Claude Code session can send messages to any other session by name
- Sessions discover each other automatically via multicast heartbeats
- Messages wake idle sessions — Claude responds even when nobody is typing
- A web dashboard shows live traffic, online sessions, and lets you send messages
- A CLI provides `watch`, `send`, `sessions`, and `request` commands

## How It Works

Each Claude Code session runs a party-line MCP server that joins a UDP multicast group on localhost. Messages are JSON envelopes broadcast to all listeners. Each session filters for messages addressed to its name (or "all" for broadcasts). The dashboard and CLI join the same group as passive listeners.

```
    UDP Multicast Group 239.77.76.10:47100

    ╔══════════╗  ╔══════════╗  ╔══════════╗
    ║ Session  ║  ║ Session  ║  ║Dashboard ║
    ║(discord) ║  ║(research)║  ║(monitor) ║
    ╚════╦═════╝  ╚════╦═════╝  ╚════╦═════╝
         │ stdio       │ stdio       │ WebSocket
    ┌────┴────┐  ┌─────┴─────┐  ┌────┴────┐
    │ Claude  │  │  Claude   │  │ Browser │
    │  Code   │  │   Code    │  │   UI    │
    └─────────┘  └───────────┘  └─────────┘
```

## Requirements

- [Claude Code](https://claude.ai/download) v2.1.80 or later
- [Bun](https://bun.sh) runtime
- Linux (multicast uses `/proc` for auto-naming; macOS not yet tested)
- Claude.ai login (API key auth doesn't support channels)

## Install

The easiest way — register the marketplace from GitHub, then install the plugin:

```bash
claude plugin marketplace add Argonaut-Creations/agent-partyline
claude plugin install party-line@agent-partyline
```

This gives you the MCP tools (`party_line_send`, `party_line_request`, etc.) inside any Claude Code session. For **wake-on-message** behavior (idle sessions respond to incoming messages), you still need the `--dangerously-load-development-channels` flag — see [Wake-on-Message Setup](#important-wake-on-message-setup) below.

If you want the dashboard, launcher script, and ability to hack on the source, also clone the repo:

```bash
git clone https://github.com/Argonaut-Creations/agent-partyline.git ~/projects/claude-party-line
cd ~/projects/claude-party-line
bun install
```

## Quick Start

### 1. Start the dashboard

```bash
bun dashboard/serve.ts
```

Open http://localhost:3400 to see the web UI. You should see the dashboard appear as an online session.

### 2. Launch a Claude Code session with party-line

The simplest way:

```bash
claude --dangerously-skip-permissions \
  --mcp-config ~/projects/claude-party-line/.mcp.json \
  --dangerously-load-development-channels server:party-line \
  --name my-session
```

Or use the included launcher script (add it to your PATH or create an alias):

```bash
# Add to ~/.bashrc:
alias ccpl='~/projects/claude-party-line/bin/ccpl'

# Then:
ccpl my-session
```

The `ccpl` script handles `--mcp-config` and `--dangerously-load-development-channels` for you. If a session with that name already exists, it resumes it.

### 3. Send a message from the dashboard

In the web UI at localhost:3400, type a session name in the "To" field, write a message, and click Send. The target session will wake up and respond.

### 4. Open a second session

In another terminal:

```bash
ccpl research
```

Now send a message between them — either from the dashboard or by asking Claude to use `party_line_send`.

## Observability (Mission Control)

The dashboard passively captures what every Claude Code session on this machine is doing — tool calls, subagent spawns, user prompts, session start/end — via hooks, and surfaces them in a live multi-view UI.

### Install

```bash
# Start the dashboard (if not already running)
bun dashboard/serve.ts

# Install hooks globally — any Claude Code session will now emit to the dashboard
bun run hooks:install
```

Visit [http://localhost:3400](http://localhost:3400).

### Uninstall

```bash
bun run hooks:uninstall
```

This removes the party-line hook entries from `~/.claude/settings.json`. Other hooks are preserved.

### Data storage

Events land in `~/.config/party-line/dashboard.db` (SQLite). Events older than 30 days are pruned automatically on dashboard startup.

### Remote machines

To have a second machine (e.g. Windows or macOS) report to the same dashboard:

1. Copy `~/.config/party-line/ingest-token` from the dashboard host to the remote host's matching path. Preserve 0600 perms on POSIX.
2. Generate a fresh machine ID on the remote host — **do not** reuse the dashboard's.
3. Copy the appropriate emitter from `hooks/remote/` (POSIX or PowerShell) and register it in the remote host's Claude Code hooks config.
4. Set `PARTY_LINE_INGEST` to `http://<dashboard-host>:3400/ingest`.

Full guide: `hooks/remote/README.md`.

## Important: Wake-on-Message Setup

This is the most common gotcha. There are two ways to load the party-line channel, and they behave differently:

| Method | Tools | Wake-on-message |
|--------|-------|-----------------|
| `--dangerously-load-development-channels server:party-line` | Yes | **Yes** |
| `--channels plugin:party-line@agent-partyline` | Yes | No |

**Wake-on-message** means a party-line message will interrupt an idle Claude session and trigger a response — the same way a Discord message wakes the Discord channel.

The `--channels` method connects the MCP server and registers all tools (send, request, respond, list_sessions, history), but Claude Code does not register channel notification listeners for plugins that aren't on the Anthropic-curated allowlist. Since party-line is a custom plugin, it doesn't get notification registration via `--channels`.

The `--dangerously-load-development-channels server:party-line` method bypasses the allowlist and registers full channel behavior, including notifications that wake idle sessions. This is the recommended approach.

**The tradeoff:** `--dangerously-load-development-channels` shows a confirmation prompt on startup. You can auto-accept it in tmux-based setups (see [Always-On Setup](#always-on-setup)).

## Installing from a Local Checkout

If you cloned the repo and want to register that checkout as a marketplace (useful when hacking on the source):

```bash
claude plugin marketplace add ~/projects/claude-party-line
claude plugin install party-line@agent-partyline
```

This is optional. The `--mcp-config` + `--dangerously-load-development-channels` approach works without installing the plugin.

## Session Naming

Sessions auto-detect their name in this order:

1. `PARTY_LINE_NAME` environment variable
2. Parent Claude Code process `--name` flag (read from `/proc/<ppid>/cmdline`)
3. Working directory name + PID (e.g. `my-project-12345`)

When you run `ccpl research`, the `--name research` flag is passed to Claude Code, and the party-line server auto-detects it from the process tree. No extra configuration needed.

Sessions can also rename themselves at runtime using the `party_line_set_name` tool.

## Dashboard

The web dashboard at localhost:3400 provides:

- **Session list** — all online sessions with heartbeat status
- **Message feed** — live stream of all bus traffic (filterable)
- **Send messages** — type a recipient and message, click Send
- **REST API** — `GET /api/sessions`, `GET /api/history`, `POST /api/send`

```bash
# Start on a custom port
bun dashboard/serve.ts --port 3500 --name my-monitor
```

## CLI

```bash
bun dashboard/cli.ts watch               # tail messages in real-time
bun dashboard/cli.ts watch --json        # JSON output for piping
bun dashboard/cli.ts watch --heartbeats  # include heartbeat messages
bun dashboard/cli.ts sessions            # list online sessions
bun dashboard/cli.ts send <to> <message> # send a message
bun dashboard/cli.ts request <to> <msg>  # send request, wait for response
bun dashboard/cli.ts history             # show recent messages
```

## Tools Available to Claude

When loaded as a channel, Claude gets these tools:

| Tool | Description |
|------|-------------|
| `party_line_send` | Send a message to a session by name, or "all" to broadcast |
| `party_line_request` | Send a request with a callback_id, expect a response |
| `party_line_respond` | Reply to a request using its callback_id |
| `party_line_list_sessions` | List all online sessions |
| `party_line_history` | View recent messages (excludes heartbeats) |
| `party_line_set_name` | Rename this session on the party line |

## Always-On Setup

For a persistent session (like a Discord bot that's also on the party line), you need to handle the `--dangerously-load-development-channels` confirmation prompt automatically.

Example launch script for a tmux-based watchdog:

```bash
#!/usr/bin/env bash
CLAUDE_BASE_ARGS=(
    --model claude-opus-4-6
    --dangerously-skip-permissions
    --channels "plugin:discord@claude-plugins-official"  # other channels via --channels
    --mcp-config /path/to/claude-party-line/.mcp.json
    --dangerously-load-development-channels server:party-line
    --name my-session
)

# Auto-accept the development channels prompt (runs in background)
(sleep 5 && tmux send-keys -t my-tmux-window Enter) &

exec claude "${CLAUDE_BASE_ARGS[@]}" --resume "$SESSION_ID"
```

The `sleep 5 && tmux send-keys Enter` sends Enter to the tmux pane after 5 seconds, which auto-accepts the "I am using this for local development" prompt.

## Configuration

### Multicast settings

Defaults in `src/types.ts`:

| Setting | Default | Notes |
|---------|---------|-------|
| Multicast address | `239.77.76.10` | Mnemonic: 77=M, 76=L |
| Port | `47100` | |
| TTL | `1` | Same-subnet only. TTL 0 is ideal but Bun rejects it |
| Loopback | `true` | Required for same-machine communication |
| Send-twice delay | `50ms` | Redundancy for reliability |
| Heartbeat interval | `30s` | |
| Session timeout | `75s` | ~2.5 heartbeat intervals |

### Environment variables

| Variable | Description |
|----------|-------------|
| `PARTY_LINE_NAME` | Override session name (highest priority) |
| `PARTY_LINE_DEBUG` | Set to `1` for debug logging to stderr |

## Project Structure

```
claude-party-line/
├── src/
│   ├── server.ts              # MCP channel server (entry point)
│   ├── protocol.ts            # Message envelope, serialization, dedup
│   ├── transport/
│   │   └── udp-multicast.ts   # UDP multicast adapter
│   ├── presence.ts            # Heartbeat, announce, session tracking
│   └── types.ts               # Shared types and constants
├── dashboard/
│   ├── monitor.ts             # Shared multicast listener
│   ├── serve.ts               # Web dashboard (HTTP + WebSocket)
│   ├── cli.ts                 # CLI tool
│   └── index.html             # Dashboard web UI
├── bin/
│   └── ccpl                   # Launcher script
├── .claude-plugin/
│   ├── plugin.json            # Plugin manifest
│   └── marketplace.json       # Local marketplace definition
├── .mcp.json                  # MCP server config
├── CLAUDE.md                  # Project instructions for Claude Code
├── SPEC.md                    # Full design spec
└── README.md                  # This file
```

## Known Limitations

- **Linux only** — Auto-naming reads `/proc/<ppid>/cmdline` which is Linux-specific. The transport itself should work on macOS but naming will fall back to `hostname-pid`.
- **UDP message size** — Limited to ~65KB per datagram. This is for control messages and text, not file transfer.
- **Localhost only** — TTL=1 means packets stay on the local subnet. For cross-machine messaging, future transport adapters (Discord, email) are planned.
- **No guaranteed delivery** — Send-twice redundancy is best-effort. Not a message queue.
- **Plugin cache** — When you change the source code, the cached plugin version doesn't update automatically. Bump the version in `plugin.json` or use `--mcp-config` to load from the project directory directly.

## Troubleshooting

**"not on the approved channels allowlist"** — You're using `--channels plugin:party-line@...` instead of `--dangerously-load-development-channels server:party-line`. Switch to the `server:` format for full channel behavior.

**Session doesn't wake on messages** — Same cause as above. The `--channels` method registers tools but not channel notifications.

**Dashboard can't start (EADDRINUSE)** — Another process is using port 3400. Use `--port 3500` or kill the existing process.

**MCP server fails with ENOENT / CLAUDE_PLUGIN_ROOT** — The `.mcp.json` uses absolute paths. If you moved the project, update the paths in `.mcp.json`.

**Session name shows as "hostname-12345"** — The parent Claude Code process wasn't started with `--name`. Pass `--name my-session` to Claude Code, and the party-line server will auto-detect it.

**Can't see other sessions in `sessions` command** — The `sessions` CLI command waits 2 seconds for heartbeats. If the other session just started, its first heartbeat may not have arrived yet. The announce-triggered heartbeat response helps, but very new sessions may take a moment to discover each other.

## License

MIT
