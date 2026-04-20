/**
 * cli.ts — Command-line interface for the party-line dashboard.
 *
 * Talks to the dashboard's HTTP API and observer WebSocket. Requires the
 * dashboard to be running. Auth via PARTY_LINE_DASHBOARD_PASSWORD env var
 * (or an already-cached cookie from a prior `watch` session, not implemented
 * yet).
 *
 * Modes:
 *   bun dashboard/cli.ts watch              — tail envelopes + session deltas
 *   bun dashboard/cli.ts watch --json       — one JSON frame per line
 *   bun dashboard/cli.ts sessions           — list registered sessions
 *   bun dashboard/cli.ts send <to> <msg>    — send a message via the dashboard
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '0'

const RAW_URL = process.env.PARTY_LINE_SWITCHBOARD_URL || 'https://localhost:3400'
// Normalize: accept http(s)://... or ws(s)://..., strip any /ws/* suffix, keep scheme.
const NORMALIZED = RAW_URL.replace(/^ws:\/\//, 'http://')
  .replace(/^wss:\/\//, 'https://')
  .replace(/\/ws\/.*$/, '')
const BASE = NORMALIZED.replace(/\/$/, '')
const WS_OBSERVER =
  BASE.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://') + '/ws/observer'

const args = process.argv.slice(2)
const command = args[0] ?? 'help'
const JSON_MODE = args.includes('--json')

function die(msg: string, code = 1): never {
  console.error(msg)
  process.exit(code)
}

async function loginCookie(): Promise<string> {
  const pw = process.env.PARTY_LINE_DASHBOARD_PASSWORD
  if (!pw) die('PARTY_LINE_DASHBOARD_PASSWORD is required for CLI auth.')
  const res = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  })
  if (!res.ok) die(`login failed: ${res.status} ${await res.text()}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  const m = setCookie.match(/pl_dash=([^;]+)/)
  if (!m) die('login succeeded but no cookie returned')
  return `pl_dash=${m[1]}`
}

interface EnvelopeFrame {
  type: 'envelope'
  id: string
  ts: number
  from: string
  to: string
  envelope_type: string
  body: string | null
  callback_id: string | null
  response_to: string | null
}

interface SessionDeltaFrame {
  type: 'session-delta'
  session: string
  revision: number
  changes: Record<string, unknown>
}

interface SessionsSnapshotFrame {
  type: 'sessions-snapshot'
  sessions: Array<{
    name: string
    cwd: string
    cc_session_uuid: string | null
    online: boolean
    revision: number
  }>
}

type AnyFrame = EnvelopeFrame | SessionDeltaFrame | SessionsSnapshotFrame | { type: string }

function fmtEnvelope(e: EnvelopeFrame): string {
  const time = new Date(e.ts).toLocaleTimeString()
  const tag = e.callback_id ? ` [cb:${e.callback_id}]` : ''
  const resp = e.response_to ? ` [↩${e.response_to}]` : ''
  const typeColor: Record<string, string> = {
    message: '\x1b[37m',
    request: '\x1b[33m',
    response: '\x1b[32m',
    status: '\x1b[36m',
    'permission-request': '\x1b[33m',
    'permission-response': '\x1b[32m',
  }
  const color = typeColor[e.envelope_type] ?? '\x1b[37m'
  const reset = '\x1b[0m'
  return `${reset}${time} ${color}${e.envelope_type.padEnd(9)}${reset} ${e.from} → ${e.to}${tag}${resp}: ${e.body ?? ''}`
}

async function watch(): Promise<void> {
  const cookie = await loginCookie()
  console.error(`Watching observer stream at ${WS_OBSERVER}... (Ctrl+C to stop)`)
  const ws = new WebSocket(WS_OBSERVER, {
    headers: { cookie },
    tls: { rejectUnauthorized: false },
  } as unknown as undefined)
  ws.addEventListener('open', () => {
    console.error('connected.')
  })
  ws.addEventListener('message', (ev) => {
    let frame: AnyFrame
    try {
      frame = JSON.parse(String(ev.data)) as AnyFrame
    } catch {
      return
    }
    if (JSON_MODE) {
      process.stdout.write(JSON.stringify(frame) + '\n')
      return
    }
    if (frame.type === 'envelope') {
      process.stdout.write(fmtEnvelope(frame as EnvelopeFrame) + '\n')
    } else if (frame.type === 'session-delta') {
      const d = frame as SessionDeltaFrame
      process.stdout.write(`[delta] ${d.session} rev=${d.revision} ${JSON.stringify(d.changes)}\n`)
    } else if (frame.type === 'sessions-snapshot') {
      const s = frame as SessionsSnapshotFrame
      process.stdout.write(`[snapshot] ${s.sessions.length} sessions\n`)
    }
  })
  ws.addEventListener('close', () => {
    console.error('disconnected.')
    process.exit(0)
  })
  ws.addEventListener('error', (e) => {
    console.error('error', e)
    process.exit(1)
  })
  process.on('SIGINT', () => {
    ws.close()
    process.exit(0)
  })
}

async function sessions(): Promise<void> {
  const cookie = await loginCookie()
  const res = await fetch(BASE + '/ccpl/sessions', { headers: { cookie } })
  if (!res.ok) die(`sessions failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as {
    sessions: Array<{
      name: string
      cwd: string
      cc_session_uuid: string | null
      online: boolean
    }>
  }
  if (JSON_MODE) {
    console.log(JSON.stringify(body.sessions, null, 2))
    return
  }
  if (body.sessions.length === 0) {
    console.log('No sessions registered.')
    return
  }
  for (const s of body.sessions) {
    const state = s.online ? 'live' : 'offline'
    console.log(`${s.name}\t${state}\t${s.cwd}`)
  }
}

async function send(): Promise<void> {
  const to = args[1]
  const message = args
    .slice(2)
    .filter((a) => !a.startsWith('--'))
    .join(' ')
  if (!to || !message) {
    die('Usage: cli.ts send <to> <message>')
  }
  const cookie = await loginCookie()
  const res = await fetch(BASE + '/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ to, message }),
  })
  if (!res.ok) die(`send failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { ok: boolean; id: string }
  if (JSON_MODE) {
    console.log(JSON.stringify(body))
  } else {
    console.log(`Sent to "${to}" (id: ${body.id})`)
  }
}

function help(): void {
  console.error(`Usage:
  bun dashboard/cli.ts watch [--json]     Tail observer stream
  bun dashboard/cli.ts sessions [--json]  List registered sessions
  bun dashboard/cli.ts send <to> <msg>    Send a message via the dashboard

Environment:
  PARTY_LINE_SWITCHBOARD_URL   Dashboard URL base (default https://localhost:3400)
  PARTY_LINE_DASHBOARD_PASSWORD  Required for all commands`)
}

async function main(): Promise<void> {
  switch (command) {
    case 'watch':
      await watch()
      return
    case 'sessions':
      await sessions()
      return
    case 'send':
      await send()
      return
    case 'help':
    case '--help':
    case '-h':
      help()
      return
    default:
      console.error(`Unknown command: ${command}`)
      help()
      process.exit(1)
  }
}

void main()
