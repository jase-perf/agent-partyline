export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'PreCompact',
  'PostCompact',
  'Notification',
  'TeammateIdle',
] as const

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]

const HOOK_EVENT_NAME_SET: ReadonlySet<string> = new Set(HOOK_EVENT_NAMES)

export interface HookEvent {
  machine_id: string
  session_name: string
  session_id: string
  hook_event: HookEventName
  ts: string
  payload: Record<string, unknown>
  agent_id?: string
  agent_type?: string
  source?: string  // "claude-code" | "gemini-cli" | future other — optional, default "claude-code"
}

const STRING_FIELDS = ['machine_id', 'session_name', 'session_id', 'hook_event', 'ts'] as const
const REQUIRED = [...STRING_FIELDS, 'payload'] as const

export function validateHookEvent(raw: unknown): HookEvent {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('HookEvent must be an object')
  }
  const obj = raw as Record<string, unknown>
  for (const key of REQUIRED) {
    if (!(key in obj)) throw new Error(`HookEvent missing required field: ${key}`)
  }
  for (const key of STRING_FIELDS) {
    if (typeof obj[key] !== 'string') throw new Error(`HookEvent field ${key} must be string`)
  }
  if (typeof obj.payload !== 'object' || obj.payload === null || Array.isArray(obj.payload)) {
    throw new Error('HookEvent payload must be an object')
  }
  if (!HOOK_EVENT_NAME_SET.has(obj.hook_event as string)) {
    throw new Error(`HookEvent hook_event unknown: ${String(obj.hook_event)}`)
  }
  for (const key of ['agent_id', 'agent_type'] as const) {
    if (key in obj && typeof obj[key] !== 'string') {
      throw new Error(`HookEvent field ${key} must be string when present`)
    }
  }
  if ('source' in obj && typeof obj.source !== 'string') {
    throw new Error('HookEvent field source must be string when present')
  }
  return obj as unknown as HookEvent
}
