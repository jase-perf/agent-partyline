import { test, expect, describe } from 'bun:test'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error - JS module without types
import { notificationRouteFromData } from '../dashboard/sw.js'

const DASHBOARD = resolve(import.meta.dir, '..', 'dashboard')

function readManifest(): Record<string, unknown> {
  const raw = readFileSync(resolve(DASHBOARD, 'manifest.json'), 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

describe('PWA manifest', () => {
  test('has Windows-friendly identity and display fields', () => {
    const m = readManifest()
    // `id` anchors PWA identity on Windows WebAPK so the taskbar icon
    // doesn't drift when start_url resolves differently across installs.
    expect(typeof m.id).toBe('string')
    expect((m.id as string).length).toBeGreaterThan(0)

    expect(m.name).toBe('Party Line Switchboard')
    expect(m.short_name).toBe('Party Line')
    expect(m.start_url).toBe('/')
    expect(m.scope).toBe('/')
    expect(m.display).toBe('standalone')
    expect(m.background_color).toBe('#0d1117')
    expect(m.theme_color).toBe('#0d1117')
  })

  test('icons include required 192 + 512 any + maskable entries', () => {
    const icons = readManifest().icons as Array<Record<string, string>>
    expect(Array.isArray(icons)).toBe(true)

    const has = (size: string, purpose: string) =>
      icons.some((i) => i.sizes === size && i.purpose === purpose)

    // Android Chrome PWA install gate requires both 192 and 512 any icons.
    expect(has('192x192', 'any')).toBe(true)
    expect(has('512x512', 'any')).toBe(true)
    // Dedicated maskable icons — never combine `any maskable` on a single
    // entry because Android crops maskable content into a safe-zone circle.
    expect(has('192x192', 'maskable')).toBe(true)
    expect(has('512x512', 'maskable')).toBe(true)
  })

  test('Windows-preferred small sizes are present for taskbar clarity', () => {
    const icons = readManifest().icons as Array<Record<string, string>>
    const sizesAny = new Set(icons.filter((i) => i.purpose === 'any').map((i) => i.sizes))
    // Windows prefers these for taskbar/start. Without smaller sizes it
    // downsamples from 192/512 and can produce fuzzy or empty squares.
    for (const s of ['48x48', '72x72', '96x96', '144x144']) {
      expect(sizesAny.has(s)).toBe(true)
    }
  })

  test('every manifest icon references a file that exists', () => {
    const icons = readManifest().icons as Array<Record<string, string>>
    for (const icon of icons) {
      const p = resolve(DASHBOARD, (icon.src as string).replace(/^\//, ''))
      expect(existsSync(p)).toBe(true)
      expect(statSync(p).size).toBeGreaterThan(0)
    }
  })

  test('"any" icons are opaque PNGs (no transparent corners)', () => {
    // Windows taskbar renders `any` icons as-is, so transparent backgrounds
    // result in empty squares — this is Bug 1. Verify by sniffing the PNG
    // IHDR: color type must not be RGBA (6) or grayscale+alpha (4). We
    // accept RGB (2), grayscale (0), or palette (3). Maskable icons are
    // allowed alpha because Android WebAPK draws them inside a circular mask.
    const icons = readManifest().icons as Array<Record<string, string>>
    for (const icon of icons) {
      if (icon.purpose !== 'any') continue
      const p = resolve(DASHBOARD, (icon.src as string).replace(/^\//, ''))
      const buf = readFileSync(p)
      // PNG signature is 8 bytes, then IHDR chunk (4 length + 4 type + data).
      // Byte offset 25 = color type field within IHDR.
      const colorType = buf[25]
      expect(colorType).toBeDefined()
      expect([0, 2, 3]).toContain(colorType as number)
    }
  })
})

describe('notificationRouteFromData (Bug 3)', () => {
  test('falls back to / when sessionName is missing', () => {
    expect(notificationRouteFromData(null)).toBe('/')
    expect(notificationRouteFromData(undefined)).toBe('/')
    expect(notificationRouteFromData({})).toBe('/')
    expect(notificationRouteFromData({ sessionName: '' })).toBe('/')
  })

  test('builds PATH-style route (matches dashboard router, not hash)', () => {
    // Dashboard router parses /session/<name>. A hash-style `/#/session/...`
    // (the previous bug) never matched, so clicks landed on Switchboard.
    expect(notificationRouteFromData({ sessionName: 'research' })).toBe('/session/research')
  })

  test('percent-encodes session names with special characters', () => {
    expect(notificationRouteFromData({ sessionName: 'party-line.dev' })).toBe(
      '/session/party-line.dev',
    )
    expect(notificationRouteFromData({ sessionName: 'a/b' })).toBe('/session/a%2Fb')
  })

  test('output matches dashboard router parseUrl regex', () => {
    // From dashboard.js: m = path.match(/^\/session\/([^/]+)\/?$/)
    const re = /^\/session\/([^/]+)\/?$/
    const url = notificationRouteFromData({ sessionName: 'partyline-dev' })
    const match = url.match(re)
    expect(match).not.toBeNull()
    expect(decodeURIComponent(match![1]!)).toBe('partyline-dev')
  })
})
