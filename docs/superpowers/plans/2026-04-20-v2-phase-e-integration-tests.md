# Party Line v2 — Phase E: Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the coverage gaps the audit flagged as "no end-to-end tests exist." Add real boot-the-server integration tests for the dashboard HTTP + WS stack, a real two-process exchange test for the switchboard, and a Playwright smoke test that drives the UI through the notifications permission flow.

**Architecture:** Tests in three layers — (1) in-process Bun `serve.ts` boot + black-box HTTP/WS calls, (2) two `ws-client.ts` instances talking through a live switchboard, (3) Playwright against a real browser with `grantPermissions(['notifications'])`.

**Tech Stack:** `bun:test` for layers 1 and 2; `@playwright/test` (new dev dependency) for layer 3.

**Prerequisite:** Phase A, B, and C complete. The app actually needs to work before we test that it works end-to-end.

**Part of:** Party Line v2 rebuild. Audit: `docs/audit/2026-04-20-tests.md`. Success criteria: `docs/superpowers/specs/2026-04-20-hub-and-spoke-design.md` §11.

---

## File Structure

| File                                 | Responsibility                                                |
| ------------------------------------ | ------------------------------------------------------------- |
| `tests/helpers/boot-server.ts`       | Boots a real `serve.ts` on an ephemeral port for tests        |
| `tests/serve-routes.test.ts`         | HTTP route matrix: login, /ccpl/\*, /api/send, auth gating    |
| `tests/serve-ws-integration.test.ts` | Boots serve.ts, connects real WS clients, exchanges envelopes |
| `tests/playwright.config.ts`         | Playwright configuration                                      |
| `tests/e2e/notifications.spec.ts`    | Playwright smoke for SW notifications                         |
| `package.json`                       | Add `@playwright/test` dev dep + e2e scripts                  |
| `.gitignore`                         | Add `test-results/`, `playwright-report/`                     |

---

## Task E1: Test harness — boot `serve.ts` on ephemeral port

**Files:**

- Create: `tests/helpers/boot-server.ts`

**Background:** All integration tests need the real dashboard server running. A helper that boots it on `port: 0` (ephemeral), returns the port and a cleanup function, with a per-test temp DB.

- [ ] **Step 1: Write the helper**

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

export interface BootedServer {
  port: number
  baseUrl: string
  dbPath: string
  password: string
  stop: () => Promise<void>
}

/**
 * Boots a fresh dashboard/serve.ts on an ephemeral port with a per-test temp DB
 * and password auth enabled. Returns the base URL + a stop function.
 *
 * Note: this relies on dashboard/serve.ts exporting a `bootServer(opts)`
 * function. If serve.ts is currently a top-level side-effect module, refactor
 * it to expose a `bootServer({port, dbPath}: BootOpts): Promise<Server>` that
 * returns the Bun Server instance.
 */
