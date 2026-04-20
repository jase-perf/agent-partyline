/**
 * transcript.ts — Build a structured transcript from Claude Code JSONL session files.
 *
 * Reads ~/.claude/projects/<cwd-slug>/<session-id>.jsonl (or subagent variant),
 * merges tool_use + tool_result pairs, and emits typed TranscriptEntry records.
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  uuid: string
  ts: string
  type:
    | 'user'
    | 'assistant-text'
    | 'tool-use'
    | 'subagent-spawn'
    | 'party-line-send'
    | 'party-line-receive'
  text?: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  agent_id?: string
  agent_type?: string
  description?: string
  envelope_id?: string
  other_session?: string
  body?: string
  callback_id?: string
  envelope_type?: 'message' | 'request' | 'response'
}

export interface PartyLineEnvelope {
  id: string
  from: string
  to: string
  type: 'message' | 'request' | 'response' | string
  body: string
  ts: string
  callback_id?: string | null
  response_to?: string | null
}

export interface BuildTranscriptOptions {
  projectsRoot: string
  sessionId: string
  agentId?: string
  limit: number
  sessionName?: string
  envelopes?: PartyLineEnvelope[]
}

/**
 * Filter a transcript to only entries that come *after* the entry with the given uuid.
 *
 * Uses positional index — the uuid is looked up in the entries array; everything
 * after that index is returned. If uuid is not found (e.g., stale after compaction
 * rewrote the file), the entire list is returned as a graceful fallback so the
 * client gets a full re-fetch rather than an empty screen.
 *
 * Party-line envelope entries (keyed by envelope_id stored in uuid) are included
 * in the same positional slice because buildTranscript interleaves them by ts
 * before returning.
 */
export function filterAfterUuid(entries: TranscriptEntry[], afterUuid: string): TranscriptEntry[] {
  const idx = entries.findIndex((e) => e.uuid === afterUuid)
  if (idx === -1) {
    // Unknown uuid — graceful fallback: return full list
    return entries
  }
  return entries.slice(idx + 1)
}

// ---------------------------------------------------------------------------
// Internal types for JSONL records
// ---------------------------------------------------------------------------

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown }

interface JsonlRecord {
  role?: 'user' | 'assistant'
  content?: string | ContentBlock[]
  /**
   * True when Claude Code injected this record synthetically — plugin skill
   * descriptions, local-command-caveat blocks, post-tool system reminders,
   * etc. These MUST NOT render as user-typed messages in the transcript UI.
   *
   * Carried up from the top-level JSONL line (`{type, message, isMeta}`)
   * into our flattened record so recordToEntries can drop them.
   */
  isMeta?: boolean
  /**
   * Stable identifier from the JSONL line (`line.uuid`). Hoisted here so that
   * recordToEntries can emit deterministic TranscriptEntry uuids — required
   * for the dashboard's incremental after_uuid fetch + renderedEntryKeys
   * dedup to function across repeated buildTranscript calls.
   */
  lineUuid?: string
  /** Stable timestamp from the JSONL line (`line.timestamp`). */
  lineTs?: string
}

/** Raw line from Claude Code JSONL — may wrap the message in a `message` field. */
interface RawJsonlLine {
  type?: string
  role?: 'user' | 'assistant'
  content?: string | ContentBlock[]
  message?: JsonlRecord
  /** Top-level synthetic marker — see JsonlRecord.isMeta. */
  isMeta?: boolean
  /** Stable per-line identifier written by Claude Code. */
  uuid?: string
  /** ISO timestamp written by Claude Code for this JSONL line. */
  timestamp?: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * True when a string is a bare <system-reminder>…</system-reminder> wrapper
 * with no surrounding user prose. Used to reject synthetic injections that
 * lack the top-level isMeta marker (defensive fallback).
 */
function isSystemReminderString(text: string): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  return trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>')
}

/**
 * For each subdir of projectsRoot, check if <slug>/<sessionId>.jsonl exists.
 * Returns the slug or null.
 */
function findCwdSlug(projectsRoot: string, sessionId: string): string | null {
  let slugs: string[]
  try {
    slugs = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return null
  }

  for (const slug of slugs) {
    try {
      readFileSync(join(projectsRoot, slug, `${sessionId}.jsonl`))
      return slug
    } catch {
      // not in this slug
    }
  }

  return null
}

