# Party Line — Get It Running

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix compilation/runtime issues, verify UDP multicast works, and validate the full stack (dashboard, CLI, MCP channel server) so we have a working baseline to iterate from.

**Architecture:** The code is already written across 8 TypeScript files. This plan fixes 3 known bugs, adds `bun-types` for type-checking, then tests each layer bottom-up: transport → dashboard → CLI → MCP channel server. Each task produces a verifiable result.

**Tech Stack:** TypeScript, Bun runtime, `@modelcontextprotocol/sdk`, `node:dgram` UDP multicast

---

### Known Issues (discovered during investigation)

1. **`bun-types` missing from devDependencies** — `tsc --noEmit` fails with "Cannot find type definition file for 'bun-types'". Need to install `@types/bun` (the modern package) and update `tsconfig.json`.
2. **`setMulticastTTL(0)` crashes in Bun** — `EINVAL: invalid argument, setsockopt`. Node.js handles TTL=0, but Bun doesn't. TTL=1 works in both. Since we only need localhost, TTL=1 (same-subnet) is fine.
3. **`tsconfig.json` only includes `src/`** — Dashboard files (`dashboard/*.ts`) are excluded from type-checking. Need to add them.

---

### Task 1: Fix `bun-types` and `tsconfig.json`

**Files:**
- Modify: `package.json` (devDependencies)
- Modify: `tsconfig.json` (types + include)

- [ ] **Step 1: Install `@types/bun` and update tsconfig**

```bash
cd /home/claude/projects/claude-party-line
bun add -d @types/bun
```

- [ ] **Step 2: Update `tsconfig.json` to use `@types/bun` and include dashboard files**

Replace the entire `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts", "dashboard/**/*.ts"]
}
```

Changes: removed `rootDir` (conflicts with multiple source dirs), dropped the explicit `"bun-types"` in favor of `"bun-types"` (still from `@types/bun`), added `dashboard/**/*.ts` to `include`.

- [ ] **Step 3: Run typecheck to verify**

```bash
bun run typecheck
```

Expected: passes with zero errors (or reveals further type issues to fix in later steps).

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock tsconfig.json
git commit -m "fix: add @types/bun, include dashboard in typecheck"
```

---

### Task 2: Fix UDP multicast TTL for Bun compatibility

**Files:**
- Modify: `src/types.ts:39-45` (change `ttl: 0` to `ttl: 1`)

- [ ] **Step 1: Change default TTL from 0 to 1**

In `src/types.ts`, change the `DEFAULT_TRANSPORT_CONFIG`:

```typescript
export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  multicastAddress: '239.77.76.10',
  port: 47100,
  ttl: 1, // same-subnet only (TTL 0 is ideal but Bun's setsockopt rejects it)
  loopback: true,
  sendTwiceDelayMs: 50,
}
```

- [ ] **Step 2: Verify the dashboard starts without crashing**

```bash
timeout 3 bun run dashboard/serve.ts 2>&1 || true
```

Expected: should print the "Party Line Dashboard" startup banner and NOT crash with EINVAL.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "fix: use TTL 1 for Bun multicast compat (TTL 0 causes EINVAL)"
```

---

### Task 3: Fix any remaining TypeScript errors

**Files:**
- Potentially: any `.ts` file with type errors

- [ ] **Step 1: Run full typecheck and fix any errors**

```bash
bun run typecheck 2>&1
```

If errors appear, fix them one by one. Common expected issues:
- `ServerWebSocket` import in `dashboard/serve.ts` may need adjustment
- `readFileSync` might need Buffer handling

- [ ] **Step 2: Verify clean typecheck**

```bash
bun run typecheck
```

Expected: exits 0, no errors.

- [ ] **Step 3: Commit fixes if any were needed**

```bash
git add -A
git commit -m "fix: resolve remaining TypeScript errors"
```

---

### Task 4: Test UDP multicast — dashboard + CLI send/receive

This is the critical validation. Two processes must exchange messages over multicast.

**Files:** No changes — testing only.

- [ ] **Step 1: Start the dashboard in the background**

```bash
bun run dashboard/serve.ts --name dashboard &
DASHBOARD_PID=$!
```

Expected: prints the startup banner with "Web UI: http://localhost:3400".

- [ ] **Step 2: Use CLI to send a message to "all"**

In a separate command:

```bash
bun run dashboard/cli.ts send all "hello from cli"
```

Expected: prints `Sent to "all" (id: ...)`.

- [ ] **Step 3: Check CLI sessions (should see dashboard)**

```bash
bun run dashboard/cli.ts sessions
```

Expected: lists at least "dashboard" and "cli" (cli sends its own announce).

- [ ] **Step 4: Test CLI watch mode receives dashboard heartbeats**

```bash
timeout 5 bun run dashboard/cli.ts watch --heartbeats 2>&1 || true
```

Expected: shows heartbeat messages from "dashboard".

