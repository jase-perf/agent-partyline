# Transcript Persistence, Per-Session History UI, and /resume Handling

**Date:** 2026-04-22
**Status:** Ready for user review

## Goal

Store every Claude Code turn into the dashboard SQLite database so conversations
survive the deletion of `~/.claude/projects/<cwd>/<uuid>.jsonl` files. Surface
past conversations as a per-session History list in the Session Detail view, and
handle `/resume` correctly whether the resumed uuid is one of our own archives
or a uuid we have never seen before.

## Context

Today the dashboard persists party-line envelopes (`messages` table) and hook-
event metadata (`events` table). Session-detail transcripts are built on the fly
by reading the Claude Code JSONL files on disk (`src/transcript.ts` → `buildTranscript`).
Archived conversations have a pointer (`ccpl_archives.old_uuid`) but no content —
the content lives only in the jsonl, and the user can delete those files.

Three consequences the user has observed:

1. The "History tab" design was aspirational — no UI surface reads `ccpl_archives`.
   In practice the user has never seen a history entry.
2. The jsonl files are the only copy of Claude Code turns. If a user cleans up
   old files, the archived uuids become dangling pointers.
3. `/resume` into an existing archive is undefined behaviour today: a hook event
   with a resumed uuid looks identical to a "/clear rotated to a brand new uuid."
   Re-archiving the already-archived-then-resumed uuid every rotation would
   clutter the archive log; failing to recognise the resumed uuid as "already
   seen" would duplicate entries.

The ping-pong in `handleSessionHello` that previously corrupted
`cc_session_uuid` state on every reconnect was fixed separately in commit
`1078d44` (2026-04-22). Without that fix, archives were unreliable and
implementing the features below would have compounded the corruption. The fix
is a prerequisite.

## Out of Scope

- **Cross-session search.** Full-text search across all past conversations (the
  "Claude Chat web UI search box" experience) is filed as a follow-up. Schema
  decisions below leave room for FTS5 indexing later.
- **Manual prune UI.** A top-level page that lists every archived conversation
  across every session, sorted by latest, with per-row delete. Filed as a
  follow-up once retention is a real concern.
- **Automatic retention / pruning.** Archives are kept forever in v1. If DB
  size becomes a problem we revisit.
- **Switching the live session-detail view to a DB-backed transcript.** Live
  rendering continues to read jsonl. Once archive rendering is proven from DB,
  a follow-up can flip the live path too. This spec deliberately keeps the
  two paths separable so that switch is incremental.
- **Search inside a single archive viewer.** Present a read-only transcript.
  Browser Ctrl-F covers the simple case.

## Design

### 1. Data model

New table:

```sql
CREATE TABLE IF NOT EXISTS transcript_entries (
  cc_session_uuid TEXT NOT NULL,
  seq             INTEGER NOT NULL,     -- positional index within the jsonl file
  session_name    TEXT,                 -- denormalised for fast per-session queries; NULL until a cc_session_uuid is attributed (see stranger uuids below)
  ts              TEXT NOT NULL,        -- entry ts as written by Claude Code
  kind            TEXT NOT NULL,        -- user | assistant-text | tool-use | tool-result | subagent-spawn | system | ...
  uuid            TEXT,                 -- Claude Code's internal entry uuid (for dedupe / filterAfterUuid)
  body_json       TEXT NOT NULL,        -- the raw jsonl line (one source of truth)
  created_at      INTEGER NOT NULL,     -- when we ingested it
  PRIMARY KEY (cc_session_uuid, seq)
);
CREATE INDEX idx_transcript_entries_name_uuid ON transcript_entries(session_name, cc_session_uuid);
CREATE INDEX idx_transcript_entries_uuid_ts  ON transcript_entries(cc_session_uuid, ts);
```

Rationale:

- `(cc_session_uuid, seq)` PK: positional index in the jsonl is the natural
  identity. Re-scans (startup, file-shrink recovery) idempotently upsert.
- `body_json`: keep the raw line. `buildTranscript` logic can be re-applied
  server- or client-side. Avoids a schema migration every time Claude Code
  adds a new entry kind.
- `kind` denormalised for cheap "last assistant text" lookups (History labels)
  and future filtering.
- `session_name` denormalised to avoid joining `ccpl_archives` every query.

`messages` table: start populating the existing `cc_session_uuid` column at
envelope-route time so envelopes filter per archive just like turns do. The
column is already nullable, so backfill is a no-op for legacy rows.

Schema version bumps from 4 → 5. Migration: `CREATE TABLE IF NOT EXISTS
transcript_entries`. No data migration needed.

### 2. Ingest pipeline (b-stream)

The existing `JsonlObserver` polls `~/.claude/projects/` every 500 ms and emits
`JsonlUpdate { session_id, file_path, entry }` events (see `src/observers/jsonl.ts`).
A new `TranscriptIngester` subscribes to that stream and inserts one row per
emitted update.

