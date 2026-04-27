# PR4 — Data Layer & Observability

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix seven data-layer and observability bugs identified in the multi-reviewer audit: JSONL observer in-flight stampede, `extractTs` fabrication, `findCwdSlug` expensive probe, aggregator hot-path allocations, aggregator over-eager subagent cancellation, chunked retention DELETE, exclusive migration transactions, and hook emitter triple jq invocation.

**Architecture:** Isolated fixes across `src/observers/`, `src/aggregator.ts`, `src/storage/retention.ts`, `src/storage/db.ts`, and `hooks/emit.sh`. No new tables or wire protocol changes. Each task is independent and can be reviewed in isolation.

**Tech Stack:** TypeScript/Bun, bun:sqlite, bash

---

## File Map

| File                                   | Change                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `src/observers/jsonl.ts`               | Add `scanning` guard to `scan()`                                         |
| `src/observers/transcript-ingester.ts` | `extractTs` → skip entry if no timestamp                                 |
| `src/transcript.ts`                    | `findCwdSlug` use `existsSync` instead of `readFileSync` probe           |
| `src/aggregator.ts`                    | Prepare statements once in constructor; add grace window to cancel query |
| `src/storage/retention.ts`             | Chunk `pruneOldEvents` in 1000-row batches                               |
| `src/storage/db.ts`                    | Use `BEGIN EXCLUSIVE` for initial schema + each migration step           |
| `hooks/emit.sh`                        | Collapse three `jq` invocations into one                                 |
| `tests/jsonl.test.ts`                  | New: in-flight guard test                                                |
| `tests/retention.test.ts`              | New: chunked delete test                                                 |
| `tests/aggregator.test.ts`             | Extend: grace-window cancel test                                         |

---

### Task 1: JSONL observer in-flight guard

**Issue #25.** `JsonlObserver.scan()` is called on a `setInterval`. If a scan takes longer than `pollIntervalMs` (e.g., many large JSONL files), the next tick fires while the first scan is still running. Two concurrent scans share `this.offsets`, leading to double-reporting lines and corrupted offset state.

**Files:**

- Modify: `src/observers/jsonl.ts`
- Test: `tests/jsonl.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/jsonl.test.ts`:

```ts
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlObserver } from '../src/observers/jsonl'

describe('JsonlObserver in-flight guard', () => {
  test('concurrent scan() calls do not double-emit lines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jsonl-test-'))
    const slug = 'abc123'
    mkdirSync(join(root, slug))
    const file = join(root, slug, 'sess1.jsonl')
    writeFileSync(file, '')

    const obs = new JsonlObserver(root, 5000) // long interval, we'll call scan manually
    const emitted: string[] = []
    obs.on((u) => emitted.push(JSON.stringify(u.entry)))

    await obs.start()

    // Seed the offset by triggering one scan (file is empty, just seeds offset)
    // Write a line and call scan twice in the same tick — simulates interval overlap
    writeFileSync(file, '{"type":"user","ts":"2024-01-01T00:00:00Z"}\n')
    // @ts-expect-error accessing private for test
    obs['scan']()
    // @ts-expect-error accessing private for test
    obs['scan']()

    expect(emitted).toHaveLength(1)
    obs.stop()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/jsonl.test.ts --timeout 10000 2>&1 | tail -20
```

Expected: FAIL — emitted has length 2 (line double-emitted) or similar assertion failure.

- [ ] **Step 3: Add the `scanning` guard to `src/observers/jsonl.ts`**

Add a private field after `private scanCount = 0`:

```ts
  private scanCount = 0
  private scanning = false
```

Wrap the body of `scan()`:

