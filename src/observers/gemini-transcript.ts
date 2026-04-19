import { readFileSync, statSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

export interface GeminiTranscriptUpdate {
  session_id: string
  file_path: string
  entry: Record<string, unknown>
  source: 'gemini-cli'
}

type Listener = (u: GeminiTranscriptUpdate) => void

interface FileState {
  mtimeMs: number
  messagesLen: number
}

export class GeminiTranscriptObserver {
  private state = new Map<string, FileState>()
  private listeners: Listener[] = []
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private scanCount = 0
  private readonly pollIntervalMs: number

  constructor(private root: string, pollIntervalMs = 1000) {
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
      for (const projectDir of readdirSync(this.root, { withFileTypes: true })) {
        if (!projectDir.isDirectory()) continue
        const chatsDir = join(this.root, projectDir.name, 'chats')
        if (!existsSync(chatsDir)) continue
        for (const entry of readdirSync(chatsDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.json') && entry.name.startsWith('session-')) {
            this.poll(join(chatsDir, entry.name))
          }
        }
      }
    } catch { /* no-op */ }

    this.scanCount++
    if (this.scanCount % 20 === 0) {
      for (const path of this.state.keys()) {
        if (!existsSync(path)) this.state.delete(path)
      }
    }
  }

  private poll(path: string): void {
    if (!this.running) return
    let mtimeMs: number
    try { mtimeMs = statSync(path).mtimeMs } catch { return }
    const prev = this.state.get(path)

    if (prev && prev.mtimeMs === mtimeMs) return // no change

    let parsed: { sessionId?: string; messages?: unknown[] }
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as typeof parsed
    } catch { return }

    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const prevLen = prev?.messagesLen ?? messages.length // first sight: seed to current length

    if (!prev) {
      this.state.set(path, { mtimeMs, messagesLen: messages.length })
      return
    }

    if (messages.length <= prevLen) {
      this.state.set(path, { mtimeMs, messagesLen: messages.length })
      return
    }

    const sessionId = parsed.sessionId ?? path.split('/').pop()!.replace(/\.json$/, '')

    for (let i = prevLen; i < messages.length; i++) {
      const entry = messages[i]
      if (typeof entry !== 'object' || entry === null) continue
      for (const l of this.listeners) {
        l({
          session_id: sessionId,
          file_path: path,
          entry: entry as Record<string, unknown>,
          source: 'gemini-cli',
        })
      }
    }

    this.state.set(path, { mtimeMs, messagesLen: messages.length })
  }

  stop(): void {
    this.running = false
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}
