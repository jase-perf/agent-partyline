#!/usr/bin/env bash
# hooks/remote/emit.sh — party-line hook emitter for remote hosts (macOS, other Linux).
#
# Differs from hooks/emit.sh:
#   - Targets a remote dashboard endpoint via PARTY_LINE_INGEST env var (required)
#   - Does not walk /proc — session name must come from CLAUDE_SESSION_NAME or PARTY_LINE_NAME
#   - Token file copied manually from the dashboard host (see hooks/remote/README.md)

set -uo pipefail

HOOK_EVENT="${1:-UNKNOWN}"
ENDPOINT="${PARTY_LINE_INGEST:-}"
TOKEN_FILE="${HOME}/.config/party-line/ingest-token"
MACHINE_ID_FILE="${HOME}/.config/party-line/machine-id"

[[ -n "$ENDPOINT" ]] || exit 0
[[ -f "$TOKEN_FILE" ]] || exit 0
[[ -f "$MACHINE_ID_FILE" ]] || exit 0
TOKEN=$(cat "$TOKEN_FILE" | tr -d '[:space:]')
MACHINE_ID=$(cat "$MACHINE_ID_FILE" | tr -d '[:space:]')

PAYLOAD=$(cat)

SESSION_NAME="${CLAUDE_SESSION_NAME:-${PARTY_LINE_NAME:-unnamed}}"
SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id // ""')
AGENT_ID=$(echo "$PAYLOAD" | jq -r '.agent_id // ""')
AGENT_TYPE=$(echo "$PAYLOAD" | jq -r '.agent_type // ""')

# Portable UTC timestamp with milliseconds. GNU date supports %N; BSD date does not,
# so emit to-the-second precision when %N is unavailable.
if date -u +%3N >/dev/null 2>&1; then
  TS=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
else
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fi

ENVELOPE=$(jq -n \
  --arg m "$MACHINE_ID" \
  --arg sn "$SESSION_NAME" \
  --arg sid "$SESSION_ID" \
  --arg he "$HOOK_EVENT" \
  --arg ts "$TS" \
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

curl --silent --show-error --max-time 2 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Party-Line-Token: $TOKEN" \
  --data-binary "$ENVELOPE" \
  "$ENDPOINT" > /dev/null 2>&1 &

exit 0
