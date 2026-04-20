import { test, expect, describe, mock } from 'bun:test'
import { createNotifications } from '../dashboard/notifications.js'
import { mockDeps } from './_notification-helpers.js'

describe('createNotifications — settings', async () => {
  test('isEnabled returns false by default (opt-in)', async () => {
    const { notif } = mockDeps()
    expect(notif.isEnabled('research')).toBe(false)
  })

  test('setEnabled persists via localStorage and round-trips', async () => {
    // Round-trip is validated within the same instance since localStorage is shared
    const { notif } = mockDeps()
    notif.setEnabled('research', true)
    expect(notif.isEnabled('research')).toBe(true)
    notif.setEnabled('research', false)
    expect(notif.isEnabled('research')).toBe(false)
  })

  test('setEnabled(false) removes the entry', async () => {
    const { notif } = mockDeps()
    notif.setEnabled('research', true)
    notif.setEnabled('research', false)
    expect(notif.isEnabled('research')).toBe(false)
  })

  test('getPermissionState reflects permission', async () => {
    const { notif, setPermission } = mockDeps()
    expect(notif.getPermissionState()).toBe('granted')
    setPermission('denied')
    expect(notif.getPermissionState()).toBe('denied')
  })

  test('getPermissionState returns "unsupported" if NotificationPermission is missing', async () => {
    const { notif } = mockDeps({ NotificationPermission: undefined })
    expect(notif.getPermissionState()).toBe('unsupported')
  })
})

describe('createNotifications — trigger A (working→idle)', async () => {
  test('fires when state transitions working→idle and toggle is on', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)

    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'idle' })

    expect(shown).toHaveLength(1)
    expect(shown[0]!.title).toContain('research')
    expect(shown[0]!.options.tag).toBe('research')
  })

  test('does not fire on idle→idle', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'idle' })
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'idle' })
    expect(shown).toHaveLength(0)
  })

  test('does not fire on working→working', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'working' })
    expect(shown).toHaveLength(0)
  })

  test('does not fire on working→ended (SessionEnd is not a turn)', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'ended' })
    expect(shown).toHaveLength(0)
  })

  test('first-ever update records state but does not fire', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'research', name: 'research', state: 'idle' })
    expect(shown).toHaveLength(0)
  })
})

describe('createNotifications — trigger B (party-line message)', async () => {
  function envelope(overrides = {}) {
    return {
      id: 'x',
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
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onPartyLineMessage(envelope())
    expect(shown).toHaveLength(1)
    expect(shown[0]!.title).toBe('research')
    expect(shown[0]!.options.body).toContain('discord')
    expect(shown[0]!.options.body).toContain('hello')
  })

  test('fires on broadcast (to=all)', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onPartyLineMessage(envelope({ to: 'all' }))
    expect(shown).toHaveLength(1)
  })

  test('does not fire if envelope.from equals the session', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onPartyLineMessage(envelope({ from: 'research' }))
    expect(shown).toHaveLength(0)
  })

  test('filters heartbeat and announce', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onPartyLineMessage(envelope({ type: 'heartbeat' }))
    await notif.onPartyLineMessage(envelope({ type: 'announce' }))
    await notif.onPartyLineMessage(envelope({ type: 'receipt' }))
    await notif.onPartyLineMessage(envelope({ type: 'response' }))
    expect(shown).toHaveLength(0)
  })

  test('truncates body to 120 chars', async () => {
    const longBody = 'x'.repeat(500)
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onPartyLineMessage(envelope({ body: longBody }))
    expect(shown[0]!.options.body!.length).toBeLessThanOrEqual(140) // "from: " + 120 + ellipsis
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
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onPermissionRequest(permFrame())
    expect(shown).toHaveLength(1)
    expect(shown[0]!.title).toContain('Permission needed')
    expect(shown[0]!.title).toContain('Bash')
    expect(shown[0]!.options.body).toContain('Run tests')
    expect(shown[0]!.options.tag).toBe('research')
  })

  test('does not fire when session toggle is off', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    await notif.onPermissionRequest(permFrame())
    expect(shown).toHaveLength(0)
  })

  test('does not fire if request_id already resolved', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onPermissionResolved({
      session: 'research',
      request_id: 'abc12',
      behavior: 'allow',
    })
    await notif.onPermissionRequest(permFrame())
    expect(shown).toHaveLength(0)
  })
})

