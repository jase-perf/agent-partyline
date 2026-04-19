# hooks/remote/emit.ps1 — party-line hook emitter for Windows.
#
# Usage (from Claude Code's Windows settings.json hooks config):
#   "command": "pwsh -NoProfile -File C:\\path\\to\\emit.ps1 PostToolUse"

param(
  [Parameter(Position=0)][string]$HookEvent = "UNKNOWN"
)

$ErrorActionPreference = 'SilentlyContinue'

$Endpoint = $env:PARTY_LINE_INGEST
if (-not $Endpoint) { exit 0 }

$ConfigDir = Join-Path $env:USERPROFILE ".config\party-line"
$TokenFile = Join-Path $ConfigDir "ingest-token"
$MachineIdFile = Join-Path $ConfigDir "machine-id"

if (-not (Test-Path $TokenFile)) { exit 0 }
if (-not (Test-Path $MachineIdFile)) { exit 0 }

$Token = (Get-Content $TokenFile -Raw).Trim()
$MachineId = (Get-Content $MachineIdFile -Raw).Trim()

$Payload = [Console]::In.ReadToEnd()
$PayloadObj = $null
try { $PayloadObj = $Payload | ConvertFrom-Json -AsHashtable } catch { $PayloadObj = @{} }

$SessionName = if ($env:CLAUDE_SESSION_NAME) { $env:CLAUDE_SESSION_NAME }
               elseif ($env:PARTY_LINE_NAME) { $env:PARTY_LINE_NAME }
               else { 'unnamed' }

$SessionId = if ($PayloadObj.ContainsKey('session_id')) { [string]$PayloadObj['session_id'] } else { '' }
$AgentId   = if ($PayloadObj.ContainsKey('agent_id'))   { [string]$PayloadObj['agent_id']   } else { '' }
$AgentType = if ($PayloadObj.ContainsKey('agent_type')) { [string]$PayloadObj['agent_type'] } else { '' }

$Ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

$Envelope = @{
  machine_id   = $MachineId
  session_name = $SessionName
  session_id   = $SessionId
  hook_event   = $HookEvent
  ts           = $Ts
  payload      = $PayloadObj
}
if ($AgentId)   { $Envelope.agent_id   = $AgentId }
if ($AgentType) { $Envelope.agent_type = $AgentType }

$Json = $Envelope | ConvertTo-Json -Compress -Depth 20

# Fire-and-forget with 2s timeout. Start-Job backgrounds the POST so we never block the hook.
$null = Start-Job -ScriptBlock {
  param($url, $token, $body)
  try {
    Invoke-RestMethod -Uri $url -Method POST `
      -Headers @{ 'X-Party-Line-Token' = $token; 'Content-Type' = 'application/json' } `
      -Body $body -TimeoutSec 2 | Out-Null
  } catch {}
} -ArgumentList $Endpoint, $Token, $Json

exit 0