export async function bootServer(): Promise<BootedServer> {
  const tmp = mkdtempSync(join(tmpdir(), 'pl-boot-'))
  const dbPath = join(tmp, 'test.db')
  const password = 'testpass-' + randomBytes(4).toString('hex')

  process.env.PARTY_LINE_DB_PATH = dbPath
  process.env.PARTY_LINE_DASHBOARD_PASSWORD = password
  process.env.PARTY_LINE_DASHBOARD_SECRET = randomBytes(32).toString('hex')
  // Ensure serve.ts doesn't insist on TLS for tests.
  delete process.env.PARTY_LINE_TLS_CERT
  delete process.env.PARTY_LINE_TLS_KEY

  // Import dynamically so env vars are picked up at boot time.
  const { bootServer: actualBoot } = await import('../../dashboard/serve')
  const server = await actualBoot({ port: 0 })
  const port = server.port

  return {
    port,
    baseUrl: `http://localhost:${port}`,
    dbPath,
    password,
    async stop() {
      server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

export async function loginAndGetCookie(s: BootedServer): Promise<string> {
  const res = await fetch(s.baseUrl + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: s.password }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') || ''
  const m = setCookie.match(/pl_dash=([^;]+)/)
  if (!m) throw new Error('no pl_dash cookie in response')
  return `pl_dash=${m[1]}`
}
```

- [ ] **Step 2: Refactor `dashboard/serve.ts` to export `bootServer`**

If `serve.ts` currently runs `Bun.serve(...)` as a top-level side effect, wrap it:

```ts
export interface BootOpts {
  port?: number
  dbPath?: string
}

export async function bootServer(opts: BootOpts = {}): Promise<Server> {
  const port = opts.port ?? Number(process.env.PORT ?? 3400)
  const dbPath = opts.dbPath ?? process.env.PARTY_LINE_DB_PATH ?? defaultDbPath()
  const db = openDb(dbPath)
  // ...existing setup: switchboard, routes, WS handlers...
  const server = Bun.serve({
    port,
    // ...fetch + websocket...
  })
  return server
}

// Preserve top-level execution for `bun dashboard/serve.ts` launches:
if (import.meta.main) {
  await bootServer()
}
```

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/boot-server.ts dashboard/serve.ts
git commit -m "test: add bootServer helper + refactor serve.ts to expose it

bootServer(opts) returns a real Bun.serve instance on an ephemeral
port with a per-test temp DB. Top-level execution preserved via
import.meta.main guard."
```

---

## Task E2: HTTP route matrix tests

**Files:**

- Create: `tests/serve-routes.test.ts`

- [ ] **Step 1: Write the tests**

```ts
import { describe, test, expect } from 'bun:test'
import { bootServer, loginAndGetCookie } from './helpers/boot-server'

describe('serve: HTTP routes', () => {
  test('GET / without cookie redirects to /login', async () => {
    const s = await bootServer()
    const res = await fetch(s.baseUrl + '/', {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/\/login/)
    await s.stop()
  })

  test('POST /login wrong password returns 401', async () => {
    const s = await bootServer()
    const res = await fetch(s.baseUrl + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    })
    expect(res.status).toBe(401)
    await s.stop()
  })

  test('POST /login correct password sets cookie', async () => {
    const s = await bootServer()
    const res = await fetch(s.baseUrl + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: s.password }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') || '').toMatch(/pl_dash=/)
    await s.stop()
  })

  test('POST /ccpl/register returns a token, second same-name returns 409', async () => {
    const s = await bootServer()
    const first = await fetch(s.baseUrl + '/ccpl/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-dup', cwd: '/tmp' }),
    })
    expect(first.status).toBe(200)
    const body = (await first.json()) as { token: string }
    expect(body.token).toMatch(/^[a-f0-9]{64}$/)
    const second = await fetch(s.baseUrl + '/ccpl/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-dup', cwd: '/tmp' }),
    })
    expect(second.status).toBe(409)
    await s.stop()
  })

  test('GET /ccpl/sessions requires cookie, returns list with cookie', async () => {
    const s = await bootServer()
    const without = await fetch(s.baseUrl + '/ccpl/sessions')
    expect(without.status).toBe(401)
    const cookie = await loginAndGetCookie(s)
    const with_ = await fetch(s.baseUrl + '/ccpl/sessions', {
      headers: { cookie },
    })
    expect(with_.status).toBe(200)
    const body = (await with_.json()) as { sessions: unknown[] }
    expect(Array.isArray(body.sessions)).toBe(true)
    await s.stop()
  })

  test('GET /ccpl/session/:name needs matching token', async () => {
    const s = await bootServer()
    const reg = (await (
      await fetch(s.baseUrl + '/ccpl/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'e2e-auth', cwd: '/tmp' }),
      })
    ).json()) as { token: string }

    const bad = await fetch(s.baseUrl + '/ccpl/session/e2e-auth')
    expect(bad.status).toBe(401)

    const good = await fetch(s.baseUrl + '/ccpl/session/e2e-auth', {
      headers: { 'X-Party-Line-Token': reg.token },
    })
    expect(good.status).toBe(200)
    const body = (await good.json()) as { name: string; cwd: string }
    expect(body.name).toBe('e2e-auth')
    await s.stop()
  })

  test('POST /ccpl/session/:name/rotate invalidates old token', async () => {
    const s = await bootServer()
    const reg = (await (
      await fetch(s.baseUrl + '/ccpl/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'e2e-rot', cwd: '/tmp' }),
      })
    ).json()) as { token: string }
    const rot = (await (
      await fetch(s.baseUrl + '/ccpl/session/e2e-rot/rotate', {
        method: 'POST',
        headers: { 'X-Party-Line-Token': reg.token },
      })
    ).json()) as { token: string }
    expect(rot.token).not.toBe(reg.token)
    const withOld = await fetch(s.baseUrl + '/ccpl/session/e2e-rot', {
      headers: { 'X-Party-Line-Token': reg.token },
    })
    expect(withOld.status).toBe(401)
    await s.stop()
  })

  test('GET /sw.js has Service-Worker-Allowed header', async () => {
    const s = await bootServer()
    const res = await fetch(s.baseUrl + '/sw.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('service-worker-allowed')).toBe('/')
    await s.stop()
  })

  test('GET /manifest.json serves application/manifest+json', async () => {
    const s = await bootServer()
    const res = await fetch(s.baseUrl + '/manifest.json')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/manifest\+json/)
    await s.stop()
  })
})
```

- [ ] **Step 2: Run**

Run: `bun test tests/serve-routes.test.ts`
Expected: all 9 pass.

- [ ] **Step 3: Commit**

```bash
git add tests/serve-routes.test.ts
git commit -m "test(integration): HTTP route matrix for dashboard server

Covers login, cookie auth gating, ccpl register/session/rotate,
PWA asset headers. Boots serve.ts in-process per test on ephemeral
port with temp DB. Closes audit T2 part 2."
```

---

## Task E3: WS session integration through booted `serve.ts`

**Files:**

- Create: `tests/serve-ws-integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, test, expect } from 'bun:test'
import { bootServer, loginAndGetCookie } from './helpers/boot-server'
import { createWsClient } from '../src/transport/ws-client'

describe('serve: WS session integration', () => {
  test('two sessions registered, clientA sends to B, B receives via envelope frame', async () => {
    const s = await bootServer()

    const regA = (await (
      await fetch(s.baseUrl + '/ccpl/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ws-a', cwd: '/tmp' }),
      })
    ).json()) as { token: string }
    const regB = (await (
      await fetch(s.baseUrl + '/ccpl/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ws-b', cwd: '/tmp' }),
      })
    ).json()) as { token: string }

    const url = s.baseUrl.replace('http://', 'ws://') + '/ws/session'
    const received: any[] = []

    const a = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: regA.token,
        name: 'ws-a',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'e2e',
      },
      pingIntervalMs: 60_000,
    })
    const b = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: regB.token,
        name: 'ws-b',
        cc_session_uuid: null,
        pid: 2,
        machine_id: null,
        version: 'e2e',
      },
      pingIntervalMs: 60_000,
    })
    b.on('envelope', (f) => received.push(f))

    let aReady = false
    let bReady = false
    a.on('accepted', () => (aReady = true))
    b.on('accepted', () => (bReady = true))

    a.start()
    b.start()

    for (let i = 0; i < 60 && (!aReady || !bReady); i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(aReady).toBe(true)
    expect(bReady).toBe(true)

    a.send({ type: 'send', to: 'ws-b', body: 'e2e hello', client_ref: 'c1' })

    for (let i = 0; i < 60 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(received.length).toBe(1)
    expect(received[0].from).toBe('ws-a')
    expect(received[0].to).toBe('ws-b')
    expect(received[0].body).toBe('e2e hello')

    a.stop()
    b.stop()
    await s.stop()
  })

  test('observer receives session-delta when session comes online then offline', async () => {
    const s = await bootServer()
    const cookie = await loginAndGetCookie(s)

    const reg = (await (
      await fetch(s.baseUrl + '/ccpl/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ws-c', cwd: '/tmp' }),
      })
    ).json()) as { token: string }

    // Connect an observer with the cookie. Use a raw WebSocket (no need for ws-client's reconnect here).
    const obsUrl = s.baseUrl.replace('http://', 'ws://') + '/ws/observer'
    const observer = new WebSocket(obsUrl, { headers: { cookie } } as any)
    const obsFrames: any[] = []
    observer.addEventListener('message', (e) => {
      obsFrames.push(JSON.parse(e.data as string))
    })
    await new Promise((r) => observer.addEventListener('open', r, { once: true }))

    // Clear the snapshot frame.
    await new Promise((r) => setTimeout(r, 30))
    obsFrames.length = 0

    // Connect the session.
    const client = createWsClient({
      url: s.baseUrl.replace('http://', 'ws://') + '/ws/session',
      helloPayload: {
        type: 'hello',
        token: reg.token,
        name: 'ws-c',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'e2e',
      },
      pingIntervalMs: 60_000,
    })
    client.start()

    for (
      let i = 0;
      i < 60 && !obsFrames.some((f) => f.type === 'session-delta' && f.session === 'ws-c');
      i++
    ) {
      await new Promise((r) => setTimeout(r, 30))
    }
    const onlineDelta = obsFrames.find((f) => f.type === 'session-delta' && f.session === 'ws-c')
    expect(onlineDelta).toBeDefined()
    expect(onlineDelta.changes.online).toBe(true)

    obsFrames.length = 0
    client.stop()

    for (
      let i = 0;
      i < 60 && !obsFrames.some((f) => f.type === 'session-delta' && f.session === 'ws-c');
      i++
    ) {
      await new Promise((r) => setTimeout(r, 30))
    }
    const offlineDelta = obsFrames.find((f) => f.type === 'session-delta' && f.session === 'ws-c')
    expect(offlineDelta).toBeDefined()
    expect(offlineDelta.changes.online).toBe(false)

    observer.close()
    await s.stop()
  })

  test('second connection with same token supersedes first (close code 4408)', async () => {
    const s = await bootServer()
    const reg = (await (
      await fetch(s.baseUrl + '/ccpl/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ws-s', cwd: '/tmp' }),
      })
    ).json()) as { token: string }

    const url = s.baseUrl.replace('http://', 'ws://') + '/ws/session'
    let firstCloseCode = 0

    const first = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: reg.token,
        name: 'ws-s',
        cc_session_uuid: null,
        pid: 1,
        machine_id: null,
        version: 'e2e',
      },
      pingIntervalMs: 60_000,
    })
    first.on('close', (code) => (firstCloseCode = code))
    first.start()
    await new Promise<void>((r) => first.on('accepted', () => r()))

    const second = createWsClient({
      url,
      helloPayload: {
        type: 'hello',
        token: reg.token,
        name: 'ws-s',
        cc_session_uuid: null,
        pid: 2,
        machine_id: null,
        version: 'e2e',
      },
      pingIntervalMs: 60_000,
    })
    second.start()
    await new Promise<void>((r) => second.on('accepted', () => r()))

    // First should have been closed with 4408.
    for (let i = 0; i < 60 && firstCloseCode === 0; i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(firstCloseCode).toBe(4408)

    second.stop()
    await s.stop()
  })
})
```

- [ ] **Step 2: Run**

Run: `bun test tests/serve-ws-integration.test.ts`
Expected: all 3 pass.

- [ ] **Step 3: Commit**

```bash
git add tests/serve-ws-integration.test.ts
git commit -m "test(integration): session WS round-trip, delta broadcast, supersede via booted serve.ts

Real Bun.serve with switchboard + real ws-client instances. Covers
session-to-session envelope delivery, session-delta online/offline
broadcasts to observers, and second-connection-wins supersede."
```

---

## Task E4: Add Playwright dev dependency + config

**Files:**

- Modify: `package.json`
- Create: `tests/playwright.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Install Playwright**

```bash
bun add -d @playwright/test
bunx playwright install chromium
```

- [ ] **Step 2: Add scripts to `package.json`**

```json
{
  "scripts": {
    "test:e2e": "playwright test -c tests/playwright.config.ts",
    "test:e2e:headed": "playwright test -c tests/playwright.config.ts --headed"
  }
}
```

- [ ] **Step 3: Create the Playwright config**

```ts
// tests/playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // Notifications tests serialize for granted-permissions state.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3500',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['notifications'],
      },
    },
  ],
  webServer: {
    command:
      'PARTY_LINE_DASHBOARD_PASSWORD=e2epw PARTY_LINE_DASHBOARD_SECRET=$(openssl rand -hex 32) PARTY_LINE_DB_PATH=/tmp/pl-e2e.db PORT=3500 bun dashboard/serve.ts',
    url: 'http://localhost:3500/login',
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
})
```

- [ ] **Step 4: Update `.gitignore`**

Append:

```
test-results/
playwright-report/
.playwright/
```

- [ ] **Step 5: Verify**

Run: `bunx playwright --version`
Expected: prints version.

- [ ] **Step 6: Commit**

```bash
git add package.json tests/playwright.config.ts .gitignore bun.lockb
git commit -m "test(e2e): add Playwright dev dep + config

