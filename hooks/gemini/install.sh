#!/usr/bin/env bash
# hooks/gemini/install.sh — install party-line hooks into ~/.gemini/settings.json
# Idempotent. Preserves existing hooks.

set -euo pipefail

CONFIG_DIR="$HOME/.config/party-line"
EMIT_SRC="$(cd "$(dirname "$0")" && pwd)/emit.sh"
EMIT_DST="$CONFIG_DIR/gemini-emit.sh"
SETTINGS="$HOME/.gemini/settings.json"

mkdir -p "$CONFIG_DIR"
mkdir -p "$HOME/.gemini"
cp "$EMIT_SRC" "$EMIT_DST"
chmod +x "$EMIT_DST"

[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"

HOOKS=$(cat <<EOF
{
  "SessionStart":  [{"hooks": [{"type": "command", "command": "$EMIT_DST SessionStart"}]}],
  "SessionEnd":    [{"hooks": [{"type": "command", "command": "$EMIT_DST SessionEnd"}]}],
  "BeforeAgent":   [{"hooks": [{"type": "command", "command": "$EMIT_DST BeforeAgent"}]}],
  "AfterAgent":    [{"hooks": [{"type": "command", "command": "$EMIT_DST AfterAgent"}]}],
  "BeforeTool":    [{"hooks": [{"type": "command", "command": "$EMIT_DST BeforeTool"}]}],
  "AfterTool":     [{"hooks": [{"type": "command", "command": "$EMIT_DST AfterTool"}]}],
  "PreCompress":   [{"hooks": [{"type": "command", "command": "$EMIT_DST PreCompress"}]}],
  "Notification":  [{"hooks": [{"type": "command", "command": "$EMIT_DST Notification"}]}]
}
EOF
)

jq --argjson new "$HOOKS" '
  .hooks //= {} |
  reduce ($new | to_entries[]) as $e (.;
    .hooks[$e.key] //= [] |
    if (.hooks[$e.key] | any(.. | .command? // "" | contains("party-line/gemini-emit.sh"))) then
      .
    else
      .hooks[$e.key] += $e.value
    end
  )
' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

echo "Installed party-line Gemini hooks -> $EMIT_DST"
echo "Settings: $SETTINGS"
