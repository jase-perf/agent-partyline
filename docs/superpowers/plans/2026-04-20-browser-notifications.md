# Browser Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-session browser notifications (A: turn finished, B: party-line message, C: MCP permission_request) with localStorage toggle, cross-device dismiss, and Discord-parity permission approve/deny routed through the existing UDP multicast + WebSocket transport.

**Architecture:** Party-line MCP server declares the `claude/channel/permission` capability and translates between MCP notifications and two new UDP envelope types. Dashboard server relays those envelopes to browsers over WebSocket and exposes `POST /api/permission-response` plus a `session-viewed` WS frame for cross-device dismiss fan-out. A new client module `dashboard/notifications.js` owns all browser-side decision logic with a pure factory signature so it is unit-testable without a DOM.

**Tech Stack:** TypeScript on Bun, `@modelcontextprotocol/sdk` for MCP channel notifications, `node:dgram` UDP multicast, `Bun.serve` HTTP + WebSocket, `bun:test` for all tests, vanilla ES module + DOM APIs on the browser.

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-04-20-browser-notifications-design.md`
- Discord plugin reference (permission protocol): `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts:473-515, 789-793`
- Party-line protocol: `src/protocol.ts`, `src/types.ts:2`
- Existing MCP server entry point: `src/server.ts`
- Dashboard server: `dashboard/serve.ts`

---

## Preamble — conventions used throughout

**Running tests.** From the repo root: `bun test tests/<name>.test.ts` for a single file; `bun test` for all. Every test file uses `bun:test` — `import { test, expect, describe, beforeEach, mock } from 'bun:test'`.

**Commit message style.** Use `feat(notif): <short summary>` for implementation commits and `test(notif): <short summary>` for test-only commits (e.g. adding a red test before implementing). Keep the body empty unless there is a non-obvious why. Do not add a Claude footer — the existing repo does, so match that.

**Git footer for every commit:**
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

**Mocking browser globals in tests.** The client module is written as a factory `createNotifications(deps)` so tests pass fakes directly — no global mocking needed. Fakes look like this, built fresh per test:

```ts
function mockDeps(overrides = {}) {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  const fired: Array<{ title: string; options: NotificationOptions }> = []
  const closed: string[] = []
  class FakeNotification {
    static permission: 'default' | 'granted' | 'denied' = 'granted'
    static requestPermission = mock(async () => FakeNotification.permission)
    title: string
    tag?: string
    data?: unknown
    onclick: ((ev: Event) => void) | null = null
    constructor(title: string, options: NotificationOptions = {}) {
      this.title = title
      this.tag = options.tag
      this.data = options.data
      fired.push({ title, options })
    }
    close() { if (this.tag) closed.push(this.tag) }
  }
  const doc = { hidden: false }
  const win = { focus: mock(() => {}) }
  const wsSends: unknown[] = []
  const ctx = {
    NotificationCtor: FakeNotification as unknown as typeof Notification,
    localStorage: localStorage as unknown as Storage,
    doc: doc as unknown as Document,
    win: win as unknown as Window,
    sendWsFrame: (frame: unknown) => void wsSends.push(frame),
    getCurrentRoute: () => '/switchboard',
    navigate: mock((_route: string) => {}),
    ...overrides,
  }
  return { ctx, fired, closed, wsSends, FakeNotification, doc, win }
}
```

This helper lives in `tests/_notification-helpers.ts` (created in Task 9, reused from Task 10 onward). When a task says "use `mockDeps()`" that's what it refers to.

**UDP isolation for server tests.** All envelopes in tests are created via `createEnvelope()` and fed to handlers directly; tests never open real sockets. For `src/server.ts` tests, the transport is replaced with an in-memory fake that captures `send` calls.

---

## Task 1: Add permission envelope types to the protocol

**Files:**
- Modify: `src/types.ts:2`
- Modify: `src/protocol.ts:54-80` (deserialize validation)
- Test: `tests/protocol.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Append the following `describe` block at the end of `tests/protocol.test.ts` (create the file if it doesn't exist — if it does exist, append to it):

```ts
import { test, expect, describe } from 'bun:test'
import { createEnvelope, deserialize, serialize } from '../src/protocol.js'

describe('permission envelope types', async () => {
  test('permission-request envelope round-trips through serialize/deserialize', async () => {
    const body = JSON.stringify({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"command":"bun test"}',
    })
    const env = createEnvelope('research', 'dashboard', 'permission-request', body)
    const wire = serialize(env)
    const decoded = deserialize(wire)
    expect(decoded).not.toBeNull()
    expect(decoded!.type).toBe('permission-request')
    expect(decoded!.body).toBe(body)
  })

  test('permission-response envelope round-trips through serialize/deserialize', async () => {
    const body = JSON.stringify({ request_id: 'abc12', behavior: 'allow' })
    const env = createEnvelope('dashboard', 'research', 'permission-response', body)
    const wire = serialize(env)
    const decoded = deserialize(wire)
    expect(decoded).not.toBeNull()
    expect(decoded!.type).toBe('permission-response')
    expect(decoded!.body).toBe(body)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/protocol.test.ts`
Expected: TypeScript error — `'permission-request'` is not assignable to `MessageType`.

- [ ] **Step 3: Extend `MessageType` in `src/types.ts:2`**

Replace:
```ts
export type MessageType = 'message' | 'request' | 'response' | 'status' | 'heartbeat' | 'announce'
```
with:
```ts
export type MessageType =
  | 'message'
  | 'request'
  | 'response'
  | 'status'
  | 'heartbeat'
  | 'announce'
  | 'permission-request'
  | 'permission-response'
```

- [ ] **Step 4: Verify `deserialize` accepts new types**

Open `src/protocol.ts` and find the validation block starting around line 54. Confirm it only checks for string `type` without restricting to a specific enum. If it does restrict (whitelist), add the two new values. If it uses `typeof parsed.type === 'string'`, no change needed.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/protocol.test.ts`
Expected: PASS for both new tests.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/protocol.ts tests/protocol.test.ts
git commit -m "feat(notif): add permission envelope types to protocol

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: MCP server — declare permission capability

**Files:**
- Modify: `src/server.ts:115-120`
- Test: `tests/server-permission.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/server-permission.test.ts`:

```ts
import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('MCP server capabilities', async () => {
  test('server.ts declares claude/channel/permission capability', async () => {
    const source = readFileSync(resolve(import.meta.dir, '../src/server.ts'), 'utf8')
    expect(source).toContain("'claude/channel/permission': {}")
  })
})
```

Yes, this test is a textual assertion. Structural introspection of the MCP SDK's capabilities object is awkward at runtime and the capability name is a string literal in a known location. A later task (Task 3) will exercise the handler end-to-end; here we pin the declaration.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server-permission.test.ts`
Expected: FAIL — `"claude/channel/permission": {}` not found in source.

- [ ] **Step 3: Add the capability declaration**

In `src/server.ts`, replace the capabilities block (around line 115-120):

```ts
    capabilities: {
      experimental: {
        'claude/channel': {},
      },
      tools: {},
    },
```

with:

```ts
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server-permission.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server-permission.test.ts
git commit -m "feat(notif): declare claude/channel/permission capability

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: MCP server — handle incoming permission_request

**Files:**
- Modify: `src/server.ts` (add handler, pending map)
- Modify: `tests/server-permission.test.ts` (add handler test)

This task extracts the permission-handling logic into a dedicated module so it can be unit-tested without spinning up the whole server.

- [ ] **Step 1: Write the failing test**

Append to `tests/server-permission.test.ts`:

```ts
import { createPermissionBridge } from '../src/permission-bridge.js'
import type { Envelope } from '../src/types.js'

describe('permission bridge — incoming request', async () => {
  test('handlePermissionRequest stashes the request and emits a permission-request envelope', async () => {
    const sent: Envelope[] = []
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: (env) => void sent.push(env),
      sendMcpNotification: () => {},
    })

    bridge.handlePermissionRequest({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"command":"bun test"}',
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('permission-request')
    expect(sent[0].from).toBe('research')
    expect(sent[0].to).toBe('dashboard')
    const body = JSON.parse(sent[0].body)
    expect(body).toEqual({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"command":"bun test"}',
    })

    expect(bridge.hasPending('abc12')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server-permission.test.ts`
Expected: FAIL — cannot import from `../src/permission-bridge.js`.

- [ ] **Step 3: Create `src/permission-bridge.ts`**

```ts
import { createEnvelope } from './protocol.js'
import type { Envelope } from './types.js'

export interface PermissionRequestParams {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export interface PermissionResponseBody {
  request_id: string
  behavior: 'allow' | 'deny'
}

export interface PermissionBridgeDeps {
  sessionName: string
  sendEnvelope: (envelope: Envelope) => void
  sendMcpNotification: (params: PermissionResponseBody) => void
}

export interface PermissionBridge {
  handlePermissionRequest: (params: PermissionRequestParams) => void
  handlePermissionResponseEnvelope: (envelope: Envelope) => void
  hasPending: (requestId: string) => boolean
}

export function createPermissionBridge(deps: PermissionBridgeDeps): PermissionBridge {
  const pending = new Map<string, PermissionRequestParams>()

  return {
    handlePermissionRequest(params) {
      pending.set(params.request_id, params)
      const body = JSON.stringify(params)
      const envelope = createEnvelope(deps.sessionName, 'dashboard', 'permission-request', body)
      deps.sendEnvelope(envelope)
    },

    handlePermissionResponseEnvelope(envelope) {
      if (envelope.type !== 'permission-response') return
      let parsed: PermissionResponseBody
      try {
        parsed = JSON.parse(envelope.body) as PermissionResponseBody
      } catch {
        return
      }
      if (parsed.behavior !== 'allow' && parsed.behavior !== 'deny') return
      if (!pending.has(parsed.request_id)) return
      pending.delete(parsed.request_id)
      deps.sendMcpNotification(parsed)
    },

    hasPending(requestId) {
      return pending.has(requestId)
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server-permission.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the bridge into `src/server.ts`**

Near the top of `src/server.ts` add:

```ts
import { createPermissionBridge } from './permission-bridge.js'
import { z } from 'zod'
```

(`zod` is already a transitive dependency of the MCP SDK; confirm `import { z } from 'zod'` resolves. If it doesn't, add `zod` to package.json — the MCP SDK exports its own zod re-export at `@modelcontextprotocol/sdk/types.js`; use that if needed.)

After the `mcp` server construction, add:

```ts
const permissionBridge = createPermissionBridge({
  sessionName,
  sendEnvelope: (envelope) => {
    void transport.send(envelope)
  },
  sendMcpNotification: ({ request_id, behavior }) => {
    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior },
    })
  },
})

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    permissionBridge.handlePermissionRequest(params)
  },
)
```

Place this after the existing `claude/channel` notification path (search for `'notifications/claude/channel'` to find the nearby section).

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: clean, or only pre-existing errors in `dashboard/cli.ts` (flagged in earlier bugfix work).

- [ ] **Step 7: Commit**

```bash
git add src/permission-bridge.ts src/server.ts tests/server-permission.test.ts
git commit -m "feat(notif): forward MCP permission_request to dashboard via UDP

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: MCP server — route permission-response envelopes back to MCP

**Files:**
- Modify: `src/server.ts` (inbound envelope dispatch)
- Modify: `tests/server-permission.test.ts` (add response tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/server-permission.test.ts`:

```ts
import { createEnvelope } from '../src/protocol.js'

describe('permission bridge — incoming response', async () => {
  test('matching permission-response envelope triggers MCP notification and clears pending', async () => {
    const notifications: Array<{ request_id: string; behavior: string }> = []
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: () => {},
      sendMcpNotification: (params) => void notifications.push(params),
    })
    bridge.handlePermissionRequest({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'x',
      input_preview: '{}',
    })

    const response = createEnvelope(
      'dashboard',
      'research',
      'permission-response',
      JSON.stringify({ request_id: 'abc12', behavior: 'allow' }),
    )
    bridge.handlePermissionResponseEnvelope(response)

    expect(notifications).toEqual([{ request_id: 'abc12', behavior: 'allow' }])
    expect(bridge.hasPending('abc12')).toBe(false)
  })

  test('unknown request_id is silently ignored', async () => {
    const notifications: Array<unknown> = []
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: () => {},
      sendMcpNotification: (params) => void notifications.push(params),
    })
    const response = createEnvelope(
      'dashboard',
      'research',
      'permission-response',
      JSON.stringify({ request_id: 'never-requested', behavior: 'allow' }),
    )
    bridge.handlePermissionResponseEnvelope(response)
    expect(notifications).toEqual([])
  })

  test('non-permission-response envelope type is ignored', async () => {
    const notifications: Array<unknown> = []
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: () => {},
      sendMcpNotification: (params) => void notifications.push(params),
    })
    const msg = createEnvelope('dashboard', 'research', 'message', 'hello')
    bridge.handlePermissionResponseEnvelope(msg)
    expect(notifications).toEqual([])
  })

  test('invalid JSON body does not throw', async () => {
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: () => {},
      sendMcpNotification: () => {},
    })
    const env = createEnvelope('dashboard', 'research', 'permission-response', '{not json')
    expect(() => bridge.handlePermissionResponseEnvelope(env)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test tests/server-permission.test.ts`
Expected: PASS — the bridge already implements this behavior from Task 3.

- [ ] **Step 3: Wire envelope dispatch in `src/server.ts`**

Find the `handleInbound(envelope: Envelope)` function. Near its top, after presence tracking but before the channel notification send, add:

```ts
  if (envelope.type === 'permission-response' && envelope.to === sessionName) {
    permissionBridge.handlePermissionResponseEnvelope(envelope)
    return
  }
  if (envelope.type === 'permission-request') {
    // permission-request envelopes are for the dashboard, not other sessions
    return
  }
```

This prevents permission-request envelopes from being forwarded as `claude/channel` notifications (which would cause Claude to see them as stray messages).

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server-permission.test.ts
git commit -m "feat(notif): route permission-response envelopes back to MCP

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Dashboard server — broadcast permission-request to WS clients

**Files:**
- Modify: `dashboard/serve.ts` (monitor.onMessage branch)
- Test: `tests/serve-permission.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/serve-permission.test.ts`:

```ts
import { test, expect, describe } from 'bun:test'
import { createEnvelope } from '../src/protocol.js'
import { buildPermissionRequestFrame } from '../dashboard/serve-helpers.js'

describe('buildPermissionRequestFrame', async () => {
  test('formats a permission-request envelope into a WS frame', async () => {
    const body = JSON.stringify({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"cmd":"ls"}',
    })
    const env = createEnvelope('research', 'dashboard', 'permission-request', body)
    const frame = buildPermissionRequestFrame(env)
    expect(frame).toEqual({
      type: 'permission-request',
      data: {
        session: 'research',
        request_id: 'abc12',
        tool_name: 'Bash',
        description: 'Run tests',
        input_preview: '{"cmd":"ls"}',
      },
    })
  })

  test('returns null for non-permission-request envelopes', async () => {
    const env = createEnvelope('a', 'b', 'message', 'hi')
    expect(buildPermissionRequestFrame(env)).toBeNull()
  })

  test('returns null if body is invalid JSON', async () => {
    const env = createEnvelope('a', 'dashboard', 'permission-request', '{bad')
    expect(buildPermissionRequestFrame(env)).toBeNull()
  })

  test('returns null if body is missing required fields', async () => {
    const env = createEnvelope(
      'a',
      'dashboard',
      'permission-request',
      JSON.stringify({ request_id: 'x' }),
    )
    expect(buildPermissionRequestFrame(env)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/serve-permission.test.ts`
Expected: FAIL — `../dashboard/serve-helpers.js` not found.

- [ ] **Step 3: Create `dashboard/serve-helpers.ts`**

```ts
import type { Envelope } from '../src/types.js'

export interface PermissionRequestFrame {
  type: 'permission-request'
  data: {
    session: string
    request_id: string
    tool_name: string
    description: string
    input_preview: string
  }
}

export function buildPermissionRequestFrame(envelope: Envelope): PermissionRequestFrame | null {
  if (envelope.type !== 'permission-request') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(envelope.body)
  } catch {
    return null
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).request_id !== 'string' ||
    typeof (parsed as Record<string, unknown>).tool_name !== 'string' ||
    typeof (parsed as Record<string, unknown>).description !== 'string' ||
    typeof (parsed as Record<string, unknown>).input_preview !== 'string'
  ) {
    return null
  }
  const p = parsed as Record<string, string>
  return {
    type: 'permission-request',
    data: {
      session: envelope.from,
      request_id: p.request_id,
      tool_name: p.tool_name,
      description: p.description,
      input_preview: p.input_preview,
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/serve-permission.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `dashboard/serve.ts`**

Near the top, import:

```ts
import { buildPermissionRequestFrame } from './serve-helpers.js'
```

Find the `monitor.onMessage(...)` block (search for `type: 'message', data: envelope`). At the top of the callback add:

```ts
  const permFrame = buildPermissionRequestFrame(envelope)
  if (permFrame) {
    const json = JSON.stringify(permFrame)
    for (const ws of sockets) ws.send(json)
    return
  }
```

Use the same iteration pattern as existing broadcasts in that file (look for `for (const ws of sockets)` or the helper used for broadcasting).

- [ ] **Step 6: Commit**

```bash
git add dashboard/serve.ts dashboard/serve-helpers.ts tests/serve-permission.test.ts
git commit -m "feat(notif): broadcast permission-request envelopes to WS clients

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Dashboard server — POST /api/permission-response

**Files:**
- Modify: `dashboard/serve.ts` (new route)
- Modify: `dashboard/serve-helpers.ts` (validation helper)
- Modify: `tests/serve-permission.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/serve-permission.test.ts`:

```ts
import { validatePermissionResponseBody, buildPermissionResponseEnvelope } from '../dashboard/serve-helpers.js'

describe('permission response validation', async () => {
  test('accepts valid allow body', async () => {
    const result = validatePermissionResponseBody({
      session: 'research',
      request_id: 'abc12',
      behavior: 'allow',
    })
    expect(result.ok).toBe(true)
  })

  test('accepts valid deny body', async () => {
    const result = validatePermissionResponseBody({
      session: 'research',
      request_id: 'abc12',
      behavior: 'deny',
    })
    expect(result.ok).toBe(true)
  })

  test('rejects missing session', async () => {
    const result = validatePermissionResponseBody({ request_id: 'a', behavior: 'allow' })
    expect(result.ok).toBe(false)
  })

  test('rejects invalid behavior', async () => {
    const result = validatePermissionResponseBody({
      session: 'r',
      request_id: 'a',
      behavior: 'maybe',
    })
    expect(result.ok).toBe(false)
  })
})

describe('buildPermissionResponseEnvelope', async () => {
  test('constructs UDP envelope addressed to the target session', async () => {
    const env = buildPermissionResponseEnvelope({
      from: 'dashboard',
      session: 'research',
      request_id: 'abc12',
      behavior: 'allow',
    })
    expect(env.type).toBe('permission-response')
    expect(env.from).toBe('dashboard')
    expect(env.to).toBe('research')
    expect(JSON.parse(env.body)).toEqual({ request_id: 'abc12', behavior: 'allow' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/serve-permission.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Extend `dashboard/serve-helpers.ts`**

Append:

```ts
import { createEnvelope } from '../src/protocol.js'

export interface PermissionResponseInput {
  session: string
  request_id: string
  behavior: 'allow' | 'deny'
}

export function validatePermissionResponseBody(
  body: unknown,
): { ok: true; value: PermissionResponseInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be object' }
  const b = body as Record<string, unknown>
  if (typeof b.session !== 'string' || !b.session) {
    return { ok: false, error: '"session" required' }
  }
  if (typeof b.request_id !== 'string' || !b.request_id) {
    return { ok: false, error: '"request_id" required' }
  }
  if (b.behavior !== 'allow' && b.behavior !== 'deny') {
    return { ok: false, error: '"behavior" must be "allow" or "deny"' }
  }
  return {
    ok: true,
    value: { session: b.session, request_id: b.request_id, behavior: b.behavior },
  }
}

export function buildPermissionResponseEnvelope(args: {
  from: string
  session: string
  request_id: string
  behavior: 'allow' | 'deny'
}): Envelope {
  return createEnvelope(
    args.from,
    args.session,
    'permission-response',
    JSON.stringify({ request_id: args.request_id, behavior: args.behavior }),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/serve-permission.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire POST handler in `dashboard/serve.ts`**

Find the REST API section (search for `/api/overrides` around line 180). Add alongside the existing routes:

```ts
    if (url.pathname === '/api/permission-response' && req.method === 'POST') {
      return (async () => {
        let body: unknown
        try {
          body = await req.json()
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 })
        }
        const result = validatePermissionResponseBody(body)
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: 400 })
        }
        const envelope = buildPermissionResponseEnvelope({
          from: NAME,
          session: result.value.session,
          request_id: result.value.request_id,
          behavior: result.value.behavior,
        })
        await monitor.send(envelope)
        const resolvedFrame = JSON.stringify({
          type: 'permission-resolved',
          data: {
            session: result.value.session,
            request_id: result.value.request_id,
            behavior: result.value.behavior,
            resolved_by: NAME,
          },
        })
        for (const ws of sockets) ws.send(resolvedFrame)
        return Response.json({ ok: true })
      })()
    }
```

Double-check the actual send helper name used in `dashboard/serve.ts` — it may be `monitor.send`, `multicast.send`, or a wrapper. Grep for existing `transport.send` or `monitor.send` calls and match.

At the top of `dashboard/serve.ts`, add to the import list:

```ts
import {
  buildPermissionRequestFrame,
  validatePermissionResponseBody,
  buildPermissionResponseEnvelope,
} from './serve-helpers.js'
```

- [ ] **Step 6: Manual smoke test**

Start the dashboard in one terminal:

```bash
bun dashboard/serve.ts
```

In another terminal, POST a request:

```bash
curl -X POST http://localhost:3400/api/permission-response \
  -H 'Content-Type: application/json' \
  -d '{"session":"nonexistent","request_id":"xyz","behavior":"allow"}'
```

Expected: `{"ok":true}`. (The envelope goes into the UDP void; since no session named "nonexistent" is listening for it, nothing happens downstream — that's fine, this only exercises the HTTP path.)

Also verify 400 on bad input:

```bash
curl -X POST http://localhost:3400/api/permission-response \
  -H 'Content-Type: application/json' \
  -d '{"behavior":"invalid"}'
```

Expected: HTTP 400 with `{"error": ...}`.

- [ ] **Step 7: Commit**

```bash
git add dashboard/serve.ts dashboard/serve-helpers.ts tests/serve-permission.test.ts
git commit -m "feat(notif): POST /api/permission-response forwards to UDP + WS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Dashboard server — session-viewed WS frame

**Files:**
- Modify: `dashboard/serve.ts` (WS message handler)
- Modify: `tests/serve-permission.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/serve-permission.test.ts`:

```ts
import { buildDismissFrame } from '../dashboard/serve-helpers.js'

describe('buildDismissFrame', async () => {
  test('formats a notification-dismiss frame', async () => {
    const frame = buildDismissFrame('research')
    expect(frame).toEqual({
      type: 'notification-dismiss',
      data: { session: 'research' },
    })
  })
})
```

- [ ] **Step 2: Run test — expect fail**

Run: `bun test tests/serve-permission.test.ts`
Expected: FAIL — `buildDismissFrame` not exported.

- [ ] **Step 3: Add helper to `dashboard/serve-helpers.ts`**

```ts
export function buildDismissFrame(session: string): { type: 'notification-dismiss'; data: { session: string } } {
  return { type: 'notification-dismiss', data: { session } }
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `bun test tests/serve-permission.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire WS message handler in `dashboard/serve.ts`**

Find the WebSocket upgrade / message handler block (search for `ws.send(JSON.stringify({ type: 'sessions'` — around line 349 — to locate the open handler, then look nearby for a `message` handler on the server's websocket object).

If there is no existing `message` handler, add one alongside `open`. The Bun.serve websocket API looks like:

```ts
websocket: {
  open(ws) { /* existing */ },
  message(ws, message) {
    let parsed: unknown
    try {
      parsed = JSON.parse(typeof message === 'string' ? message : message.toString())
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const msg = parsed as Record<string, unknown>
    if (msg.type === 'session-viewed' && typeof msg.session === 'string') {
      const frame = JSON.stringify(buildDismissFrame(msg.session))
      for (const ws of sockets) ws.send(frame)
      return
    }
  },
  close(ws) { /* existing */ },
},
```

If a `message` handler already exists, merge the `session-viewed` branch into it. Also add the import for `buildDismissFrame` to the existing helper import block at the top.

- [ ] **Step 6: Manual smoke test**

Start dashboard, open a browser dev console on the dashboard URL, and run:

```js
const ws = Array.from(document.scripts).length // dummy — grab the actual ws reference
// Easier: reload page, open dev console, type:
window.__dbg_sendSessionViewed = () => {
  // Need access to the dashboard's existing ws instance.
}
```

Alternative: use `wscat`:
```bash
bunx wscat -c ws://localhost:3400/ws
> {"type":"session-viewed","session":"research"}
```

Expected: receive back `{"type":"notification-dismiss","data":{"session":"research"}}`.

- [ ] **Step 7: Commit**

```bash
git add dashboard/serve.ts dashboard/serve-helpers.ts tests/serve-permission.test.ts
git commit -m "feat(notif): fan session-viewed WS frames out as notification-dismiss

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Create client notification module — skeleton + settings

**Files:**
- Create: `dashboard/notifications.js`
- Create: `tests/_notification-helpers.ts`
- Create: `tests/notifications.test.ts`

- [ ] **Step 1: Create the test helper**

Create `tests/_notification-helpers.ts` with the `mockDeps()` factory from the Preamble. Copy it verbatim.

- [ ] **Step 2: Write the failing tests**

Create `tests/notifications.test.ts`:

```ts
import { test, expect, describe, beforeEach } from 'bun:test'
import { createNotifications } from '../dashboard/notifications.js'
import { mockDeps } from './_notification-helpers.js'

describe('createNotifications — settings', async () => {
  test('isEnabled returns false by default (opt-in)', async () => {
    const { ctx } = mockDeps()
    const notif = createNotifications(ctx)
    expect(notif.isEnabled('research')).toBe(false)
  })

  test('setEnabled persists via localStorage and round-trips', async () => {
    const { ctx } = mockDeps()
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    expect(notif.isEnabled('research')).toBe(true)

    // Simulate a page reload by creating a second instance with the same storage
    const notif2 = createNotifications(ctx)
    expect(notif2.isEnabled('research')).toBe(true)
  })

  test('setEnabled(false) removes the entry', async () => {
    const { ctx } = mockDeps()
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    notif.setEnabled('research', false)
    expect(notif.isEnabled('research')).toBe(false)
  })

  test('getPermissionState reflects FakeNotification.permission', async () => {
    const { ctx, FakeNotification } = mockDeps()
    const notif = createNotifications(ctx)
    expect(notif.getPermissionState()).toBe('granted')
    FakeNotification.permission = 'denied'
    expect(notif.getPermissionState()).toBe('denied')
  })

  test('getPermissionState returns "unsupported" if NotificationCtor is missing', async () => {
    const { ctx } = mockDeps({ NotificationCtor: undefined })
    const notif = createNotifications(ctx)
    expect(notif.getPermissionState()).toBe('unsupported')
  })
})
```

- [ ] **Step 3: Run tests — expect fail**

Run: `bun test tests/notifications.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `dashboard/notifications.js`**

```js
// @ts-check
/**
 * Browser notification module for Party Line dashboard.
 * Factory pattern: dependencies injected via createNotifications(deps) so
 * the module is unit-testable without a DOM.
 */

const STORAGE_KEY = 'partyLineNotifications'

/**
 * @typedef {Object} NotificationDeps
 * @property {typeof Notification | undefined} NotificationCtor
 * @property {Storage} localStorage
 * @property {Document} doc
 * @property {Window} win
 * @property {(frame: unknown) => void} sendWsFrame
 * @property {() => string} getCurrentRoute
 * @property {(route: string) => void} navigate
 */

/**
 * @param {NotificationDeps} deps
 */
export function createNotifications(deps) {
  const settings = loadSettings(deps.localStorage)
  const activeNotifications = new Map()
  const lastAssistantText = new Map()
  const lastKnownState = new Map()
  const resolvedPermissions = new Set()

  function loadSettings(storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY)
      if (!raw) return new Map()
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return new Map()
      const m = new Map()
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'boolean' && v) m.set(k, true)
      }
      return m
    } catch {
      return new Map()
    }
  }

  function persistSettings() {
    const obj = {}
    for (const [k, v] of settings) obj[k] = v
    deps.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
  }

  return {
    isEnabled(sessionName) {
      return settings.get(sessionName) === true
    },
    setEnabled(sessionName, enabled) {
      if (enabled) settings.set(sessionName, true)
      else settings.delete(sessionName)
      persistSettings()
    },
    getPermissionState() {
      if (!deps.NotificationCtor) return 'unsupported'
      return deps.NotificationCtor.permission
    },
    async requestPermission() {
      if (!deps.NotificationCtor) return 'unsupported'
      return await deps.NotificationCtor.requestPermission()
    },
  }
}
```

Note the outer `const settings = loadSettings(...)` references `loadSettings` which is declared inside the function body. Move `loadSettings` above the `const settings = ...` line so the declaration comes first:

```js
export function createNotifications(deps) {
  function loadSettings(storage) { /* ... */ }
  function persistSettings() { /* ... */ }

  const settings = loadSettings(deps.localStorage)
  const activeNotifications = new Map()
  const lastAssistantText = new Map()
  const lastKnownState = new Map()
  const resolvedPermissions = new Set()

  return { /* ... */ }
}
```

Adjust `persistSettings` to close over `settings` and `deps.localStorage` correctly.

- [ ] **Step 5: Run tests — expect pass**

Run: `bun test tests/notifications.test.ts`
Expected: PASS (all 5).

- [ ] **Step 6: Commit**

```bash
git add dashboard/notifications.js tests/_notification-helpers.ts tests/notifications.test.ts
git commit -m "feat(notif): client notification module skeleton with localStorage toggle

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Trigger A — working → idle detection

**Files:**
- Modify: `dashboard/notifications.js`
- Modify: `tests/notifications.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/notifications.test.ts`:

```ts
describe('createNotifications — trigger A (working→idle)', async () => {
  test('fires when state transitions working→idle and toggle is on', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)

    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'idle' })

    expect(fired).toHaveLength(1)
    expect(fired[0].title).toContain('research')
    expect(fired[0].options.tag).toBe('research')
  })

  test('does not fire on idle→idle', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'idle' })
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'idle' })
    expect(fired).toHaveLength(0)
  })

  test('does not fire on working→working', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'working' })
    expect(fired).toHaveLength(0)
  })

  test('does not fire on working→ended (SessionEnd is not a turn)', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'ended' })
    expect(fired).toHaveLength(0)
  })

  test('first-ever update records state but does not fire', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'idle' })
    expect(fired).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests — expect fail**

Run: `bun test tests/notifications.test.ts`
Expected: FAIL — `notif.onSessionUpdate is not a function`.

- [ ] **Step 3: Implement `onSessionUpdate` and core fire logic**

In `dashboard/notifications.js`, add inside `createNotifications` before the return statement:

```js
  function shouldFire(sessionName) {
    if (!settings.get(sessionName)) return false
    if (!deps.NotificationCtor) return false
    if (deps.NotificationCtor.permission !== 'granted') return false
    if (deps.doc.hidden) return true
    const route = deps.getCurrentRoute()
    return route !== '/session/' + sessionName
  }

  function fire(sessionName, title, body) {
    const NC = deps.NotificationCtor
    if (!NC) return
    const n = new NC(title, {
      body,
      tag: sessionName,
      data: { sessionName },
    })
    activeNotifications.set(sessionName, n)
    n.onclick = () => {
      try { deps.win.focus() } catch {}
      deps.navigate('/#/session/' + sessionName)
      n.close()
    }
  }
```

And extend the returned object with:

```js
    onSessionUpdate(update) {
      if (!update || !update.name) return
      const prev = lastKnownState.get(update.name)
      lastKnownState.set(update.name, update.state)
      if (prev === 'working' && update.state === 'idle' && shouldFire(update.name)) {
        const body = lastAssistantText.get(update.name) || 'Claude is waiting'
        fire(update.name, update.name, body)
      }
    },
```

The title is just the session name for now. (Spec allows title to be `"<session name>"` for turn-finished — concise and unambiguous.)

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test tests/notifications.test.ts`
Expected: PASS (all tests in this describe block + previous tests still pass).

- [ ] **Step 5: Commit**

```bash
git add dashboard/notifications.js tests/notifications.test.ts
git commit -m "feat(notif): trigger A — fire on working→idle transition

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Trigger B — party-line message

**Files:**
- Modify: `dashboard/notifications.js`
- Modify: `tests/notifications.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/notifications.test.ts`:

```ts
describe('createNotifications — trigger B (party-line message)', async () => {
  function envelope(overrides = {}) {
    return {
      id: 'x',
      seq: 0,
      from: 'discord',
      to: 'research',
      type: 'message',
      body: 'hello',
      callback_id: null,
      response_to: null,
      ts: '2026-04-20T00:00:00Z',
      ...overrides,
    }
  }

  test('fires when envelope addressed directly to session', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    notif.onPartyLineMessage(envelope())
    expect(fired).toHaveLength(1)
    expect(fired[0].title).toBe('research')
    expect(fired[0].options.body).toContain('discord')
    expect(fired[0].options.body).toContain('hello')
  })

  test('fires on broadcast (to=all)', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    notif.onPartyLineMessage(envelope({ to: 'all' }))
    expect(fired).toHaveLength(1)
  })

  test('does not fire if envelope.from equals the session', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    notif.onPartyLineMessage(envelope({ from: 'research' }))
    expect(fired).toHaveLength(0)
  })

  test('filters heartbeat and announce', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    notif.onPartyLineMessage(envelope({ type: 'heartbeat' }))
    notif.onPartyLineMessage(envelope({ type: 'announce' }))
    notif.onPartyLineMessage(envelope({ type: 'receipt' }))
    notif.onPartyLineMessage(envelope({ type: 'response' }))
    expect(fired).toHaveLength(0)
  })

  test('truncates body to 120 chars', async () => {
    const longBody = 'x'.repeat(500)
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    notif.onPartyLineMessage(envelope({ body: longBody }))
    expect(fired[0].options.body.length).toBeLessThanOrEqual(140) // "from: " + 120 + ellipsis
  })
})
```

- [ ] **Step 2: Run tests — expect fail**

Run: `bun test tests/notifications.test.ts`
Expected: FAIL — `onPartyLineMessage` not defined.

- [ ] **Step 3: Implement `onPartyLineMessage`**

Extend the returned object in `dashboard/notifications.js`:

```js
    onPartyLineMessage(envelope) {
      if (!envelope || envelope.type !== 'message') return
      for (const [sessionName] of settings) {
        if (envelope.to !== sessionName && envelope.to !== 'all') continue
        if (envelope.from === sessionName) continue
        if (!shouldFire(sessionName)) continue
        const bodyText = String(envelope.body || '')
        const preview = bodyText.length > 120 ? bodyText.slice(0, 120) + '…' : bodyText
        fire(sessionName, sessionName, (envelope.from || '?') + ': ' + preview)
      }
    },
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test tests/notifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/notifications.js tests/notifications.test.ts
git commit -m "feat(notif): trigger B — fire on party-line message for a toggled session

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Trigger C — permission-request

**Files:**
- Modify: `dashboard/notifications.js`
- Modify: `tests/notifications.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/notifications.test.ts`:

```ts
describe('createNotifications — trigger C (permission-request)', async () => {
  function permFrame(overrides = {}) {
    return {
      session: 'research',
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"cmd":"ls"}',
      ...overrides,
    }
  }

  test('fires with "Permission needed" title when toggle on', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    notif.onPermissionRequest(permFrame())
    expect(fired).toHaveLength(1)
    expect(fired[0].title).toContain('Permission needed')
    expect(fired[0].title).toContain('Bash')
    expect(fired[0].options.body).toContain('Run tests')
    expect(fired[0].options.tag).toBe('research')
  })

  test('does not fire when session toggle is off', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.onPermissionRequest(permFrame())
    expect(fired).toHaveLength(0)
  })

  test('does not fire if request_id already resolved', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    notif.onPermissionResolved({ session: 'research', request_id: 'abc12', behavior: 'allow' })
    notif.onPermissionRequest(permFrame())
    expect(fired).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests — expect fail**

Run: `bun test tests/notifications.test.ts`
Expected: FAIL — `onPermissionRequest` / `onPermissionResolved` not defined.

- [ ] **Step 3: Implement handlers**

Extend the returned object:

```js
    onPermissionRequest(frame) {
      if (!frame || !frame.session || !frame.request_id) return
      if (resolvedPermissions.has(frame.request_id)) return
      if (!shouldFire(frame.session)) return
      const title = 'Permission needed: ' + (frame.tool_name || '?')
      const descr = String(frame.description || '')
      const body = descr.length > 120 ? descr.slice(0, 120) + '…' : descr
      fire(frame.session, title, body)
    },

    onPermissionResolved(frame) {
      if (!frame || !frame.request_id) return
      resolvedPermissions.add(frame.request_id)
      const active = activeNotifications.get(frame.session)
      if (active) {
        active.close()
        activeNotifications.delete(frame.session)
      }
    },
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test tests/notifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/notifications.js tests/notifications.test.ts
git commit -m "feat(notif): trigger C — fire on permission-request, dedup via resolved set

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Fire conditions — visibility + route + permission gates

**Files:**
- Modify: `tests/notifications.test.ts` (add coverage)

The conditions are already implemented in `shouldFire` from Task 9. This task pins them with explicit tests.

- [ ] **Step 1: Write the failing tests**

Append to `tests/notifications.test.ts`:

```ts
describe('createNotifications — fire conditions', async () => {
  test('does not fire if tab visible AND route is current session', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = false
    ctx.getCurrentRoute = () => '/session/research'
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })
    expect(fired).toHaveLength(0)
  })

  test('fires if tab visible but viewing different session', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = false
    ctx.getCurrentRoute = () => '/session/other'
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })
    expect(fired).toHaveLength(1)
  })

  test('does not fire if toggle off for that session', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    // no setEnabled call
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })
    expect(fired).toHaveLength(0)
  })

  test('does not fire if Notification.permission !== granted', async () => {
    const { ctx, fired, FakeNotification } = mockDeps()
    FakeNotification.permission = 'denied'
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })
    expect(fired).toHaveLength(0)
  })

  test('fires on Switchboard (not on any session detail)', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = false
    ctx.getCurrentRoute = () => '/switchboard'
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })
    expect(fired).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests — expect pass**

Run: `bun test tests/notifications.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/notifications.test.ts
git commit -m "test(notif): pin fire condition gates (visibility, route, permission, toggle)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Notification click — focus + navigate + close

**Files:**
- Modify: `tests/notifications.test.ts`

The click handler is already attached in `fire()` from Task 9. This task verifies it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/notifications.test.ts`:

```ts
describe('createNotifications — click handler', async () => {
  test('click navigates to session route, focuses window, closes notification', async () => {
    const { ctx, fired, closed, win } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })

    expect(fired).toHaveLength(1)
    // Find the last-created FakeNotification instance via the module's
    // onclick assignment — ctx's test harness returns the constructor so
    // we can trigger the click.
    const instance = fired[0] // this is the input args, not the instance
    // Since mockDeps doesn't currently return instances, extend it:
    // (see Step 2)
  })
})
```

Note: the current `mockDeps()` helper doesn't expose created `FakeNotification` instances. Extend it.

- [ ] **Step 2: Extend `tests/_notification-helpers.ts`**

Modify the `FakeNotification` class to push instances to a collected array:

```ts
const instances: FakeNotification[] = []
class FakeNotification {
  // ... as before ...
  constructor(title: string, options: NotificationOptions = {}) {
    this.title = title
    this.tag = options.tag
    this.data = options.data
    fired.push({ title, options })
    instances.push(this)
  }
  // ... rest ...
}
```

And include `instances` in the returned object:

```ts
return { ctx, fired, closed, wsSends, FakeNotification, doc, win, instances }
```

- [ ] **Step 3: Rewrite the click test**

Replace the body of the click test:

```ts
  test('click navigates to session route, focuses window, closes notification', async () => {
    const { ctx, instances, win } = mockDeps()
    ctx.doc.hidden = true
    const navigateMock = ctx.navigate
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })

    expect(instances).toHaveLength(1)
    const n = instances[0]
    n.onclick?.(new Event('click'))

    expect(win.focus).toHaveBeenCalled()
    expect(navigateMock).toHaveBeenCalledWith('/#/session/research')
  })
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test tests/notifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/notifications.test.ts tests/_notification-helpers.ts
git commit -m "test(notif): notification click focuses window and navigates to session

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Auto-dismiss via WS frames

**Files:**
- Modify: `dashboard/notifications.js`
- Modify: `tests/notifications.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/notifications.test.ts`:

```ts
describe('createNotifications — auto-dismiss', async () => {
  test('onNotificationDismiss closes the session\'s active notification', async () => {
    const { ctx, closed } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })

    notif.onNotificationDismiss({ session: 'research' })
    expect(closed).toContain('research')
  })

  test('onNotificationDismiss for unknown session is a no-op', async () => {
    const { ctx, closed } = mockDeps()
    const notif = createNotifications(ctx)
    notif.onNotificationDismiss({ session: 'nobody' })
    expect(closed).toEqual([])
  })

  test('dispatchSessionViewed sends session-viewed WS frame', async () => {
    const { ctx, wsSends } = mockDeps()
    const notif = createNotifications(ctx)
    notif.dispatchSessionViewed('research')
    expect(wsSends).toEqual([{ type: 'session-viewed', session: 'research' }])
  })
})
```

- [ ] **Step 2: Run tests — expect fail**

Run: `bun test tests/notifications.test.ts`
Expected: FAIL — `onNotificationDismiss`, `dispatchSessionViewed` not defined.

- [ ] **Step 3: Implement handlers**

Extend the returned object in `dashboard/notifications.js`:

```js
    onNotificationDismiss(frame) {
      if (!frame || !frame.session) return
      const active = activeNotifications.get(frame.session)
      if (active) {
        active.close()
        activeNotifications.delete(frame.session)
      }
    },

    dispatchSessionViewed(sessionName) {
      if (!sessionName) return
      deps.sendWsFrame({ type: 'session-viewed', session: sessionName })
    },
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test tests/notifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/notifications.js tests/notifications.test.ts
git commit -m "feat(notif): auto-dismiss via notification-dismiss + session-viewed WS frames

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Fetch last assistant text on trigger A fire

**Files:**
- Modify: `dashboard/notifications.js`
- Modify: `tests/notifications.test.ts`

Rationale: the `jsonl` WS frame carries only `{session_id, file_path}` — not the assistant text. To populate the trigger-A body we fetch `/api/transcript?session_id=<id>&limit=5` lazily when A fires, then mutate the body. Because `Notification` body is immutable after construction, we do this in the order "fetch first (with 200ms timeout), then fire." If the fetch times out, fall back to the generic message.

- [ ] **Step 1: Extend `mockDeps()` with a fetch mock**

In `tests/_notification-helpers.ts`, add `fetch` to deps:

```ts
  const fetchCalls: string[] = []
  let fetchResponse: unknown = []
  const fetchMock = mock(async (url: string) => {
    fetchCalls.push(url)
    return {
      ok: true,
      json: async () => fetchResponse,
    }
  })
  // ... add to ctx:
  const ctx = {
    // ... existing ...
    fetch: fetchMock,
    // ...
  }
  // ... return:
  return { ctx, fired, closed, wsSends, FakeNotification, doc, win, instances,
    fetchCalls, setFetchResponse: (r: unknown) => { fetchResponse = r } }
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/notifications.test.ts`:

```ts
describe('createNotifications — last assistant text', async () => {
  test('Trigger A fetches transcript and uses last assistant text as body', async () => {
    const { ctx, fired, setFetchResponse } = mockDeps()
    ctx.doc.hidden = true
    setFetchResponse([
      { type: 'user', text: 'hi' },
      { type: 'assistant', text: 'The answer is 42.' },
    ])
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'research-sid', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'research-sid', name: 'research', state: 'idle' })

    expect(fired).toHaveLength(1)
    expect(fired[0].options.body).toContain('42')
  })

  test('Trigger A falls back to "Claude is waiting" when transcript fetch fails', async () => {
    const { ctx, fired } = mockDeps({
      fetch: mock(async () => { throw new Error('network') }),
    })
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })

    expect(fired).toHaveLength(1)
    expect(fired[0].options.body).toBe('Claude is waiting')
  })
})
```

- [ ] **Step 3: Run tests — expect fail**

Run: `bun test tests/notifications.test.ts`
Expected: FAIL — `onSessionUpdate` currently returns undefined (not a Promise); also fetch not wired.

- [ ] **Step 4: Rewire `onSessionUpdate` to be async and fetch transcript**

In `dashboard/notifications.js`, replace `onSessionUpdate` with:

```js
    async onSessionUpdate(update) {
      if (!update || !update.name) return
      const prev = lastKnownState.get(update.name)
      lastKnownState.set(update.name, update.state)
      if (prev === 'working' && update.state === 'idle' && shouldFire(update.name)) {
        let body = 'Claude is waiting'
        try {
          const sid = update.session_id
          if (sid && deps.fetch) {
            const res = await deps.fetch('/api/transcript?session_id=' + encodeURIComponent(sid) + '&limit=5')
            if (res.ok) {
              const entries = await res.json()
              if (Array.isArray(entries)) {
                for (let i = entries.length - 1; i >= 0; i--) {
                  const e = entries[i]
                  if (e && e.type === 'assistant' && typeof e.text === 'string' && e.text.trim()) {
                    const t = e.text.trim()
                    body = t.length > 120 ? t.slice(0, 120) + '…' : t
                    break
                  }
                }
              }
            }
          }
        } catch {
          // fall back to generic body
        }
        fire(update.name, update.name, body)
      }
    },
```

Also update the `NotificationDeps` typedef comment at the top:

```js
 * @property {typeof fetch} [fetch]
```

- [ ] **Step 5: Run tests — expect pass**

Run: `bun test tests/notifications.test.ts`
Expected: PASS (and all previous tests still pass).

- [ ] **Step 6: Confirm `/api/transcript` entry shape matches**

Spot-check `dashboard/serve.ts` for the `/api/transcript` handler and `src/transcript.ts` `buildTranscript()` return shape. Verify entries have at least `{type: 'assistant', text: string}` or similar. If the field is `content` instead of `text`, adjust the extraction in the implementation above.

Look for the return type of `buildTranscript` or the Entry interface. If the assistant text is under a different path (e.g. `entry.content[0].text`), update the loop accordingly.

- [ ] **Step 7: Commit**

```bash
git add dashboard/notifications.js tests/_notification-helpers.ts tests/notifications.test.ts
git commit -m "feat(notif): fetch last assistant text as trigger A body

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Permission banner UI

**Files:**
- Modify: `dashboard/index.html`
- Modify: `dashboard/dashboard.js` (wire banner)
- Modify: `dashboard/dashboard.css` (banner styles)

- [ ] **Step 1: Add banner markup to `dashboard/index.html`**

Directly after the opening `<body>` tag, before `<header>`, insert:

```html
<div id="notif-banner" class="notif-banner" hidden>
  <span id="notif-banner-text">🔔 Enable browser notifications for Party Line</span>
  <button id="notif-banner-btn" type="button">Enable</button>
  <button id="notif-banner-dismiss" class="notif-banner-dismiss" type="button" aria-label="Dismiss">×</button>
</div>
```

- [ ] **Step 2: Add styles to `dashboard/dashboard.css`**

Append:

```css
.notif-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: #1c2a44;
  border-bottom: 1px solid #2f4a75;
  font-size: 14px;
}
.notif-banner[hidden] { display: none; }
.notif-banner button {
  background: #3b82f6;
  color: #fff;
  border: none;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}
.notif-banner button:hover { background: #2563eb; }
.notif-banner-dismiss {
  margin-left: auto;
  background: transparent !important;
  color: #8fa0bb !important;
  font-size: 18px !important;
  padding: 0 6px !important;
  line-height: 1;
}
.notif-banner-dismiss:hover { color: #fff !important; }
```

- [ ] **Step 3: Wire banner in `dashboard/dashboard.js`**

Near the end of `dashboard.js`, before the existing `connectWs()` call, initialize the notification module and banner:

```js
import { createNotifications } from './notifications.js'

const notif = createNotifications({
  NotificationCtor: typeof Notification !== 'undefined' ? Notification : undefined,
  localStorage: window.localStorage,
  doc: document,
  win: window,
  sendWsFrame: (frame) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
  },
  getCurrentRoute: () => location.hash.replace(/^#/, '') || '/switchboard',
  navigate: (route) => { location.hash = route.replace(/^#/, '') },
  fetch: (url) => fetch(url),
})

function updateBanner() {
  const banner = document.getElementById('notif-banner')
  const text = document.getElementById('notif-banner-text')
  const btn = document.getElementById('notif-banner-btn')
  if (!banner || !text || !btn) return
  const state = notif.getPermissionState()
  if (state === 'granted' || state === 'unsupported') {
    banner.hidden = true
    return
  }
  if (localStorage.getItem('partyLineNotifBannerDismissed') === '1') {
    banner.hidden = true
    return
  }
  banner.hidden = false
  if (state === 'denied') {
    text.textContent = '🔔 Notifications blocked. Re-enable in browser settings.'
    btn.hidden = true
  } else {
    text.textContent = '🔔 Enable browser notifications for Party Line'
    btn.hidden = false
  }
}

document.getElementById('notif-banner-btn')?.addEventListener('click', async () => {
  await notif.requestPermission()
  updateBanner()
})
document.getElementById('notif-banner-dismiss')?.addEventListener('click', async () => {
  localStorage.setItem('partyLineNotifBannerDismissed', '1')
  updateBanner()
})

updateBanner()
```

- [ ] **Step 4: Manual smoke test**

Start the dashboard, open in a browser where notifications are currently `default`:

```bash
bun dashboard/serve.ts
```

Visit `http://localhost:3400`. Expected: banner visible with "Enable" button. Click → OS prompt. Grant → banner vanishes. Reload → banner stays vanished (permission granted). Revoke in browser settings, reload → banner shows "blocked" message.

- [ ] **Step 5: Commit**

```bash
git add dashboard/index.html dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(notif): add first-run permission banner

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Bell icon on Switchboard card

**Files:**
- Modify: `dashboard/dashboard.js` (card rendering)
- Modify: `dashboard/dashboard.css`

- [ ] **Step 1: Identify the Switchboard card render path**

Grep for the function that builds session cards on the Switchboard. Likely named `renderOverviewGrid`, `renderSessionCard`, or similar. Look in `dashboard/dashboard.js`.

```bash
grep -nE "overview-grid|renderSession|renderCard" dashboard/dashboard.js | head -20
```

- [ ] **Step 2: Add the bell to each card**

In the card template, alongside the existing session name / state pill, add:

```js
const bellState = notif.isEnabled(s.name) ? 'on' : 'off'
const permDenied = notif.getPermissionState() !== 'granted'
const bellHtml = `<button class="notif-bell notif-bell-${bellState}${permDenied ? ' notif-bell-disabled' : ''}"
  data-session="${s.name}"
  title="${permDenied ? 'Enable notifications first' : 'Toggle notifications for ' + s.name}"
  aria-label="Notifications for ${s.name}: ${bellState}">${bellState === 'on' ? '🔔' : '🔕'}</button>`
```

Insert this HTML into the card markup at the top-right corner. Use CSS `position: absolute; top: 6px; right: 6px` to place it.

- [ ] **Step 3: Attach click handler via delegation**

Somewhere in the card-grid init (probably after `replaceChildren`), attach a single delegated handler:

```js
document.getElementById('overview-grid')?.addEventListener('click', (ev) => {
  const target = ev.target
  if (!(target instanceof HTMLElement)) return
  const bell = target.closest('.notif-bell')
  if (!bell) return
  if (bell.classList.contains('notif-bell-disabled')) return
  const session = bell.getAttribute('data-session')
  if (!session) return
  const next = !notif.isEnabled(session)
  notif.setEnabled(session, next)
  bell.classList.toggle('notif-bell-on', next)
  bell.classList.toggle('notif-bell-off', !next)
  bell.textContent = next ? '🔔' : '🔕'
  bell.setAttribute('aria-label', `Notifications for ${session}: ${next ? 'on' : 'off'}`)
})
```

Use event delegation from the grid container to avoid re-binding per card.

- [ ] **Step 4: Add bell styles to `dashboard/dashboard.css`**

Append:

```css
.notif-bell {
  position: absolute;
  top: 6px;
  right: 6px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
  opacity: 0.7;
  transition: opacity 0.15s;
}
.notif-bell:hover { opacity: 1; background: rgba(255,255,255,0.08); }
.notif-bell-off { opacity: 0.35; }
.notif-bell-on { opacity: 1; }
.notif-bell-disabled { opacity: 0.2 !important; cursor: not-allowed; }
```

Ensure the card itself has `position: relative;` so the absolute-positioned bell anchors correctly. Check `dashboard/dashboard.css` for the existing session card selector (likely `.session-card` or similar).

- [ ] **Step 5: Manual smoke test**

Reload dashboard. Bell appears on each card. Click toggles icon between 🔔 and 🔕. Refresh page: bell state persists. Revoke notification permission in browser: bells become dim with "Enable notifications first" tooltip.

- [ ] **Step 6: Commit**

```bash
git add dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(notif): bell toggle on Switchboard session cards

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Bell icon in Session Detail header

**Files:**
- Modify: `dashboard/index.html` (detail header)
- Modify: `dashboard/dashboard.js` (render + handler)
- Modify: `dashboard/dashboard.css`

- [ ] **Step 1: Add a bell slot in the detail header**

In `dashboard/index.html`, find the `detail-header` block (around line 50). Insert a bell button:

```html
      <span class="state-pill" id="detail-state"></span>
      <button id="detail-bell" class="notif-bell-detail" type="button" title="Toggle notifications" aria-label="Notifications: off" hidden>🔕</button>
      <h2 id="detail-name"></h2>
```

Place it between `state-pill` and `<h2 id="detail-name">`.

- [ ] **Step 2: Wire into the render path**

Find the function that populates the detail header (likely `renderDetailHeader` or similar). After setting the session name, update the bell:

```js
const bell = document.getElementById('detail-bell')
if (bell) {
  const permDenied = notif.getPermissionState() !== 'granted'
  const on = notif.isEnabled(session.name)
  bell.hidden = false
  bell.classList.toggle('notif-bell-on', on)
  bell.classList.toggle('notif-bell-off', !on)
  bell.classList.toggle('notif-bell-disabled', permDenied)
  bell.textContent = on ? '🔔' : '🔕'
  bell.setAttribute('aria-label', 'Notifications for ' + session.name + ': ' + (on ? 'on' : 'off'))
  bell.setAttribute('data-session', session.name)
  bell.disabled = permDenied
}
```

- [ ] **Step 3: Add click handler (once, at init)**

Near where the Switchboard handler was added in Task 17:

```js
document.getElementById('detail-bell')?.addEventListener('click', (ev) => {
  const bell = ev.currentTarget
  if (!(bell instanceof HTMLElement)) return
  const session = bell.getAttribute('data-session')
  if (!session || bell.classList.contains('notif-bell-disabled')) return
  const next = !notif.isEnabled(session)
  notif.setEnabled(session, next)
  bell.classList.toggle('notif-bell-on', next)
  bell.classList.toggle('notif-bell-off', !next)
  bell.textContent = next ? '🔔' : '🔕'
  bell.setAttribute('aria-label', 'Notifications for ' + session + ': ' + (next ? 'on' : 'off'))
  // Also update the Switchboard bell for this session if the card is in the DOM
  const cardBell = document.querySelector(`.notif-bell[data-session="${CSS.escape(session)}"]`)
  if (cardBell) {
    cardBell.classList.toggle('notif-bell-on', next)
    cardBell.classList.toggle('notif-bell-off', !next)
    cardBell.textContent = next ? '🔔' : '🔕'
  }
})
```

- [ ] **Step 4: Add style in `dashboard/dashboard.css`**

Append:

```css
.notif-bell-detail {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1;
  opacity: 0.7;
  color: inherit;
}
.notif-bell-detail:hover:not(:disabled) { opacity: 1; background: rgba(255,255,255,0.08); }
.notif-bell-detail:disabled { opacity: 0.25; cursor: not-allowed; }
```

- [ ] **Step 5: Manual smoke test**

Open a session detail view. Bell appears in header. Click: icon flips, and if a card is visible in the Switchboard tab, switching tabs back shows the card bell updated too.

- [ ] **Step 6: Commit**

```bash
git add dashboard/index.html dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(notif): bell toggle in Session Detail header

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: session-viewed dispatch from router + WS frame handlers

**Files:**
- Modify: `dashboard/dashboard.js`

- [ ] **Step 1: Hook the existing router**

Find the router's route-apply or navigation function (search for `applyRoute`, `navigate`, or `location.hash`). At the point where the app commits to a `/session/<name>` view:

```js
if (route.startsWith('/session/')) {
  const name = route.slice('/session/'.length)
  if (name) notif.dispatchSessionViewed(name)
}
```

- [ ] **Step 2: Hook the existing WS message handler**

Find the `ws.onmessage` dispatcher (around `dashboard.js:231` — `if (data.type === 'quota')` etc.). Add branches:

```js
    else if (data.type === 'message') { notif.onPartyLineMessage(data.data) }
    else if (data.type === 'permission-request') { notif.onPermissionRequest(data.data); renderPermissionCard(data.data) }
    else if (data.type === 'permission-resolved') { notif.onPermissionResolved(data.data); updatePermissionCardResolved(data.data) }
    else if (data.type === 'notification-dismiss') { notif.onNotificationDismiss(data.data) }
```

The existing `if (data.type === 'session-update') { handleSessionUpdate(data.data); bumpUnread(data.data.name); }` branch should also call `notif.onSessionUpdate(data.data)`:

```js
    else if (data.type === 'session-update') { handleSessionUpdate(data.data); bumpUnread(data.data.name); notif.onSessionUpdate(data.data) }
```

`renderPermissionCard` and `updatePermissionCardResolved` are implemented in the next task (Task 20). For now, leave them as no-ops to keep commits independent:

```js
function renderPermissionCard(_data) { /* implemented in Task 20 */ }
function updatePermissionCardResolved(_data) { /* implemented in Task 20 */ }
```

- [ ] **Step 3: Also dispatch on `visibilitychange` if looking at a session**

Add once at init:

```js
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden) {
    const route = location.hash.replace(/^#/, '')
    if (route.startsWith('/session/')) {
      const name = route.slice('/session/'.length)
      if (name) notif.dispatchSessionViewed(name)
    }
  }
})
```

This ensures that returning to a tab you'd already navigated into clears any pending notifications for that session.

- [ ] **Step 4: Manual smoke test**

Open dev console. Navigate to a session. Check Network → WS frames: should see outbound `{"type":"session-viewed","session":"..."}`. The server should echo `notification-dismiss` back.

- [ ] **Step 5: Commit**

```bash
git add dashboard/dashboard.js
git commit -m "feat(notif): dispatch session-viewed from router, wire WS frame handlers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 20: Permission request card in session stream

