# Task 0 Verification — 2026-04-20

Verification spike for the Mission Control plan. Conducted against:

- Claude Code `2.1.114`
- Bun `1.3.11`
- Node `v22.22.2`
- Linux kernel `6.8.0-107-generic` (Ubuntu 24.04)

Primary source for hook schemas: <https://code.claude.com/docs/en/hooks>
(The `docs.claude.com` URL 301s here.) Cross-checked against live `~/.claude/projects/` data on this machine.

---

## 1. Hook Payload Shapes

All events below exist in Claude Code 2.1.114's documented hook event list. Every event
ships a common envelope: `session_id`, `transcript_path`, `cwd`, `hook_event_name`.
`permission_mode` is present on most (not all). Subagent-context fields
(`agent_id`, `agent_type`) are optional — present only when the hook fires inside a
subagent or when `--agent` is in use.

| hook_event        | exists? | event-specific payload fields                                                                                                     | source |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| SessionStart      | yes     | common + `source` (`startup`\|`resume`\|`clear`\|`compact`) + `model`; `agent_type` optional                                      | docs   |
| SessionEnd        | yes     | common + `reason` (`clear`\|`resume`\|`logout`\|`prompt_input_exit`\|`bypass_permissions_disabled`\|`other`) — full schema not spelled out, matcher only | docs (partial) |
| UserPromptSubmit  | yes     | common + `permission_mode` + `prompt`                                                                                             | docs   |
| Stop              | yes     | common + `permission_mode` — docs confirm the event but do not spell out further fields                                           | docs (partial) |
| PreToolUse        | yes     | common + `permission_mode` + `tool_name` + `tool_input` + `tool_use_id`; `agent_id`/`agent_type` optional                         | docs   |
| PostToolUse       | yes     | common + `permission_mode` + `tool_name` + `tool_input` + `tool_response` + `tool_use_id`; `agent_id`/`agent_type` optional        | docs   |
| SubagentStart     | yes     | common + `agent_id` + `agent_type`                                                                                                | docs   |
| SubagentStop      | yes     | common + `permission_mode` + `stop_hook_active` + `agent_id` + `agent_type` + `agent_transcript_path` + `last_assistant_message`  | docs   |
| TaskCreated       | yes     | common + `permission_mode` + `task_id` + `task_subject` + `task_description?` + `teammate_name?` + `team_name?`                   | docs   |
| TaskCompleted     | yes     | common + `permission_mode` + `task_id` + `success` — docs list the event; full schema not fully spelled out, `success` is confirmed per original plan | docs (partial) |
| TeammateIdle      | yes     | common + `permission_mode` + `teammate_name` + `team_name` — docs list the event; full stdin JSON not spelled out                  | docs (partial) |
| PreCompact        | yes     | common + `trigger` (`manual`\|`auto`) — matcher documented, full stdin JSON not spelled out                                       | docs (partial) |
| PostCompact       | yes     | common + `trigger` (`manual`\|`auto`) — same caveat                                                                                | docs (partial) |
| Notification      | yes     | common + `message` + `title?` + `notification_type` (`permission_prompt`\|`idle_prompt`\|`auth_success`\|`elicitation_dialog`)     | docs   |

### Specific question: does PostToolUse include `tool_name`, `tool_input`, `tool_response`, `success`, `session_id`?

