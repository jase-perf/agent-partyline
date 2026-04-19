# Party Line — Remote Host Emitters

These scripts emit Claude Code hook events from a **remote machine** (macOS, other Linux, Windows) to the party-line dashboard running on your primary host. They behave identically to the main `hooks/emit.sh` except:

- They require `PARTY_LINE_INGEST` to be set to the remote dashboard URL (no localhost default).
- They do not walk `/proc` — session name must be set via `CLAUDE_SESSION_NAME` or `PARTY_LINE_NAME`.
- The ingest token is copied manually from the dashboard host during setup.

---

## Prerequisites

| Platform       | Requirements                                              |
|----------------|-----------------------------------------------------------|
| macOS / Linux  | `bash`, `curl`, `jq`                                      |
| Windows        | PowerShell 5.1+ or PowerShell 7+ (`pwsh`)                 |

The dashboard host must be running `bun dashboard/serve.ts` and reachable from the remote host on the configured port (default 3400).

---

## Setup

### 1. Copy the ingest token from the dashboard host

The ingest token was generated when you ran `hooks/install.sh` on the dashboard host. Copy it to the remote machine:

**From the dashboard host:**
```bash
cat ~/.config/party-line/ingest-token
# Copy the output — you'll paste it on the remote host
```

**On the remote host (macOS/Linux):**
```bash
mkdir -p ~/.config/party-line
# Paste the token value from the dashboard host:
echo -n "PASTE-TOKEN-HERE" > ~/.config/party-line/ingest-token
chmod 0600 ~/.config/party-line/ingest-token
```

**On the remote host (Windows PowerShell):**
```powershell
$dir = Join-Path $env:USERPROFILE ".config\party-line"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
"PASTE-TOKEN-HERE" | Out-File (Join-Path $dir "ingest-token") -Encoding utf8 -NoNewline
```

> Do **not** copy the dashboard host's `machine-id` — each remote host must generate its own (see next step).

### 2. Generate a unique machine-id on the remote host

Each machine must have its own UUID so events can be attributed correctly in the dashboard.

**macOS/Linux:**
```bash
uuidgen | tr '[:upper:]' '[:lower:]' > ~/.config/party-line/machine-id
chmod 0600 ~/.config/party-line/machine-id
```

**Windows PowerShell:**
```powershell
$dir = Join-Path $env:USERPROFILE ".config\party-line"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
[guid]::NewGuid().Guid | Out-File (Join-Path $dir "machine-id") -Encoding utf8 -NoNewline
```

### 3. Set the `PARTY_LINE_INGEST` environment variable

Point the emitter at the dashboard host. The URL format is `http://<host>:<port>/ingest`.

**Examples:**
```
http://192.168.68.77:3400/ingest
https://dashboard.mybox.local/ingest
```

**macOS/Linux — add to `~/.zshrc` or `~/.bash_profile`:**
```bash
export PARTY_LINE_INGEST="http://192.168.68.77:3400/ingest"
```

**Windows — set as a user environment variable (PowerShell):**
```powershell
[Environment]::SetEnvironmentVariable("PARTY_LINE_INGEST", "http://192.168.68.77:3400/ingest", "User")
```

### 4. Set `CLAUDE_SESSION_NAME` per session

On remote hosts there is no `/proc` walk, so the session name must be set explicitly. Add it alongside `PARTY_LINE_INGEST`, or set it per session before launching Claude Code:

```bash
export CLAUDE_SESSION_NAME="macbook"
claude --name macbook
```

Or in your shell config to give all sessions on this machine a default name:
```bash
export CLAUDE_SESSION_NAME="macbook"
```

### 5. Copy the emitter script to the remote host

Place the script in a stable location that won't move. `~/.config/party-line/` works well.

**macOS/Linux:**
```bash
mkdir -p ~/.config/party-line
cp /path/to/party-line/hooks/remote/emit.sh ~/.config/party-line/emit.sh
chmod +x ~/.config/party-line/emit.sh
```

**Windows** — copy `emit.ps1` to a permanent path, e.g.:
```
C:\Users\you\.config\party-line\emit.ps1
```

### 6. Register hooks in Claude Code `settings.json`

Open your Claude Code settings file (`~/.claude/settings.json` on macOS/Linux, `%APPDATA%\Claude\settings.json` on Windows) and add hook entries for each event you want to capture.