**Files:**
- Modify: `dashboard/dashboard.js` (rendering + POST)
- Modify: `dashboard/dashboard.css`

- [ ] **Step 1: Implement `renderPermissionCard`**

Replace the no-op stub from Task 19:

```js
function renderPermissionCard(data) {
  if (currentView !== 'session-detail') return
  if (selectedSessionId !== data.session) return
  const stream = document.getElementById('detail-stream')
  if (!stream) return

  const existing = document.querySelector(`.perm-card[data-request-id="${CSS.escape(data.request_id)}"]`)
  if (existing) return // idempotent

  const card = document.createElement('div')
  card.className = 'perm-card perm-card-pending'
  card.setAttribute('data-request-id', data.request_id)
  card.innerHTML = `
    <div class="perm-card-header">🔐 Permission requested: <strong>${escapeHtml(data.tool_name)}</strong></div>
    <div class="perm-card-descr">${escapeHtml(data.description)}</div>
    <details class="perm-card-details">
      <summary>Show input preview</summary>
      <pre class="perm-card-input"></pre>
    </details>
    <div class="perm-card-actions">
      <button class="perm-btn perm-btn-allow">✅ Allow</button>
      <button class="perm-btn perm-btn-deny">❌ Deny</button>
      <span class="perm-card-status" hidden></span>
    </div>
  `
  const preEl = card.querySelector('.perm-card-input')
  if (preEl) {
    let pretty = data.input_preview
    try { pretty = JSON.stringify(JSON.parse(data.input_preview), null, 2) } catch {}
    preEl.textContent = pretty
  }
  card.querySelector('.perm-btn-allow')?.addEventListener('click', () => respondToPermission(data, 'allow', card))
  card.querySelector('.perm-btn-deny')?.addEventListener('click', () => respondToPermission(data, 'deny', card))
  stream.appendChild(card)
  stream.scrollTop = stream.scrollHeight
}

async function respondToPermission(data, behavior, card) {
  const allowBtn = card.querySelector('.perm-btn-allow')
  const denyBtn = card.querySelector('.perm-btn-deny')
  const statusEl = card.querySelector('.perm-card-status')
  if (allowBtn) allowBtn.disabled = true
  if (denyBtn) denyBtn.disabled = true
  try {
    const res = await fetch('/api/permission-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: data.session, request_id: data.request_id, behavior }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    // Success: server will broadcast permission-resolved which updates the card
  } catch (err) {
    if (allowBtn) allowBtn.disabled = false
    if (denyBtn) denyBtn.disabled = false
    if (statusEl) {
      statusEl.hidden = false
      statusEl.textContent = 'Error: ' + (err.message || 'send failed')
      statusEl.className = 'perm-card-status perm-card-status-error'
    }
  }
}

function updatePermissionCardResolved(data) {
  const card = document.querySelector(`.perm-card[data-request-id="${CSS.escape(data.request_id)}"]`)
  if (!card) return
  card.classList.remove('perm-card-pending')
  card.classList.add('perm-card-resolved')
  const actions = card.querySelector('.perm-card-actions')
  if (actions) {
    actions.innerHTML = `<span class="perm-card-status perm-card-status-${data.behavior}">${
      data.behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    }</span>`
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
```

