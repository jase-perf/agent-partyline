# PR 3 — Transport Reliability

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten WebSocket reliability across the hub-and-spoke transport: pong-timeout to detect dead half-open sockets, jittered reconnect to avoid stampedes, error handler that actually closes, observer snapshot ordering, broadcast backpressure to bound buffer growth, frame size cap, and graceful quota-poller shutdown.

**Architecture:**

- `ws-client.ts` (outbound, used by every MCP plugin): track `lastPongAt`; force-close when `now - lastPongAt > pongTimeoutMs`. Add `Math.random() * 0.3 * delay` jitter to reconnect. Wire `error` event to call `ws.close()` so the close handler fires reconnect.
- `switchboard.ts` (inbound, on the dashboard): `handleObserverOpen` sends snapshot BEFORE adding to the observers Set so a delta can't interleave between add + snapshot. `toObservers` checks `bufferedAmount` before send and drops slow clients (`> 4 MB` threshold).
- `dashboard/serve.ts`: Bun.serve `websocket: { maxPayloadLength: 1 MiB }` so a misbehaving session can't OOM the loop.
- `dashboard/quota.ts`: track in-flight `fetchQuota()` promise; `stopQuotaPoller()` clears interval AND awaits any in-flight fetch.

**Tech Stack:** TypeScript (strict), Bun runtime, `node:events` for the WS client EventEmitter, `bun:test`.

---

## Branch + verification commands

All tasks run on `pr3-transport-reliability` (created in Task 0).

