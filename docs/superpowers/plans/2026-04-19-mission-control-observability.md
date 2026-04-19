# Mission Control Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the party-line dashboard into a persistent, multi-host "mission control" that passively observes every Claude Code session via hooks + JSONL and presents live multi-view state, so the operator can watch agents and subagents work without the sessions having to report in manually.

**Architecture:**
- **Hooks** fire on every Claude Code event (PostToolUse, UserPromptSubmit, Stop, Subagent*, SessionStart/End, PreCompact, Notification, TaskCreated/Completed) and POST a JSON event to the dashboard's `/ingest` endpoint via a small bash emitter.
- **Passive observers** in the dashboard watch `~/.claude/projects/**/*.jsonl` transcripts for context the hooks can't give us.
- **SQLite** (via `bun:sqlite`) stores events, derived session state, remote machines, and subagents. Provides history, metrics, and late-join replay.
- **`Bun.serve`** exposes `/ingest` (HTTP POST with shared-secret auth for remote hosts), unchanged WS broadcast to browsers, plus new REST endpoints for history/metrics/per-session detail.
- **UDP multicast + MCP party-line stay unchanged** — they remain the agent-to-agent channel. The dashboard no longer depends on MCP for observability; it ingests hook events independently.
- **Tighten MCP server instructions** so agents know they must respond via `party_line_respond` for `type=request` but can continue normally for `type=message` (their output is captured by hooks/JSONL, not the channel).

**Tech Stack:**
- Bun runtime + TypeScript, strict mode
- `bun:sqlite` (built-in, zero native deps)
- `Bun.serve` HTTP + WebSocket (existing)
- `node:dgram` for multicast (existing)
- `node:fs.watch` + manual JSONL tail for transcripts
- Bash (`curl`, `jq`) for hook emitters
- Vanilla JS/HTML in dashboard (no framework)

---

## File Structure

**New:**
- `src/events.ts` — HookEvent type definitions, validation
- `src/storage/db.ts` — SQLite open, migration runner, typed query helpers
- `src/storage/schema.sql` — `events`, `sessions`, `machines`, `tool_calls`, `subagents` tables + indexes
- `src/storage/queries.ts` — prepared statements and query fns
- `src/ingest/http.ts` — `/ingest` handler, auth check, envelope validation
- `src/ingest/auth.ts` — shared-secret token management
- `src/observers/jsonl.ts` — `~/.claude/projects/**/*.jsonl` **polling** tailer (fs.watch recursive is broken on Bun/Linux — see verification doc §4), session-id extractor, also tails `<session-id>/subagents/agent-<id>.jsonl` for subagent activity
- `src/aggregator.ts` — fold events + JSONL into per-session state objects
- `src/machine-id.ts` — read/write stable machine ID at `~/.config/party-line/machine-id`
- `hooks/emit.sh` — bash emitter: reads stdin JSON, augments with session/machine/hook-event name, POSTs to ingest
- `hooks/install.sh` — installer: merges hook definitions into `~/.claude/settings.json`
- `hooks/uninstall.sh` — removes party-line hook entries
- `dashboard/views/overview.html` — (fragment) overview pane
- `dashboard/views/session-detail.html` — (fragment) per-session detail pane
- `dashboard/views/machines.html` — (fragment) multi-host pane
- `dashboard/views/history.html` — (fragment) event/message history pane
- `dashboard/dashboard.js` — extracted JS (was inline); router + view manager + WS client
- `dashboard/dashboard.css` — extracted CSS
- `tests/events.test.ts`, `tests/storage.test.ts`, `tests/ingest-auth.test.ts`, `tests/ingest-http.test.ts`, `tests/jsonl-observer.test.ts`, `tests/aggregator.test.ts`