If there's an existing `escapeHtml` utility in `dashboard.js`, use it instead. Grep first:

```bash
grep -n "function escapeHtml\|escapeHTML\|htmlEscape" dashboard/dashboard.js
```

- [ ] **Step 2: Add card styles to `dashboard/dashboard.css`**

Append:

```css
.perm-card {
  border: 1px solid #d29922;
  border-left: 4px solid #d29922;
  background: rgba(210, 153, 34, 0.06);
  border-radius: 6px;
  padding: 10px 14px;
  margin: 8px 0;
}
.perm-card-resolved { opacity: 0.7; border-color: #3a4252; border-left-color: #3a4252; background: transparent; }
.perm-card-header { font-weight: 600; margin-bottom: 4px; }
.perm-card-descr { margin-bottom: 8px; color: #c9d1d9; }
.perm-card-details summary { cursor: pointer; color: #8fa0bb; font-size: 13px; }
.perm-card-input { background: #0d1117; padding: 8px; border-radius: 4px; overflow-x: auto; margin: 6px 0 8px 0; font-size: 12px; }
.perm-card-actions { display: flex; gap: 8px; align-items: center; }
.perm-btn { border: none; padding: 4px 10px; border-radius: 4px; font-size: 13px; cursor: pointer; color: #fff; }
.perm-btn-allow { background: #2ea043; }
.perm-btn-allow:hover:not(:disabled) { background: #238636; }
.perm-btn-deny { background: #da3633; }
.perm-btn-deny:hover:not(:disabled) { background: #b62625; }
.perm-btn:disabled { opacity: 0.5; cursor: default; }
.perm-card-status { font-size: 13px; color: #8fa0bb; }
.perm-card-status-allow { color: #3fb950; }
.perm-card-status-deny { color: #f85149; }
.perm-card-status-error { color: #f85149; }
```

