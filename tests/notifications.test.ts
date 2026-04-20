import { test, expect, describe } from 'bun:test'
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