From the docs' literal PostToolUse example:

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": "/path", "content": "..." },
  "tool_response": { "filePath": "/path", "success": true },
  "tool_use_id": "toolu_01ABC..."
}
```

- `tool_name` — **yes**, top-level
- `tool_input` — **yes**, top-level
- `tool_response` — **yes**, top-level (tool-specific shape)
- `success` — **not a top-level field**. In the Write example it shows up *inside* `tool_response.success`, but that's a per-tool response shape, not a hook-level contract. We should NOT rely on a top-level `success`; instead check tool-specific `tool_response` shape.
- `session_id` — **yes**, top-level

### Specific question: does PreToolUse include `tool_name`, `tool_input`, `session_id`?

Yes to all three. No `tool_response` (tool hasn't run yet). Has `tool_use_id`.

---

## 2. Subagent Identification on Tool Hooks

**Answer: partially verified — docs say yes, but we couldn't empirically confirm that hooks actually fire in the parent session for subagent tool calls.**

What the docs say (verbatim paraphrase):

> When running with `--agent` or inside a subagent, two additional fields are included:
> `agent_id`: Unique identifier for the subagent. Present only when the hook fires
> inside a subagent call.
> `agent_type`: Agent name. Present when the session uses `--agent` or the hook fires
> inside a subagent.

So the fields are documented to exist on `PreToolUse`/`PostToolUse` payloads when the
invocation originates from a subagent.

**What the docs do NOT explicitly answer:** whether those hooks fire in the *parent
session's hook handlers* or only in a separate subagent-scoped context. The language
"fires inside a subagent call" suggests the hook fires in subagent scope. Without
installing a test hook into `~/.claude/settings.json` (which the task forbids), we
cannot empirically verify this on the live session.

**Cross-referenced evidence from filesystem:**

- Subagent activity is stored in a **separate** JSONL file at
  `~/.claude/projects/<cwd-slug>/<parent-session-id>/subagents/agent-<agent_id>.jsonl`,
  with a sibling `agent-<agent_id>.meta.json` containing
  `{"agentType": "...", "description": "..."}`.
- The parent session's main `.jsonl` contains `isSidechain: false` on every record I
  checked (826 lines across a working session). I found zero records with
  `isSidechain: true` inlined in the parent transcript.
- This strongly implies subagent events are stored (and hooks likely fire) in the
  subagent's own scope, not the parent's.

**Risk to the plan:** if `PreToolUse`/`PostToolUse` do NOT fire in the parent session
for subagent tool calls, we can't use a single hook in the parent to produce a live
tool log for subagents. Fallbacks in order of preference:

1. Install the hook also in the subagent's context (if Claude Code inherits hooks into
   subagents — docs imply so, but again unverified without installing).
2. Rely on `SubagentStart`/`SubagentStop` for coarse-grained events in the parent, and
   tail the subagent JSONL file (`<parent>/subagents/agent-<id>.jsonl`) for per-tool
   activity. `SubagentStop` payload includes `agent_transcript_path` which gives us
   the exact file.
3. Live with subagent activity being a black box until stop — only the last
   assistant message surfaced via `SubagentStop`.

**Recommended next step:** once we start implementing, add a temporary `PreToolUse`
hook in a scratch Claude Code session and invoke the Task tool, dump every payload to
disk, inspect for `agent_id`. Decide on architecture after that observation.

---

## 3. JSONL Transcript Path Convention

**Path pattern:** `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`

- `<cwd-slug>` — the absolute cwd with every `/` replaced by `-`, including the leading
  dash. Example: `/home/claude/projects/claude-party-line` becomes
  `-home-claude-projects-claude-party-line`.
- `<session-id>` — a UUIDv4. Matches the `--session-id` flag and the `session_id` field
  delivered in hook payloads.

**Each session also has a sibling directory** `~/.claude/projects/<cwd-slug>/<session-id>/`
that contains:

- `subagents/agent-<agent_id>.jsonl` — per-subagent transcripts
- `subagents/agent-<agent_id>.meta.json` — `{"agentType": "...", "description": "..."}`
- `tool-results/<something>.txt` or `<tool_use_id>.txt` — overflow tool results stored
  externally (e.g. large Playwright snapshots, bash stdout). Main transcript references
  these files.

**Single file or multiple?** For the *main* session: one `.jsonl`. Subagent transcripts
are separate files. Large tool results are stored as external `.txt` files under
`tool-results/`.

**Append-only (tail-friendly)?** Yes — entries are appended. I verified by watching
modification times of the live session file growing over the course of this task.
File sizes grow monotonically. The append-offset + re-read approach works fine
(`/tmp/tail-test.ts` confirmed; see §4).

### Entry shapes (from `0b60bd10-7c14-4d8d-946b-ae87c47694d3.jsonl`, 826 lines)

Record type distribution:

```
custom-title: 1
permission-mode: 1
file-history-snapshot: 34
user: 315
attachment: 2
assistant: 446
system: 15
queue-operation: 12
```

**First line** (session preamble):

```json
{"type":"custom-title","customTitle":"party-line","sessionId":"0b60bd10-..."}
```

Followed by `permission-mode`, then `file-history-snapshot`, then the first `user` line.

**Assistant line with tool_use** — top-level keys:

```
parentUuid, isSidechain, message, requestId, type, uuid, timestamp,
userType, entrypoint, cwd, sessionId, version, gitBranch, slug
```

Embedded `message.content[]` entry for a tool call:

```json
{"type":"tool_use","id":"toolu_01Ft6Z...","name":"Read",
 "input":{"file_path":"/home/claude/projects/claude-party-line/SPEC.md"},
 "caller":{"type":"direct"}}
