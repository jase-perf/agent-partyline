import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync } from 'node:fs'
import { buildUserPromptFrame } from '../dashboard/serve-helpers.js'
import { handleIngest } from '../src/ingest/http.js'
import { openDb } from '../src/storage/db.js'
import { Aggregator } from '../src/aggregator.js'
import { createSwitchboard } from '../src/server/switchboard.js'
import type { HookEvent } from '../src/events.js'

const DB_PATH = '/tmp/party-line-user-prompt-test.db'
const TOKEN = 'tkn-user-prompt'

describe('buildUserPromptFrame (unit)', () => {
  test('returns null for non-UserPromptSubmit events', () => {
    const ev: HookEvent = {
      machine_id: 'm',
      session_name: 's',
      session_id: 'sid',
      hook_event: 'Stop',
      ts: '2026-04-21T00:00:00Z',
      payload: { prompt: 'ignored' },
    }
    expect(buildUserPromptFrame(ev)).toBeNull()
  })

  test('returns null when prompt is missing or empty', () => {
    const base: HookEvent = {
      machine_id: 'm',
      session_name: 's',
      session_id: 'sid',
      hook_event: 'UserPromptSubmit',
      ts: '2026-04-21T00:00:00Z',
      payload: {},
    }
    expect(buildUserPromptFrame(base)).toBeNull()
    expect(buildUserPromptFrame({ ...base, payload: { prompt: '' } })).toBeNull()
    expect(buildUserPromptFrame({ ...base, payload: { prompt: 42 } })).toBeNull()
  })

  test('builds frame with correct fields for valid UserPromptSubmit', () => {
    const ev: HookEvent = {
      machine_id: 'm',
      session_name: 'partyline-dev',
      session_id: 'sid-1',
      hook_event: 'UserPromptSubmit',
      ts: '2026-04-21T12:00:00Z',
      payload: { prompt: 'hello world' },
    }
    const frame = buildUserPromptFrame(ev)
    expect(frame).not.toBeNull()
    expect(frame!.type).toBe('user-prompt')
    expect(frame!.data).toEqual({
      session_name: 'partyline-dev',
      session_id: 'sid-1',
      ts: '2026-04-21T12:00:00Z',
      prompt: 'hello world',
    })
  })

  test('returns null when prompt is a party-line <channel> wrapper (avoids duplicate with envelope render)', () => {
    const base: HookEvent = {
      machine_id: 'm',
      session_name: 'partyline-dev',
      session_id: 'sid-1',
      hook_event: 'UserPromptSubmit',
      ts: '2026-04-22T00:00:00Z',
      payload: {},
    }
    const channelPrompt =
      '<channel source="party-line" from="dashboard" to="partyline-dev" type="message" message_id="abc123">hi there</channel>'
    expect(buildUserPromptFrame({ ...base, payload: { prompt: channelPrompt } })).toBeNull()
    // Surrounding whitespace must still match — the recipient's JSONL may trim.
    expect(
      buildUserPromptFrame({ ...base, payload: { prompt: '\n  ' + channelPrompt + '\n' } }),
    ).toBeNull()
    // A prompt that merely mentions a channel tag inside normal prose is NOT
    // suppressed — only whole-prompt channel wrappers.
    const mixed = 'look at this: ' + channelPrompt + ' — what do you think?'
    expect(buildUserPromptFrame({ ...base, payload: { prompt: mixed } })).not.toBeNull()
  })
})