**macOS/Linux — add to `hooks` section:**
```json
{
  "hooks": {
    "SessionStart":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.config/party-line/emit.sh SessionStart" }] }],
    "SessionEnd":          [{ "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.config/party-line/emit.sh SessionEnd" }] }],
    "UserPromptSubmit":    [{ "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.config/party-line/emit.sh UserPromptSubmit" }] }],
    "Stop":                [{ "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.config/party-line/emit.sh Stop" }] }],
    "PreCompact":          [{ "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.config/party-line/emit.sh PreCompact" }] }],
    "Notification":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.config/party-line/emit.sh Notification" }] }],
    "SubagentStart":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.config/party-line/emit.sh SubagentStart" }] }],
    "SubagentStop":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.config/party-line/emit.sh SubagentStop" }] }],
    "TaskCreated":         [{ "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.config/party-line/emit.sh TaskCreated" }] }],
    "TaskCompleted":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.config/party-line/emit.sh TaskCompleted" }] }],
    "PostToolUse":         [{ "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.config/party-line/emit.sh PostToolUse" }] }]
  }
}
```

**Windows — add to `hooks` section:**
```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:\\Users\\you\\.config\\party-line\\emit.ps1 SessionStart" }] }],
    "SessionEnd":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:\\Users\\you\\.config\\party-line\\emit.ps1 SessionEnd" }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:\\Users\\you\\.config\\party-line\\emit.ps1 UserPromptSubmit" }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:\\Users\\you\\.config\\party-line\\emit.ps1 Stop" }] }],
    "PreCompact":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:\\Users\\you\\.config\\party-line\\emit.ps1 PreCompact" }] }],
    "Notification":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:\\Users\\you\\.config\\party-line\\emit.ps1 Notification" }] }],
    "SubagentStart":    [{ "matcher": "", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:\\Users\\you\\.config\\party-line\\emit.ps1 SubagentStart" }] }],
    "SubagentStop":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:\\Users\\you\\.config\\party-line\\emit.ps1 SubagentStop" }] }],
    "TaskCreated":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:\\Users\\you\\.config\\party-line\\emit.ps1 TaskCreated" }] }],
    "TaskCompleted":    [{ "matcher": "", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:\\Users\\you\\.config\\party-line\\emit.ps1 TaskCompleted" }] }],
    "PostToolUse":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:\\Users\\you\\.config\\party-line\\emit.ps1 PostToolUse" }] }]
  }
}
```

---

## Troubleshooting

### Token mismatch (HTTP 401)
The token in `~/.config/party-line/ingest-token` on the remote host does not match the one on the dashboard host. Re-copy the token from `~/.config/party-line/ingest-token` on the dashboard host and replace the file on the remote.

To manually verify the token works:
```bash
TOKEN=$(cat ~/.config/party-line/ingest-token | tr -d '[:space:]')
curl -v -X POST "$PARTY_LINE_INGEST" \
  -H "Content-Type: application/json" \
  -H "X-Party-Line-Token: $TOKEN" \
  -d '{"session_id":"test","hook_event":"Stop"}'
```

### Endpoint unreachable
The script exits 0 silently when the POST fails (so it never blocks Claude Code). To debug manually:
```bash
curl -v --max-time 5 "$PARTY_LINE_INGEST" \
  -H "X-Party-Line-Token: $(cat ~/.config/party-line/ingest-token | tr -d '[:space:]')" \
  -H "Content-Type: application/json" \
  -d '{"test":true}'
```

Common causes:
- Dashboard is not running on the host (`bun dashboard/serve.ts`)
- Firewall blocking port 3400 — open it on the dashboard host
- Wrong IP or hostname in `PARTY_LINE_INGEST`
- VPN or subnet isolation between remote and dashboard host

### `jq` or `curl` not found (macOS/Linux)
```bash
# macOS (Homebrew)
brew install jq curl

# Ubuntu/Debian
sudo apt-get install -y jq curl
```

### PowerShell version too old (Windows)
`ConvertFrom-Json -AsHashtable` requires PowerShell 6+. Install PowerShell 7 from https://github.com/PowerShell/PowerShell/releases or use `winget install Microsoft.PowerShell`.

### Timezone / timestamp issues
All timestamps are emitted in UTC. The dashboard displays them in your browser's local timezone. If timestamps look wrong, verify the system clock on the remote host is accurate (`date -u`).

### Session name shows as "unnamed"
`CLAUDE_SESSION_NAME` or `PARTY_LINE_NAME` is not set in the environment where Claude Code runs. Set it in your shell config (`.zshrc`, `.bash_profile`, or Windows user environment variables) so it is inherited by all child processes.