- [ ] **Step 5: Stop dashboard**

```bash
kill $DASHBOARD_PID 2>/dev/null
```

- [ ] **Step 6: Record what worked and what didn't**

Document any issues found. If multicast doesn't work, investigate:
- `ip maddr show` — check multicast group membership
- Try binding to `0.0.0.0` vs specific interface
- Check if `lo` interface has multicast enabled

---

### Task 5: Test the web dashboard in a browser

**Files:** No changes — testing only.

- [ ] **Step 1: Start dashboard**

```bash
bun run dashboard/serve.ts &
```

- [ ] **Step 2: Verify HTTP endpoint responds**

```bash
curl -s http://localhost:3400 | head -5
```

Expected: returns HTML starting with `<!DOCTYPE html>`.

- [ ] **Step 3: Verify WebSocket endpoint responds**

```bash
curl -s http://localhost:3400/api/sessions
```

Expected: returns JSON array (at minimum contains the dashboard session itself).

- [ ] **Step 4: Verify REST API send endpoint**

```bash
curl -s -X POST http://localhost:3400/api/send \
  -H 'Content-Type: application/json' \
  -d '{"to":"all","message":"hello from curl"}'
```

Expected: returns `{"ok":true,"id":"..."}`.

- [ ] **Step 5: Stop dashboard**

```bash
kill %1 2>/dev/null
```

---

### Task 6: Test MCP channel server startup

**Files:** No changes — testing only.

- [ ] **Step 1: Test the MCP server starts and responds to MCP init**

The server expects stdio MCP. We can verify it starts by running it with debug mode and checking stderr:

```bash
PARTY_LINE_DEBUG=1 PARTY_LINE_NAME=test-session timeout 5 bun run src/server.ts 2>server-stderr.txt &
sleep 2
# Send a basic MCP initialize request
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | timeout 3 bun run src/server.ts 2>/dev/null | head -1
```

Expected: stderr shows debug messages like "Starting party line...", "UDP multicast transport started", etc. stdout returns MCP initialize response JSON.

- [ ] **Step 2: Review server stderr for any warnings**

```bash
cat server-stderr.txt
```

Expected: clean startup messages, no errors.

- [ ] **Step 3: Clean up**

```bash
rm -f server-stderr.txt
```

---

### Task 7: Test with Claude Code dev channel loading

**Files:**
- Potentially modify: `.mcp.json` if the command format needs adjustment
- Potentially modify: `.claude-plugin/plugin.json` if manifest needs `channels` array

- [ ] **Step 1: Verify the plugin manifest + MCP config are correct**

Check that `.mcp.json` uses the right command format. The `${CLAUDE_PLUGIN_ROOT}` variable should work since Claude Code sets it for plugin subprocesses.

Current `.mcp.json`:
```json
{
  "mcpServers": {
    "party-line": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
```

This should work. The `start` script does `bun install --no-summary && bun src/server.ts`.

- [ ] **Step 2: Add `channels` array to plugin.json**

The plugin manifest needs to declare which MCP server is a channel. Update `.claude-plugin/plugin.json`:

```json
{
  "name": "party-line",
  "description": "Shared-bus channel for Claude Code inter-session messaging. Sessions on the same machine can send messages to each other by name.",
  "version": "0.1.0",
  "keywords": ["channel", "messaging", "inter-session", "mcp"],
  "channels": [
    {
      "server": "party-line"
    }
  ]
}
```

- [ ] **Step 3: Test loading with Claude Code**

```bash
claude --dangerously-load-development-channels server:party-line --name test-party
```

Then in that session, verify the channel is registered:
- Type `/mcp` to see server status
- Try `party_line_list_sessions` tool
- Try sending a message via `party_line_send`

- [ ] **Step 4: Commit plugin manifest changes**

```bash
git add .claude-plugin/plugin.json
git commit -m "feat: add channels declaration to plugin manifest"
```

---

### Task 8: Two-session end-to-end test

**Files:** No changes — testing only.

- [ ] **Step 1: Start the dashboard as a monitor**

```bash
bun run dashboard/serve.ts --name monitor &
```

- [ ] **Step 2: Open two Claude Code sessions with different names**

Terminal A:
```bash
PARTY_LINE_NAME=session-a claude --dangerously-load-development-channels server:party-line
```

Terminal B:
```bash
PARTY_LINE_NAME=session-b claude --dangerously-load-development-channels server:party-line
```

- [ ] **Step 3: From session A, send a message to session B**

In Claude Code session A, ask Claude to use `party_line_send` to send a message to "session-b".

- [ ] **Step 4: Verify session B receives the message**

Check that session B shows a `<channel source="party-line" from="session-a" ...>` notification.

- [ ] **Step 5: Check the dashboard sees both sessions**

Open http://localhost:3400 in a browser and verify both sessions appear in the sidebar.

- [ ] **Step 6: Document results**

Record what worked, what didn't, and any issues to fix in the next iteration.