/**
 * Reads a JSONL file, splits on newlines, parses each non-empty line.
 * Handles both direct `{role, content}` format and the Claude Code wrapper
 * format `{type, message: {role, content}}`. Skips malformed lines silently.
 */
function readJsonlLines(path: string): JsonlRecord[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return []
  }

  const records: JsonlRecord[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as RawJsonlLine
      // Claude Code wraps conversation turns as {type:"user"|"assistant", message:{role,content}}
      // The top-level carries the synthetic marker `isMeta` plus the stable
      // per-line `uuid` and `timestamp`. Hoist all three onto the flattened
      // record so downstream code can (a) drop synthetic plugin content and
      // (b) emit deterministic entries for incremental fetch dedup.
      if (parsed.message?.role !== undefined) {
        const rec: JsonlRecord = { ...parsed.message }
        if (parsed.isMeta) rec.isMeta = true
        if (parsed.uuid) rec.lineUuid = parsed.uuid
        if (parsed.timestamp) rec.lineTs = parsed.timestamp
        records.push(rec)
      } else if (parsed.role !== undefined) {
        records.push(parsed as JsonlRecord)
      }
      // Skip non-conversation lines (custom-title, permission-mode, etc.)
    } catch {
      // skip malformed
    }
  }

  return records
}

/**
 * Scan <cwdSlug>/<sessionId>/subagents/*.meta.json for a matching agent.
 * Returns the agent id string (extracted from filename) or null.
 */
function resolveSpawnAgentId(
  projectsRoot: string,
  cwdSlug: string,
  sessionId: string,
  subagentType: string,
  description: string | undefined,
): string | null {
  const subagentsDir = join(projectsRoot, cwdSlug, sessionId, 'subagents')
  let files: string[]
  try {
    files = readdirSync(subagentsDir).filter((f) => f.endsWith('.meta.json'))
  } catch {
    return null
  }

  for (const filename of files) {
    const match = filename.match(/^agent-(.+)\.meta\.json$/)
    if (!match) continue
    const agentId = match[1]!
    try {
      const meta = JSON.parse(
        readFileSync(join(subagentsDir, filename), 'utf-8'),
      ) as { agentType?: string; description?: string }
      if (meta.agentType !== subagentType) continue
      if (description !== undefined && meta.description !== description) continue
      return agentId
    } catch {
      // skip unreadable/malformed meta
    }
  }

  return null
}

/**
 * Load agent metadata from agent-<agentId>.meta.json.
 */
function loadAgentMeta(
  projectsRoot: string,
  cwdSlug: string,
  sessionId: string,
  agentId: string,
): { agentType?: string; description?: string } {
  const metaPath = join(
    projectsRoot,
    cwdSlug,
    sessionId,
    'subagents',
    `agent-${agentId}.meta.json`,
  )
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8')) as {
      agentType?: string
      description?: string
    }
  } catch {
    return {}
  }
}

/**
 * Convert one JSONL record into 0+ TranscriptEntry objects.
 */
