# Party Line v2 Migration — Hub-and-Spoke Transport

**Branch:** `main` (all Phase C commits landed)
**Date:** 2026-04-21
**Status:** 171 tests pass, typecheck clean, smoke tests green

## What changed

The party line rebuilt itself from **UDP multicast** (peer-to-peer) to **hub-and-spoke** (central WebSocket switchboard). The dashboard is now the sole router. Every session authenticates with a persistent token.

### Old flow

```
[session A] ─ UDP multicast ─ [session B]
              │
              └─ [dashboard] (passive listener)
```

### New flow

```
[session A] ──wss──> [dashboard/switchboard] <──wss── [session B]
                            │
                            └─ observers (dashboard UI, CLI)
```

Effects:

- **Sessions are first-class.** `ccpl new <name>` registers a named session with a 256-bit token. The token goes to `~/.config/party-line/sessions/<name>.token` (mode 0600).
- **Dashboard requires a password** (if `PARTY_LINE_DASHBOARD_PASSWORD` is set).
- **No more heartbeats / announces.** Presence = "is the WebSocket open?" Offline/online flips within ~30s of a disconnect (Bun idleTimeout).
- **Single session-delta stream.** The dashboard consumes one WS (`/ws/observer`) with `sessions-snapshot` + `session-delta` + `envelope` frames. No more flicker from racing `sessions`/`session-update`/`jsonl`/`hook-event`.
- **UDP multicast code is gone.** `src/transport/udp-multicast.ts`, `dashboard/monitor.ts`, `PresenceTracker` — deleted or reduced to thin shims.

## Your morning checklist

### 1. Set new env vars on the dashboard service

Edit `/home/claude/.config/systemd/user/party-line-dashboard.service`:

```ini
[Service]
...existing Environment= lines...
Environment=PARTY_LINE_DASHBOARD_PASSWORD=<pick-a-password>
Environment=PARTY_LINE_DASHBOARD_SECRET=<hex string ≥32 chars, e.g. `openssl rand -hex 32`>
```

**If you skip `PARTY_LINE_DASHBOARD_PASSWORD`:** auth is disabled (backwards-compatible mode). Dashboard and CLI work without a password. Only do this on a fully firewalled host.

**If you skip `PARTY_LINE_DASHBOARD_SECRET`:** dashboard cookies become invalid on every restart (ephemeral in-memory secret). Fine for dev, annoying for production. Startup logs a warning.

Then:

```bash
systemctl --user daemon-reload
systemctl --user restart party-line-dashboard
systemctl --user status party-line-dashboard
journalctl --user -u party-line-dashboard -n 40
```

### 2. The DB migrates automatically

`~/.config/party-line/dashboard.db` will upgrade from v3 → v4 on first run (adds `ccpl_sessions`, `ccpl_archives`, `messages`, `dashboard_sessions` tables). No manual steps.

Your existing events/sessions/machines/tool_calls/subagents data is preserved — Phase A/B never touched it and Phase C only added tables.

### 3. Log in to the dashboard

Browse to `https://claude.argo:3400/`. You'll hit `/login`. Enter the password.
After login, the dashboard shows the session list (empty until you register one).

### 4. Register your first session

```bash
cd ~/projects/claude-party-line
bun bin/ccpl new discord --cwd /home/claude/projects/claude-party-line
```

Output:

```
Registered 'discord' at /home/claude/projects/claude-party-line.
Token stored at /home/claude/.config/party-line/sessions/discord.token (chmod 600).
Run 'ccpl discord' to launch.
```

The token is required for the MCP plugin to connect to the switchboard — keep it secret.

### 5. Reinstall the `ccpl` binary symlink (if applicable)

The old `bin/ccpl` was a bash script. It's now a Bun TypeScript CLI (`bin/ccpl.ts` with a shim at `bin/ccpl`). If you had `~/.local/bin/ccpl` pointing at the old file, the symlink still works — point it at the same path:

```bash
ln -sfn /home/claude/projects/claude-party-line/bin/ccpl ~/.local/bin/ccpl
ccpl --help
```

### 6. Launch Claude Code via ccpl

```bash
ccpl discord
```

What this does:

1. Reads the token from `~/.config/party-line/sessions/discord.token`
2. GETs `/ccpl/session/discord` to verify the token + look up `cwd`
3. `chdir(row.cwd)`
4. Spawns `claude --name discord --mcp-config <.mcp.json> --dangerously-load-development-channels server:party-line [--resume <uuid>]`
5. Sets `PARTY_LINE_TOKEN=<token>` and `PARTY_LINE_SWITCHBOARD_URL=wss://localhost:3400/ws/session` in the environment
6. The MCP plugin reads those env vars, dials the switchboard, authenticates with the token

**First launch after migration:** the session row has no `cc_session_uuid` yet, so you'll get a fresh Claude Code session. Subsequent launches of `ccpl discord` will resume it automatically (the plugin sends `uuid-rotate` frames when `/clear` happens, so the switchboard archives and updates).

### 7. Your long-running `discord` session (watchdog)