```ts
  private scan(): void {
    if (!this.running) return
    if (this.scanning) return
    this.scanning = true
    try {
      if (!existsSync(this.root)) return
      try {
        for (const cwdDir of readdirSync(this.root, { withFileTypes: true })) {
          if (!cwdDir.isDirectory()) continue
          const cwdPath = join(this.root, cwdDir.name)
          for (const entry of readdirSync(cwdPath, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
              this.poll(join(cwdPath, entry.name))
            } else if (entry.isDirectory()) {
              const subagentsDir = join(cwdPath, entry.name, 'subagents')
              if (existsSync(subagentsDir)) {
                for (const sub of readdirSync(subagentsDir, { withFileTypes: true })) {
                  if (sub.isFile() && sub.name.endsWith('.jsonl')) {
                    this.poll(join(subagentsDir, sub.name))
                  }
                }
              }
            }
          }
        }
      } catch { /* root read failed — next tick retries */ }

      this.scanCount++
      if (this.scanCount % 20 === 0) {
        for (const path of this.offsets.keys()) {
          if (!existsSync(path)) {
            this.offsets.delete(path)
            this.fingerprints.delete(path)
          }
        }
      }
    } finally {
      this.scanning = false
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/jsonl.test.ts --timeout 10000 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 5: Run full suite**

```bash
bun test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/observers/jsonl.ts tests/jsonl.test.ts
git commit -m "fix(jsonl): add scanning guard to prevent setInterval stampede"
```

---

### Task 2: extractTs skip/log + findCwdSlug existsSync

Two small fixes in the transcript pipeline.

**Issue #34.** `extractTs` in `transcript-ingester.ts` fabricates a timestamp (`new Date().toISOString()`) when an entry has no `timestamp` or `ts` field. Fabricated timestamps silently corrupt the ordering of entries in the history view. The correct behaviour is to skip the entry (return `null`) and let the caller drop it.

**Issue #35.** `findCwdSlug` in `transcript.ts` probes for file existence by calling `readFileSync` inside a try/catch. This reads (and discards) the entire file on every hit that doesn't match, which is wasteful. `existsSync` is the correct tool.

**Files:**

- Modify: `src/observers/transcript-ingester.ts`
- Modify: `src/transcript.ts`
- Test: `tests/transcript-ingester.test.ts` (extend existing if present, else create)

- [ ] **Step 1: Write failing tests**

Check if `tests/transcript-ingester.test.ts` exists:

```bash
ls tests/transcript-ingester.test.ts 2>/dev/null || echo "missing"
```

If missing, create `tests/transcript-ingester.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import { TranscriptIngester } from '../src/observers/transcript-ingester'
import { JsonlObserver } from '../src/observers/jsonl'
import { listEntries } from '../src/storage/transcript-entries'