- `bun test` — full suite (baseline 349 / 0)
- `bunx tsc --noEmit -p .` — strict type check (clean as of PR 2 merge)
- `node --check dashboard/dashboard.js` — frontend parse (PR 3 doesn't touch the frontend)

---

## Task 0: Branch + baseline

- [ ] **Step 1: Branch**

```bash
git status
git checkout -b pr3-transport-reliability
```

Expected: `bin/ccpl.ts` may show user WIP (uncommitted) — leave it. No other dirt.

- [ ] **Step 2: Baseline**

```bash
bun test 2>&1 | tail -5
```

Expected: `349 pass / 0 fail`.

---

## Task 1: WS client pong-timeout

**Files:**

- Modify: `src/transport/ws-client.ts`
- Test: `tests/ws-client.test.ts`

A half-open TCP connection (server crashed, NAT dropped state, network partition) leaves the client believing the WS is `OPEN` because no FIN/RST arrives. Pings still send; nothing comes back; `isConnected()` keeps returning true; sends silently fail or queue. Add a pong-timeout: if we haven't received ANY frame from the server in `pongTimeoutMs` (default 60s, ≈ 3 ping intervals at the default 20s), force-close so the close handler fires reconnect.

**Implementation note:** Bun's WS client doesn't have a "pong" message type by default — the switchboard's `handleObserverFrame` does respond with `{type:'pong'}` when sent `{type:'ping'}` (see `src/server/switchboard.ts:357-367`). For session sockets, the switchboard at `dashboard/serve.ts` doesn't currently respond to `ping` — verify and add the response there if needed (sub-step within this task).

- [ ] **Step 1: Add pong response on session WS**

In `dashboard/serve.ts` `websocket.message`, find the session-handling branch (after `if (kind === 'session')`). Add a `ping` case BEFORE the `if (frame.type === 'hello')` check:

```typescript
if (frame.type === 'ping') {
  try {
    ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
  } catch {
    /* ignore */
  }
  return
}
```

This is a tiny addition — pings can come pre-hello (during reconnect) and shouldn't be blocked.

- [ ] **Step 2: Track `lastPongAt` in `src/transport/ws-client.ts`**

Add to the local closure variables (around line 39):

```typescript
let lastPongAt = 0
let pongCheckTimer: Timer | null = null
```

Update the message handler to record activity:

```typescript
ws.addEventListener('message', (e) => {
  lastPongAt = Date.now() // ANY frame from the server proves liveness
  let data: { type?: string }
  try {
    data = JSON.parse(e.data as string) as { type?: string }
  } catch {
    log('warn', 'non-JSON frame dropped')
    return
  }
  emitter.emit('frame', data)
  if (typeof data.type === 'string') emitter.emit(data.type, data)
})
```

In the `open` handler, initialize and start the check:

```typescript
ws.addEventListener('open', () => {
  log('info', `ws open to ${opts.url}`)
  reconnectDelay = opts.reconnectInitialMs ?? 100
  lastPongAt = Date.now()
  // ... existing hello send + setPingTimer ...
  setPongCheckTimer()
  emitter.emit('open')
})
```

Add helper near `setPingTimer`:

```typescript
function setPongCheckTimer(): void {
  if (pongCheckTimer) clearInterval(pongCheckTimer)
  const timeout = opts.pongTimeoutMs ?? 60_000
  pongCheckTimer = setInterval(
    () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastPongAt > timeout) {
        log('warn', `pong timeout (${timeout}ms since last frame); force-close`)
        try {
          ws.close(4000, 'pong_timeout')
        } catch {
          /* ignore */
        }
      }
    },
    Math.min(opts.pingIntervalMs ?? 20_000, 10_000),
  )
}
```

In the `close` handler, clear the pong check timer:

```typescript
ws.addEventListener('close', (e) => {
  log('warn', `ws close code=${e.code} reason=${e.reason}`)
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
  if (pongCheckTimer) {
    clearInterval(pongCheckTimer)
    pongCheckTimer = null
  }
  // ... existing close handling
})
```

In `emitter.stop`, also clear it:

```typescript
emitter.stop = () => {
  stopped = true
  if (pingTimer) clearInterval(pingTimer)
  if (pongCheckTimer) clearInterval(pongCheckTimer)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (ws) ws.close()
}
```

Add `pongTimeoutMs?: number` to `WsClientOpts` interface.

- [ ] **Step 3: Write a test**

In `tests/ws-client.test.ts` (already exists), add:

```typescript
import { test, expect } from 'bun:test'
// (Use the existing test harness pattern — there's likely a fake-WS helper.)

test('client force-closes WS when no pong arrives within timeout', async () => {
  // Use the existing test harness's mock WebSocket to:
  // 1. Open the client
  // 2. Send some traffic, then go silent
  // 3. Advance time past pongTimeoutMs (or use a short timeout for the test)
  // 4. Assert ws.close was called with code 4000 'pong_timeout'
})
```

If the existing test file has a clear pattern for time-based tests, follow it. If time mocking is unavailable, use a very short `pongTimeoutMs: 100` and a real setTimeout to wait 200ms — fragile but acceptable for a single behavior. Cap the wait at 500ms.

- [ ] **Step 4: Run tests**

```bash
bun test 2>&1 | tail -3
```

Expected: 350 / 0 (or however many tests are in the suite + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/transport/ws-client.ts dashboard/serve.ts tests/ws-client.test.ts
git commit -m "fix(ws-client): pong-timeout detection — force-close half-open sockets"
```

---

## Task 2: WS client reconnect jitter

**Files:**

- Modify: `src/transport/ws-client.ts:56-61`
- Test: `tests/ws-client.test.ts`

Current `scheduleReconnect` uses pure exponential backoff. N sessions all reconnect on the same boundary after a server blip. Add jitter.

- [ ] **Step 1: Modify `scheduleReconnect`**

```typescript
// BEFORE
function scheduleReconnect(): void {
  if (stopped) return
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(connect, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, opts.reconnectMaxMs ?? 30_000)
}

// AFTER
function scheduleReconnect(): void {
  if (stopped) return
  if (reconnectTimer) clearTimeout(reconnectTimer)
  // Jitter ±30% to avoid synchronized reconnect storms when N clients
  // disconnect at the same moment (server restart). Math.random() returns
  // [0, 1), so (random - 0.5) gives [-0.5, 0.5); * 0.6 gives [-0.3, 0.3).
  const jitter = (Math.random() - 0.5) * 0.6
  const delayWithJitter = Math.max(0, Math.round(reconnectDelay * (1 + jitter)))
  reconnectTimer = setTimeout(connect, delayWithJitter)
  reconnectDelay = Math.min(reconnectDelay * 2, opts.reconnectMaxMs ?? 30_000)
}
```

- [ ] **Step 2: Write/update test**

In `tests/ws-client.test.ts`, add:

```typescript
test('reconnect delay has jitter applied (±30%)', async () => {
  // Hard to test directly without exposing scheduleReconnect. If the existing
  // test harness mocks setTimeout, you can capture the delay arg over many
  // disconnects and verify the spread. If not, mark this test as a smoke
  // assertion: trigger a close, observe the next reconnect timer, verify it's
  // within [0.7 * base, 1.3 * base] for a known base.
  //
  // Acceptable: skip this test if the harness can't observe the delay
  // (the implementation is small enough that visual review is sufficient).
})
```

If the test is too invasive, skip it and document in the commit message.

- [ ] **Step 3: Run tests + commit**

```bash
bun test 2>&1 | tail -3
git add src/transport/ws-client.ts tests/ws-client.test.ts
git commit -m "fix(ws-client): jitter reconnect delay ±30% — defeat synchronized reconnect storms"
```

---

## Task 3: WS error handler closes the socket

**Files:**

- Modify: `src/transport/ws-client.ts:132-134`

Today the `error` handler logs only. Some failure modes (e.g., DNS resolution failure mid-connect on a slow link) emit `error` without `close`, leaving the client stuck — `isConnected()` returns false but no reconnect ever fires.

- [ ] **Step 1: Update the error handler**

```typescript
// BEFORE
ws.addEventListener('error', (e) => {
  log('warn', `ws error: ${String(e)}`)
})

// AFTER
ws.addEventListener('error', (e) => {
  log('warn', `ws error: ${String(e)} — closing to trigger reconnect`)
  try {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close(4001, 'transport_error')
    }
  } catch {
    /* ignore */
  }
})
```

- [ ] **Step 2: Confirm tests still pass**

```bash
bun test 2>&1 | tail -3
```

(No new test needed — the existing close-handler test should still cover the resulting reconnect path. If a test was specifically asserting `error` did NOT close, update it to expect close.)

- [ ] **Step 3: Commit**

```bash
git add src/transport/ws-client.ts
git commit -m "fix(ws-client): error handler closes socket so reconnect actually fires"
```

---

## Task 4: Observer-add / snapshot ordering

**Files:**

- Modify: `src/server/switchboard.ts:336-355` — `handleObserverOpen`

Today `observers.add(ws)` runs BEFORE the snapshot send. A `routeEnvelope` call interleaving between add + send-snapshot would broadcast a `session-delta` (revision X) to the new observer, then the snapshot at revision X-1 would clobber it client-side. Fix: send snapshot first, then add to the set.

- [ ] **Step 1: Reorder**

```typescript
// BEFORE
handleObserverOpen(ws) {
  observers.add(ws)
  const rows = listSessions(db)
  try {
    ws.send(JSON.stringify({
      type: 'sessions-snapshot',
      sessions: rows.map((r) => ({ ... })),
    }))
  } catch {
    /* ignore */
  }
}

// AFTER
handleObserverOpen(ws) {
  // CRITICAL ORDERING: send the snapshot BEFORE registering as an observer.
  // If we add to the set first, a routeEnvelope call between add+send can
  // deliver a session-delta at revision X, then this snapshot (built before
  // that delta) lands at revision X-1 and the client clobbers fresh state.
  // By sending snapshot first, the client sees snapshot → deltas in causal
  // order regardless of timing.
  const rows = listSessions(db)
  try {
    ws.send(JSON.stringify({
      type: 'sessions-snapshot',
      sessions: rows.map((r) => ({
        name: r.name,
        cwd: r.cwd,
        cc_session_uuid: r.cc_session_uuid,
        online: r.online,
        revision: r.revision,
      })),
    }))
  } catch {
    /* ignore */
  }
  observers.add(ws)
}
```

- [ ] **Step 2: Test**

In `tests/switchboard.test.ts` (already exists), add a regression test:

```typescript
test('handleObserverOpen sends snapshot before joining the broadcast set', () => {
  // Setup: createSwitchboard with a fake db
  // Mock observer ws with a `sent: string[]` array that captures every send()
  // Call routeEnvelope BEFORE handleObserverOpen — observer must NOT receive it
  // Then call handleObserverOpen — observer must receive the snapshot first
  // Call routeEnvelope after open — observer must receive the envelope
  //
  // This proves the ordering: snapshot is the FIRST message the observer ever
  // sees, regardless of broadcast traffic.
})
```

Use the existing test patterns in the file. If the harness doesn't easily allow mid-handler interleaving, a simpler test: assert that after calling `handleObserverOpen`, the first send was the snapshot.

- [ ] **Step 3: Run tests + commit**

```bash
bun test 2>&1 | tail -3
git add src/server/switchboard.ts tests/switchboard.test.ts
git commit -m "fix(switchboard): send observer snapshot before joining broadcast set"
```

---

## Task 5: Observer broadcast backpressure

**Files:**

- Modify: `src/server/switchboard.ts:84-93` — `toObservers`

A slow observer (background browser tab, throttled mobile) accumulates buffered data when broadcasts outpace its consumption. Bun's WS doesn't enforce a buffer cap — eventually the dashboard process OOMs. Fix: check `bufferedAmount` before send; drop the observer if over threshold.

- [ ] **Step 1: Add backpressure check**

```typescript
// BEFORE
function toObservers(frame: unknown): void {
  const payload = JSON.stringify(frame)
  for (const o of observers) {
    try {
      o.send(payload)
    } catch {
      /* ignore broken sockets */
    }
  }
}

// AFTER
const OBSERVER_BACKPRESSURE_BYTES = 4 * 1024 * 1024 // 4 MB

function toObservers(frame: unknown): void {
  const payload = JSON.stringify(frame)
  for (const o of observers) {
    try {
      // bufferedAmount is the OS-level send buffer. Above this threshold the
      // observer is consuming slower than we're producing — keep dropping
      // would OOM the dashboard. Close the connection; the client will
      // reconnect and get a fresh snapshot.
      if (o.getBufferedAmount() > OBSERVER_BACKPRESSURE_BYTES) {
        try {
          o.close(1013, 'backpressure')
        } catch {
          /* ignore */
        }
        observers.delete(o)
        continue
      }
      o.send(payload)
    } catch {
      /* ignore broken sockets */
    }
  }
}
```

Note on the `1013` close code: per RFC 6455 §7.4.1, 1013 is "Try Again Later" — appropriate for a server-initiated drop due to load. The client's reconnect logic (with jitter from Task 2) will pick up.

- [ ] **Step 2: Test**

In `tests/switchboard.test.ts`, add:

```typescript
test('toObservers drops observers exceeding backpressure threshold', () => {
  // Mock observer with getBufferedAmount() returning > 4 MB
  // Call broadcastObserverFrame
  // Assert observer.close was called with code 1013
  // Assert observer is no longer in the observers set (next broadcast doesn't try)
})
```

- [ ] **Step 3: Run tests + commit**

```bash
bun test 2>&1 | tail -3
git add src/server/switchboard.ts tests/switchboard.test.ts
git commit -m "fix(switchboard): drop slow observers above 4 MB backpressure threshold"
```

---

## Task 6: WS frame size cap

**Files:**

- Modify: `dashboard/serve.ts:1136` (the `websocket: { ... }` config)

Bun.serve accepts `websocket.maxPayloadLength` to bound inbound message size. Today there's no cap — a misbehaving session can flood the loop with arbitrarily large frames.

- [ ] **Step 1: Add cap to the websocket config**

In `dashboard/serve.ts:1136`, the `websocket: {` block:

```typescript
websocket: {
  // ... existing fields (data, idleTimeout)
  maxPayloadLength: 1024 * 1024, // 1 MiB — generous for envelope bodies but
                                  // bounds memory pressure from a malformed
                                  // or hostile session.
  // ... existing open / message / close handlers
}
```

Place the field next to `idleTimeout: 30,` for readability.

- [ ] **Step 2: Verify Bun's behavior on oversized frames**

Per Bun docs: when `maxPayloadLength` is exceeded, Bun drops the frame and may close the connection. No additional handling needed in the message handler — Bun enforces server-side.

- [ ] **Step 3: Run tests**

```bash
bun test 2>&1 | tail -3
```

No new test needed — this is a runtime configuration change. If the existing WS integration tests cover frame sizes, they'll catch a regression. If not, a manual smoke is the verification path.

- [ ] **Step 4: Commit**

```bash
git add dashboard/serve.ts
git commit -m "fix(serve): cap WS frames at 1 MiB — bounds memory pressure on bad senders"
```

---

## Task 7: Quota poller graceful shutdown

**Files:**

- Modify: `dashboard/quota.ts`
- Test: optional — depends on whether quota.ts has a test file

Today `stopQuotaPoller` clears the interval but an in-flight `fetchQuota()` keeps running and writes to module-level `latestQuota` after the caller's `db.close()`. Track the in-flight promise; await it in `stopQuotaPoller`.

- [ ] **Step 1: Track in-flight + await on stop**

```typescript
// AT TOP, alongside latestQuota / pollTimer
let inFlight: Promise<QuotaStatus | null> | null = null

// MODIFY fetchQuota to track:
async function fetchQuota(): Promise<QuotaStatus | null> {
  // ... existing body up through token check ...
  // After the early return for !token, wrap the actual work:
  const promise = (async (): Promise<QuotaStatus | null> => {
    try {
      const resp = await fetch(...) // existing fetch + parse logic
      // ... existing logic ...
      return quota
    } catch (err) {
      // ... existing error log ...
      return null
    }
  })()
  inFlight = promise
  try {
    return await promise
  } finally {
    if (inFlight === promise) inFlight = null
  }
}

// MODIFY stopQuotaPoller to be async:
export async function stopQuotaPoller(): Promise<void> {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (inFlight) {
    try {
      await inFlight
    } catch {
      /* ignore — fetchQuota itself swallows errors */
    }
  }
}
```

The `startQuotaPoller` call signature stays the same — only `stopQuotaPoller`'s return type changes from `void` to `Promise<void>`. Update the one call site (find via `grep -n "stopQuotaPoller" .`).

- [ ] **Step 2: Update the caller**

```bash
grep -n "stopQuotaPoller" .
```

The caller (likely in `dashboard/serve.ts`'s shutdown path) needs to `await stopQuotaPoller()` instead of calling sync. If the shutdown handler isn't async, make it async.

- [ ] **Step 3: Run tests + commit**

```bash
bun test 2>&1 | tail -3
git add dashboard/quota.ts dashboard/serve.ts
git commit -m "fix(quota): graceful shutdown — stopQuotaPoller awaits in-flight fetch"
```

---

## Final verification

- [ ] **Step 1: Full test suite**

```bash
bun test
```

Expected: ≥ 349 + new tests, 0 fail.

- [ ] **Step 2: Type check**

```bash
bunx tsc --noEmit -p .
```

Should pass clean.

- [ ] **Step 3: Manual smoke (controller does this — not the implementer)**

After merge:

1. **Pong-timeout**: SIGSTOP the dashboard process (`kill -STOP <pid>`), wait 80s, SIGCONT it. The session WS clients should have force-closed during the freeze and reconnected cleanly after resume.
2. **Reconnect jitter**: bounce the dashboard. Multiple session reconnects shouldn't all fire on the same 100ms boundary (visible in dashboard logs).
3. **Observer ordering**: open the dashboard in two browser tabs at once. Both should receive a snapshot followed by deltas in causal order — no flicker.
4. **Backpressure**: hard to test naturally; if you want to verify, set `OBSERVER_BACKPRESSURE_BYTES` lower in dev and verify slow connections get a 1013 close.
5. **Frame size cap**: send a >1 MiB envelope through `bun dashboard/cli.ts send all $(node -e "process.stdout.write('x'.repeat(1100000))")` — should be rejected at the wire, not buffered.
6. **Quota shutdown**: in dev, start the dashboard, immediately Ctrl-C. Verify no "after db.close" warnings in the log.

- [ ] **Step 4: Merge to main**

```bash
git stash push bin/ccpl.ts -m "user WIP" 2>/dev/null
git checkout main
git merge --ff-only pr3-transport-reliability
git branch -d pr3-transport-reliability
git stash pop 2>/dev/null
bun test 2>&1 | tail -3
```

---

## Notes for the implementer

- DO NOT TOUCH `bin/ccpl.ts` (user WIP).
- DO NOT TOUCH `dashboard/dashboard.js` (PR 1 territory).
- Each task ends in a commit. Don't bundle.
- For tests that are hard without time mocking (Tasks 1, 2), the plan authorizes skipping with a documented note in the commit message.
- Strict TypeScript — explicit return types on new exports.