function recordToEntries(
  rec: JsonlRecord,
  pendingToolUses: Map<string, { name: string; input: unknown }>,
  projectsRoot: string,
  cwdSlug: string,
  sessionId: string,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  // Prefer the stable per-line identifiers captured from the JSONL wrapper so
  // that repeated buildTranscript calls produce identical entries — required
  // for incremental fetch dedup. Fall back to random values for tests or
  // records that don't carry the Claude Code envelope.
  const lineUuid = rec.lineUuid ?? randomUUID()
  const ts = rec.lineTs ?? new Date().toISOString()
  // For multi-block content we suffix the line uuid with the block index so
  // every emitted entry still has a unique-but-deterministic uuid.
  const entryUuid = (blockIdx: number): string =>
    rec.lineUuid ? `${lineUuid}#${blockIdx}` : lineUuid

  if (rec.role === 'user') {
    // Drop synthetic user records — plugin skill descriptions, caveats,
    // <system-reminder> injections, local-command wrappers. Claude Code flags
    // these with isMeta:true at the top level of the JSONL line; they should
    // never appear as user-typed text in the dashboard transcript.
    if (rec.isMeta) return entries

    if (typeof rec.content === 'string') {
      // Even without isMeta, a bare <system-reminder>… string is never real
      // user input — skip it as a safety net for older or hook-injected lines.
      if (isSystemReminderString(rec.content)) return entries
      entries.push({ uuid: lineUuid, ts, type: 'user', text: rec.content })
    } else if (Array.isArray(rec.content)) {
      let blockIdx = 0
      for (const blk of rec.content) {
        if (blk.type === 'tool_result') {
          const pending = pendingToolUses.get(blk.tool_use_id)
          if (pending) {
            entries.push({
              uuid: entryUuid(blockIdx),
              ts,
              type: 'tool-use',
              tool_name: pending.name,
              tool_input: pending.input,
              tool_response: { content: blk.content },
            })
            pendingToolUses.delete(blk.tool_use_id)
          }
        } else if (blk.type === 'text') {
          // Same safety net for array-shaped content: <system-reminder>-only
          // text blocks are synthetic injections, not user input.
          if (isSystemReminderString(blk.text)) { blockIdx++; continue }
          entries.push({ uuid: entryUuid(blockIdx), ts, type: 'user', text: blk.text })
        }
        blockIdx++
      }
    }
  } else if (rec.role === 'assistant' && Array.isArray(rec.content)) {
    let blockIdx = 0
    for (const blk of rec.content) {
      if (blk.type === 'text') {
        entries.push({ uuid: entryUuid(blockIdx), ts, type: 'assistant-text', text: blk.text })
      } else if (blk.type === 'tool_use') {
        if (blk.name === 'Agent' || blk.name === 'Task') {
          // Subagent spawn
          const input = blk.input as { subagent_type?: string; prompt?: string }
          const subagentType = input.subagent_type ?? ''
          const desc = input.prompt
          const agentId = resolveSpawnAgentId(
            projectsRoot,
            cwdSlug,
            sessionId,
            subagentType,
            desc,
          )
          const meta = agentId
            ? loadAgentMeta(projectsRoot, cwdSlug, sessionId, agentId)
            : {}
          entries.push({
            uuid: entryUuid(blockIdx),
            ts,
            type: 'subagent-spawn',
            agent_id: agentId ?? undefined,
            agent_type: meta.agentType ?? (subagentType !== '' ? subagentType : undefined),
            description: meta.description ?? desc,
          })
        } else {
          // Regular tool use — stash for later merge with tool_result.
          // We do NOT emit an entry yet; the merged entry is emitted when
          // the corresponding tool_result arrives.
          pendingToolUses.set(blk.id, { name: blk.name, input: blk.input })
        }
      }
      blockIdx++
    }
  }

  return entries
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a structured transcript from a Claude Code JSONL session file.
 * If agentId is provided, reads the subagent transcript instead.
 */
export function buildTranscript(opts: BuildTranscriptOptions): TranscriptEntry[] {
  const { projectsRoot, sessionId, agentId, limit } = opts

  const cwdSlug = findCwdSlug(projectsRoot, sessionId)
  if (cwdSlug === null) return []

  const jsonlPath = agentId
    ? join(projectsRoot, cwdSlug, sessionId, 'subagents', `agent-${agentId}.jsonl`)
    : join(projectsRoot, cwdSlug, `${sessionId}.jsonl`)

  const records = readJsonlLines(jsonlPath)
  const pendingToolUses = new Map<string, { name: string; input: unknown }>()
  const entries: TranscriptEntry[] = []

  for (const rec of records) {
    const newEntries = recordToEntries(rec, pendingToolUses, projectsRoot, cwdSlug, sessionId)
    entries.push(...newEntries)
  }

  if (opts.envelopes && opts.sessionName) {
    const name = opts.sessionName
    for (const env of opts.envelopes) {
      if (env.from === name) {
        entries.push({
          uuid: env.id,
          ts: env.ts,
          type: 'party-line-send',
          envelope_id: env.id,
          other_session: env.to,
          body: env.body,
          callback_id: env.callback_id ?? undefined,
          envelope_type: (env.type as 'message' | 'request' | 'response'),
        })
      } else if (env.to === name || env.to.split(',').map((s) => s.trim()).includes(name)) {
        entries.push({
          uuid: env.id,
          ts: env.ts,
          type: 'party-line-receive',
          envelope_id: env.id,
          other_session: env.from,
          body: env.body,
          callback_id: env.callback_id ?? undefined,
          envelope_type: (env.type as 'message' | 'request' | 'response'),
        })
      }
    }
    entries.sort((a, b) => a.ts.localeCompare(b.ts))
  }

  return entries.slice(-limit)
}
