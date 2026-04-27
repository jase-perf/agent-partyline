import { statSync, readdirSync, existsSync, openSync, readSync, closeSync } from 'fs'
import { basename, join } from 'path'

export interface JsonlUpdate {
  session_id: string
  file_path: string
  entry: Record<string, unknown>
}

type Listener = (u: JsonlUpdate) => void
type ResetListener = (filePath: string) => void

/**
 * How many bytes to read from the start of a file to use as a fingerprint
 * for detecting whether the file was replaced vs. merely truncated-in-place.
 * 64 bytes is enough to distinguish different JSONL content.
 */
const FINGERPRINT_BYTES = 64

export class JsonlObserver {
  private offsets = new Map<string, number>()
  /** Fingerprint (first FINGERPRINT_BYTES bytes as hex) indexed by file path. */
  private fingerprints = new Map<string, string>()
  private listeners: Listener[] = []
  private resetListeners: ResetListener[] = []
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly pollIntervalMs: number
  private scanCount = 0
  private scanning = false

  constructor(
    private root: string,
    pollIntervalMs = 500,
  ) {
    this.pollIntervalMs = pollIntervalMs
  }

  on(l: Listener): void {
    this.listeners.push(l)
  }

  /** Register a callback fired when a file is detected to have shrunk (truncation/replacement). */
  onReset(l: ResetListener): void {
    this.resetListeners.push(l)
  }

  async start(): Promise<void> {
    this.running = true
    this.scan()
    this.timer = setInterval(() => this.scan(), this.pollIntervalMs)
  }

  private scan(): void {
    if (!this.running) return
    if (this.scanning) return
    this.scanning = true
    try {
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
      } catch {
        /* root read failed — next tick retries */
      }

      // Periodic GC: drop offset + fingerprint entries for files that no longer exist.
      this.scanCount++
      if (this.scanCount % 20 === 0) {
        for (const path of this.offsets.keys()) {
          if (!existsSync(path)) {
            this.offsets.delete(path)
            this.fingerprints.delete(path)
          }
        }
      }
    } finally {
      this.scanning = false
    }
  }

  /**
   * Read the first FINGERPRINT_BYTES bytes of a file as a hex string.
   * Returns an empty string if the file cannot be read or is empty.
   */
  private readFingerprint(fd: number, fileSize: number): string {
    if (fileSize === 0) return ''
    const len = Math.min(FINGERPRINT_BYTES, fileSize)
    const buf = Buffer.alloc(len)
    try {
      readSync(fd, buf, 0, len, 0)
      return buf.toString('hex')
    } catch {
      return ''
    }
  }

  private poll(path: string): void {
    if (!this.running) return
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    const prev = this.offsets.get(path)
    if (prev === undefined) {
      // First sighting — seed offset to current size; don't replay existing content.
      // Also capture a fingerprint so we can detect future file replacement.
      let fd: number
      try {
        fd = openSync(path, 'r')
      } catch {
        return
      }
      try {
        const fp = this.readFingerprint(fd, size)
        if (fp) this.fingerprints.set(path, fp)
      } finally {
        closeSync(fd)
      }
      this.offsets.set(path, size)
      return
    }

    if (size < prev) {
      // File shrank — could be compaction (file replaced) or in-place truncation.
      // Open the file and compare fingerprint to determine what happened.
      let fd: number
      try {
        fd = openSync(path, 'r')
      } catch {
        return
      }
      try {
        const newFp = this.readFingerprint(fd, size)
        const oldFp = this.fingerprints.get(path) ?? ''

        if (newFp && oldFp && newFp === oldFp) {
          // Same file start — likely an in-place truncation at the end.
          // Rewind offset to current size so we don't read past EOF.
          this.offsets.set(path, size)
        } else {
          // Different fingerprint (or couldn't compare) — file was replaced.
          // Reset to current size; client must force a full re-fetch.
          // Update fingerprint for the new file.
          if (newFp) this.fingerprints.set(path, newFp)
          this.offsets.set(path, size)
        }
      } finally {
        closeSync(fd)
      }

      // Notify reset listeners so the client can trigger a forced full refetch.
      for (const l of this.resetListeners) l(path)
      return
    }

    if (size === prev) return

    // Normal append case: size > prev
    let tail: string
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch {
      return
    }
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
      } catch {
        /* malformed — ignore */
      }
    }
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