Boots serve.ts on port 3500 with test password. Single worker (tests
are stateful wrt notifications). Chromium only for now; granted
notification permissions."
```

---

## Task E5: Playwright smoke — SW registers + notification fires

**Files:**

- Create: `tests/e2e/notifications.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test'

test.describe('notifications smoke', () => {
  test('login → SW registers → bell toggle → message fires notification', async ({
    page,
    context,
  }) => {
    // 1. Login.
    await page.goto('/login')
    await page.fill('input[name="password"]', 'e2epw')
    await page.click('button[type="submit"]')
    await expect(page).toHaveURL('/')

    // 2. Service Worker is registered within 5s.
    const swRegistered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false
      const reg = await navigator.serviceWorker.ready
      return !!reg
    })
    expect(swRegistered).toBe(true)

    // 3. Create a test session via API and connect it.
    const token = await page.evaluate(async () => {
      const res = await fetch('/ccpl/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'e2e-target', cwd: '/tmp' }),
      })
      const body = await res.json()
      return body.token as string
    })
    expect(token).toMatch(/^[a-f0-9]{64}$/)

    // Open a WS session in the page's JS context.
    await page.evaluate(
      ({ tk }) =>
        new Promise<void>((resolve) => {
          const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws/session')
          ws.addEventListener('open', () => {
            ws.send(
              JSON.stringify({
                type: 'hello',
                token: tk,
                name: 'e2e-target',
                cc_session_uuid: null,
                pid: 1,
                machine_id: null,
                version: 'e2e',
              }),
            )
          })
          ws.addEventListener('message', (e) => {
            const frame = JSON.parse(String(e.data))
            if (frame.type === 'accepted') {
              ;(window as any).__e2eTargetWs = ws
              resolve()
            }
          })
        }),
      { tk: token },
    )

    // 4. Wait for the card to render and toggle the bell.
    const card = page.locator('[data-session-id="e2e-target"]')
    await expect(card).toBeVisible()
    const bell = card.locator('.notif-bell')
    await bell.click()

    // Chromium's permission was pre-granted via the config, so click immediately enables.
    await expect(bell).toHaveText('🔔')

    // 5. Hide the dashboard tab (so notifications fire — tab not in focus for its route).
    // Easiest: navigate to a different route so shouldFire() returns true.
    await page.goto('/history')

    // 6. Send an envelope TO e2e-target via /api/send.
    const sent = await page.evaluate(async () => {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'e2e-target', message: 'hello from E2E' }),
      })
      return res.ok
    })
    expect(sent).toBe(true)

    // 7. Inspect the SW's active notifications. The page reaches the SW
    //    via navigator.serviceWorker.ready and asks for notifications tagged 'e2e-target'.
    const notifications = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      const ns = await reg.getNotifications({ tag: 'e2e-target' })
      return ns.map((n) => ({ title: n.title, body: n.body, tag: n.tag }))
    })
    expect(notifications.length).toBeGreaterThan(0)
    expect(notifications[0].tag).toBe('e2e-target')
  })

  test('permission banner: insecure context copy + denied state copy', async ({ page }) => {
    await page.goto('/login')
    await page.fill('input[name="password"]', 'e2epw')
    await page.click('button[type="submit"]')

    // With granted permission from context, banner should be hidden.
    const banner = page.locator('#notif-banner')
    await expect(banner).toBeHidden()
  })
})
```

- [ ] **Step 2: Run the Playwright tests**

Run: `bun run test:e2e`
Expected: the first test passes (granted permissions + fresh SW). The second test passes because `grantPermissions(['notifications'])` is in config.

If tests fail due to timing (ws-open faster than card render), tune the 5s default timeout up. If the SW registration races, add `await navigator.serviceWorker.ready` polling.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/notifications.spec.ts
git commit -m "test(e2e): Playwright smoke for SW notifications

Login → SW registered → session registered + WS-connected → bell
toggled → message sent → SW notification exists with correct tag.
Covers the full stack that audit N1 showed was silently broken."
```