- [ ] **Step 3: Manual smoke test**

You need a real MCP permission_request to exercise this — not easy to fake without a live Claude Code session. One approach: directly test the dashboard side by hand via `wscat`:

```bash
bunx wscat -c ws://localhost:3400/ws
# send nothing; switch to another terminal
# use another tool to emit a WS frame server-side, OR curl the dashboard:
curl -X POST http://localhost:3400/api/_debug_emit_frame \
  -d '{"type":"permission-request","data":{"session":"research","request_id":"abc12","tool_name":"Bash","description":"Run ls","input_preview":"{\"command\":\"ls\"}"}}'
```

No such `_debug_emit_frame` endpoint exists — so for manual test, simpler path: open browser console, inject the frame directly into the dispatcher:

```js
renderPermissionCard({ session: 'research', request_id: 'abc12', tool_name: 'Bash', description: 'Run ls', input_preview: '{"command":"ls"}' })
```

Verify the card appears. Click Allow: buttons disable, request goes out (Network tab → `POST /api/permission-response`). Since there's no listening session, server still broadcasts `permission-resolved` → buttons replaced with "✅ Allowed" text.

- [ ] **Step 4: Commit**

```bash
git add dashboard/dashboard.js dashboard/dashboard.css
git commit -m "feat(notif): permission request card with Allow/Deny in session stream

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 21: Integration test — end-to-end permission flow

**Files:**
- Create: `tests/notifications-integration.test.ts`

This tests the full round-trip without touching browser-layer code:
- `permission_request` → `permissionBridge.handlePermissionRequest` → UDP envelope.
- Server-side `buildPermissionRequestFrame` → WS frame shape.
- Dashboard POST → `buildPermissionResponseEnvelope` → UDP.
- `permissionBridge.handlePermissionResponseEnvelope` → MCP notification.

- [ ] **Step 1: Write the integration test**

Create `tests/notifications-integration.test.ts`:

```ts
import { test, expect, describe } from 'bun:test'
import { createPermissionBridge } from '../src/permission-bridge.js'
import {
  buildPermissionRequestFrame,
  validatePermissionResponseBody,
  buildPermissionResponseEnvelope,
} from '../dashboard/serve-helpers.js'
import type { Envelope } from '../src/types.js'