describe('TranscriptIngester', () => {
  test('entries without timestamp are skipped (not fabricated)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ingester-test-'))
    const dir = join(root, 'slug1')
    mkdirSync(dir)
    const uuid = 'test-uuid-no-ts'
    const file = join(dir, `${uuid}.jsonl`)
    // Entry with no timestamp field
    writeFileSync(file, '{"type":"user","content":"hello"}\n')

    const db = openDb(':memory:')
    const ingester = new TranscriptIngester(db, root)
    const obs = new JsonlObserver(root, 5000)
    ingester.subscribe(obs)
    await obs.start()

    // Seed offset, then write the file with content and trigger scan
    writeFileSync(file, '')
    // @ts-expect-error private
    obs['scan']()

    writeFileSync(file, '{"type":"user","content":"hello"}\n')
    // @ts-expect-error private
    obs['scan']()

    // Give async operations a tick
    await new Promise((r) => setTimeout(r, 10))

    const entries = listEntries(db, uuid)
    // Entry without timestamp must be skipped
    expect(entries).toHaveLength(0)

    obs.stop()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/transcript-ingester.test.ts --timeout 15000 2>&1 | tail -20
```

Expected: FAIL — entry is inserted with a fabricated timestamp.

- [ ] **Step 3: Fix `extractTs` in `src/observers/transcript-ingester.ts`**

Change the function signature to return `string | null` and the caller to skip `null`:

```ts
// Change extractTs to return null instead of fabricating
function extractTs(entry: Record<string, unknown>): string | null {
  if (typeof entry.timestamp === 'string') return entry.timestamp
  if (typeof entry.ts === 'string') return entry.ts
  return null
}
```

Update `handleUpdate` to skip entries with no timestamp:

```ts
  private handleUpdate(u: JsonlUpdate): void {
    const ccUuid = u.session_id
    const ts = extractTs(u.entry)
    if (ts === null) return   // no timestamp — skip rather than fabricate
    const seq = this.allocateSeq(ccUuid)
    const sessionName = this.lookupSessionName(ccUuid)
    insertEntry(this.db, {
      cc_session_uuid: ccUuid,
      seq,
      session_name: sessionName,
      ts,
      kind: deriveKind(u.entry),
      uuid: extractUuid(u.entry),
      body_json: JSON.stringify(u.entry),
      created_at: Date.now(),
    })
  }
```

Update `backfillFromUuid` similarly:

```ts
const ts = extractTs(entry)
if (ts === null) continue // skip entries without timestamp
insertEntry(this.db, {
  cc_session_uuid: ccUuid,
  seq,
  session_name: sessionName,
  ts,
  kind: deriveKind(entry),
  uuid: extractUuid(entry),
  body_json: JSON.stringify(entry),
  created_at: Date.now(),
})
seq++
```

- [ ] **Step 4: Fix `findCwdSlug` in `src/transcript.ts`**

Replace the `readFileSync` probe with `existsSync`:

```ts
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
    if (existsSync(join(projectsRoot, slug, `${sessionId}.jsonl`))) {
      return slug
    }
  }

  return null
}
```

Ensure `existsSync` is imported at the top of `src/transcript.ts`. Check the existing import:

```bash
head -5 src/transcript.ts
```

Add `existsSync` to the `fs` import if not already present.

- [ ] **Step 5: Run tests**

```bash
bun test tests/transcript-ingester.test.ts --timeout 15000 2>&1 | tail -10
bun test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/observers/transcript-ingester.ts src/transcript.ts tests/transcript-ingester.test.ts
git commit -m "fix(transcript): skip entries without timestamp; use existsSync in findCwdSlug"
```

---

### Task 3: Aggregator prepared-statement memoization

**Issue #33.** `Aggregator.ingest()` is called for every hook event — potentially hundreds per minute during active sessions. Each call to `this.db.query(sql)` re-prepares the SQL statement. `bun:sqlite` does maintain an internal statement cache, but relying on it means the cache key (string equality) is checked every call. Storing `Statement` objects as class fields eliminates the lookup entirely and makes the hot path explicit.

**Files:**

- Modify: `src/aggregator.ts`
- Test: no new test needed (existing aggregator tests cover correctness; this is a pure performance fix)

- [ ] **Step 1: Prepare statements in constructor**

In `src/aggregator.ts`, add typed statement fields and prepare them in the constructor. The full updated class:

```ts
import type { Database, Statement } from 'bun:sqlite'
import type { HookEvent } from './events.js'
import { upsertSession, type SessionRow } from './storage/queries.js'

export interface SubagentRow {
  agent_id: string
  session_id: string
  agent_type: string | null
  description: string | null
  started_at: string
  ended_at: string | null
  status: string
}

type Listener = (s: SessionRow) => void

const WORKING_EVENTS = new Set(['PostToolUse', 'PreToolUse', 'UserPromptSubmit'])
const IDLE_EVENTS = new Set(['Stop', 'SessionEnd', 'SessionStart'])

export class Aggregator {
  private listeners: Listener[] = []
  private readonly stmtUpsertSubagent: Statement<
    void,
    [string, string, string | null, string | null, string]
  >
  private readonly stmtCompleteSubagent: Statement<void, [string, string]>
  private readonly stmtCancelSubagents: Statement<void, [string, string, string]>
  private readonly stmtInsertToolCall: Statement<
    void,
    [string, string | null, string, string, number]
  >
  private readonly stmtGetSessionById: Statement<SessionRow, [string]>
  private readonly stmtGetSessionByName: Statement<SessionRow, [string]>
  private readonly stmtGetSubagents: Statement<SubagentRow, [string]>
  private readonly stmtListSessions: Statement<SessionRow, []>

