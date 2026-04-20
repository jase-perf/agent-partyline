import { mock } from 'bun:test'

// Minimal DOM-ish interfaces — the project doesn't pull in TS's DOM lib, so we
// declare the shapes the notifications module needs right here. `ctx` carries
// concrete test types (not `unknown`) so individual tests can mutate e.g.
// `ctx.doc.hidden` without casts.
interface NotificationOptionsLike {
  body?: string
  tag?: string
  data?: unknown
}
interface StorageLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}
interface DocumentLike {
  hidden: boolean
}
interface WindowLike {
  focus(): void
}

class FakeNotificationBase {
  static permission: 'default' | 'granted' | 'denied' = 'granted'
  static requestPermission = mock(async () => FakeNotificationBase.permission)
  title = ''
  tag?: string
  data?: unknown
  onclick: ((ev: unknown) => void) | null = null
  close(): void {}
}

export type FakeNotificationCtor = typeof FakeNotificationBase & {
  new (title: string, options?: NotificationOptionsLike): FakeNotificationBase
}

export interface NotificationTestCtx {
  NotificationCtor: FakeNotificationCtor | undefined
  localStorage: StorageLike
  doc: DocumentLike
  win: WindowLike & { focus: ReturnType<typeof mock> }
  sendWsFrame: (frame: unknown) => void
  getCurrentRoute: () => string
  navigate: ReturnType<typeof mock>
  fetch: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
}

export function mockDeps(overrides: Partial<NotificationTestCtx> = {}): {
  ctx: NotificationTestCtx
  fired: Array<{ title: string; options: NotificationOptionsLike }>
  closed: string[]
  wsSends: unknown[]
  FakeNotification: FakeNotificationCtor
  doc: DocumentLike
  win: WindowLike & { focus: ReturnType<typeof mock> }
  instances: FakeNotificationBase[]
  fetchCalls: string[]
  setFetchResponse: (r: unknown) => void
} {
  const store = new Map<string, string>()
  const localStorage: StorageLike = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  const fired: Array<{ title: string; options: NotificationOptionsLike }> = []
  const closed: string[] = []
  const instances: FakeNotificationBase[] = []
  class FakeNotification extends FakeNotificationBase {
    constructor(title: string, options: NotificationOptionsLike = {}) {
      super()
      this.title = title
      this.tag = options.tag
      this.data = options.data
      fired.push({ title, options })
      instances.push(this)
    }
    override close(): void {
      if (this.tag) closed.push(this.tag)
    }
  }
  const doc: DocumentLike = { hidden: false }
  const win: WindowLike & { focus: ReturnType<typeof mock> } = { focus: mock(() => {}) }
  const wsSends: unknown[] = []
  const fetchCalls: string[] = []
  let fetchResponse: unknown = []
  const fetchMock = mock(async (url: string) => {
    fetchCalls.push(url)
    return {
      ok: true,
      json: async () => fetchResponse,
    }
  })
  const ctx: NotificationTestCtx = {
    NotificationCtor: FakeNotification as unknown as FakeNotificationCtor,
    localStorage,
    doc,
    win,
    sendWsFrame: (frame: unknown) => void wsSends.push(frame),
    getCurrentRoute: () => '/switchboard',
    navigate: mock((_route: string) => {}),
    fetch: fetchMock,
    ...overrides,
  }
  return {
    ctx,
    fired,
    closed,
    wsSends,
    FakeNotification: FakeNotification as unknown as FakeNotificationCtor,
    doc,
    win,
    instances,
    fetchCalls,
    setFetchResponse: (r: unknown) => {
      fetchResponse = r
    },
  }
}