describe('notification flow end-to-end (permission)', async () => {
  test('MCP → UDP → WS frame → POST → UDP → MCP', async () => {
    // --- Session side ---
    const mcpNotifications: Array<{ request_id: string; behavior: string }> = []
    const udpFromSession: Envelope[] = []
    const sessionBridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: (env) => udpFromSession.push(env),
      sendMcpNotification: (params) => mcpNotifications.push(params),
    })

    // --- Claude sends permission_request to the session's MCP server ---
    sessionBridge.handlePermissionRequest({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"cmd":"bun test"}',
    })
    expect(udpFromSession).toHaveLength(1)
    const envToDashboard = udpFromSession[0]
    expect(envToDashboard.type).toBe('permission-request')

    // --- Dashboard side receives UDP envelope, formats as WS frame ---
    const wsFrame = buildPermissionRequestFrame(envToDashboard)
    expect(wsFrame).not.toBeNull()
    expect(wsFrame!.data.session).toBe('research')
    expect(wsFrame!.data.request_id).toBe('abc12')
    expect(wsFrame!.data.tool_name).toBe('Bash')

    // --- Browser clicks Allow → POST /api/permission-response ---
    const validation = validatePermissionResponseBody({
      session: 'research',
      request_id: 'abc12',
      behavior: 'allow',
    })
    expect(validation.ok).toBe(true)

    // --- Dashboard emits UDP response ---
    const envToSession = buildPermissionResponseEnvelope({
      from: 'dashboard',
      session: 'research',
      request_id: 'abc12',
      behavior: 'allow',
    })

    // --- Session receives UDP response, translates back to MCP ---
    sessionBridge.handlePermissionResponseEnvelope(envToSession)
    expect(mcpNotifications).toEqual([{ request_id: 'abc12', behavior: 'allow' }])
    expect(sessionBridge.hasPending('abc12')).toBe(false)
  })

  test('second response for same request is ignored', async () => {
    const mcpNotifications: Array<unknown> = []
    const bridge = createPermissionBridge({
      sessionName: 'research',
      sendEnvelope: () => {},
      sendMcpNotification: (params) => mcpNotifications.push(params),
    })
    bridge.handlePermissionRequest({
      request_id: 'abc12',
      tool_name: 'Bash',
      description: '',
      input_preview: '',
    })

    const first = buildPermissionResponseEnvelope({
      from: 'dashboard',
      session: 'research',
      request_id: 'abc12',
      behavior: 'allow',
    })
    bridge.handlePermissionResponseEnvelope(first)

    const second = buildPermissionResponseEnvelope({
      from: 'dashboard',
      session: 'research',
      request_id: 'abc12',
      behavior: 'deny',
    })
    bridge.handlePermissionResponseEnvelope(second)

    expect(mcpNotifications).toHaveLength(1)
    expect(mcpNotifications[0]).toEqual({ request_id: 'abc12', behavior: 'allow' })
  })
})
```

- [ ] **Step 2: Run tests — expect pass**

Run: `bun test tests/notifications-integration.test.ts`
Expected: PASS (both tests).

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: PASS — no existing test should be broken by these changes.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: clean (ignoring any pre-existing unrelated errors in `dashboard/cli.ts`).

- [ ] **Step 5: Commit**

```bash
git add tests/notifications-integration.test.ts
git commit -m "test(notif): end-to-end permission flow integration test

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