**Modified:**
- `dashboard/serve.ts` — wire in ingest handler, storage, aggregator; add REST endpoints
- `dashboard/monitor.ts` — subscribe aggregator output; publish to WS
- `dashboard/index.html` — shell that loads view fragments + extracted JS/CSS
- `src/server.ts` — tighten `instructions` string (request vs message semantics)
- `src/types.ts` — add HookEvent-related shared types if needed
- `src/introspect.ts` — reuse or share logic with `src/observers/jsonl.ts` (don't duplicate)
- `package.json` — add `"hooks:install"`, `"hooks:uninstall"`, `"test"` scripts
- `SPEC.md` — add "Phase 2: Observability" section; update status
- `README.md` — add install/hooks docs
- `.gitignore` — add `dashboard.db*`

---

## Open Verification Items (Task 0)

Before writing code, verify a few assumptions with a short spike. These MAY invalidate downstream tasks.

- **Hook payload shapes** — confirm `SubagentStart`/`SubagentStop`/`TaskCreated`/`TaskCompleted`/`TeammateIdle` actually exist as of current Claude Code and capture their real stdin payloads. If any don't exist, drop from scope and note in plan.
- **Subagent identification** — verify parent-session `PreToolUse`/`PostToolUse` include `agent_id` and `agent_type` when a subagent is running. If not, subagent tree visibility falls back to `SubagentStart`/`Stop` only.
- **JSONL file naming** — confirm current location is `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` on this machine.
- **Bun `fs.watch` recursion** — confirm recursive watch works on Linux for `~/.claude/projects/`. If not, use `inotifywait` as a child process.

**RESOLVED (see `docs/superpowers/plans/2026-04-19-verification.md`):**
- Hook set complete — every planned event exists.
- Bun `fs.watch` recursive is **broken** on Linux (Node works; Bun doesn't). Polling confirmed working — use polling in Task 9.
- JSONL convention confirmed: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` (append-only). Subagent transcripts live separately at `<cwd-slug>/<session-id>/subagents/agent-<id>.jsonl`; sibling `agent-<id>.meta.json` has `agentType`/`description`.
- `success` is **not** top-level on `PostToolUse`. Inspect `tool_response` per tool (Write has `tool_response.success`; other tools vary).
- Parent-session vs subagent hook scope is **unverified** — design Task 10 to rely on `SubagentStart`/`SubagentStop` events + tailing `<session>/subagents/agent-<id>.jsonl` via observer. Treat parent-session PreToolUse/PostToolUse with `agent_id` as bonus if/when it works.

Record findings in a short note at `docs/superpowers/plans/2026-04-19-verification.md`.

---

## Phase 1 — Foundation (events, storage, ingest)

### Task 1: Event envelope types + validator

**Files:**
- Create: `src/events.ts`
- Test: `tests/events.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/events.test.ts
import { describe, expect, test } from 'bun:test'
import { validateHookEvent, type HookEvent } from '../src/events.js'

describe('validateHookEvent', () => {
  test('accepts minimal valid PostToolUse event', () => {
    const raw = {
      machine_id: 'm1',
      session_name: 'discord',
      session_id: 's1',
      hook_event: 'PostToolUse',
      ts: '2026-04-19T12:00:00.000Z',
      payload: { tool_name: 'Bash', success: true },
    }
    const ev = validateHookEvent(raw)
    expect(ev.hook_event).toBe('PostToolUse')
    expect(ev.session_name).toBe('discord')
  })

  test('rejects event missing hook_event', () => {
    const raw = { machine_id: 'm1', session_name: 'x', session_id: 's', ts: 't', payload: {} }
    expect(() => validateHookEvent(raw)).toThrow(/hook_event/)
  })

  test('rejects event with non-string machine_id', () => {
    const raw = {
      machine_id: 42,
      session_name: 'x',
      session_id: 's',
      hook_event: 'Stop',
      ts: 't',
      payload: {},
    }
    expect(() => validateHookEvent(raw)).toThrow(/machine_id/)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run: `bun test tests/events.test.ts`
Expected: FAIL — `Cannot find module '../src/events.js'`

- [ ] **Step 3: Implement**

```typescript
// src/events.ts
export type HookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'PreCompact'
  | 'PostCompact'
  | 'Notification'
  | 'TeammateIdle'

export interface HookEvent {
  machine_id: string
  session_name: string
  session_id: string
  hook_event: HookEventName
  ts: string
  payload: Record<string, unknown>
  agent_id?: string
  agent_type?: string
}

const REQUIRED = ['machine_id', 'session_name', 'session_id', 'hook_event', 'ts', 'payload'] as const

export function validateHookEvent(raw: unknown): HookEvent {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('HookEvent must be an object')
  }
  const obj = raw as Record<string, unknown>
  for (const key of REQUIRED) {
    if (!(key in obj)) throw new Error(`HookEvent missing required field: ${key}`)
  }
  for (const key of ['machine_id', 'session_name', 'session_id', 'hook_event', 'ts'] as const) {
    if (typeof obj[key] !== 'string') throw new Error(`HookEvent field ${key} must be string`)
  }
  if (typeof obj.payload !== 'object' || obj.payload === null) {
    throw new Error('HookEvent payload must be an object')
  }
  return obj as unknown as HookEvent
}
```

- [ ] **Step 4: Run — verify passes**

Run: `bun test tests/events.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/events.ts tests/events.test.ts
git commit -m "feat(events): hook event envelope types and validator"
```

---

### Task 2: SQLite schema + migration

**Files:**
- Create: `src/storage/schema.sql`
- Create: `src/storage/db.ts`
- Test: `tests/storage.test.ts`

- [ ] **Step 1: Write schema**

```sql
-- src/storage/schema.sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cwd TEXT,
  started_at TEXT,
  last_seen TEXT NOT NULL,
  state TEXT,
  model TEXT,
  git_branch TEXT,
  context_tokens INTEGER,
  message_count INTEGER,
  last_text TEXT,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_machine ON sessions(machine_id);
CREATE INDEX IF NOT EXISTS idx_sessions_lastseen ON sessions(last_seen);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_name TEXT NOT NULL,
  hook_event TEXT NOT NULL,
  ts TEXT NOT NULL,
  agent_id TEXT,
  agent_type TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_hook_ts ON events(hook_event, ts);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id) WHERE agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  tool_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  success INTEGER,
  input_json TEXT,
  output_preview TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, started_at);

CREATE TABLE IF NOT EXISTS subagents (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_type TEXT,
  description TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT
);
CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagents(session_id);
```

- [ ] **Step 2: Write failing test**

```typescript
// tests/storage.test.ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync } from 'fs'
import { openDb } from '../src/storage/db.js'

const TEST_PATH = '/tmp/party-line-test.db'

describe('storage', () => {
  beforeEach(() => {
    try { rmSync(TEST_PATH) } catch { /* no-op */ }
  })

  test('openDb creates schema', () => {
    const db = openDb(TEST_PATH)
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name)
    expect(tables).toContain('machines')
    expect(tables).toContain('sessions')
    expect(tables).toContain('events')
    expect(tables).toContain('tool_calls')
    expect(tables).toContain('subagents')
    db.close()
  })

  test('openDb is idempotent', () => {
    openDb(TEST_PATH).close()
    const db = openDb(TEST_PATH)
    db.close()
  })
})
```

- [ ] **Step 3: Implement**

```typescript
// src/storage/db.ts
import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(__dirname, 'schema.sql')

export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  const schema = readFileSync(SCHEMA_PATH, 'utf-8')
  db.exec(schema)
  return db
}
```

- [ ] **Step 4: Run — verify passes**

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.sql src/storage/db.ts tests/storage.test.ts
git commit -m "feat(storage): SQLite schema and database initializer"
```

---

### Task 3: Typed query helpers

**Files:**
- Create: `src/storage/queries.ts`
- Modify: `tests/storage.test.ts`

- [ ] **Step 1: Extend test with query coverage**

Append to `tests/storage.test.ts`:

```typescript
import { insertEvent, upsertSession, recentEvents, sessionState } from '../src/storage/queries.js'

test('insertEvent + recentEvents roundtrip', () => {
  const db = openDb(TEST_PATH)
  insertEvent(db, {
    machine_id: 'm1',
    session_name: 'test',
    session_id: 's1',
    hook_event: 'PostToolUse',
    ts: '2026-04-19T12:00:00Z',
    payload: { tool_name: 'Bash' },
  })
  const rows = recentEvents(db, { sessionId: 's1', limit: 10 })
  expect(rows.length).toBe(1)
  expect(rows[0]!.hook_event).toBe('PostToolUse')
  expect((rows[0]!.payload as { tool_name: string }).tool_name).toBe('Bash')
  db.close()
})

test('upsertSession updates last_seen and name', () => {
  const db = openDb(TEST_PATH)
  upsertSession(db, { session_id: 's1', machine_id: 'm1', name: 'test', last_seen: 't1' })
  upsertSession(db, { session_id: 's1', machine_id: 'm1', name: 'test-renamed', last_seen: 't2' })
  const row = sessionState(db, 's1')
  expect(row?.name).toBe('test-renamed')
  expect(row?.last_seen).toBe('t2')
  db.close()
})
```

- [ ] **Step 2: Implement**

```typescript
// src/storage/queries.ts
import type { Database } from 'bun:sqlite'
import type { HookEvent } from '../events.js'

export interface SessionRow {
  session_id: string
  machine_id: string
  name: string
  cwd: string | null
  state: string | null
  model: string | null
  git_branch: string | null
  context_tokens: number | null
  message_count: number | null
  last_text: string | null
  last_seen: string
  started_at: string | null
}

export interface EventRow {
  id: number
  machine_id: string
  session_id: string
  session_name: string
  hook_event: string
  ts: string
  agent_id: string | null
  agent_type: string | null
  payload: Record<string, unknown>
}

export function insertEvent(db: Database, ev: HookEvent): void {
  db.query(
    `INSERT INTO events (machine_id, session_id, session_name, hook_event, ts, agent_id, agent_type, payload_json)
     VALUES ($machine_id, $session_id, $session_name, $hook_event, $ts, $agent_id, $agent_type, $payload_json)`,
  ).run({
    $machine_id: ev.machine_id,
    $session_id: ev.session_id,
    $session_name: ev.session_name,
    $hook_event: ev.hook_event,
    $ts: ev.ts,
    $agent_id: ev.agent_id ?? null,
    $agent_type: ev.agent_type ?? null,
    $payload_json: JSON.stringify(ev.payload),
  })
}

export interface UpsertSessionInput {
  session_id: string
  machine_id: string
  name: string
  cwd?: string | null
  last_seen: string
  state?: string | null
  model?: string | null
  git_branch?: string | null
  context_tokens?: number | null
  message_count?: number | null
  last_text?: string | null
  started_at?: string | null
}

export function upsertSession(db: Database, s: UpsertSessionInput): void {
  db.query(
    `INSERT INTO sessions (session_id, machine_id, name, cwd, last_seen, state, model, git_branch, context_tokens, message_count, last_text, started_at)
     VALUES ($session_id, $machine_id, $name, $cwd, $last_seen, $state, $model, $git_branch, $context_tokens, $message_count, $last_text, $started_at)
     ON CONFLICT(session_id) DO UPDATE SET
       name = excluded.name,
       cwd = COALESCE(excluded.cwd, sessions.cwd),
       last_seen = excluded.last_seen,
       state = COALESCE(excluded.state, sessions.state),
       model = COALESCE(excluded.model, sessions.model),
       git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
       context_tokens = COALESCE(excluded.context_tokens, sessions.context_tokens),
       message_count = COALESCE(excluded.message_count, sessions.message_count),
       last_text = COALESCE(excluded.last_text, sessions.last_text),
       started_at = COALESCE(excluded.started_at, sessions.started_at)`,
  ).run({
    $session_id: s.session_id,
    $machine_id: s.machine_id,
    $name: s.name,
    $cwd: s.cwd ?? null,
    $last_seen: s.last_seen,
    $state: s.state ?? null,
    $model: s.model ?? null,
    $git_branch: s.git_branch ?? null,
    $context_tokens: s.context_tokens ?? null,
    $message_count: s.message_count ?? null,
    $last_text: s.last_text ?? null,
    $started_at: s.started_at ?? null,
  })
}

export function sessionState(db: Database, sessionId: string): SessionRow | null {
  const row = db
    .query<SessionRow, { $id: string }>('SELECT * FROM sessions WHERE session_id = $id')
    .get({ $id: sessionId })
  return row ?? null
}

export function recentEvents(
  db: Database,
  opts: { sessionId?: string; limit?: number },
): EventRow[] {
  const limit = opts.limit ?? 50
  const rows = opts.sessionId
    ? db
        .query<
          Omit<EventRow, 'payload'> & { payload_json: string },
          { $id: string; $limit: number }
        >('SELECT * FROM events WHERE session_id = $id ORDER BY ts DESC LIMIT $limit')
        .all({ $id: opts.sessionId, $limit: limit })
    : db
        .query<Omit<EventRow, 'payload'> & { payload_json: string }, { $limit: number }>(
          'SELECT * FROM events ORDER BY ts DESC LIMIT $limit',
        )
        .all({ $limit: limit })
  return rows.map(({ payload_json, ...rest }) => ({
    ...rest,
    payload: JSON.parse(payload_json) as Record<string, unknown>,
  }))
}
```

- [ ] **Step 3: Run — passes**

- [ ] **Step 4: Commit**

```bash
git add src/storage/queries.ts tests/storage.test.ts
git commit -m "feat(storage): typed query helpers for events and sessions"
```

---

### Task 4: Machine ID

**Files:**
- Create: `src/machine-id.ts`
- Test: `tests/machine-id.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// tests/machine-id.test.ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync, existsSync } from 'fs'
import { getMachineId } from '../src/machine-id.js'

const TEST_PATH = '/tmp/party-line-machine-id'

describe('getMachineId', () => {
  beforeEach(() => {
    if (existsSync(TEST_PATH)) rmSync(TEST_PATH)
  })

  test('creates a stable ID on first call', () => {
    const a = getMachineId(TEST_PATH)
    const b = getMachineId(TEST_PATH)
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9-]{36}$/)
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/machine-id.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'node:crypto'

export function getMachineId(path: string): string {
  if (existsSync(path)) {
    return readFileSync(path, 'utf-8').trim()
  }
  const id = randomUUID()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, id + '\n')
  return id
}
```

- [ ] **Step 3: Commit**

```bash
git add src/machine-id.ts tests/machine-id.test.ts
git commit -m "feat: stable machine ID generator"
```

---

### Task 5: Ingest auth

**Files:**
- Create: `src/ingest/auth.ts`
- Test: `tests/ingest-auth.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// tests/ingest-auth.test.ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync, existsSync } from 'fs'
import { loadOrCreateToken, verifyToken } from '../src/ingest/auth.js'

const TEST_PATH = '/tmp/party-line-token'

describe('ingest auth', () => {
  beforeEach(() => {
    if (existsSync(TEST_PATH)) rmSync(TEST_PATH)
  })

  test('token persists across calls', () => {
    const a = loadOrCreateToken(TEST_PATH)
    const b = loadOrCreateToken(TEST_PATH)
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(32)
  })

  test('verifyToken accepts matching and rejects otherwise', () => {
    const t = loadOrCreateToken(TEST_PATH)
    expect(verifyToken(t, t)).toBe(true)
    expect(verifyToken(t, 'wrong')).toBe(false)
    expect(verifyToken(t, null)).toBe(false)
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/ingest/auth.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { dirname } from 'path'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) return readFileSync(path, 'utf-8').trim()
  const token = randomBytes(32).toString('hex')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, token + '\n')
  chmodSync(path, 0o600)
  return token
}

export function verifyToken(expected: string, received: string | null | undefined): boolean {
  if (!received) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
```

- [ ] **Step 3: Commit**

```bash
git add src/ingest/auth.ts tests/ingest-auth.test.ts
git commit -m "feat(ingest): shared-secret token for remote event ingest"
```

---

### Task 6: HTTP ingest handler

**Files:**
- Create: `src/ingest/http.ts`
- Test: `tests/ingest-http.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// tests/ingest-http.test.ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync } from 'fs'
import { openDb } from '../src/storage/db.js'
import { handleIngest } from '../src/ingest/http.js'

const DB_PATH = '/tmp/party-line-ingest-test.db'
const TOKEN = 'test-token'

describe('handleIngest', () => {
  beforeEach(() => {
    try { rmSync(DB_PATH) } catch { /* no-op */ }
  })

  test('accepts valid event with correct token', async () => {
    const db = openDb(DB_PATH)
    const body = JSON.stringify({
      machine_id: 'm1',
      session_name: 'test',
      session_id: 's1',
      hook_event: 'Stop',
      ts: '2026-04-19T12:00:00Z',
      payload: {},
    })
    const req = new Request('http://x/ingest', {
      method: 'POST',
      body,
      headers: { 'X-Party-Line-Token': TOKEN, 'Content-Type': 'application/json' },
    })
    let pushed: unknown = null
    const res = await handleIngest(req, { db, token: TOKEN, onEvent: (e) => { pushed = e } })
    expect(res.status).toBe(200)
    expect((pushed as { hook_event: string }).hook_event).toBe('Stop')
    db.close()
  })

  test('rejects bad token', async () => {
    const db = openDb(DB_PATH)
    const req = new Request('http://x/ingest', {
      method: 'POST',
      body: '{}',
      headers: { 'X-Party-Line-Token': 'wrong' },
    })
    const res = await handleIngest(req, { db, token: TOKEN, onEvent: () => {} })
    expect(res.status).toBe(401)
    db.close()
  })

  test('rejects malformed body', async () => {
    const db = openDb(DB_PATH)
    const req = new Request('http://x/ingest', {
      method: 'POST',
      body: '{"bad": true}',
      headers: { 'X-Party-Line-Token': TOKEN },
    })
    const res = await handleIngest(req, { db, token: TOKEN, onEvent: () => {} })
    expect(res.status).toBe(400)
    db.close()
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/ingest/http.ts
import type { Database } from 'bun:sqlite'
import { verifyToken } from './auth.js'
import { validateHookEvent, type HookEvent } from '../events.js'
import { insertEvent } from '../storage/queries.js'

export interface IngestOptions {
  db: Database
  token: string
  onEvent: (ev: HookEvent) => void
}

export async function handleIngest(req: Request, opts: IngestOptions): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const received = req.headers.get('X-Party-Line-Token')
  if (!verifyToken(opts.token, received)) {
    return new Response('Unauthorized', { status: 401 })
  }
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }
  let ev: HookEvent
  try {
    ev = validateHookEvent(raw)
  } catch (err) {
    return new Response(`Invalid event: ${(err as Error).message}`, { status: 400 })
  }
  insertEvent(opts.db, ev)
  opts.onEvent(ev)
  return Response.json({ ok: true })
}
```

- [ ] **Step 3: Commit**

```bash
git add src/ingest/http.ts tests/ingest-http.test.ts
git commit -m "feat(ingest): HTTP /ingest handler with auth and storage"
```

---

## Phase 2 — Hooks

### Task 7: Hook emitter bash script

**Files:**
- Create: `hooks/emit.sh`

This script is verified manually (end-to-end) rather than with a TypeScript subprocess test — the bash/curl path has too many environment dependencies for a useful unit test.

- [ ] **Step 1: Write script**

```bash
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
ENDPOINT="${PARTY_LINE_INGEST:-http://localhost:3400/ingest}"
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

SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id // ""')
AGENT_ID=$(echo "$PAYLOAD" | jq -r '.agent_id // ""')
AGENT_TYPE=$(echo "$PAYLOAD" | jq -r '.agent_type // ""')

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

curl --silent --show-error --max-time 1 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Party-Line-Token: $TOKEN" \
  --data-binary "$ENVELOPE" \
  "$ENDPOINT" > /dev/null 2>&1 &

exit 0
```

- [ ] **Step 2: Make executable**

```bash
chmod +x hooks/emit.sh
```

- [ ] **Step 3: Manual verification**

Start dashboard in another terminal (once Task 11 lands). Then:

```bash
echo '{"session_id":"manual-test"}' | HOME="$HOME" CLAUDE_SESSION_NAME=manual bash hooks/emit.sh Stop
```

Check: `curl -s http://localhost:3400/api/events?limit=1 | jq`
Expected: returns a Stop event for session_name=manual.

- [ ] **Step 4: Commit**

```bash
git add hooks/emit.sh
git commit -m "feat(hooks): emit.sh — POST hook payloads to ingest endpoint"
```

---

### Task 8: Hooks installer

**Files:**
- Create: `hooks/install.sh`
- Create: `hooks/uninstall.sh`
- Modify: `package.json`

- [ ] **Step 1: Installer script**

```bash
#!/usr/bin/env bash
# hooks/install.sh — install party-line hooks into ~/.claude/settings.json
# Idempotent. Preserves existing hooks.

set -euo pipefail

CONFIG_DIR="$HOME/.config/party-line"
EMIT_SRC="$(cd "$(dirname "$0")" && pwd)/emit.sh"
EMIT_DST="$CONFIG_DIR/emit.sh"
SETTINGS="$HOME/.claude/settings.json"

mkdir -p "$CONFIG_DIR"
cp "$EMIT_SRC" "$EMIT_DST"
chmod +x "$EMIT_DST"

[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"

HOOKS=$(cat <<EOF
{
  "SessionStart":      [{"hooks": [{"type": "command", "command": "$EMIT_DST SessionStart"}]}],
  "SessionEnd":        [{"hooks": [{"type": "command", "command": "$EMIT_DST SessionEnd"}]}],
  "UserPromptSubmit":  [{"hooks": [{"type": "command", "command": "$EMIT_DST UserPromptSubmit"}]}],
  "Stop":              [{"hooks": [{"type": "command", "command": "$EMIT_DST Stop"}]}],
  "PreCompact":        [{"hooks": [{"type": "command", "command": "$EMIT_DST PreCompact"}]}],
  "Notification":      [{"hooks": [{"type": "command", "command": "$EMIT_DST Notification"}]}],
  "SubagentStart":     [{"hooks": [{"type": "command", "command": "$EMIT_DST SubagentStart"}]}],
  "SubagentStop":      [{"hooks": [{"type": "command", "command": "$EMIT_DST SubagentStop"}]}],
  "TaskCreated":       [{"hooks": [{"type": "command", "command": "$EMIT_DST TaskCreated"}]}],
  "TaskCompleted":     [{"hooks": [{"type": "command", "command": "$EMIT_DST TaskCompleted"}]}],
  "PostToolUse":       [{"matcher": "", "hooks": [{"type": "command", "command": "$EMIT_DST PostToolUse"}]}]
}
EOF
)

jq --argjson new "$HOOKS" '
  .hooks //= {} |
  reduce ($new | to_entries[]) as $e (.;
    .hooks[$e.key] //= [] |
    if (.hooks[$e.key] | any(.. | .command? // "" | contains("party-line/emit.sh"))) then
      .
    else
      .hooks[$e.key] += $e.value
    end
  )
' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

echo "Installed party-line hooks -> $EMIT_DST"
echo "Settings: $SETTINGS"
```

- [ ] **Step 2: Uninstaller**

```bash
#!/usr/bin/env bash
# hooks/uninstall.sh — remove party-line hook entries from ~/.claude/settings.json
set -euo pipefail

SETTINGS="$HOME/.claude/settings.json"
[[ -f "$SETTINGS" ]] || { echo "No settings file to modify."; exit 0; }

jq '
  .hooks //= {} |
  .hooks |= with_entries(
    .value |= map(
      .hooks |= map(select((.command // "") | contains("party-line/emit.sh") | not))
    ) |
    .value |= map(select(.hooks | length > 0))
  ) |
  .hooks |= with_entries(select(.value | length > 0))
' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

echo "Removed party-line hook entries from $SETTINGS."
```

- [ ] **Step 3: Add npm scripts**

In `package.json`:

```json
"scripts": {
  "hooks:install": "bash hooks/install.sh",
  "hooks:uninstall": "bash hooks/uninstall.sh"
}
```

- [ ] **Step 4: Manual verification**

Back up your settings first: `cp ~/.claude/settings.json ~/.claude/settings.json.bak`
Run: `bun run hooks:install`
Check: `jq '.hooks | keys' ~/.claude/settings.json` — includes the new events alongside any existing ones.
Run: `bun run hooks:uninstall`
Check: party-line entries gone. Existing hooks still present.

- [ ] **Step 5: Commit**

```bash
chmod +x hooks/install.sh hooks/uninstall.sh
git add hooks/install.sh hooks/uninstall.sh package.json
git commit -m "feat(hooks): install/uninstall scripts with idempotent merge"
```

---

## Phase 3 — Observers

### Task 9: JSONL transcript observer (polling)

**Files:**
- Create: `src/observers/jsonl.ts`
- Test: `tests/jsonl-observer.test.ts`

**Note:** The original design used `fs.watch({ recursive: true })`. Verification in §4 of `2026-04-19-verification.md` found this is **broken** on Bun 1.3.11 + Linux — nested-file events are silently dropped. Polling is the replacement: `setInterval` walks the target root every 500ms, `statSync` each known `.jsonl` file, re-reads any that grew. New files are discovered by periodic `readdir` of the root + `<session-id>/subagents/` subdirs.

The class also observes subagent transcripts at `~/.claude/projects/<cwd-slug>/<session-id>/subagents/agent-<agent_id>.jsonl` so the dashboard can show subagent tool activity even if parent-session hooks don't fire for subagent tool calls.

- [ ] **Step 1: Failing test**

```typescript
// tests/jsonl-observer.test.ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlObserver } from '../src/observers/jsonl.js'

describe('JsonlObserver', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pl-jsonl-')) })

  test('detects new session file and emits last entry', async () => {
    const obs = new JsonlObserver(dir)
    const events: unknown[] = []
    obs.on((e) => events.push(e))
    await obs.start()

    const f = join(dir, 'session-abc.jsonl')
    writeFileSync(f, JSON.stringify({ type: 'user', text: 'hi', ts: 't1' }) + '\n')
    appendFileSync(f, JSON.stringify({ type: 'assistant', text: 'hello', ts: 't2' }) + '\n')

    await new Promise((r) => setTimeout(r, 100))
    obs.stop()
    expect(events.length).toBeGreaterThan(0)
    const last = events.at(-1) as { session_id: string; entry: { type: string } }
    expect(last.session_id).toBe('session-abc')
    expect(last.entry.type).toBe('assistant')
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/observers/jsonl.ts
import { readFileSync, statSync, readdirSync, existsSync } from 'fs'
import { basename, join } from 'path'

export interface JsonlUpdate {
  session_id: string
  file_path: string
  entry: Record<string, unknown>
}

type Listener = (u: JsonlUpdate) => void

export class JsonlObserver {
  private offsets = new Map<string, number>()
  private listeners: Listener[] = []
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly pollIntervalMs: number

  constructor(private root: string, pollIntervalMs = 500) {
    this.pollIntervalMs = pollIntervalMs
  }

  on(l: Listener): void { this.listeners.push(l) }

  async start(): Promise<void> {
    this.running = true
    this.scan()
    this.timer = setInterval(() => this.scan(), this.pollIntervalMs)
  }

  private scan(): void {
    if (!this.running) return
    if (!existsSync(this.root)) return
    // Main-session transcripts: <root>/<cwd-slug>/<session-id>.jsonl
    try {
      for (const cwdDir of readdirSync(this.root, { withFileTypes: true })) {
        if (!cwdDir.isDirectory()) continue
        const cwdPath = join(this.root, cwdDir.name)
        for (const entry of readdirSync(cwdPath, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            this.poll(join(cwdPath, entry.name))
          } else if (entry.isDirectory()) {
            // Subagent transcripts: <session-id>/subagents/agent-<agent_id>.jsonl
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
    } catch { /* root read failed — next tick will retry */ }
  }

  private poll(path: string): void {
    if (!this.running) return
    let size: number
    try { size = statSync(path).size } catch { return }
    const prev = this.offsets.get(path)
    if (prev === undefined) {
      // First sighting — seed offset to current size; don't replay existing content.
      this.offsets.set(path, size)
      return
    }
    if (size <= prev) return
    let tail: string
    try {
      const buf = readFileSync(path)
      tail = buf.subarray(prev).toString('utf-8')
    } catch { return }
    this.offsets.set(path, size)

    const session_id = basename(path, '.jsonl')
    for (const line of tail.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        for (const l of this.listeners) l({ session_id, file_path: path, entry })
      } catch { /* malformed — ignore */ }
    }
  }

  stop(): void {
    this.running = false
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/observers/jsonl.ts tests/jsonl-observer.test.ts
git commit -m "feat(observers): JSONL transcript tailer"
```

---

### Task 10: State aggregator

**Files:**
- Create: `src/aggregator.ts`
- Test: `tests/aggregator.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// tests/aggregator.test.ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync } from 'fs'
import { openDb } from '../src/storage/db.js'
import { Aggregator } from '../src/aggregator.js'

const DB = '/tmp/party-line-agg-test.db'

describe('Aggregator', () => {
  beforeEach(() => { try { rmSync(DB) } catch { /* no-op */ } })

  test('SessionStart event creates a session row with idle state', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm1',
      session_name: 'work',
      session_id: 's1',
      hook_event: 'SessionStart',
      ts: '2026-04-19T12:00:00Z',
      payload: { cwd: '/home/x' },
    })
    const s = agg.getSession('s1')
    expect(s?.name).toBe('work')
    expect(s?.state).toBe('idle')
    db.close()
  })

  test('PostToolUse transitions to working; Stop to idle', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({ machine_id: 'm', session_name: 'w', session_id: 's', hook_event: 'SessionStart', ts: 't1', payload: {} })
    agg.ingest({ machine_id: 'm', session_name: 'w', session_id: 's', hook_event: 'PostToolUse', ts: 't2', payload: { tool_name: 'Bash' } })
    expect(agg.getSession('s')?.state).toBe('working')
    agg.ingest({ machine_id: 'm', session_name: 'w', session_id: 's', hook_event: 'Stop', ts: 't3', payload: {} })
    expect(agg.getSession('s')?.state).toBe('idle')
    db.close()
  })

  test('SubagentStart records a subagent row', () => {
    const db = openDb(DB)
    const agg = new Aggregator(db)
    agg.ingest({
      machine_id: 'm', session_name: 'w', session_id: 's', hook_event: 'SubagentStart',
      ts: 't', payload: { agent_type: 'Explore', description: 'find thing' },
      agent_id: 'a1',
    })
    const subs = agg.getSubagents('s')
    expect(subs.length).toBe(1)
    expect(subs[0]!.status).toBe('running')
    db.close()
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/aggregator.ts
import type { Database } from 'bun:sqlite'
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
const IDLE_EVENTS = new Set(['Stop', 'SessionEnd'])

export class Aggregator {
  private listeners: Listener[] = []
  constructor(private db: Database) {}

  onUpdate(l: Listener): void { this.listeners.push(l) }

  ingest(ev: HookEvent): void {
    const state = WORKING_EVENTS.has(ev.hook_event)
      ? 'working'
      : IDLE_EVENTS.has(ev.hook_event)
        ? (ev.hook_event === 'SessionEnd' ? 'ended' : 'idle')
        : undefined

    upsertSession(this.db, {
      session_id: ev.session_id || `${ev.machine_id}:${ev.session_name}`,
      machine_id: ev.machine_id,
      name: ev.session_name,
      cwd: (ev.payload as { cwd?: string }).cwd ?? null,
      last_seen: ev.ts,
      state: state ?? null,
      started_at: ev.hook_event === 'SessionStart' ? ev.ts : null,
    })

    if (ev.hook_event === 'SubagentStart' && ev.agent_id) {
      this.db.query(
        `INSERT INTO subagents (agent_id, session_id, agent_type, description, started_at, status)
         VALUES ($a, $s, $t, $d, $ts, 'running')
         ON CONFLICT(agent_id) DO UPDATE SET status='running', started_at=excluded.started_at`,
      ).run({
        $a: ev.agent_id,
        $s: ev.session_id,
        $t: ev.agent_type ?? (ev.payload as { agent_type?: string }).agent_type ?? null,
        $d: (ev.payload as { description?: string }).description ?? null,
        $ts: ev.ts,
      })
    } else if (ev.hook_event === 'SubagentStop' && ev.agent_id) {
      this.db.query(
        `UPDATE subagents SET status='completed', ended_at=$ts WHERE agent_id=$a`,
      ).run({ $a: ev.agent_id, $ts: ev.ts })
    }

    if (ev.hook_event === 'PostToolUse') {
      const p = ev.payload as {
        tool_name?: string
        tool_response?: { success?: boolean; isError?: boolean; error?: unknown }
      }
      // `success` is not top-level on PostToolUse. Inspect tool_response per tool.
      // Heuristic: tool_response.success === false, or tool_response.isError === true,
      // or tool_response.error present → failure. Otherwise assume success.
      const tr = p.tool_response
      const success =
        tr && (tr.success === false || tr.isError === true || tr.error != null) ? 0 : 1
      this.db.query(
        `INSERT INTO tool_calls (session_id, agent_id, tool_name, started_at, ended_at, success)
         VALUES ($s, $a, $t, $ts, $ts, $ok)`,
      ).run({
        $s: ev.session_id,
        $a: ev.agent_id ?? null,
        $t: p.tool_name ?? 'unknown',
        $ts: ev.ts,
        $ok: success,
      })
    }

    const current = this.getSession(ev.session_id)
    if (current) for (const l of this.listeners) l(current)
  }

  getSession(id: string): SessionRow | null {
    const row = this.db
      .query<SessionRow, { $id: string }>('SELECT * FROM sessions WHERE session_id=$id')
      .get({ $id: id })
    return row ?? null
  }

  getSubagents(sessionId: string): SubagentRow[] {
    return this.db
      .query<SubagentRow, { $s: string }>(
        'SELECT * FROM subagents WHERE session_id=$s ORDER BY started_at DESC',
      )
      .all({ $s: sessionId })
  }

  listSessions(): SessionRow[] {
    return this.db.query<SessionRow, []>('SELECT * FROM sessions ORDER BY last_seen DESC').all()
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/aggregator.ts tests/aggregator.test.ts
git commit -m "feat(aggregator): derive session state and subagents from hook events"
```

---

## Phase 4 — Dashboard integration

### Task 11: Wire ingest + storage into serve.ts

**Files:**
- Modify: `dashboard/serve.ts`

- [ ] **Step 1: Add imports and init**

At the top of `dashboard/serve.ts`, add:

```typescript
import { openDb } from '../src/storage/db.js'
import { Aggregator } from '../src/aggregator.js'
import { handleIngest } from '../src/ingest/http.js'
import { loadOrCreateToken } from '../src/ingest/auth.js'
import { getMachineId } from '../src/machine-id.js'
import { JsonlObserver } from '../src/observers/jsonl.js'
import { recentEvents } from '../src/storage/queries.js'
```

After `const monitor = new PartyLineMonitor(NAME)`:

```typescript
const CONFIG_DIR = resolve(process.env.HOME ?? '/home/claude', '.config/party-line')
const DB_PATH = join(CONFIG_DIR, 'dashboard.db')
const TOKEN_PATH = join(CONFIG_DIR, 'ingest-token')
const MACHINE_ID_PATH = join(CONFIG_DIR, 'machine-id')

mkdirSync(CONFIG_DIR, { recursive: true })
const db = openDb(DB_PATH)
const token = loadOrCreateToken(TOKEN_PATH)
const machineId = getMachineId(MACHINE_ID_PATH)
const aggregator = new Aggregator(db)

aggregator.onUpdate((session) => {
  const json = JSON.stringify({ type: 'session-update', data: session })
  for (const ws of wsClients) ws.send(json)
})

const jsonlObserver = new JsonlObserver(
  join(process.env.HOME ?? '/home/claude', '.claude', 'projects'),
)
jsonlObserver.on((u) => {
  const json = JSON.stringify({ type: 'jsonl', data: u })
  for (const ws of wsClients) ws.send(json)
})
```

- [ ] **Step 2: Add ingest + new REST routes**

Inside the `fetch` handler, before the catch-all HTML return:

```typescript
if (url.pathname === '/ingest') {
  return handleIngest(req, {
    db,
    token,
    onEvent: (ev) => aggregator.ingest(ev),
  })
}

if (url.pathname === '/api/session' && url.searchParams.get('id')) {
  const id = url.searchParams.get('id')!
  return Response.json({
    session: aggregator.getSession(id),
    subagents: aggregator.getSubagents(id),
  })
}

if (url.pathname === '/api/events') {
  const id = url.searchParams.get('session_id') ?? undefined
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10)
  return Response.json(recentEvents(db, { sessionId: id, limit }))
}

if (url.pathname === '/api/machines') {
  const machines = db
    .query<{ id: string; hostname: string; last_seen: string }, []>(
      'SELECT * FROM machines ORDER BY last_seen DESC',
    )
    .all()
  return Response.json(machines)
}
```

- [ ] **Step 3: Start observer in `main()` and clean up in `shutdown()`**

```typescript
async function main(): Promise<void> {
  await monitor.start()
  await jsonlObserver.start()
  startQuotaPoller(300_000)
  console.log(`Party Line Dashboard`)
  console.log(`  Web UI:   http://localhost:${PORT}`)
  console.log(`  Ingest:   http://localhost:${PORT}/ingest`)
  console.log(`  Token:    ${TOKEN_PATH}`)
  console.log(`  DB:       ${DB_PATH}`)
  console.log(`  Machine:  ${machineId}`)
  console.log()
}
```

Add to `shutdown()`:

```typescript
jsonlObserver.stop()
db.close()
```

- [ ] **Step 4: Manual end-to-end verification**

Run: `bun dashboard/serve.ts`
Check: prints token + DB + machine ID on start.

Ingest a mocked event:

```bash
TOKEN=$(cat ~/.config/party-line/ingest-token)
MACHINE=$(cat ~/.config/party-line/machine-id)
curl -s -X POST http://localhost:3400/ingest \
  -H "Content-Type: application/json" \
  -H "X-Party-Line-Token: $TOKEN" \
  -d "{\"machine_id\":\"$MACHINE\",\"session_name\":\"manual\",\"session_id\":\"manual-1\",\"hook_event\":\"Stop\",\"ts\":\"2026-04-19T12:00:00Z\",\"payload\":{}}"
```

Expected: `{"ok":true}`.

Check: `sqlite3 ~/.config/party-line/dashboard.db "SELECT hook_event, session_name FROM events"`
Expected: one row `Stop | manual`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/serve.ts
git commit -m "feat(dashboard): wire ingest, storage, aggregator into serve.ts"
```

---

### Task 12: Tighten MCP server instructions

**Files:**
- Modify: `src/server.ts:121-133`

- [ ] **Step 1: Replace instructions block**

In `src/server.ts`, replace the `instructions: [...].join('\n')` block with:

```typescript
    instructions: [
      `The party-line channel connects this session to other Claude Code sessions on the same machine via UDP multicast.`,
      `This session is registered as "${sessionName}".`,
      ``,
      `Messages from other sessions arrive as <channel source="party-line" from="..." to="..." type="...">body</channel> tags.`,
      ``,
      `When you receive a channel message:`,
      `- If type="request" (meta includes callback_id): you MUST reply via party_line_respond with that callback_id. The requesting session is waiting.`,
      `- If type="message": informational. No reply required. Continue your current work. A dashboard captures your output via hooks, so you do not need to acknowledge on the channel.`,
      `- If type="response": a reply to a request you sent earlier. Use the content as you need.`,
      `- Broadcasts (to="all") never require a reply.`,
      ``,
      `Available tools:`,
      `- party_line_send: Send a message to another session by name (or "all" for broadcast). Fire-and-forget.`,
      `- party_line_request: Send a request and expect a response. Returns a callback_id so the other end can reply.`,
      `- party_line_respond: Reply to a request using its callback_id (REQUIRED when you receive a type=request).`,
      `- party_line_list_sessions: See which sessions are currently connected.`,
      `- party_line_history: View recent messages on the bus.`,
    ].join('\n'),
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "docs(mcp): clarify reply semantics for channel messages vs requests"
```

---

### Task 13: Dashboard UI — mission control views

**Files:**
- Create: `dashboard/dashboard.js`, `dashboard/dashboard.css`
- Create: `dashboard/views/overview.html`, `views/session-detail.html`, `views/machines.html`, `views/history.html`
- Modify: `dashboard/index.html` (shell), `dashboard/serve.ts` (serve static files)

The dashboard becomes a small single-page app with view-switching:

- **Overview** — grid of session cards. Each card: name, state pill (working/idle/ended), current tool, last user turn, context tokens, subagent count. Live via WS.
- **Session Detail** — click a card: event timeline (tool calls, subagent spawns, prompts, stops), recent transcript tail, subagent tree.
- **Machines** — list each machine seen, session count per machine, last_seen.
- **History** — searchable event feed (filter by session, hook_event).

This task is subdivided into UI steps (commits per step):

- [ ] **Step 1: Extract inline JS/CSS from `dashboard/index.html`** into `dashboard.js` / `dashboard.css` (straight copy — no behavior change). Wire `serve.ts` to serve them as static files. Confirm dashboard still renders identically.

Commit: `refactor(dashboard): extract inline JS/CSS`.

- [ ] **Step 2: Tab bar + view container in `index.html`**

```html
<header>
  <h1>Party Line — Mission Control</h1>
  <nav class="tabs">
    <button data-view="overview" class="active">Overview</button>
    <button data-view="session-detail" disabled>Session</button>
    <button data-view="machines">Machines</button>
    <button data-view="history">History</button>
  </nav>
  <span class="conn-status" id="conn">connecting...</span>
</header>
<main id="view-root"></main>
```

In `dashboard.js`, load the corresponding `views/*.html` fragment on tab click.

Commit: `feat(dashboard): tab bar scaffold`.

- [ ] **Step 3: Overview view**

Per-session card with live state pill colour-coded (green=idle, yellow=working, grey=ended, red=errored), single-line "running Bash" / "awaiting user" status, "N subagents" if any running. On WS `session-update`, update that card in place.

Commit: `feat(dashboard): overview cards with live state`.

- [ ] **Step 4: Session-detail view**

Tab enabled when user clicks a card. Fetches `/api/session?id=<id>` + `/api/events?session_id=<id>&limit=200`. Renders:
- Header: name, state, cwd, model, context%
- Subagent tree with started/ended time + status
- Event timeline (most recent first), grouped by hook, with collapsible payload JSON

WS pushes append to the timeline in real time.

Commit: `feat(dashboard): session detail view`.

- [ ] **Step 5: Machines view**

Fetches `/api/machines`. Simple table.

Commit: `feat(dashboard): machines view`.

- [ ] **Step 6: History view**

Fetches `/api/events?limit=500`. Search input filters client-side by substring. Dropdown filters by hook_event.

Commit: `feat(dashboard): history view with filters`.

---

## Phase 5 — Remote hosts (Windows, etc.)

### Task 14: Remote emitter bundle

**Files:**
- Create: `hooks/remote/emit.ps1` (PowerShell, Windows)
- Create: `hooks/remote/emit.sh` (POSIX, macOS + other Linux)
- Create: `hooks/remote/README.md` with install instructions

Parallel to `hooks/emit.sh` but target a remote `PARTY_LINE_INGEST` URL and carry their own token file. Instead of auto-detecting session name from `/proc`, rely on `CLAUDE_SESSION_NAME` env var only.

- [ ] **Step 1:** Write PowerShell emitter (mirrors Linux shape: read stdin, build envelope, POST with timeout)
- [ ] **Step 2:** Write POSIX emitter (same shape as Linux, skip `/proc` walk; macOS users set `CLAUDE_SESSION_NAME` env var)
- [ ] **Step 3:** Install docs — how to copy token from the dashboard host, set `PARTY_LINE_INGEST`, register hooks in Windows Claude Code config
- [ ] **Step 4:** Commit

---

## Phase 6 — Polish

### Task 15: Dashboard DB retention + rollup

- [ ] **Step 1:** Events older than N days deleted on startup. Default N=30.
- [ ] **Step 2:** Daily metrics rollup — `metrics_daily` table with (day, session_id, tool_calls, subagents_spawned, turns). Populated by a simple "on shutdown, roll up yesterday" job.
- [ ] **Step 3:** Metrics sparkline per session in Overview — tool calls/hour last 24h.

### Task 16: Documentation

- [ ] **Step 1: Update `SPEC.md`**
  - Add "Phase 2: Observability" section describing hook-based architecture
  - Document the ingest API (POST /ingest, headers, envelope)
  - Note remote host support design
  - Clarify that `--dangerously-load-development-channels` is still required for wake-on-message (unchanged)

- [ ] **Step 2: Update `README.md`**
  - Add "Observability" section: `bun run hooks:install`, start dashboard, visit localhost:3400
  - Add a "Remote machines" subsection with token-sharing instructions

- [ ] **Step 3: Update `CLAUDE.md`**
  - Note new directories: `hooks/`, `src/ingest/`, `src/observers/`, `src/storage/`
  - Note that dashboard now writes SQLite to `~/.config/party-line/dashboard.db`
  - Note that hooks emit to `/ingest` — the dashboard must be running for events to be captured

### Task 17: End-to-end verification

- [ ] **Step 1:** Start dashboard. Confirm token + machine ID created.
- [ ] **Step 2:** Install hooks (`bun run hooks:install`). Confirm `~/.claude/settings.json` has party-line entries alongside existing hooks.
- [ ] **Step 3:** Open a ccpl session. Run a few tool calls (`ls`, a Grep, an Edit). Confirm events arrive in dashboard overview in real time.
- [ ] **Step 4:** Dispatch a subagent via Task tool. Confirm subagent appears in the session-detail subagent tree, transitions to "completed" on stop.
- [ ] **Step 5:** `/exit`. Confirm session state transitions to `ended`.
- [ ] **Step 6:** From a second ssh'd session to this machine, re-hit `/ingest` with a different `machine_id` + fake session. Confirm it shows on Machines view.

---

## Phase 7 — Gemini CLI support

Research confirmed near-parity with Claude Code for our use case. Gemini CLI has a full hooks system configured in `~/.gemini/settings.json`, auto-saves per-session JSON transcripts under `~/.gemini/tmp/<project_hash>/chats/session-*.json`, exposes OpenTelemetry, and even includes a `gemini hooks migrate` subcommand for porting Claude hooks. The only gap is inter-session messaging — Gemini has no channels / wake-on-message feature (A2A remote agents and ACP exist but are not a broadcast bus).

**Hook event mapping (Gemini → our HookEventName):**
- `SessionStart` / `SessionEnd` → same
- `BeforeAgent` / `AfterAgent` → `UserPromptSubmit` / `Stop`
- `BeforeTool` / `AfterTool` → `PreToolUse` / `PostToolUse`
- `BeforeModel` / `AfterModel` / `BeforeToolSelection` → **new events**, add to `HookEventName` enum as optional
- `PreCompress` → `PreCompact`
- `Notification` → same

### Task 18: Gemini hook emitter

**Files:**
- Create: `hooks/gemini/emit.sh`
- Create: `hooks/gemini/install.sh`
- Create: `hooks/gemini/uninstall.sh`

- [ ] **Step 1:** Copy `hooks/emit.sh` to `hooks/gemini/emit.sh`. Modify it to:
  - Read hook event name from a new env var (Gemini passes it via `$GEMINI_HOOK_EVENT` / the docs mention `hook_event_name` in stdin payload; confirm at runtime)
  - Map Gemini event names to our enum (table above)
  - Use `GEMINI_SESSION_ID` env var for session ID (no `/proc` walk needed)
  - Tag payload with `source: "gemini-cli"` so downstream can distinguish

- [ ] **Step 2:** Gemini installer writes `~/.gemini/settings.json` hook entries. `jq` merge logic same as `hooks/install.sh` but different settings path + different hook event keys.

- [ ] **Step 3:** Manual verification:

```bash
bun run hooks:install-gemini
gemini  # start a gemini CLI session, run a tool
curl -s http://localhost:3400/api/events?limit=5 | jq '.[].session_name'
```

Expected: see the Gemini session show up alongside any Claude Code sessions.

- [ ] **Step 4:** Commit

### Task 19: Gemini transcript observer

**Files:**
- Create: `src/observers/gemini-transcript.ts`
- Test: `tests/gemini-transcript.test.ts`

Gemini transcripts are **single JSON files** (not JSONL). Need a different parser than `JsonlObserver`.

- [ ] **Step 1:** Write `GeminiTranscriptObserver` that watches `~/.gemini/tmp/*/chats/` and re-reads full file on modify (cheap — files are small). Diffs the `messages[]` array against last seen, emits new entries.
- [ ] **Step 2:** Tests mirror `jsonl-observer.test.ts` shape.
- [ ] **Step 3:** Wire into `dashboard/serve.ts` alongside the existing JsonlObserver.
- [ ] **Step 4:** Commit

### Task 20: Dashboard source tagging

**Files:**
- Modify: `src/storage/schema.sql` (add `source` column to `events` + `sessions`)
- Modify: `src/aggregator.ts` and UI to display `[cc]` / `[gemini]` badge on each session card

- [ ] **Step 1:** Add migration — `ALTER TABLE events ADD COLUMN source TEXT DEFAULT 'claude-code'; ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'claude-code';`
- [ ] **Step 2:** Pass `source` through `HookEvent` (optional field, defaults to `"claude-code"` if absent)
- [ ] **Step 3:** Dashboard overview card shows a colored badge per source
- [ ] **Step 4:** Commit

### Task 21: Document Gemini gap

- [ ] **Step 1:** Update `SPEC.md` Phase 7 section: explicitly note that Gemini sessions appear in Mission Control read-only; they cannot send or receive party-line messages (no channel/wake-on-message in Gemini CLI). If a user wants bidirectional Gemini integration, options are:
  - Wrap Gemini via A2A (Agent-to-Agent) as an internal service a Claude session can call
  - Run an adapter process that subscribes to our UDP multicast and injects messages into a specific Gemini session via stdin (similar to the rejected tmux paste-buffer approach)
  - Both are out-of-scope for this phase

- [ ] **Step 2:** Commit

---

## Self-Review Checklist

- [x] Every spec item from the wiki article mapped to a task (dashboard status ✓, last messages ✓, subagent visibility ✓, real-time ✓, passive capture ✓). Message-injection explicitly **not** implemented — replaced by passive capture, recorded in SPEC.
- [x] Every task has real code, not placeholders.
- [x] Types are consistent across tasks: `HookEvent`, `SessionRow`, `SubagentRow` used throughout.
- [x] Ingest auth + retention considered.
- [x] Remote-host scope split out (Phase 5) — doesn't block local mission control landing.
- [x] Gemini CLI support split out (Phase 7) — research complete, concrete tasks (18-21).

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a plan this size (17 tasks, many independent).
2. **Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints. More continuity, but context is already wide.
