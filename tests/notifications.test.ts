import { test, expect, describe, mock } from 'bun:test'
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

describe('createNotifications — trigger A (working→idle)', async () => {
  test('fires when state transitions working→idle and toggle is on', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)

    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'idle' })

    expect(fired).toHaveLength(1)
    expect(fired[0]!.title).toContain('research')
    expect(fired[0]!.options.tag).toBe('research')
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
    expect(fired[0]!.title).toBe('research')
    expect(fired[0]!.options.body).toContain('discord')
    expect(fired[0]!.options.body).toContain('hello')
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
    expect(fired[0]!.options.body!.length).toBeLessThanOrEqual(140) // "from: " + 120 + ellipsis
  })
})

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
    expect(fired[0]!.title).toContain('Permission needed')
    expect(fired[0]!.title).toContain('Bash')
    expect(fired[0]!.options.body).toContain('Run tests')
    expect(fired[0]!.options.tag).toBe('research')
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

describe('createNotifications — click handler', async () => {
  test('click navigates to session route, focuses window, closes notification', async () => {
    const { ctx, instances, win } = mockDeps()
    ctx.doc.hidden = true
    const navigateMock = ctx.navigate
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })

    expect(instances).toHaveLength(1)
    const n = instances[0]!
    n.onclick?.(new Event('click'))

    expect(win.focus).toHaveBeenCalled()
    expect(navigateMock).toHaveBeenCalledWith('/#/session/research')
  })
})

describe('createNotifications — auto-dismiss', async () => {
  test("onNotificationDismiss closes the session's active notification", async () => {
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

describe('createNotifications — last assistant text', async () => {
  test('Trigger A fetches transcript and uses last assistant text as body', async () => {
    const { ctx, fired, setFetchResponse } = mockDeps()
    ctx.doc.hidden = true
    setFetchResponse([
      { type: 'user', text: 'hi' },
      { type: 'assistant-text', text: 'The answer is 42.' },
    ])
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'research-sid', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'research-sid', name: 'research', state: 'idle' })

    expect(fired).toHaveLength(1)
    expect(fired[0]!.options.body).toContain('42')
  })

  test('Trigger A falls back to "Claude is waiting" when transcript fetch fails', async () => {
    const { ctx, fired } = mockDeps({
      fetch: mock(async () => {
        throw new Error('network')
      }),
    })
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })

    expect(fired).toHaveLength(1)
    expect(fired[0]!.options.body).toBe('Claude is waiting')
  })
})

describe('createNotifications — trigger B (dashboard as recipient)', async () => {
  function envelope(overrides = {}) {
    return {
      id: 'x',
      seq: 0,
      from: 'research',
      to: 'dashboard',
      type: 'message',
      body: 'status update',
      callback_id: null,
      response_to: null,
      ts: '2026-04-20T00:00:00Z',
      ...overrides,
    }
  }

  test("fires for the sender's session when message is addressed to dashboard", async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('research', true)
    notif.onPartyLineMessage(envelope())
    expect(fired).toHaveLength(1)
    expect(fired[0]!.options.body).toContain('dashboard')
    expect(fired[0]!.options.body).toContain('status update')
    expect(fired[0]!.options.tag).toBe('research')
  })

  test('does not fire on unrelated session when dashboard is the recipient', async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.setEnabled('unrelated', true)
    notif.onPartyLineMessage(envelope())
    expect(fired).toHaveLength(0)
  })

  test("does not fire if the sender's session toggle is off", async () => {
    const { ctx, fired } = mockDeps()
    ctx.doc.hidden = true
    const notif = createNotifications(ctx)
    notif.onPartyLineMessage(envelope())
    expect(fired).toHaveLength(0)
  })
})