  constructor(private db: Database) {
    this.stmtUpsertSubagent = db.prepare(
      `INSERT INTO subagents (agent_id, session_id, agent_type, description, started_at, status)
       VALUES (?, ?, ?, ?, ?, 'running')
       ON CONFLICT(agent_id) DO UPDATE SET status='running', started_at=excluded.started_at`,
    )
    this.stmtCompleteSubagent = db.prepare(
      `UPDATE subagents SET status='completed', ended_at=? WHERE agent_id=?`,
    )
    this.stmtCancelSubagents = db.prepare(
      `UPDATE subagents SET status='cancelled', ended_at=?
       WHERE session_id=? AND status='running' AND started_at < ?`,
    )
    this.stmtInsertToolCall = db.prepare(
      `INSERT INTO tool_calls (session_id, agent_id, tool_name, started_at, ended_at, success)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    this.stmtGetSessionById = db.prepare(`SELECT * FROM sessions WHERE session_id=?`)
    this.stmtGetSessionByName = db.prepare(
      `SELECT * FROM sessions WHERE name=? ORDER BY last_seen DESC LIMIT 1`,
    )
    this.stmtGetSubagents = db.prepare(
      `SELECT * FROM subagents WHERE session_id=? ORDER BY started_at DESC`,
    )
    this.stmtListSessions = db.prepare(`SELECT * FROM sessions ORDER BY last_seen DESC`)
  }

  onUpdate(l: Listener): void {
    this.listeners.push(l)
  }

  ingest(ev: HookEvent): void {
    const state =
      ev.hook_event === 'SessionEnd'
        ? 'ended'
        : WORKING_EVENTS.has(ev.hook_event)
          ? 'working'
          : IDLE_EVENTS.has(ev.hook_event)
            ? 'idle'
            : undefined

    const source =
      ev.source ??
      (typeof (ev.payload as { source?: unknown }).source === 'string'
        ? (ev.payload as { source: string }).source
        : 'claude-code')

    upsertSession(this.db, {
      session_id: ev.session_id || `${ev.machine_id}:${ev.session_name}`,
      machine_id: ev.machine_id,
      name: ev.session_name,
      cwd: (ev.payload as { cwd?: string }).cwd ?? null,
      last_seen: ev.ts,
      state: state ?? null,
      started_at: ev.hook_event === 'SessionStart' ? ev.ts : null,
      source,
    })

    if (ev.hook_event === 'SubagentStart' && ev.agent_id) {
      this.stmtUpsertSubagent.run(
        ev.agent_id,
        ev.session_id,
        ev.agent_type ?? (ev.payload as { agent_type?: string }).agent_type ?? null,
        (ev.payload as { description?: string }).description ?? null,
        ev.ts,
      )
    } else if (ev.hook_event === 'SubagentStop' && ev.agent_id) {
      this.stmtCompleteSubagent.run(ev.ts, ev.agent_id)
    }

    if (
      !ev.agent_id &&
      (ev.hook_event === 'UserPromptSubmit' ||
        ev.hook_event === 'SessionStart' ||
        ev.hook_event === 'SessionEnd')
    ) {
      const graceCutoff = new Date(new Date(ev.ts).getTime() - CANCEL_GRACE_MS).toISOString()
      this.stmtCancelSubagents.run(ev.ts, ev.session_id, graceCutoff)
    }

    if (ev.hook_event === 'PostToolUse') {
      const p = ev.payload as {
        tool_name?: string
        tool_response?: { success?: boolean; isError?: boolean; error?: unknown }
      }
      const tr = p.tool_response
      const success =
        tr && (tr.success === false || tr.isError === true || tr.error != null) ? 0 : 1
      this.stmtInsertToolCall.run(
        ev.session_id,
        ev.agent_id ?? null,
        p.tool_name ?? 'unknown',
        ev.ts,
        success,
      )
    }

    const current = this.getSession(ev.session_id)
    if (current) {
      for (const l of this.listeners) l(current)
    }
  }

  getSession(key: string): SessionRow | null {
    const byId = this.stmtGetSessionById.get(key)
    if (byId) return byId
    return this.stmtGetSessionByName.get(key) ?? null
  }

  getSubagents(sessionKey: string): SubagentRow[] {
    const resolved = this.getSession(sessionKey)
    const uuid = resolved?.session_id ?? sessionKey
    return this.stmtGetSubagents.all(uuid)
  }

  listSessions(): SessionRow[] {
    return this.stmtListSessions.all()
  }
}
```

Note: `CANCEL_GRACE_MS` is defined in Task 4 (10_000). Add it before the class:

```ts
/** Subagents started within this window are not cancelled on UserPromptSubmit. */
const CANCEL_GRACE_MS = 10_000
```

- [ ] **Step 2: Check `bun:sqlite` Statement import**

In bun:sqlite, `Statement` is a generic type available as `import type { Statement } from 'bun:sqlite'` but actually bun exposes it differently. If the `Statement` import fails at type-check, use the return type of `db.prepare`:

```ts
type Stmt = ReturnType<Database['prepare']>
```

Then replace all `Statement<...>` annotations with `Stmt`. The generic type arguments are documentation-only at runtime; bun's `prepare()` still works correctly without them.

Run `bun run tsc --noEmit 2>&1 | head -20` to check.

- [ ] **Step 3: Run tests**

```bash
bun test 2>&1 | tail -5
```

Expected: all tests pass (existing aggregator tests exercise correctness).

- [ ] **Step 4: Commit**

```bash
git add src/aggregator.ts
git commit -m "perf(aggregator): prepare statements once in constructor, add cancel grace window"
```

---

### Task 4: Aggregator subagent grace window

**Note:** This task's implementation was merged into Task 3 above — the `CANCEL_GRACE_MS = 10_000` constant and the `graceCutoff` parameter are part of the `stmtCancelSubagents.run()` call in Task 3's full rewrite.

If Task 3 already added the grace window, this task is to add a targeted test confirming the behaviour.

**Files:**

- Test: `tests/aggregator.test.ts` (extend)

- [ ] **Step 1: Find existing aggregator test**

```bash
ls tests/aggregator.test.ts 2>/dev/null && echo "exists" || echo "missing"
```

- [ ] **Step 2: Write grace-window test**

Add to `tests/aggregator.test.ts` (or create it if missing):

```ts
import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import { Aggregator } from '../src/aggregator'
import type { HookEvent } from '../src/events'

function makeEvent(overrides: Partial<HookEvent>): HookEvent {
  return {
    machine_id: 'test-machine',
    session_name: 'test-session',
    session_id: 'sess-uuid',
    hook_event: 'UserPromptSubmit',
    ts: new Date().toISOString(),
    payload: {},
    ...overrides,
  }
}

describe('Aggregator subagent grace window', () => {
  test('subagents started within grace window are not cancelled', () => {
    const db = openDb(':memory:')
    const agg = new Aggregator(db)

    const now = Date.now()
    const recentTs = new Date(now - 2_000).toISOString() // 2s ago — within 10s grace
    const staleTs = new Date(now - 15_000).toISOString() // 15s ago — outside grace

    // Start a session so upsertSession doesn't fail
    agg.ingest(makeEvent({ hook_event: 'SessionStart', ts: new Date(now - 20_000).toISOString() }))

    // Insert a recent subagent and a stale subagent directly
    db.exec(`INSERT INTO subagents (agent_id, session_id, agent_type, description, started_at, status)
             VALUES ('recent-agent', 'sess-uuid', null, null, '${recentTs}', 'running')`)
    db.exec(`INSERT INTO subagents (agent_id, session_id, agent_type, description, started_at, status)
             VALUES ('stale-agent', 'sess-uuid', null, null, '${staleTs}', 'running')`)

    // Fire UserPromptSubmit — should cancel stale but not recent
    agg.ingest(makeEvent({ hook_event: 'UserPromptSubmit', ts: new Date(now).toISOString() }))

    const agents = db
      .query('SELECT agent_id, status FROM subagents ORDER BY agent_id')
      .all() as Array<{ agent_id: string; status: string }>
    const recent = agents.find((a) => a.agent_id === 'recent-agent')
    const stale = agents.find((a) => a.agent_id === 'stale-agent')

    expect(recent?.status).toBe('running') // not cancelled
    expect(stale?.status).toBe('cancelled') // correctly cancelled
  })
})
```

- [ ] **Step 3: Run test**

```bash
bun test tests/aggregator.test.ts --timeout 10000 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 4: Run full suite**

```bash
bun test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add tests/aggregator.test.ts
git commit -m "test(aggregator): verify subagent grace window prevents premature cancel"
```

---

### Task 5: Chunked pruneOldEvents

**Issue #27.** `pruneOldEvents` issues a single `DELETE FROM events WHERE ts < $cutoff`. On a DB with millions of rows, SQLite holds a write lock for the entire duration. Readers are blocked for seconds. Chunked deletion (1000 rows at a time) limits the lock window per iteration and allows reads between chunks.

**Files:**

- Modify: `src/storage/retention.ts`
- Test: `tests/retention.test.ts` (new)

- [ ] **Step 1: Write failing test**

Create `tests/retention.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { openDb } from '../src/storage/db'
import { pruneOldEvents } from '../src/storage/retention'

describe('pruneOldEvents', () => {
  test('deletes in chunks, returns total deleted', () => {
    const db = openDb(':memory:')

    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    // Insert 2500 old events and 100 new ones
    const insertStmt = db.prepare(
      `INSERT INTO events (machine_id, session_id, session_name, hook_event, ts, payload_json, source)
       VALUES ('m1', 's1', 'test', 'Stop', ?, '{}', 'claude-code')`,
    )
    const oldTs = new Date(cutoffDate.getTime() - 1000).toISOString()
    const newTs = new Date().toISOString()
    for (let i = 0; i < 2500; i++) {
      insertStmt.run(oldTs)
    }
    for (let i = 0; i < 100; i++) {
      insertStmt.run(newTs)
    }

    const deleted = pruneOldEvents(db, 30)
    expect(deleted).toBe(2500)

    const remaining = db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    expect(remaining.n).toBe(100)
  })
})
```

- [ ] **Step 2: Run test to verify it passes against current code**

```bash
bun test tests/retention.test.ts --timeout 10000 2>&1 | tail -10
```

The existing single-shot DELETE already returns correct counts — the test should pass. This confirms the correctness baseline before refactoring.

- [ ] **Step 3: Refactor `pruneOldEvents` to chunk**

In `src/storage/retention.ts`, replace the current single-DELETE implementation:

```ts
const CHUNK_SIZE = 1000

/** Delete events older than `days` days. Returns number of rows deleted. */
export function pruneOldEvents(db: Database, days: number): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const stmt = db.prepare<{ changes: number }, [string]>(
    `DELETE FROM events WHERE id IN (
       SELECT id FROM events WHERE ts < ? LIMIT ${CHUNK_SIZE}
     )`,
  )
  let total = 0
  while (true) {
    const result = stmt.run(cutoff) as unknown as { changes: number }
    total += result.changes
    if (result.changes < CHUNK_SIZE) break
  }
  return total
}
```

- [ ] **Step 4: Run test suite**

```bash
bun test tests/retention.test.ts --timeout 10000 2>&1 | tail -10
bun test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/storage/retention.ts tests/retention.test.ts
git commit -m "fix(retention): chunk pruneOldEvents to 1000-row batches, reducing lock contention"
```

---

### Task 6: Migration BEGIN EXCLUSIVE

**Issue #32.** `applyMigrations` wraps each step in `db.transaction(() => { ... })()`, which uses `BEGIN DEFERRED`. If a read transaction is active when the migration tries to promote to a write lock for DDL, it will get `SQLITE_LOCKED`. With `BEGIN EXCLUSIVE`, the lock is acquired upfront, failing fast rather than partway through a schema change.

**Files:**

- Modify: `src/storage/db.ts`

No new test needed: migration correctness is already covered by the existing DB tests; the exclusive-lock behaviour is only observable under concurrent access which is hard to test in unit tests without a real multi-process setup.

- [ ] **Step 1: Replace `applyMigrations` with explicit BEGIN EXCLUSIVE**

In `src/storage/db.ts`, replace the `applyMigrations` function:

```ts
function applyMigrations(db: Database, fromVersion: number): void {
  for (let v = fromVersion; v < SCHEMA_VERSION; v++) {
    const targetVersion = v + 1
    const step = MIGRATIONS[targetVersion]
    if (!step) throw new Error(`No migration registered for v${v} → v${targetVersion}`)
    db.exec('BEGIN EXCLUSIVE')
    try {
      step(db)
      db.exec(`PRAGMA user_version = ${targetVersion}`)
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore secondary failure */
      }
      throw e
    }
  }
}
```

Also update the fresh-DB path in `openDb` to use explicit EXCLUSIVE:

```ts
  if (currentVersion === 0) {
    const schema = readFileSync(SCHEMA_PATH, 'utf-8')
    db.exec('BEGIN EXCLUSIVE')
    try {
      db.exec(schema)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      throw e
    }
  } else if (currentVersion < SCHEMA_VERSION) {
```

Remove the now-unused `Migration = (db: Database) => void` type's implicit use of `db.transaction` — the `Migration` type itself doesn't change, but the caller no longer wraps in `db.transaction`.

- [ ] **Step 2: Run tests**

```bash
bun test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/storage/db.ts
git commit -m "fix(db): use BEGIN EXCLUSIVE for initial schema and each migration step"
```

---

### Task 7: Hook emitter single-pass jq

**Issue #29.** `hooks/emit.sh` runs three separate `jq` invocations to extract `session_id`, `agent_id`, and `agent_type` from `$PAYLOAD`:

```bash
SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id // ""')
AGENT_ID=$(echo "$PAYLOAD" | jq -r '.agent_id // ""')
AGENT_TYPE=$(echo "$PAYLOAD" | jq -r '.agent_type // ""')
```

Each invocation forks a new `jq` process and pipes the full payload JSON. Hooks run synchronously in the Claude Code hook pipeline before control returns to the CLI (the POST is backgrounded, but the jq calls are not). On busy hooks with large payloads, three forks add measurable latency.

Fix: combine into one `jq` call producing tab-separated output, then `read` into three variables.

**Files:**

- Modify: `hooks/emit.sh`

- [ ] **Step 1: Locate the three jq lines**

In `hooks/emit.sh`, find lines 47–49 (approximately):

```bash
SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id // ""')
AGENT_ID=$(echo "$PAYLOAD" | jq -r '.agent_id // ""')
AGENT_TYPE=$(echo "$PAYLOAD" | jq -r '.agent_type // ""')
```

- [ ] **Step 2: Replace with single-pass extraction**

Replace those three lines with:

```bash
IFS=$'\t' read -r SESSION_ID AGENT_ID AGENT_TYPE < <(
  printf '%s' "$PAYLOAD" | jq -r '[.session_id // "", .agent_id // "", .agent_type // ""] | @tsv'
)
```

This runs one jq process, outputs all three fields tab-separated, and `read` splits on `\t` into the three variables. The `IFS` is scoped to the `read` invocation via the assignment prefix.

- [ ] **Step 3: Verify the ENVELOPE construction still works**

The `ENVELOPE` jq block at the end of `emit.sh` uses `$SESSION_ID`, `$AGENT_ID`, and `$AGENT_TYPE` via `--arg` flags. Those variable names don't change, so the jq block is unaffected.

Manually verify by diff:

```bash
git diff hooks/emit.sh
```

The only changes should be lines 47–49 → the new `IFS/read` block.

- [ ] **Step 4: Smoke-test the emitter**

```bash
echo '{"session_id":"abc","agent_id":"ag1","agent_type":"task"}' | bash hooks/emit.sh TestEvent 2>&1
```

Expected: the script exits 0 (token file won't exist → early exit 0, but the jq parsing runs first). To verify the variables were extracted, add a temporary `echo "SID=$SESSION_ID AID=$AGENT_ID AT=$AGENT_TYPE"` before the early exits and remove it after confirming.

Actually, since the early exits happen before the jq calls (token/machine-id file checks), do a quick inline test of just the extraction:

```bash
PAYLOAD='{"session_id":"abc","agent_id":"ag1","agent_type":"task"}'
IFS=$'\t' read -r SESSION_ID AGENT_ID AGENT_TYPE < <(
  printf '%s' "$PAYLOAD" | jq -r '[.session_id // "", .agent_id // "", .agent_type // ""] | @tsv'
)
echo "SID=$SESSION_ID AID=$AGENT_ID AT=$AGENT_TYPE"
```

Expected output: `SID=abc AID=ag1 AT=task`

- [ ] **Step 5: Commit**

```bash
git add hooks/emit.sh
git commit -m "perf(hooks): collapse three jq invocations into one in emit.sh"
```

---

## Final Steps

After all 7 tasks are committed:

- [ ] **Run full test suite**

```bash
bun test 2>&1 | tail -5
```

Expected: all tests pass (≥352).

- [ ] **TypeScript check**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Merge and push**

```bash
git checkout main
git merge pr4-data-layer --no-ff -m "chore: merge pr4-data-layer — data layer & observability fixes"
git push
```