```

Note: the `caller.type` field is interesting — `"direct"` indicates the main session
called the tool. This is likely distinct from subagent-originated tool calls; worth
investigating when building the live tool feed.

**Assistant text line** — same top-level keys, `message.content[].type === "text"`:

```json
{"type":"text","text":"Let me read the spec and survey the existing code."}
```

**User message line** — top-level includes
`parentUuid, isSidechain, promptId, type, message, uuid, timestamp, permissionMode,
userType, entrypoint, cwd, sessionId, version, gitBranch`. `message.role === "user"`.

**isSidechain** — false on every record in the sample. Subagent activity does not
interleave into the parent transcript; it lives in `<sessionId>/subagents/*.jsonl`.

---

## 4. Bun `fs.watch` Recursive

**Verdict: DOES NOT WORK reliably on Linux with Bun 1.3.11.**

Bun reports the creation of top-level immediate children but does not propagate events
for nested writes. Node's implementation on the same kernel works correctly.

### Test output

`/tmp/watch-test.ts` (exact script from the task prompt):

```
events: [ "rename:sub" ]
```

— no events for `sub/a.txt` or `sub/b.jsonl`.

Slower-paced `/tmp/watch-test3.ts`:

```
after root-level write events: 2 [ "rename:root.txt", "change:root.txt" ]
final events (count=3):
  rename:root.txt
  change:root.txt
  rename:sub
```

— root-level writes fire, but nothing inside `sub/`, even with 500 ms between events.

`fs/promises.watch` async iterator (`/tmp/watch-test4.ts`):

```
final events (count=1):
  rename:sub
```

— same story.

For comparison, `/tmp/watch-node.mjs` under Node 22.22.2:

```
node events: [ 'rename:sub', 'rename:sub/a.txt', 'rename:sub/b.jsonl' ]
```

— Node correctly reports nested events. This is a Bun runtime bug, not a kernel issue.

### Workarounds

1. **Polling (preferred).** `/tmp/tail-test.ts` verified: `statSync(path).size` +
   `readSync(fd, buf, 0, len, offset)` works perfectly for tailing an appended
   JSONL. Cost: ~1 stat per file per poll interval. For a dozen live transcripts
   at 500 ms interval this is essentially free.
2. **Manual recursive dispatch.** Walk the tree at start, `fs.watch` each directory
   non-recursively, and when a `rename` event adds a new subdir, start a new watcher
   for it. Works but complex; requires careful teardown to avoid leaks.
3. **Node child process.** Spawn a short Node process whose only job is to emit events
   over stdin/IPC back to Bun. Heavyweight and awkward; skip unless needed.
4. **Run the Mission Control daemon under Node** instead of Bun. Drops one runtime
   dependency (Bun's speed/DX), but gives us correct recursive watch for free.

**Recommendation:** go with polling (option 1). The JSONL files grow via append, the
set of files to watch is small (one per live session), and polling at 250–500 ms is
plenty responsive for a dashboard. We lose nothing vs. fs.watch semantics because we
already need to parse appended bytes on change — we'd be calling `readSync` either way.

---

## Impact on Plan

Refer back to the task-level plan in
`docs/superpowers/plans/2026-04-19-mission-control-observability.md` when applying
these adjustments.

### Blocking findings

**Bun `fs.watch` recursive does not work (Finding §4)** —
impacts any task that assumed a single recursive watcher over `~/.claude/projects/`.
Swap to a polling tailer or per-directory watcher + auto-registration. Plan for:

- Tasks that designed a transcript-tailing component.
- Any "watch the hooks-logs directory" work.

### Adjustments needed

**Subagent identification on tool hooks is only partially verified (Finding §2).** Before
committing to the "live tool log for subagents via parent-session hooks" design, run a
one-shot probe in a scratch Claude Code session:

- Install a temp `PreToolUse` hook that appends stdin to a file.
- Invoke the Task tool.
- Inspect output for `agent_id`/`agent_type`.

If the hook does NOT fire in the parent for subagent tool calls, pivot to
`SubagentStart`/`SubagentStop` + tail the subagent JSONL at
`agent_transcript_path` (provided on `SubagentStop`). The JSONL under
`~/.claude/projects/<cwd-slug>/<parent-session-id>/subagents/agent-<id>.jsonl` contains
the per-subagent tool activity.

Impacts any task depending on a unified PreToolUse stream across main + subagent scope.

**`tool_response.success` vs. top-level `success` (Finding §1).** The plan's mental
model had a top-level `success` field on `PostToolUse`. It doesn't exist. To detect
failures, inspect `tool_response` per-tool (Write has `tool_response.success`, Bash has
exit status fields, etc.) or watch for error markers in `tool_response`. Minor refactor
to whichever task handles success/failure display.

### Confirmed (no change)

- Hook event set is complete: every event we planned around exists.
- JSONL path convention matches assumption (`<cwd-slug>/<session-id>.jsonl`),
  append-only, tail-friendly.
- Subagent transcripts are stored separately at a predictable path
  (`<cwd-slug>/<parent-session-id>/subagents/agent-<id>.jsonl`) with sibling
  `.meta.json` giving agentType — useful even if hook-scope verification fails.
- `caller.type` field in tool_use entries may help distinguish `"direct"` vs.
  subagent-originated calls inside a transcript — flagged as an investigation item
  if we end up tailing transcripts.

### Unverified / flagged

- Whether `PreToolUse`/`PostToolUse` fire in the parent session for subagent tool
  calls (see §2). Resolve with an empirical probe before committing to that design.
- Whether Claude Code propagates hooks configured in `~/.claude/settings.json` into
  subagent contexts, or if subagents have their own hook config. Probe alongside §2.
- Exact full schemas of `Stop`, `SessionEnd`, `TaskCompleted`, `TeammateIdle`,
  `PreCompact`, `PostCompact` — docs mention these events and their matchers but don't
  spell out full stdin JSON. If the plan uses a field from one of these events that
  isn't explicitly documented, flag it as unverified and probe before building.