Key responsibilities of `TranscriptIngester`:

- **Positional `seq`**: the observer already tracks byte offsets per file;
  surface the zero-based line index along with the entry (extend the
  `JsonlUpdate` shape) so the ingester writes deterministic seq values. Avoids
  row duplication on re-scan after a dashboard restart.
- **`session_name` resolution**: the observer emits `session_id` (which is the
  cc_session_uuid). To set `session_name`, look up
  `ccpl_sessions.cc_session_uuid`. If no row matches (happens when the jsonl's
  uuid is a stranger we have not adopted yet), look up by `cwd_slug` from the
  file path. If ambiguous (multiple sessions share a cwd) leave `session_name`
  `NULL` — we fill it in later when the uuid is adopted.
- **Attribution fix-up on adopt**: when `reconcileCcSessionUuid` adopts a new
  uuid, `UPDATE transcript_entries SET session_name = ? WHERE cc_session_uuid = ?
AND session_name IS NULL` so stranger ingests get retroactively attributed.
- **File shrink / replace**: the observer already detects shrink via fingerprint
  and fires an `onReset(filePath)` callback. Ingester listens and deletes rows
  for the affected cc_session_uuid before the re-scan re-ingests. Correct
  behaviour even for in-place compaction rewrites.

Backfill for stranger uuids (see `/resume` section below) lives in
`TranscriptIngester.backfillFromJsonl(filePath)` — a one-shot readfile + bulk
insert invoked when `reconcileCcSessionUuid` sees a uuid it has never seen and
the corresponding jsonl file exists.

### 3. /resume handling

Two cases are handled by `reconcileCcSessionUuid` and the stream ingester:

**Case A — resumed uuid is one of our archives for this session name.**
`reconcileCcSessionUuid` currently archives outgoing + adopts incoming. When
the incoming uuid matches an existing `ccpl_archives` row for the name:
historical archive rows stay in place (append-only), `ccpl_sessions.cc_session_uuid`
is set to the resumed uuid, and the uuid becomes live again. The
`/api/archives` response moves that uuid from `archives` into `live`
automatically (because the query excludes the currently-live uuid from the
archive list). On the next rotation-away, a new `ccpl_archives` row appends.
The same uuid can cycle archived → resumed → re-archived indefinitely; each
cycle adds one row, and the UI always represents a given uuid as a single
History entry.

**Case B — resumed uuid is a stranger.**
`reconcileCcSessionUuid` adopts the new uuid as normal. If
`transcript_entries` has no rows for that uuid, the ingester performs a one-shot
backfill of the corresponding jsonl (up to current tail), then streaming
resumes. The user sees the pre-resume conversation as the starting state of
that archive entry, just as if we had been observing all along.

No special UI treatment distinguishes Case A vs Case B — from the user's
perspective, the History list just shows all uuids this session has ever been.

### 4. API additions

```
GET /api/archives?session=<name>
  → {
      live: { uuid, last_active_at, label, entry_count } | null,
      archives: [{ uuid, archived_at, label, entry_count }]
    }
```

The response is split so the UI doesn't have to infer which row is the live
one. `live` is the current `ccpl_sessions.cc_session_uuid` for the name (null
if the session has no live uuid — fresh registration or post-clear before the
first hook). `archives` is every distinct `cc_session_uuid` that has ever been
archived for this name, with duplicates folded to the most recent archive row
(`GROUP BY old_uuid HAVING MAX(archived_at)`). A uuid that is currently live
does NOT appear in `archives` — it appears only in `live`. `label` is the last
assistant-text entry from `transcript_entries` truncated to 32 chars (or null
when no entries exist yet). `entry_count` is the row count in
`transcript_entries` for that uuid. `archives` is ordered by `archived_at`
DESC.

```
GET /api/transcript?session=<name>&uuid=<uuid>
```

The existing endpoint gains a `uuid` query parameter. When provided, it
bypasses the `ccpl?.cc_session_uuid` heuristic and reads directly from DB
(`transcript_entries` + the `messages` rows with matching `cc_session_uuid`).
When omitted, current live-rendering behaviour is preserved.

```
GET /api/archive-label?session=<name>&uuid=<uuid>
```

Returns the ~200-character label for the hover tooltip (last assistant-text,
longer truncation). Separate from `/api/archives` so the list loads fast and
tooltips fetch lazily on hover.

All three endpoints are dashboard-cookie authenticated (fall through
`requireAuth`).

### 5. UI

Session-detail sidebar splits into two equal-height sections:

