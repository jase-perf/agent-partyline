export const TAB_DOM_LRU_CAP: number

export function loadDismissed(): Set<string>

export function saveDismissed(dismissed: Set<string>): void

export interface TabLruEntry {
  lastViewedAt: number
}

export function pickLruEvictionVictim<T extends TabLruEntry>(
  tabs: Map<string, T>,
  cap: number,
): string | null

export interface SessionForStrip {
  name: string
  online: boolean
}

export function filterStripSessions<S extends SessionForStrip>(
  sessions: S[],
  dismissed: Set<string>,
): S[]

export type BumpClassification =
  | { kind: 'hook-event'; hookEvent: string }
  | { kind: 'api-error' }
  | { kind: 'envelope' }

export function shouldBumpUnread(ev: BumpClassification): boolean
