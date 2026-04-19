#!/usr/bin/env bash
# hooks/gemini/emit.sh — party-line hook emitter for Gemini CLI
#
# Reads Gemini CLI hook stdin JSON, maps event names to our HookEventName union,
# wraps with session/machine/hook-event/ts, POSTs to the dashboard's /ingest
# endpoint. Hard 1s timeout so we never block the hook pipeline.
#
# Usage (from ~/.gemini/settings.json):
#   "command": "$HOME/.config/party-line/gemini-emit.sh <GEMINI_HOOK_EVENT>"
#
# Differences from the Claude Code emit.sh:
#   - Uses GEMINI_SESSION_ID env var for session ID (no /proc walk fallback)
#   - Maps Gemini event names to our canonical HookEventName values
#   - Tags payload with source: "gemini-cli" for downstream disambiguation

set -uo pipefail

HOOK_EVENT="${1:-UNKNOWN}"
ENDPOINT="${PARTY_LINE_INGEST:-http://localhost:3400/ingest}"
TOKEN_FILE="${HOME}/.config/party-line/ingest-token"
MACHINE_ID_FILE="${HOME}/.config/party-line/machine-id"

[[ -f "$TOKEN_FILE" ]] || exit 0
[[ -f "$MACHINE_ID_FILE" ]] || exit 0
TOKEN=$(<"$TOKEN_FILE")
MACHINE_ID=$(<"$MACHINE_ID_FILE")

PAYLOAD=$(cat)

# Map Gemini event names to our canonical HookEventName union.
# Unknown names pass through verbatim — ingest will 400 but emit exits 0.
case "$HOOK_EVENT" in
  BeforeAgent) MAPPED="UserPromptSubmit" ;;
  AfterAgent)  MAPPED="Stop" ;;
  BeforeTool)  MAPPED="PreToolUse" ;;
  AfterTool)   MAPPED="PostToolUse" ;;
  PreCompress) MAPPED="PreCompact" ;;
  *)           MAPPED="$HOOK_EVENT" ;;
esac

# Session name: prefer CLAUDE_SESSION_NAME (set by ccpl / user), then PARTY_LINE_NAME.
# No /proc walk — Gemini doesn't surface --name through the process tree the same way.
SESSION_NAME="${CLAUDE_SESSION_NAME:-${PARTY_LINE_NAME:-}}"
SESSION_NAME="${SESSION_NAME:-unnamed}"

# Gemini provides session_id as GEMINI_SESSION_ID env var; also in stdin JSON.
_SID_FROM_PAYLOAD=$(echo "$PAYLOAD" | jq -r '.session_id // ""')
SESSION_ID="${GEMINI_SESSION_ID:-$_SID_FROM_PAYLOAD}"

ENVELOPE=$(jq -n \
  --arg m "$MACHINE_ID" \
  --arg sn "$SESSION_NAME" \
  --arg sid "$SESSION_ID" \
  --arg he "$MAPPED" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
  --arg src "gemini-cli" \
  --argjson p "$PAYLOAD" \
  '{
    machine_id: $m,
    session_name: $sn,
    session_id: $sid,
    hook_event: $he,
    ts: $ts,
    payload: ($p + {source: $src})
  }')

curl --silent --show-error --max-time 1 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Party-Line-Token: $TOKEN" \
  --data-binary "$ENVELOPE" \
  "$ENDPOINT" > /dev/null 2>&1 &

exit 0
