import { mock } from 'bun:test'
import { createNotifications } from '../dashboard/notifications.js'

// Minimal DOM-ish interfaces — the project doesn't pull in TS's DOM lib, so we
// declare the shapes the notifications module needs right here.
interface NotificationOptionsLike {
  body?: string
  tag?: string
  data?: unknown
}
interface DocumentLike {
  hidden: boolean
}
interface WindowLike {
  focus(): void
}

export interface MockShown {
  title: string
  options: NotificationOptionsLike
}

export function mockDeps(
  overrides: Partial<{
    permission: 'default' | 'granted' | 'denied'
    hidden: boolean
    route: string
    fetch: typeof fetch
    NotificationPermission: undefined
  }> = {},
): {
  notif: ReturnType<typeof createNotifications>
  shown: MockShown[]
  closed: string[]
  wsSends: unknown[]
  doc: DocumentLike
  win: WindowLike & { focus: ReturnType<typeof mock> }
  fetchCalls: string[]
  setFetchResponse: (r: unknown) => void
  setPermission: (p: 'default' | 'granted' | 'denied') => void
  setRoute: (r: string) => void
} {
  const shown: MockShown[] = []
  const closed: string[] = []

  const fakeRegistration = {
    showNotification: (title: string, options: NotificationOptionsLike) => {
      shown.push({ title, options })
      return Promise.resolve()
    },
    getNotifications: async ({ tag }: { tag: string }) => {
      return shown
        .filter((s) => s.options.tag === tag)
        .map((s) => ({
          tag: s.options.tag,
          close: () => closed.push(s.options.tag as string),
        }))
    },
  }

  let perm: 'default' | 'granted' | 'denied' = overrides.permission ?? 'granted'
  const NotificationPermission =
    overrides.NotificationPermission === undefined && 'NotificationPermission' in overrides
      ? undefined
      : {
          get permission() {
            return perm as NotificationPermission
          },
          async requestPermission() {
            return perm as NotificationPermission
          },
        }

  const store = new Map<string, string>()
  const localStorage: Storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }

  const doc: DocumentLike = { hidden: overrides.hidden ?? false }
  const win: WindowLike & { focus: ReturnType<typeof mock> } = { focus: mock(() => {}) }
  const wsSends: unknown[] = []
  const fetchCalls: string[] = []
  let fetchResponse: unknown = []
  const fetchMock =
    overrides.fetch ??
    (mock(async (url: string) => {
      fetchCalls.push(url)
      return {
        ok: true,
        json: async () => fetchResponse,
      }
    }) as unknown as typeof fetch)

  let currentRoute = overrides.route ?? '/switchboard'

  const notif = createNotifications({
    swRegistration: Promise.resolve(fakeRegistration as unknown as ServiceWorkerRegistration),
    NotificationPermission: NotificationPermission as
      | {
          permission: NotificationPermission
          requestPermission: () => Promise<NotificationPermission>
        }
      | undefined,
    localStorage,
    doc: doc as Document,
    win: win as unknown as Window,
    sendWsFrame: (frame: unknown) => void wsSends.push(frame),
    getCurrentRoute: () => currentRoute,
    navigate: mock((_route: string) => {}),
    fetch: fetchMock,
  })

  return {
    notif,
    shown,
    closed,
    wsSends,
    doc,
    win,
    fetchCalls,
    setFetchResponse: (r: unknown) => {
      fetchResponse = r
    },
    setPermission: (p: 'default' | 'granted' | 'denied') => {
      perm = p
    },
    setRoute: (r: string) => {
      currentRoute = r
    },
  }
}
