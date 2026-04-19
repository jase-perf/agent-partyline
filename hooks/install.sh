#!/usr/bin/env bash
# hooks/install.sh — install party-line hooks into ~/.claude/settings.json
# Idempotent. Preserves existing hooks.

set -euo pipefail

CONFIG_DIR="$HOME/.config/party-line"
EMIT_SRC="$(cd "$(dirname "$0")" && pwd)/emit.sh"
EMIT_DST="$CONFIG_DIR/emit.sh"
SETTINGS="$HOME/.claude/settings.json"

mkdir -p "$CONFIG_DIR"
cp "$EMIT_SRC" "$EMIT_DST"
chmod +x "$EMIT_DST"

[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"

HOOKS=$(cat <<EOF
{
  "SessionStart":      [{"hooks": [{"type": "command", "command": "$EMIT_DST SessionStart"}]}],
  "SessionEnd":        [{"hooks": [{"type": "command", "command": "$EMIT_DST SessionEnd"}]}],
  "UserPromptSubmit":  [{"hooks": [{"type": "command", "command": "$EMIT_DST UserPromptSubmit"}]}],
  "Stop":              [{"hooks": [{"type": "command", "command": "$EMIT_DST Stop"}]}],
  "PreCompact":        [{"hooks": [{"type": "command", "command": "$EMIT_DST PreCompact"}]}],
  "Notification":      [{"hooks": [{"type": "command", "command": "$EMIT_DST Notification"}]}],
  "SubagentStart":     [{"hooks": [{"type": "command", "command": "$EMIT_DST SubagentStart"}]}],
  "SubagentStop":      [{"hooks": [{"type": "command", "command": "$EMIT_DST SubagentStop"}]}],
  "TaskCreated":       [{"hooks": [{"type": "command", "command": "$EMIT_DST TaskCreated"}]}],
  "TaskCompleted":     [{"hooks": [{"type": "command", "command": "$EMIT_DST TaskCompleted"}]}],
  "PostToolUse":       [{"matcher": "", "hooks": [{"type": "command", "command": "$EMIT_DST PostToolUse"}]}]
}
EOF
)

jq --argjson new "$HOOKS" '
  .hooks //= {} |
  reduce ($new | to_entries[]) as $e (.;
    .hooks[$e.key] //= [] |
    if (.hooks[$e.key] | any(.. | .command? // "" | contains("party-line/emit.sh"))) then
      .
    else
      .hooks[$e.key] += $e.value
    end
  )
' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

echo "Installed party-line hooks -> $EMIT_DST"
echo "Settings: $SETTINGS"
