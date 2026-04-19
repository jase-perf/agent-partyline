import { statSync, readdirSync, existsSync, openSync, readSync, closeSync } from 'fs'
import { basename, join } from 'path'

export interface JsonlUpdate {
  session_id: string
  file_path: string
  entry: Record<string, unknown>
}

type Listener = (u: JsonlUpdate) => void

export class JsonlObserver {
  private offsets = new Map<string, number>()
  private listeners: Listener[] = []
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly pollIntervalMs: number
  private scanCount = 0

  constructor(private root: string, pollIntervalMs = 500) {
    this.pollIntervalMs = pollIntervalMs
  }

  on(l: Listener): void { this.listeners.push(l) }

  async start(): Promise<void> {
    this.running = true
    this.scan()
    this.timer = setInterval(() => this.scan(), this.pollIntervalMs)
  }

  private scan(): void {
    if (!this.running) return
    if (!existsSync(this.root)) return
    try {
      for (const cwdDir of readdirSync(this.root, { withFileTypes: true })) {
        if (!cwdDir.isDirectory()) continue
        const cwdPath = join(this.root, cwdDir.name)
        for (const entry of readdirSync(cwdPath, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            this.poll(join(cwdPath, entry.name))
          } else if (entry.isDirectory()) {
            const subagentsDir = join(cwdPath, entry.name, 'subagents')
            if (existsSync(subagentsDir)) {
              for (const sub of readdirSync(subagentsDir, { withFileTypes: true })) {
                if (sub.isFile() && sub.name.endsWith('.jsonl')) {
                  this.poll(join(subagentsDir, sub.name))
                }
              }
            }
          }
        }
      }
    } catch { /* root read failed — next tick retries */ }

    // Periodic GC: drop offset entries for files that no longer exist.
    this.scanCount++
    if (this.scanCount % 20 === 0) {
      for (const path of this.offsets.keys()) {
        if (!existsSync(path)) this.offsets.delete(path)
      }
    }
  }

  private poll(path: string): void {
    if (!this.running) return
    let size: number
    try { size = statSync(path).size } catch { return }
    const prev = this.offsets.get(path)
    if (prev === undefined) {
      // First sighting — seed offset to current size; don't replay existing content.
      this.offsets.set(path, size)
      return
    }
    if (size <= prev) return
    let tail: string
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch { return }
    try {
      const length = size - prev
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, prev)
      tail = buf.toString('utf-8')
    } finally {
      closeSync(fd)
    }
    this.offsets.set(path, size)

    const session_id = basename(path, '.jsonl')
    for (const line of tail.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        for (const l of this.listeners) l({ session_id, file_path: path, entry })
      } catch { /* malformed — ignore */ }
    }
  }

  stop(): void {
    this.running = false
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}