describe('user-prompt end-to-end pipeline', () => {
  beforeEach(() => {
    try {
      rmSync(DB_PATH)
    } catch {
      /* no-op */
    }
  })

  afterEach(() => {
    try {
      rmSync(DB_PATH)
    } catch {
      /* no-op */
    }
  })

  test('UserPromptSubmit POST /ingest → switchboard broadcasts user-prompt frame to observers', async () => {
    const db = openDb(DB_PATH)
    const aggregator = new Aggregator(db)
    const switchboard = createSwitchboard(db)

    // Register a stub observer socket that captures outbound frames.
    const captured: Array<{ type?: string; data?: unknown }> = []
    const observerSocket = {
      send: (payload: string) => {
        try {
          captured.push(JSON.parse(payload) as { type?: string; data?: unknown })
        } catch {
          /* ignore */
        }
      },
      getBufferedAmount: () => 0,
    }
    switchboard.handleObserverOpen(
      observerSocket as unknown as Parameters<typeof switchboard.handleObserverOpen>[0],
    )

    // Simulate the exact onEvent wiring from dashboard/serve.ts.
    const onEvent = (ev: HookEvent): void => {
      aggregator.ingest(ev)
      switchboard.broadcastObserverFrame({ type: 'hook-event', data: ev })
      const frame = buildUserPromptFrame(ev)
      if (frame) switchboard.broadcastObserverFrame(frame)
    }

    // Construct a real Request, run it through the ingest handler.
    const body = JSON.stringify({
      machine_id: 'm1',
      session_name: 'partyline-dev',
      session_id: 'sid-current',
      hook_event: 'UserPromptSubmit',
      ts: '2026-04-21T14:00:00Z',
      payload: { prompt: 'what is the status of the build?' },
    })
    const req = new Request('http://x/ingest', {
      method: 'POST',
      body,
      headers: { 'X-Party-Line-Token': TOKEN, 'Content-Type': 'application/json' },
    })
    const res = await handleIngest(req, { db, token: TOKEN, onEvent })
    expect(res.status).toBe(200)

    // Observer should have received two frames: hook-event + user-prompt.
    const userPromptFrames = captured.filter((f) => f.type === 'user-prompt')
    expect(userPromptFrames).toHaveLength(1)
    const data = userPromptFrames[0]!.data as {
      session_name: string
      session_id: string
      ts: string
      prompt: string
    }
    expect(data.session_name).toBe('partyline-dev')
    expect(data.session_id).toBe('sid-current')
    expect(data.prompt).toBe('what is the status of the build?')

    // sessions-snapshot on observer open + hook-event + user-prompt = 3 frames
    expect(captured.some((f) => f.type === 'sessions-snapshot')).toBe(true)
    expect(captured.some((f) => f.type === 'hook-event')).toBe(true)

    db.close()
  })

  test('Stop events do NOT produce user-prompt frames', async () => {
    const db = openDb(DB_PATH)
    const aggregator = new Aggregator(db)
    const switchboard = createSwitchboard(db)

    const captured: Array<{ type?: string }> = []
    const observerSocket = {
      send: (payload: string) => {
        try {
          captured.push(JSON.parse(payload) as { type?: string })
        } catch {
          /* ignore */
        }
      },
      getBufferedAmount: () => 0,
    }
    switchboard.handleObserverOpen(
      observerSocket as unknown as Parameters<typeof switchboard.handleObserverOpen>[0],
    )

    const onEvent = (ev: HookEvent): void => {
      aggregator.ingest(ev)
      switchboard.broadcastObserverFrame({ type: 'hook-event', data: ev })
      const frame = buildUserPromptFrame(ev)
      if (frame) switchboard.broadcastObserverFrame(frame)
    }

    const body = JSON.stringify({
      machine_id: 'm',
      session_name: 's',
      session_id: 'sid',
      hook_event: 'Stop',
      ts: '2026-04-21T14:00:00Z',
      payload: {},
    })
    const req = new Request('http://x/ingest', {
      method: 'POST',
      body,
      headers: { 'X-Party-Line-Token': TOKEN, 'Content-Type': 'application/json' },
    })
    await handleIngest(req, { db, token: TOKEN, onEvent })

    expect(captured.some((f) => f.type === 'user-prompt')).toBe(false)
    expect(captured.some((f) => f.type === 'hook-event')).toBe(true)

    db.close()
  })
})
