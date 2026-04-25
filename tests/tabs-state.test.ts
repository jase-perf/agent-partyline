import { describe, expect, test, beforeEach } from 'bun:test'
import {
  loadDismissed,
  saveDismissed,
  pickLruEvictionVictim,
  filterStripSessions,
  shouldBumpUnread,
  TAB_DOM_LRU_CAP,
} from '../dashboard/tabs-state.js'

const KEY = 'partyLine.tabs.dismissed'

describe('tabs-state', () => {
  beforeEach(() => {
    // bun:test runs in Node-ish env. Stub a minimal localStorage on globalThis.
    const store: Record<string, string> = {}
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => (k in store ? store[k]! : null),
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() {
        return Object.keys(store).length
      },
    }
  })

  describe('loadDismissed / saveDismissed', () => {
    test('loadDismissed returns empty Set when key is absent', () => {
      expect(loadDismissed()).toEqual(new Set())
    })

    test('round-trip: saveDismissed then loadDismissed returns same set', () => {
      saveDismissed(new Set(['argonaut', 'hots3']))
      expect(loadDismissed()).toEqual(new Set(['argonaut', 'hots3']))
    })

    test('loadDismissed tolerates malformed JSON without throwing', () => {
      localStorage.setItem(KEY, 'not-json{')
      expect(loadDismissed()).toEqual(new Set())
    })

    test('loadDismissed tolerates non-object payload (string)', () => {
      localStorage.setItem(KEY, '"oops"')
      expect(loadDismissed()).toEqual(new Set())
    })

    test('loadDismissed tolerates payload missing dismissed key', () => {
      localStorage.setItem(KEY, '{"other":"junk"}')
      expect(loadDismissed()).toEqual(new Set())
    })

    test('saveDismissed empty Set still writes (so cleared dismissals persist)', () => {
      saveDismissed(new Set(['foo']))
      saveDismissed(new Set())
      expect(loadDismissed()).toEqual(new Set())
    })
  })

  describe('pickLruEvictionVictim', () => {
    test('returns null when under cap', () => {
      const tabs = new Map([
        ['a', { lastViewedAt: 1 }],
        ['b', { lastViewedAt: 2 }],
      ])
      expect(pickLruEvictionVictim(tabs, 8)).toBeNull()
    })

    test('returns least-recently-viewed name when over cap', () => {
      const tabs = new Map([
        ['oldest', { lastViewedAt: 100 }],
        ['middle', { lastViewedAt: 200 }],
        ['newest', { lastViewedAt: 300 }],
      ])
      expect(pickLruEvictionVictim(tabs, 2)).toBe('oldest')
    })

    test('returns null when over cap but everyone has same lastViewedAt of 0 (never viewed)', () => {
      // Defensive: prefetched tabs that the user has never focused all have
      // lastViewedAt=0. Picking one to evict would be arbitrary; better to
      // wait until the user focuses something.
      const tabs = new Map([
        ['a', { lastViewedAt: 0 }],
        ['b', { lastViewedAt: 0 }],
        ['c', { lastViewedAt: 0 }],
      ])
      expect(pickLruEvictionVictim(tabs, 2)).toBeNull()
    })

    test('TAB_DOM_LRU_CAP is the documented soft cap of 8', () => {
      expect(TAB_DOM_LRU_CAP).toBe(8)
    })
  })

  describe('filterStripSessions', () => {
    test('keeps only online sessions absent from dismissed set', () => {
      const sessions = [
        { name: 'a', online: true },
        { name: 'b', online: false },
        { name: 'c', online: true },
        { name: 'd', online: true },
      ]
      const dismissed = new Set(['c'])
      expect(filterStripSessions(sessions, dismissed).map((s) => s.name)).toEqual(['a', 'd'])
    })

    test('preserves input order (stable insertion order)', () => {
      const sessions = [
        { name: 'second', online: true },
        { name: 'first', online: true },
        { name: 'third', online: true },
      ]
      expect(filterStripSessions(sessions, new Set()).map((s) => s.name)).toEqual([
        'second',
        'first',
        'third',
      ])
    })

    test('empty input returns empty array', () => {
      expect(filterStripSessions([], new Set())).toEqual([])
    })
  })

  describe('shouldBumpUnread', () => {
    test('Stop hook bumps', () => {
      expect(shouldBumpUnread({ kind: 'hook-event', hookEvent: 'Stop' })).toBe(true)
    })

    test('Notification hook bumps', () => {
      expect(shouldBumpUnread({ kind: 'hook-event', hookEvent: 'Notification' })).toBe(true)
    })

    test('api-error frame bumps', () => {
      expect(shouldBumpUnread({ kind: 'api-error' })).toBe(true)
    })

    test('SessionEnd hook does NOT bump (lifecycle, not a message)', () => {
      expect(shouldBumpUnread({ kind: 'hook-event', hookEvent: 'SessionEnd' })).toBe(false)
    })

    test('PostToolUse hook does NOT bump (per-tool noise)', () => {
      expect(shouldBumpUnread({ kind: 'hook-event', hookEvent: 'PostToolUse' })).toBe(false)
    })

    test('UserPromptSubmit hook does NOT bump', () => {
      expect(shouldBumpUnread({ kind: 'hook-event', hookEvent: 'UserPromptSubmit' })).toBe(false)
    })

    test('party-line envelope (any kind) does NOT bump (inter-agent noise)', () => {
      expect(shouldBumpUnread({ kind: 'envelope' })).toBe(false)
    })

    test('unknown kind does NOT bump (defensive default)', () => {
      expect(shouldBumpUnread({ kind: 'totally-made-up' as 'envelope' })).toBe(false)
    })
  })
})