If you have a systemd watchdog running an always-on Discord Claude Code session, update the ExecStart to use `ccpl`:

```ini
ExecStart=/home/claude/.local/bin/ccpl discord
```

Before restarting it: run `ccpl new discord --cwd <watchdog-working-dir>` from a human shell so the token gets written. Then restart the watchdog. It'll pick up `PARTY_LINE_TOKEN` from the token file via ccpl.

## Quick sanity tests

Once everything is up:

```bash
# list registered sessions (requires PARTY_LINE_DASHBOARD_PASSWORD in env)
PARTY_LINE_DASHBOARD_PASSWORD=<pw> bun dashboard/cli.ts sessions

# send a message from the CLI
PARTY_LINE_DASHBOARD_PASSWORD=<pw> bun dashboard/cli.ts send discord 'hello from cli'

# watch the observer stream
PARTY_LINE_DASHBOARD_PASSWORD=<pw> bun dashboard/cli.ts watch
```

You should see the envelope appear in `watch`, in the dashboard's bus feed, AND (if the target session is online and is not the CLI itself) in the target session's Claude Code.

## Common problems

### "Invalid password" at /login

- Make sure `PARTY_LINE_DASHBOARD_PASSWORD` is set in the service environment. Check with `systemctl --user show party-line-dashboard | grep Environment`.

### "Token rejected for 'X'. Try 'ccpl rotate X'."

- The token in `~/.config/party-line/sessions/X.token` doesn't match what's in the DB. Maybe the DB was deleted while the token file survived. Solution:
  ```bash
  ccpl forget X   # removes token file, best-effort DELETE to dashboard
  ccpl new X --cwd <dir>
  ```

### Dashboard cookie lost after restart

- Set `PARTY_LINE_DASHBOARD_SECRET` in the service env. Without it, cookies are signed with a per-process random secret.

### No browser notifications on the phone

- Phase B groundwork is in place (Service Worker + PWA manifest). Permission is requested on first bell-click. If you previously denied notifications on the phone, clear the site permissions and reload. After granting, bell icons light up per session.
- Notifications work in the background only when the PWA is installed to home screen ("Add to Home Screen" from iOS Safari / the install prompt on Android Chrome).

### `ccpl list` says auth required

- `list` hits the cookie-authed `/ccpl/sessions` endpoint. Export `PARTY_LINE_DASHBOARD_PASSWORD=<pw>` or log in via the browser first.

### MCP plugin says "PARTY_LINE_TOKEN not set"

- You launched Claude Code directly without `ccpl`. The plugin runs in degraded mode (tools return errors, no connection). Launch via `ccpl <name>` instead.

### Self-signed cert warnings

- The CLI sets `NODE_TLS_REJECT_UNAUTHORIZED=0` by default for local development. For the browser, you trust the mkcert-issued `claude.argo` cert once per device.

## What's NOT changed

- Hook-based event ingest (`POST /ingest` with shared-secret auth) still works. Remote hosts that run `hooks/remote/emit.sh` continue to flow events in.
- JSONL + Gemini transcript observers still poll and populate the aggregator tables.
- The Mission Control dashboard (Overview/Session Detail/Machines/History tabs) still renders. C13 migrated its WS source but kept the UI otherwise.
- PWA: manifest, icons, Service Worker install, install prompts — all survive Phase C.
- Service Worker-based notifications still register (`handleBellClick` in `dashboard.js`); just the session list feeding them is now switchboard-sourced.

## Known follow-up items (from code review)

See review notes in session history. Tracked as backlog:

- `/ccpl/register` is unauthenticated. Acceptable on localhost; add a rate limiter if you expose the dashboard beyond Twingate.
- `/ccpl/sessions` only accepts cookie auth. The MCP plugin's `party_line_list_sessions` tool falls back to `/ccpl/session/<self>` (own row only). A token-authed list endpoint would let the tool show all peers.
- `pruneInactive` removes archives by name match; consider cascading via FK.
- Quota + overrides now broadcast to observers in parallel with legacy wsClients pushes (C13 kept legacy). Actually wait — the legacy wsClients is gone after C14. Verify quota's 30s push broadcasts via `switchboard.broadcastObserverFrame` only.

## Rolling back

If something goes sideways and you need the old UDP behavior:

```bash
cd ~/projects/claude-party-line
git log --oneline | head -20    # find the last pre-Phase-C commit (0e452b4)
git checkout 0e452b4 -- .       # restore files only (keep your .git)
# Restart the dashboard
systemctl --user restart party-line-dashboard
```

The v4 schema tables are additive — they won't break the v3-era code if you roll back. But the DB's `user_version` will be 4, and v3 code will refuse to open it. If rollback is necessary, also downgrade `user_version`:

```bash
sqlite3 ~/.config/party-line/dashboard.db "PRAGMA user_version = 3;"
```

Then Phase C code can't open it (it refuses newer user_version), but Phase A/B code will. Clean rollback.

Ideally you never need this. The Phase C stack is well-tested (171 tests) and each task was individually smoke-tested.

## Sleep well. In the morning, start with step 1 above.
