// Type surface for the JS `createNotifications` factory. Kept separate so the
// runtime module stays plain JS (consistent with dashboard/dashboard.js) while
// TS tests still get coverage.

export interface NotificationDeps {
  NotificationCtor:
    | {
        permission: 'default' | 'granted' | 'denied' | 'unsupported' | string
        requestPermission(): Promise<string>
        new (
          title: string,
          options?: unknown,
        ): { close(): void; onclick: ((ev: unknown) => void) | null }
      }
    | undefined
  localStorage: {
    getItem(k: string): string | null
    setItem(k: string, v: string): void
    removeItem(k: string): void
  }
  doc: { hidden: boolean }
  win: { focus(): void }
  sendWsFrame: (frame: unknown) => void
  getCurrentRoute: () => string
  navigate: (route: string) => void
  fetch?: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
}

export interface SessionUpdate {
  session_id?: string
  name: string
  state: 'working' | 'idle' | 'ended' | string
}

export interface PartyLineEnvelope {
  id?: string
  seq?: number
  from?: string
  to?: string
  type: string
  body?: string
  callback_id?: string | null
  response_to?: string | null
  ts?: string
}

export interface PermissionRequestFrame {
  session: string
  request_id: string
  tool_name?: string
  description?: string
  input_preview?: string
}

export interface PermissionResolvedFrame {
  session: string
  request_id: string
  behavior?: string
}

export interface DismissFrame {
  session: string
}

export interface NotificationsApi {
  isEnabled(sessionName: string): boolean
  setEnabled(sessionName: string, enabled: boolean): void
  getPermissionState(): string
  requestPermission(): Promise<string>
  onSessionUpdate(update: SessionUpdate): Promise<void> | void
  onPartyLineMessage(envelope: PartyLineEnvelope): void
  onPermissionRequest(frame: PermissionRequestFrame): void
  onPermissionResolved(frame: PermissionResolvedFrame): void
  onNotificationDismiss(frame: DismissFrame): void
  dispatchSessionViewed(sessionName: string): void
}

export function createNotifications(deps: unknown): NotificationsApi
