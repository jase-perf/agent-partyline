/**
 * introspect.ts — Read session JSONL to extract live status.
 *
 * Reads the tail of the active session's conversation JSONL file
 * to determine what the session is currently doing (idle, working,
 * waiting for input) and extract useful metadata like last message
 * text, current tool, git branch, etc.
 */

import { readFileSync, readdirSync, openSync, readSync, closeSync, fstatSync } from 'fs'
import { join, resolve } from 'path'

/** Structured status extracted from a session's JSONL. */
export interface SessionStatus {
  state: 'idle' | 'working' | 'unknown'
  lastActivity: string // ISO timestamp of last entry
  lastText: string // last assistant text (truncated)
  currentTool: string | null // tool currently being executed, if any
  gitBranch: string | null
  cwd: string | null
  model: string | null // model from JSONL (e.g. "claude-opus-4-6")
  uptimeMs: number
  turnDurationMs: number | null // last turn duration
  messageCount: number | null // messages in context (from turn_duration)
  contextTokens: number | null // cache_read + cache_creation + input tokens
  outputTokens: number | null // output tokens from last response
}

interface UsageData {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
  service_tier?: string
  speed?: string
}

interface JournalEntry {
  type?: string
  subtype?: string
  timestamp?: string
  durationMs?: number
  messageCount?: number
  gitBranch?: string
  cwd?: string
  sourceToolAssistantUUID?: string
  toolUseResult?: unknown
  message?: {
    role?: string
    model?: string
    content?: string | ContentBlock[]
    usage?: UsageData
  }
}

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
}

const CLAUDE_DIR = resolve(process.env.HOME ?? '/home/claude', '.claude')
const startTime = Date.now()

/**
 * Find the session ID for this MCP server's parent Claude Code process.
 * Reads ~/.claude/sessions/<pid>.json for the parent PID chain.
 */
function findSessionId(): string | null {
  const sessionsDir = join(CLAUDE_DIR, 'sessions')
  try {
    const files = readdirSync(sessionsDir)
    // Walk up the process tree to find a matching session file
    let pid = process.ppid
    for (let i = 0; i < 5; i++) {
      const filename = `${pid}.json`
      if (files.includes(filename)) {
        const data = JSON.parse(readFileSync(join(sessionsDir, filename), 'utf-8')) as {
          sessionId?: string
        }
        if (data.sessionId) return data.sessionId
      }
      // Walk up via /proc
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
        const ppid = parseInt(stat.split(' ')[3]!, 10)
        if (ppid <= 1) break
        pid = ppid
      } catch {
        break
      }
    }
  } catch {
    // sessions dir doesn't exist or isn't readable
  }
  return null
}

/**
 * Find the JSONL file path for a given session ID.
 * Claude stores conversations at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 */
function findJsonlPath(sessionId: string): string | null {
  const projectsDir = join(CLAUDE_DIR, 'projects')
  try {
    const projectDirs = readdirSync(projectsDir)
    for (const dir of projectDirs) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
      try {
        // Quick existence check via open
        const fd = openSync(candidate, 'r')
        closeSync(fd)
        return candidate
      } catch {
        continue
      }
    }
  } catch {
    // projects dir doesn't exist
  }
  return null
}

/**
 * Read the last N bytes of a file and extract complete JSON lines.
 * Returns parsed entries in chronological order.
 */
function readTail(filePath: string, bytes: number = 16384): JournalEntry[] {
  try {
    const fd = openSync(filePath, 'r')
    try {
      const { size } = fstatSync(fd)
      const start = Math.max(0, size - bytes)
      const buf = Buffer.alloc(Math.min(bytes, size))
      readSync(fd, buf, 0, buf.length, start)
      const text = buf.toString('utf-8')

      // Split into lines, skip the first (likely partial)
      const lines = text.split('\n').filter(Boolean)
      if (start > 0 && lines.length > 0) {
        lines.shift() // first line is probably truncated
      }

      const entries: JournalEntry[] = []
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as JournalEntry)
        } catch {
          // Skip malformed lines (partial write)
        }
      }
      return entries
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
}

/**
 * Extract the last assistant text from a content array or string.
 */
function extractText(content: string | ContentBlock[] | undefined, maxLen: number = 2000): string {
  if (!content) return ''
  if (typeof content === 'string') return content.slice(0, maxLen)
  // Walk backwards through content blocks to find the last text
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i]!
    if (block.type === 'text' && block.text) {
      return block.text.slice(0, maxLen)
    }
  }
  return ''
}

/**
 * Extract the tool name from a content array if the last block is tool_use.
 */
function extractTool(content: string | ContentBlock[] | undefined): string | null {
  if (!content || typeof content === 'string') return null
  const last = content[content.length - 1]
  if (last?.type === 'tool_use' && last.name) return last.name
  return null
}

