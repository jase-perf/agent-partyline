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
  attachments?: import('./types.js').Attachment[]
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
  attachments?: import('./types.js').Attachment[]
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
   * Claude Code sets these on the auto-generated post-compaction summary
   * record. Hoisted from the top-level JSONL line so recordToEntries can
   * drop the giant "This session is being continued from a previous
   * conversation..." block, which is internal context, not user prose.
   */
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
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
  /** Top-level flags — see JsonlRecord.isCompactSummary. */
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
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
 * True when the string is nothing but a `<channel source="party-line" ...>...</channel>`
 * tag. These appear in JSONL as user turns whenever the plugin delivers an
 * inbound party-line message to the session's conversation. We already render
 * the underlying envelope (from the `messages` table) as a transcript entry,
 * so re-rendering the raw channel tag would duplicate it and leak protocol
 * framing into the UI.
 */
/** True when `to` (a raw envelope recipient field) addresses `name` directly,
 *  via broadcast, or as part of a comma-separated fan-out list. */
function targetsName(to: string, name: string): boolean {
  if (!to) return false
  if (to === name || to === 'all') return true
  return to
    .split(',')
    .map((s) => s.trim())
    .includes(name)
}

function isPartyLineChannelString(text: string): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  return /^<channel\s+[^>]*\bsource="party-line"[^>]*>[\s\S]*<\/channel>$/.test(trimmed)
}

/**
 * True when the user-role string is one of Claude Code's internal markers:
 *   - <task-notification>    background subagent completion ping
 *   - <command-name>         /slash command name (paired with -message/-args)
 *   - <command-message>      /slash command message
 *   - <local-command-stdout> output of a /slash command
 *   - <local-command-stderr> stderr of a /slash command
 *   - <local-command-caveat> caveat appended after a local command
 * These have no isMeta flag, so detection by tag prefix is the only signal.
 */
const SYNTHETIC_USER_TAGS = [
  'task-notification',
  'command-name',
  'command-message',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
]
function isSyntheticUserContent(text: string): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trimStart()
  for (const tag of SYNTHETIC_USER_TAGS) {
    if (trimmed.startsWith(`<${tag}>`) || trimmed.startsWith(`<${tag} `)) return true
  }
  return false
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
        if (parsed.isCompactSummary) rec.isCompactSummary = true
        if (parsed.isVisibleInTranscriptOnly) rec.isVisibleInTranscriptOnly = true
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
      const meta = JSON.parse(readFileSync(join(subagentsDir, filename), 'utf-8')) as {
        agentType?: string
        description?: string
      }
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
  const metaPath = join(projectsRoot, cwdSlug, sessionId, 'subagents', `agent-${agentId}.meta.json`)
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
    // Compaction-emitted summary block — internal context, not user prose.
    if (rec.isCompactSummary || rec.isVisibleInTranscriptOnly) return entries

    if (typeof rec.content === 'string') {
      // Even without isMeta, a bare <system-reminder>… string is never real
      // user input — skip it as a safety net for older or hook-injected lines.
      if (isSystemReminderString(rec.content)) return entries
      if (isPartyLineChannelString(rec.content)) return entries
      if (isSyntheticUserContent(rec.content)) return entries
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
          if (isSystemReminderString(blk.text)) {
            blockIdx++
            continue
          }
          if (isPartyLineChannelString(blk.text)) {
            blockIdx++
            continue
          }
          if (isSyntheticUserContent(blk.text)) {
            blockIdx++
            continue
          }
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
          const agentId = resolveSpawnAgentId(projectsRoot, cwdSlug, sessionId, subagentType, desc)
          const meta = agentId ? loadAgentMeta(projectsRoot, cwdSlug, sessionId, agentId) : {}
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
 * Fold raw JSONL records (already parsed from disk OR loaded from DB) into
 * TranscriptEntry[] with envelopes interleaved by ts. Extracted from
 * buildTranscript so the DB-backed archive viewer can reuse the same
 * render-shape.
 */
export function recordsToTranscript(
  records: Record<string, unknown>[],
  projectsRoot: string,
  cwdSlug: string,
  sessionId: string,
  sessionName: string | undefined,
  envelopes: PartyLineEnvelope[] | undefined,
  limit: number,
): TranscriptEntry[] {
  const pendingToolUses = new Map<string, { name: string; input: unknown }>()
  const entries: TranscriptEntry[] = []
  for (const rec of records) {
    // Accept both shapes: already-flattened JsonlRecord (live path, where
    // readJsonlLines has already unwrapped {message: {role, content}}) and
    // raw Claude Code JSONL lines (DB path, where body_json is the verbatim
    // line). Flatten the wrapper shape inline so a single helper covers both.
    let flat: JsonlRecord
    const raw = rec as RawJsonlLine
    if (raw.message?.role !== undefined) {
      flat = { ...raw.message }
      if (raw.isMeta) flat.isMeta = true
      if (raw.isCompactSummary) flat.isCompactSummary = true
      if (raw.isVisibleInTranscriptOnly) flat.isVisibleInTranscriptOnly = true
      if (raw.uuid) flat.lineUuid = raw.uuid
      if (raw.timestamp) flat.lineTs = raw.timestamp
    } else if (raw.role !== undefined) {
      flat = rec as JsonlRecord
    } else {
      continue
    }
    const newEntries = recordToEntries(flat, pendingToolUses, projectsRoot, cwdSlug, sessionId)
    entries.push(...newEntries)
  }
  if (envelopes && sessionName) {
    const name = sessionName
    for (const env of envelopes) {
      if (env.from === 'dashboard' && (env.to === name || targetsName(env.to, name))) {
        entries.push({
          uuid: env.id,
          ts: env.ts,
          type: 'user',
          text: env.body,
          ...(env.attachments && env.attachments.length > 0
            ? { attachments: env.attachments }
            : {}),
        })
      } else if (env.from === name) {
        entries.push({
          uuid: env.id,
          ts: env.ts,
          type: 'party-line-send',
          envelope_id: env.id,
          other_session: env.to,
          body: env.body,
          callback_id: env.callback_id ?? undefined,
          envelope_type: env.type as 'message' | 'request' | 'response',
          ...(env.attachments && env.attachments.length > 0
            ? { attachments: env.attachments }
            : {}),
        })
      } else if (targetsName(env.to, name)) {
        entries.push({
          uuid: env.id,
          ts: env.ts,
          type: 'party-line-receive',
          envelope_id: env.id,
          other_session: env.from,
          body: env.body,
          callback_id: env.callback_id ?? undefined,
          envelope_type: env.type as 'message' | 'request' | 'response',
          ...(env.attachments && env.attachments.length > 0
            ? { attachments: env.attachments }
            : {}),
        })
      }
    }
    entries.sort((a, b) => a.ts.localeCompare(b.ts))
  }
  return entries.slice(-limit)
}

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
  return recordsToTranscript(
    records as unknown as Record<string, unknown>[],
    projectsRoot,
    cwdSlug,
    sessionId,
    opts.sessionName,
    opts.envelopes,
    limit,
  )
}
