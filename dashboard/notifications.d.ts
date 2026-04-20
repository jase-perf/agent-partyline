export interface NotificationDeps {
  swRegistration: Promise<ServiceWorkerRegistration | null> | null
  NotificationPermission:
    | {
        permission: NotificationPermission
        requestPermission: () => Promise<NotificationPermission>
      }
    | undefined
  localStorage: Storage
  doc: Document
  win: Window
  sendWsFrame: (frame: unknown) => void
  getCurrentRoute: () => string
  navigate: (route: string) => void
  fetch?: typeof fetch
}

export interface NotificationModule {
  isEnabled(sessionName: string): boolean
  setEnabled(sessionName: string, enabled: boolean): void
  getPermissionState(): NotificationPermission | 'unsupported'
  requestPermission(): Promise<NotificationPermission | 'unsupported'>
  onSessionUpdate(update: unknown): Promise<void>
  onPartyLineMessage(envelope: unknown): Promise<void>
  onPermissionRequest(frame: unknown): Promise<void>
  onPermissionResolved(frame: unknown): Promise<void>
  onNotificationDismiss(frame: unknown): Promise<void>
  dispatchSessionViewed(sessionName: string): void
}

export function createNotifications(deps: NotificationDeps): NotificationModule