```
┌──────────────────┐
│ AGENTS           │  top 50%, scrolls independently
│   • main         │
│   • subagent-1   │
├──────────────────┤
│ HISTORY          │  bottom 50%, scrolls independently
│ ● LIVE           │  pinned; class .history-row-live
│ ─── archives ──  │
│ ◐ "the issue i…" │  .history-row · :hover → tooltip
│   2h ago         │
│ ◐ "ssh into the" │
│   yesterday      │
└──────────────────┘
```

Each row renders the 32-char last-assistant-text label + relative timestamp.
Hover fetches `/api/archive-label` once (memoised) and shows a 200-char
tooltip beside the row.

Ordering: LIVE is always pinned at the top. Archives appear below, sorted by
`archived_at` DESC. The live uuid never also appears as an archive row (it is
excluded from the archive list — see `/api/archives` response shape). When an
archive is resumed it transitions from "archive row" to "LIVE row" in place,
with no duplicate entry.

Routes:

- `/session/<name>` — live view (current behaviour, unchanged).
- `/session/<name>/archive/<uuid>` — archived transcript in read-only mode.

The client router at `dashboard/dashboard.js` learns the second shape.
Matching uuid becomes `currentArchiveUuid` on the detail-view state.
`loadDetail(sessionName, { archiveUuid })` calls
`/api/transcript?session=<name>&uuid=<uuid>` instead of the live path.

Archive view differences:

- Stream renders the same, driven by the returned entries.
- Top banner replaces the state pill: "Viewing archive from <date> · ← Back to live"
  (link to `/session/<name>`).
- Send bar disabled and visually greyed. Attach button hidden.
- Live observer WS delta frames for this session are ignored in archive mode.
- History list shows the viewed uuid as the selected row (LIVE row highlighted
  in live mode; the archive row highlighted in archive mode).

### 6. Testing

Unit tests in `tests/`:

- `transcript-ingester.test.ts` — ingest a fixture jsonl, verify
  `(cc_session_uuid, seq)` row shape, idempotent re-scan, file-shrink reset
  deletes + re-ingests, session_name backfill on `reconcileCcSessionUuid`.
- `transcript-entries-queries.test.ts` — query helpers (list-archives-for-session,
  archive-label, transcript-by-uuid).
- `switchboard.test.ts` — new tests: resume-to-existing-archive doesn't
  re-archive; resume-to-stranger adopts and triggers backfill.
- `serve.test.ts` (or `api-archives.test.ts` in the existing fixture pattern) —
  HTTP tests for the three new API endpoints.

Browser verification (mandatory per user's standing rule):

- Boot an HTTP dashboard on a free port (`bun dashboard/serve.ts --port 3411`),
  seed it with a session and a couple archived uuids, and via Playwright MCP:
  1. Load `/session/<name>` — confirm AGENTS + HISTORY sidebar sections render.
  2. Click a history row — URL changes to `/session/<name>/archive/<uuid>`,
     stream populates, banner appears, send bar is disabled.
  3. Click "Back to live" — URL returns to `/session/<name>`, stream refreshes,
     send bar re-enabled.
  4. Click LIVE in archive mode — same as "Back to live".
  5. Hover a row — tooltip appears with longer label.

### 7. Rollout

One PR. Schema migration is additive. Existing session-detail rendering paths
are unchanged until the user hits a new URL shape. Ingest starts filling
`transcript_entries` immediately on deploy; backfilling pre-existing jsonl for
already-archived uuids is out of scope (the user accepts that "history from
before the feature shipped" may be sparse — our archives start fresh from the
deploy date, and legacy jsonl files are still on disk if the user needs them).

## Risks / Open Questions

- **Ingest write amplification.** 500 ms jsonl polling × N active sessions ×
  M new entries per poll = SQLite inserts. Bun's `bun:sqlite` in WAL mode
  handles thousands of inserts/sec easily; the realistic load is <10/sec
  total. No buffering needed in v1. If profiling later shows latency, batch
  on the observer tick.
- **Schema bump 4 → 5.** The migration runner in `src/storage/db.ts` needs a
  `v5` case that creates the table. Verify existing migrations still apply
  cleanly against v4 DBs.
- **`handleSessionHello`'s new "keep stored uuid" behaviour interaction with
  /resume into a stranger:** stored uuid is non-null (the outgoing live uuid)
  and hello from the plugin still says stored uuid (pid file lag), so hello
  doesn't adopt anything. The hook event with the stranger uuid drives
  reconcile, which adopts the new uuid. Works. Covered by existing
  switchboard tests + a new resume-stranger test.
- **History row ordering.** Ordered by most recent activity (the archive row's
  `archived_at` for archived, `last_active_at` for live). If a user resumes
  an old archive the list reshuffles; acceptable.
- **Tooltip over long conversations.** The label query runs
  `SELECT body_json FROM transcript_entries WHERE cc_session_uuid = ? AND kind
= 'assistant-text' ORDER BY seq DESC LIMIT 1`. Indexed. ~sub-ms even at 10k
  entries.
