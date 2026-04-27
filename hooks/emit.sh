#!/usr/bin/env bash
# hooks/emit.sh — party-line hook emitter
#
# Reads Claude Code hook stdin JSON, wraps with session/machine/hook-event/ts,
# POSTs to the dashboard's /ingest endpoint. Hard 1s timeout so we never
# block the hook pipeline.
#
# Usage (from ~/.claude/settings.json):
#   "command": "$HOME/.config/party-line/emit.sh <HOOK_EVENT>"

set -uo pipefail

HOOK_EVENT="${1:-UNKNOWN}"
ENDPOINT="${PARTY_LINE_INGEST:-https://localhost:3400/ingest}"
# Localhost dashboards typically use a self-signed cert; accept it.
CURL_TLS_OPTS=()
if [[ "$ENDPOINT" == https://localhost* || "$ENDPOINT" == https://127.0.0.1* ]]; then
  CURL_TLS_OPTS+=(-k)
fi
TOKEN_FILE="${HOME}/.config/party-line/ingest-token"
MACHINE_ID_FILE="${HOME}/.config/party-line/machine-id"

[[ -f "$TOKEN_FILE" ]] || exit 0
[[ -f "$MACHINE_ID_FILE" ]] || exit 0
TOKEN=$(<"$TOKEN_FILE")
MACHINE_ID=$(<"$MACHINE_ID_FILE")

PAYLOAD=$(cat)

SESSION_NAME="${CLAUDE_SESSION_NAME:-${PARTY_LINE_NAME:-}}"
if [[ -z "$SESSION_NAME" ]]; then
  PID=$PPID
  for _ in 1 2 3 4 5; do
    if [[ -r "/proc/$PID/cmdline" ]]; then
      CMDLINE=$(tr '\0' ' ' < "/proc/$PID/cmdline")
      if [[ "$CMDLINE" == *claude* && "$CMDLINE" == *--name* ]]; then
        SESSION_NAME=$(echo "$CMDLINE" | sed -n 's/.*--name \([^ ]*\).*/\1/p')
        break
      fi
      PID=$(awk '{print $4}' < "/proc/$PID/stat")
      [[ "$PID" -le 1 ]] && break
    fi
  done
fi
SESSION_NAME="${SESSION_NAME:-unnamed}"

IFS=$'\t' read -r SESSION_ID AGENT_ID AGENT_TYPE < <(
  printf '%s' "$PAYLOAD" | jq -r '[.session_id // "", .agent_id // "", .agent_type // ""] | @tsv'
)

ENVELOPE=$(jq -n \
  --arg m "$MACHINE_ID" \
  --arg sn "$SESSION_NAME" \
  --arg sid "$SESSION_ID" \
  --arg he "$HOOK_EVENT" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
  --arg aid "$AGENT_ID" \
  --arg at "$AGENT_TYPE" \
  --argjson p "$PAYLOAD" \
  '{
    machine_id: $m,
    session_name: $sn,
    session_id: $sid,
    hook_event: $he,
    ts: $ts,
    payload: $p
  } + (if $aid != "" then {agent_id: $aid} else {} end)
    + (if $at != "" then {agent_type: $at} else {} end)')

curl --silent --show-error --max-time 1 "${CURL_TLS_OPTS[@]}" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Party-Line-Token: $TOKEN" \
  --data-binary "$ENVELOPE" \
  "$ENDPOINT" > /dev/null 2>&1 &

exit 0
