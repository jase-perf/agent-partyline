import { mock } from 'bun:test'

// Minimal DOM-ish interfaces — the project doesn't pull in TS's DOM lib, so we
// declare the shapes the notifications module needs right here. These are
// cast targets only; the fakes below are duck-typed.
interface NotificationOptions {
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

export function mockDeps(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, string>()
  const localStorage: StorageLike = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  const fired: Array<{ title: string; options: NotificationOptions }> = []
  const closed: string[] = []
  const instances: FakeNotification[] = []
  class FakeNotification {
    static permission: 'default' | 'granted' | 'denied' = 'granted'
    static requestPermission = mock(async () => FakeNotification.permission)
    title: string
    tag?: string
    data?: unknown
    onclick: ((ev: Event) => void) | null = null
    constructor(title: string, options: NotificationOptions = {}) {
      this.title = title
      this.tag = options.tag
      this.data = options.data
      fired.push({ title, options })
      instances.push(this)
    }
    close() {
      if (this.tag) closed.push(this.tag)
    }
  }
  const doc: DocumentLike = { hidden: false }
  const win: WindowLike & { focus: ReturnType<typeof mock> } = { focus: mock(() => {}) }
  const wsSends: unknown[] = []
  const ctx = {
    NotificationCtor: FakeNotification as unknown as typeof globalThis extends {
      Notification: infer N
    }
      ? N
      : unknown,
    localStorage: localStorage as unknown,
    doc: doc as unknown,
    win: win as unknown,
    sendWsFrame: (frame: unknown) => void wsSends.push(frame),
    getCurrentRoute: () => '/switchboard',
    navigate: mock((_route: string) => {}),
    ...overrides,
  }
  return { ctx, fired, closed, wsSends, FakeNotification, doc, win, instances }
}
