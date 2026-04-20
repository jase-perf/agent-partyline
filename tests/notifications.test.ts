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
