#!/usr/bin/env bash
# hooks/gemini/uninstall.sh — remove party-line hook entries from ~/.gemini/settings.json
set -euo pipefail

SETTINGS="$HOME/.gemini/settings.json"
[[ -f "$SETTINGS" ]] || { echo "No settings file to modify."; exit 0; }

jq '
  .hooks //= {} |
  .hooks |= with_entries(
    .value |= map(
      .hooks |= map(select((.command // "") | contains("party-line/gemini-emit.sh") | not))
    ) |
    .value |= map(select(.hooks | length > 0))
  ) |
  .hooks |= with_entries(select(.value | length > 0))
' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

echo "Removed party-line hook entries from $SETTINGS."