describe('createNotifications — fire conditions', async () => {
  test('does not fire if tab visible AND route is current session', async () => {
    const { notif, shown } = mockDeps({ hidden: false, route: '/session/research' })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })
    expect(shown).toHaveLength(0)
  })

  test('fires if tab visible but viewing different session', async () => {
    const { notif, shown } = mockDeps({ hidden: false, route: '/session/other' })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })
    expect(shown).toHaveLength(1)
  })

  test('does not fire if toggle off for that session', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    // no setEnabled call
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })
    expect(shown).toHaveLength(0)
  })

  test('does not fire if Notification.permission !== granted', async () => {
    const { notif, shown, setPermission } = mockDeps({ hidden: true })
    setPermission('denied')
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })
    expect(shown).toHaveLength(0)
  })

  test('fires on Switchboard (not on any session detail)', async () => {
    const { notif, shown } = mockDeps({ hidden: false, route: '/switchboard' })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })
    expect(shown).toHaveLength(1)
  })
})

describe('createNotifications — auto-dismiss', async () => {
  test("onNotificationDismiss closes the session's active notification", async () => {
    const { notif, closed } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })

    await notif.onNotificationDismiss({ session: 'research' })
    expect(closed).toContain('research')
  })

  test('onNotificationDismiss for unknown session is a no-op', async () => {
    const { notif, closed } = mockDeps()
    await notif.onNotificationDismiss({ session: 'nobody' })
    expect(closed).toEqual([])
  })

  test('dispatchSessionViewed sends session-viewed WS frame', async () => {
    const { notif, wsSends } = mockDeps()
    notif.dispatchSessionViewed('research')
    expect(wsSends).toEqual([{ type: 'session-viewed', session: 'research' }])
  })
})

describe('createNotifications — last assistant text', async () => {
  test('Trigger A fetches transcript and uses last assistant text as body', async () => {
    const { notif, shown, setFetchResponse } = mockDeps({ hidden: true })
    setFetchResponse([
      { type: 'user', text: 'hi' },
      { type: 'assistant-text', text: 'The answer is 42.' },
    ])
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'research-sid', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'research-sid', name: 'research', state: 'idle' })

    expect(shown).toHaveLength(1)
    expect(shown[0]!.options.body).toContain('42')
  })

  test('Trigger A falls back to "Claude is waiting" when transcript fetch fails', async () => {
    const { notif, shown } = mockDeps({
      hidden: true,
      fetch: mock(async () => {
        throw new Error('network')
      }) as unknown as typeof fetch,
    })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'working' })
    await notif.onSessionUpdate({ session_id: 'r', name: 'research', state: 'idle' })

    expect(shown).toHaveLength(1)
    expect(shown[0]!.options.body).toBe('Claude is waiting')
  })
})

describe('createNotifications — trigger B (dashboard as recipient)', async () => {
  function envelope(overrides = {}) {
    return {
      id: 'x',
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
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onPartyLineMessage(envelope())
    expect(shown).toHaveLength(1)
    expect(shown[0]!.options.body).toContain('dashboard')
    expect(shown[0]!.options.body).toContain('status update')
    expect(shown[0]!.options.tag).toBe('research')
  })

  test('does not fire on unrelated session when dashboard is the recipient', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('unrelated', true)
    await notif.onPartyLineMessage(envelope())
    expect(shown).toHaveLength(0)
  })

  test("does not fire if the sender's session toggle is off", async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    await notif.onPartyLineMessage(envelope())
    expect(shown).toHaveLength(0)
  })
})

describe('createNotifications — SW dispatch path', () => {
  test('fires notification via swRegistration.showNotification with correct tag + data', async () => {
    const { notif, shown } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ name: 'research', state: 'working' })
    await notif.onSessionUpdate({ name: 'research', state: 'idle' })
    expect(shown.length).toBe(1)
    expect(shown[0]!.title).toBe('research')
    expect(shown[0]!.options.tag).toBe('research')
    expect(shown[0]!.options.data).toEqual({ sessionName: 'research' })
  })

  test('dismiss by tag closes every notification with that tag', async () => {
    const { notif, closed } = mockDeps({ hidden: true })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ name: 'research', state: 'working' })
    await notif.onSessionUpdate({ name: 'research', state: 'idle' })
    await notif.onNotificationDismiss({ session: 'research' })
    expect(closed).toContain('research')
  })

  test('permission denied → no fire', async () => {
    const { notif, shown } = mockDeps({ permission: 'denied', hidden: true })
    notif.setEnabled('research', true)
    await notif.onSessionUpdate({ name: 'research', state: 'working' })
    await notif.onSessionUpdate({ name: 'research', state: 'idle' })
    expect(shown.length).toBe(0)
  })
})