// Cached state
let cachedSessionId: string | null = null
let cachedJsonlPath: string | null = null
let lookupAttempted = false

/**
 * Get the current session status by reading the JSONL tail.
 * Caches the session ID and file path after first lookup.
 */
export function getSessionStatus(): SessionStatus | null {
  // Resolve session ID once
  if (!lookupAttempted) {
    lookupAttempted = true
    cachedSessionId = findSessionId()
    if (cachedSessionId) {
      cachedJsonlPath = findJsonlPath(cachedSessionId)
    }
  }

  if (!cachedJsonlPath) return null

  const entries = readTail(cachedJsonlPath)
  if (entries.length === 0) return null

  // Find the last few meaningful entries
  let lastAssistantText = ''
  let currentTool: string | null = null
  let gitBranch: string | null = null
  let cwd: string | null = null
  let model: string | null = null
  let lastActivity = ''
  let turnDurationMs: number | null = null
  let messageCount: number | null = null
  let contextTokens: number | null = null
  let outputTokens: number | null = null
  let state: 'idle' | 'working' | 'unknown' = 'unknown'

  // Walk backwards through entries to build status
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!

    // Grab branch/cwd from any entry that has it
    if (!gitBranch && entry.gitBranch) gitBranch = entry.gitBranch
    if (!cwd && entry.cwd) cwd = entry.cwd

    // Last activity timestamp
    if (!lastActivity && entry.timestamp) lastActivity = entry.timestamp

    // Turn duration + message count from system entries
    if (entry.type === 'system' && entry.subtype === 'turn_duration' && turnDurationMs === null) {
      turnDurationMs = entry.durationMs ?? null
      messageCount = entry.messageCount ?? null
    }

    // Usage data from the most recent assistant message that has it
    if (contextTokens === null && entry.type === 'assistant' && entry.message?.usage) {
      const u = entry.message.usage
      const input = u.input_tokens ?? 0
      const cacheRead = u.cache_read_input_tokens ?? 0
      const cacheCreate = u.cache_creation_input_tokens ?? 0
      contextTokens = input + cacheRead + cacheCreate
      outputTokens = u.output_tokens ?? null
    }
  }

  // Determine state by walking backwards past metadata entries to find
  // the last "meaningful" entry. The key insight: a session is only
  // actively "working" if it's mid-tool-execution (assistant sent tool_use
  // and we're waiting for the result, or tool result returned and Claude
  // is generating the next response). An assistant message with text/thinking
  // content (no tool_use) means the turn is complete — the session is idle.
  // turn_duration entries are not always written (especially for short turns),
  // so we can't rely on them for idle detection.
  const metadataTypes = new Set([
    'custom-title', 'permission-mode', 'file-history-snapshot',
  ])
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (metadataTypes.has(entry.type ?? '')) continue
    if (entry.type === 'system' && entry.subtype === 'turn_duration') {
      state = 'idle'
    } else if (entry.type === 'assistant') {
      // Check if the last content block is tool_use — that means
      // the session is actively waiting for a tool result
      const content = entry.message?.content
      const lastBlock = Array.isArray(content) ? content[content.length - 1] : null
      if (lastBlock && typeof lastBlock === 'object' && 'type' in lastBlock && lastBlock.type === 'tool_use') {
        state = 'working'
      } else {
        // Text or thinking content — turn is complete, session is idle
        state = 'idle'
      }
    } else if (entry.type === 'user' && entry.toolUseResult !== undefined) {
      // Tool result returned — Claude is generating next response
      state = 'working'
    } else if (entry.type === 'user') {
      // Human message — either waiting for API response (working)
      // or the session hasn't started processing yet. Check if this
      // is recent (within last 60s) to distinguish.
      const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
      state = (Date.now() - ts < 60_000) ? 'working' : 'idle'
    } else {
      state = 'idle'
    }
    break
  }

  // Walk backwards to find last assistant text and current tool
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type !== 'assistant') continue
    const msg = entry.message
    if (!msg?.content) continue

    if (!model && msg.model) model = msg.model

    // Check if this assistant message has a tool_use (means it's actively running a tool)
    const tool = extractTool(msg.content)
    if (tool && !currentTool && state === 'working') {
      currentTool = tool
    }

    // Get last text
    const text = extractText(msg.content)
    if (text && !lastAssistantText) {
      lastAssistantText = text
    }

    if (lastAssistantText && (currentTool || state !== 'working')) break
  }

  return {
    state,
    lastActivity,
    lastText: lastAssistantText,
    currentTool,
    gitBranch,
    cwd,
    model,
    uptimeMs: Date.now() - startTime,
    turnDurationMs,
    messageCount,
    contextTokens,
    outputTokens,
  }
}
