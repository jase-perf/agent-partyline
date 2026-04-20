// Generate placeholder PWA icons as PNG files from an inline SVG template.
// Requires: rsvg-convert (apt package: librsvg2-bin).

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SVG = (size: number, fontSize: number) =>
  `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#0d1117"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
        font-family="system-ui, sans-serif" font-weight="700"
        font-size="${fontSize}" fill="#3fb950">PL</text>
</svg>
`.trim()

async function renderSvgToPng(svg: string, outPath: string) {
  const tmp = `/tmp/pwa-icon-${Math.random().toString(36).slice(2)}.svg`
  writeFileSync(tmp, svg)
  const proc = Bun.spawn(['rsvg-convert', '-o', outPath, tmp], { stderr: 'pipe' })
  const exit = await proc.exited
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(
      `rsvg-convert failed: ${err.trim()}\nInstall with: sudo apt install librsvg2-bin`,
    )
  }
}

const outDir = resolve(import.meta.dir, '..', 'dashboard', 'icons')

// Standard sizes: half of canvas for tight fit on 192, 512.
await renderSvgToPng(SVG(192, 96), resolve(outDir, 'icon-192.png'))
await renderSvgToPng(SVG(512, 256), resolve(outDir, 'icon-512.png'))
// Maskable: smaller "PL" so it sits inside the ~80% safe zone (Android's
// circular/rounded-square mask crops up to 20%).
await renderSvgToPng(SVG(512, 160), resolve(outDir, 'icon-maskable-512.png'))

console.log('Icons generated in', outDir)