---

## Task E6: Wire E2E into `test:all`

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Extend `test:all`**

Update the `test:all` script:

```json
{
  "scripts": {
    "test:all": "bun run typecheck && bun test && bun run test:e2e"
  }
}
```

- [ ] **Step 2: Run**

Run: `bun run test:all`
Expected: typecheck passes, unit tests pass, Playwright tests pass.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test: include e2e in test:all

Single command now runs typecheck + unit + integration + Playwright."
```

---

## Task E7: MCP plugin integration test (optional — if time allows)

**Files:**

- Create: `tests/mcp-plugin-integration.test.ts`

**Background:** Boots the MCP plugin as a subprocess with a `PARTY_LINE_TOKEN`, connects a fake switchboard, and validates the hello frame. This is higher-value than it sounds because it exercises the exact startup path Claude Code will use.

- [ ] **Step 1: Write the test**

```ts
import { describe, test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('mcp plugin — hello flow', () => {
  test('plugin connects with PARTY_LINE_TOKEN and sends a valid hello frame', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pl-mcp-'))

    // Stand up a fake switchboard that just validates the hello frame.
    let helloFrame: any = null
    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req, { data: { kind: 'session' } })) return
        return new Response('no', { status: 400 })
      },
      websocket: {
        open() {},
        message(ws: any, raw) {
          const frame = JSON.parse(String(raw))
          if (frame.type === 'hello') {
            helloFrame = frame
            ws.send(JSON.stringify({ type: 'accepted', server_time: Date.now() }))
          }
        },
        close() {},
      },
    })

    // Spawn the MCP plugin with token + switchboard URL.
    const env = {
      ...process.env,
      PARTY_LINE_TOKEN: 'fake-token-for-shape-test',
      PARTY_LINE_SWITCHBOARD_URL: `ws://localhost:${server.port}/`,
      // Name resolution fallback — the plugin reads `--name` from process tree;
      // in test we override via env var if the plugin supports it.
      PARTY_LINE_SESSION_NAME_OVERRIDE: 'mcp-test',
    }
    const child = spawn('bun', ['src/server.ts'], { env, stdio: ['pipe', 'pipe', 'pipe'] })

    // Wait up to 3 seconds for the hello frame.
    for (let i = 0; i < 100 && helloFrame === null; i++) {
      await new Promise((r) => setTimeout(r, 30))
    }

    expect(helloFrame).not.toBeNull()
    expect(helloFrame.type).toBe('hello')
    expect(helloFrame.token).toBe('fake-token-for-shape-test')
    expect(typeof helloFrame.pid).toBe('number')

    child.kill('SIGTERM')
    server.stop()
    rmSync(tmp, { recursive: true, force: true })
  })
})
```

Note: If `src/server.ts` doesn't currently support `PARTY_LINE_SESSION_NAME_OVERRIDE`, add a small read at startup:

```ts
const name =
  process.env.PARTY_LINE_SESSION_NAME_OVERRIDE || resolveNameFromProcessTree() || 'unknown'