After Task 21, do a real-world dogfood pass:

- [ ] Dashboard starts clean: `bun dashboard/serve.ts`.
- [ ] Browser loads `localhost:3400`. If permission default, banner appears. Click Enable → granted.
- [ ] Start a party-line Claude session: `ccpl test-a`. Card appears on Switchboard. Click bell → turns on.
- [ ] Close tab. Have `test-a` session finish a turn. Phone / another browser tab should receive notification. Click → navigates to `/session/test-a`.
- [ ] Open two browsers on the same dashboard. From `ccpl test-a`, trigger a real permission prompt (e.g. ask Claude to run a Bash command). Both browsers show the card. Click Allow in browser 1 → browser 2's card updates to "✅ Allowed" (cross-device dismiss works).
- [ ] Send a party-line DM from `ccpl test-b` to `test-a`. Browser notification fires on all tabs not currently viewing `/session/test-a`. Notifications on tabs that ARE viewing the session do NOT fire.
- [ ] Navigate into `/session/test-a` on browser 1 → notifications on browser 2 close (cross-device dismiss via `session-viewed`).

Any failure in the dogfood pass is a bug — fix on the same branch before merging.

---

## Out-of-scope reminders

Do not add any of the following in this plan:
- Service Worker registration or `manifest.json`.
- Web Push / VAPID / push subscription endpoints.
- HTTPS / TLS cert handling for mobile LAN access.
- Inline Allow/Deny buttons on browser notifications (we route to the session detail view instead).
- Tmux send-keys for any command routing.
- Per-trigger-type toggles (single toggle covers A/B/C for MVP).
- Sound selection / custom audio.
- Notification history / "mark as read" affordance.

These are either in the follow-up "PWA + Web Push" spec or the deferred "remote control" spec.
