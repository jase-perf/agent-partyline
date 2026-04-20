/**
 * cli.ts — Command-line interface for the party line.
 *
 * Modes:
 *   bun dashboard/cli.ts watch              — tail all messages (human-readable)
 *   bun dashboard/cli.ts watch --json       — tail all messages (JSON, one per line)
 *   bun dashboard/cli.ts sessions           — list online sessions and exit
 *   bun dashboard/cli.ts send <to> <msg>    — send a message and exit
 *   bun dashboard/cli.ts request <to> <msg> — send a request, wait for response, exit
 *   bun dashboard/cli.ts history [--limit N] — show recent history and exit
 */

import { PartyLineMonitor } from './monitor.js'
import type { Envelope } from '../src/types.js'

const args = process.argv.slice(2)
const command = args[0] ?? 'watch'

function getFlag(flag: string): boolean {
  return args.includes(flag)
}

function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] ? args[idx + 1]! : fallback
}

const NAME = getArg('--name', 'cli')
const JSON_MODE = getFlag('--json')
const INCLUDE_HEARTBEATS = getFlag('--heartbeats')

function formatMessage(envelope: Envelope): string {
  if (JSON_MODE) return JSON.stringify(envelope)

  const time = new Date(envelope.ts).toLocaleTimeString()
  const tag = envelope.callback_id ? ` [cb:${envelope.callback_id}]` : ''
  const resp = envelope.response_to ? ` [↩${envelope.response_to}]` : ''
  const typeColor =
    {
      message: '\x1b[37m',
      request: '\x1b[33m',
      response: '\x1b[32m',
      status: '\x1b[36m',
      heartbeat: '\x1b[90m',
      announce: '\x1b[35m',
      'permission-request': '\x1b[33m',
      'permission-response': '\x1b[32m',
    }[envelope.type] ?? '\x1b[37m'
  const reset = '\x1b[0m'

  return `${reset}${time} ${typeColor}${envelope.type.padEnd(9)}${reset} ${envelope.from} → ${envelope.to}${tag}${resp}: ${envelope.body}`
}

async function main(): Promise<void> {
  const monitor = new PartyLineMonitor(NAME)

  switch (command) {
    case 'watch': {
      await monitor.start()
      console.error(`Watching party line as "${NAME}"... (Ctrl+C to stop)`)
      console.error()

      monitor.onMessage((envelope) => {
        if (!INCLUDE_HEARTBEATS && envelope.type === 'heartbeat') return
        process.stdout.write(formatMessage(envelope) + '\n')
      })

      // Keep alive
      process.on('SIGINT', () => {
        monitor.stop()
        process.exit(0)
      })
      break
    }

    case 'sessions': {
      await monitor.start()
      // Wait a bit for heartbeats to arrive
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const sessions = monitor.getSessions()
      if (JSON_MODE) {
        console.log(JSON.stringify(sessions, null, 2))
      } else {
        if (sessions.length === 0) {
          console.log('No sessions online.')
        } else {
          console.log('Online sessions:')
          for (const s of sessions) {
            const self = s.name === NAME ? ' (this)' : ''
            const st = s.metadata?.status
            if (st) {
              const stateIcon = st.state === 'working' ? '🔄' : st.state === 'idle' ? '💤' : '❓'
              const branch = st.gitBranch ? `[${st.gitBranch}]` : ''
              const tool = st.currentTool ? `running ${st.currentTool}` : st.state
              const ctx =
                st.contextPercent !== null
                  ? `ctx: ${st.contextPercent}% (${Math.round((st.contextTokens ?? 0) / 1000)}k/${Math.round((st.contextLimit ?? 0) / 1000)}k)`
                  : ''
              const msgs = st.messageCount ? `${st.messageCount} msgs` : ''
              console.log(`  ${stateIcon} ${s.name}${self} ${branch}`)
              console.log(`     ${tool} · ${ctx} · ${msgs}`)
              if (st.lastText) {
                console.log(`     "${st.lastText.slice(0, 80)}"`)
              }
            } else {
              const desc = s.metadata?.description ? ` — ${s.metadata.description}` : ''
              console.log(`  ${s.name}${self}${desc}`)
            }
          }
        }
      }
      monitor.stop()
      break
    }

    case 'send': {
      const to = args[1]
      const message = args
        .slice(2)
        .filter((a) => !a.startsWith('--'))
        .join(' ')
      if (!to || !message) {
        console.error('Usage: cli.ts send <to> <message>')
        process.exit(1)
      }

      await monitor.start()
      const envelope = await monitor.send(to, message)
      if (JSON_MODE) {
        console.log(JSON.stringify(envelope))
      } else {
        console.log(`Sent to "${to}" (id: ${envelope.id})`)
      }
      // Brief delay for send-twice to complete
      await new Promise((resolve) => setTimeout(resolve, 100))
      monitor.stop()
      break
    }

    case 'request': {
      const to = args[1]
      const message = args
        .slice(2)
        .filter((a) => !a.startsWith('--'))
        .join(' ')
      if (!to || !message) {
        console.error('Usage: cli.ts request <to> <message>')
        process.exit(1)
      }

      const timeoutMs = parseInt(getArg('--timeout', '30000'), 10)
      await monitor.start()
      const envelope = await monitor.send(to, message, 'request')
      console.error(`Request sent to "${to}" (callback: ${envelope.callback_id}). Waiting...`)

      const gotResponse = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), timeoutMs)
        monitor.onMessage((resp) => {
          if (resp.response_to === envelope.callback_id) {
            clearTimeout(timeout)
            if (JSON_MODE) {
              console.log(JSON.stringify(resp))
            } else {
              console.log(`Response from ${resp.from}: ${resp.body}`)
            }
            resolve(true)
          }
        })
      })

      if (!gotResponse) {
        console.error('Timed out waiting for response.')
        process.exit(1)
      }
      monitor.stop()
      break
    }

    case 'history': {
      await monitor.start()
      // Wait briefly for any in-flight messages
      await new Promise((resolve) => setTimeout(resolve, 500))

      const limit = parseInt(getArg('--limit', '20'), 10)
      const history = monitor.getHistory({ limit, excludeHeartbeats: !INCLUDE_HEARTBEATS })

      if (JSON_MODE) {
        console.log(JSON.stringify(history, null, 2))
      } else {
        if (history.length === 0) {
          console.log('No recent messages.')
        } else {
          for (const msg of history) {
            console.log(formatMessage(msg))
          }
        }
      }
      monitor.stop()
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.error()
      console.error('Commands:')
      console.error('  watch              — tail all messages (add --json for JSON output)')
      console.error('  sessions           — list online sessions')
      console.error('  send <to> <msg>    — send a message')
      console.error('  request <to> <msg> — send a request and wait for response')
      console.error('  history            — show recent messages')
      process.exit(1)
  }
}

void main()