```

- [ ] **Step 2: Run**

Run: `bun test tests/mcp-plugin-integration.test.ts`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp-plugin-integration.test.ts src/server.ts
git commit -m "test(mcp): plugin subprocess boot + hello frame shape

Spawns src/server.ts as a child, points it at a fake switchboard,
and verifies the hello frame shape. Closes audit T5 part."
```

---

## Phase E Exit Criteria

After all tasks:

- [ ] `bun run test:all` runs typecheck + unit + integration + Playwright and all pass.
- [ ] A fresh clone can `bun install && bunx playwright install chromium && bun run test:all` and land green.
- [ ] Playwright report shows a passing `notifications smoke` test.
- [ ] Test coverage map (rough, not measured numerically):
  - MCP plugin startup: covered by E7.
  - Switchboard routing: covered by E3 + C8's unit tests.
  - HTTP routes: covered by E2.
  - Notifications end-to-end: covered by E5.
  - WebSocket session round-trip with real Bun.serve: covered by E3.

## Notes for the Implementer

- Phase E is where all the "it works in unit tests but breaks in real use" bugs get caught. Expect to find 1-3 real bugs while writing these tests; treat them as plan amendments and commit fixes alongside the tests that catch them.
- Playwright is flakier than bun:test — if a test flakes once in three runs, raise the expect timeout first before adding retries.
- E4's `webServer.command` uses `$(openssl rand -hex 32)` which requires a shell — confirm Playwright's shell is bash. If not, bake the secret into a fixture file.
- E7 is marked optional — skip it if you're time-boxed. The shape tests in E3 plus the unit tests in C10 already cover most of the plugin contract.
