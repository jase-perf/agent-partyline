#!/usr/bin/env bun
// ccpl — Party Line session manager + launcher.

import {
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
  renameSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

// Accept self-signed certs for localhost dashboards.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '0'

const RAW_URL = process.env.PARTY_LINE_SWITCHBOARD_URL || 'https://localhost:3400'
const SWITCHBOARD = RAW_URL.replace(/^wss?:\/\//, 'https://').replace(/\/ws\/.*$/, '')

function switchboardWssUrl(): string {
  return SWITCHBOARD.replace(/^https?:\/\//, 'wss://') + '/ws/session'
}

const CFG_DIR = join(homedir(), '.config', 'party-line')
const SESS_DIR = join(CFG_DIR, 'sessions')

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/

function tokenPath(name: string): string {
  return join(SESS_DIR, `${name}.token`)
}

function readToken(name: string): string | null {
  try {
    return readFileSync(tokenPath(name), 'utf8').trim()
  } catch {
    return null
  }
}

function writeToken(name: string, token: string): void {
  mkdirSync(SESS_DIR, { recursive: true, mode: 0o700 })
  chmodSync(SESS_DIR, 0o700)
  // Atomic write: write to a sibling tmp file with O_EXCL so a concurrent
  // writer can't overwrite ours mid-flight, then rename. POSIX rename(2) is
  // atomic on the same filesystem. Use a unique tmp name per call so two
  // concurrent invocations for the same name don't collide.
  const tmp = `${tokenPath(name)}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, token, { mode: 0o600, flag: 'wx' })
  renameSync(tmp, tokenPath(name))
}

function removeToken(name: string): void {
  try {
    unlinkSync(tokenPath(name))
  } catch {
    /* ignore */
  }
}

function die(msg: string, code = 1): never {
  console.error(msg)
  process.exit(code)
}

function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    die(
      `Invalid name '${name}'. Names must match ${NAME_RE.source} (start with alphanumeric, 1-63 chars, allows . _ -).`,
    )
  }
}

async function api(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const headers = new Headers(init.headers as HeadersInit | undefined)
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  if (token) headers.set('X-Party-Line-Token', token)
  return fetch(SWITCHBOARD + path, { ...init, headers })
}

function mcpConfigPath(): string | null {
  // Try <binDir>/../.mcp.json (dev layout) first.
  const binDir = dirname(fileURLToPath(import.meta.url))
  const dev = resolve(binDir, '..', '.mcp.json')
  if (existsSync(dev)) return dev
  return null
}

async function cmdNew(name: string, cwdOverride?: string): Promise<void> {
  validateName(name)
  const cwd = cwdOverride ? resolve(cwdOverride) : process.cwd()
  const res = await api('/ccpl/register', {
    method: 'POST',
    body: JSON.stringify({ name, cwd }),
  })
  if (res.status === 409) die(`Session '${name}' already exists. Run 'ccpl forget ${name}' first.`)
  if (!res.ok) die(`Register failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { token: string }
  writeToken(name, body.token)
  console.log(`Registered '${name}' at ${cwd}.`)
  console.log(`Token stored at ${tokenPath(name)} (chmod 600).`)
  console.log(`Run 'ccpl ${name}' to launch.`)
}

function jsonlPathForCwdUuid(cwd: string, uuid: string): string {
  // Claude Code encodes project cwds by replacing every non-[a-zA-Z0-9] char
  // with a hyphen — so "/home/claude/Claude_Main" becomes
  // "-home-claude-Claude-Main" (underscore IS replaced). Using just `/`→`-`
  // misses underscores, spaces, dots, etc. and yields "directory not found"
  // for perfectly valid sessions.
  const encoded = cwd.replace(/[^a-zA-Z0-9-]/g, '-')
  const direct = join(homedir(), '.claude', 'projects', encoded, `${uuid}.jsonl`)
  if (existsSync(direct)) return direct
  // Fallback: scan projects/ for any subdir containing <uuid>.jsonl. Handles
  // encoder drift (Claude Code tweaking their slug rules) without breaking us.
  const projectsRoot = join(homedir(), '.claude', 'projects')
  try {
    for (const d of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const candidate = join(projectsRoot, d.name, `${uuid}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    /* ignore */
  }
  return direct
}

function promptYn(q: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolvePromise) => {
    rl.question(q, (ans) => {
      rl.close()
      const a = ans.trim().toLowerCase()
      resolvePromise(a === '' || a === 'y' || a === 'yes')
    })
  })
}

async function cmdLaunch(name: string, extraArgs: string[] = []): Promise<void> {
  validateName(name)
  const token = readToken(name)
  if (!token) die(`No session named '${name}'. Use 'ccpl new ${name}' to create it.`)
  const res = await api(`/ccpl/session/${encodeURIComponent(name)}`, {}, token)
  if (res.status === 401) die(`Token rejected for '${name}'. Try 'ccpl rotate ${name}'.`)
  if (!res.ok) die(`Lookup failed: ${res.status} ${await res.text()}`)
  const row = (await res.json()) as { cwd: string; cc_session_uuid: string | null }

  try {
    process.chdir(row.cwd)
  } catch (err) {
    die(`Cannot chdir to ${row.cwd}: ${String(err)}`)
  }

  // Rename the current tmux window to the session name. Gate strictly on
  // TMUX (the socket path) AND TMUX_PANE — both are set together by tmux
  // and both get cleared by `sudo -i` / `su -`. The previous TERM=tmux*
  // fallback fired after sudo across users, sending the rename to whatever
  // tmux server matched the new UID's socket and clobbering an unrelated
  // pane. Targeting -t $TMUX_PANE makes the rename address-explicit so it
  // can never hit the wrong server even if TMUX leaks through.
  if (process.env.TMUX && process.env.TMUX_PANE) {
    try {
      spawn('tmux', ['rename-window', '-t', process.env.TMUX_PANE, name], {
        stdio: 'ignore',
      }).unref()
    } catch {
      /* ignore */
    }
  }

  let resumeUuid: string | null = null
  if (row.cc_session_uuid) {
    const jsonl = jsonlPathForCwdUuid(row.cwd, row.cc_session_uuid)
    if (existsSync(jsonl)) {
      resumeUuid = row.cc_session_uuid
    } else {
      const yes = await promptYn(
        `No resumable CC session for '${name}' (UUID ${row.cc_session_uuid} not found). Archive prior history and start fresh? [Y/n] `,
      )
      if (!yes) process.exit(0)
      const archRes = await api(
        `/ccpl/archive`,
        { method: 'POST', body: JSON.stringify({ name, reason: 'jsonl_missing' }) },
        token,
      )
      if (!archRes.ok) die(`Archive failed: ${archRes.status}`)
    }
  }

  const baseArgs = [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels',
    'server:party-line',
    '--name',
    name,
  ]
  const mcp = mcpConfigPath()
  if (mcp) {
    baseArgs.splice(1, 0, '--mcp-config', mcp)
  } else {
    console.warn('[ccpl] No .mcp.json found alongside the ccpl binary; --mcp-config flag omitted.')
  }
  if (resumeUuid) {
    baseArgs.push('--resume', resumeUuid)
  }
  if (extraArgs.length > 0) {
    baseArgs.push(...extraArgs)
  }

  const env = {
    ...process.env,
    PARTY_LINE_TOKEN: token,
    PARTY_LINE_SWITCHBOARD_URL: switchboardWssUrl(),
  }

  const child = spawn('claude', baseArgs, { stdio: 'inherit', env })
  child.on('exit', (code) => process.exit(code ?? 0))
}

async function loginCookie(): Promise<string | null> {
  const pw = process.env.PARTY_LINE_DASHBOARD_PASSWORD
  if (!pw) return null
  const res = await fetch(SWITCHBOARD + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  })
  if (!res.ok) return null
  const setCookie = res.headers.get('set-cookie') || ''
  const match = setCookie.match(/pl_dash=([^;]+)/)
  return match ? `pl_dash=${match[1]}` : null
}

async function cmdList(asJson: boolean): Promise<void> {
  const cookie = await loginCookie()
  if (!cookie) {
    die(
      'list requires PARTY_LINE_DASHBOARD_PASSWORD to be set (or an active browser session). Otherwise the dashboard will refuse access.',
    )
  }
  const res = await fetch(SWITCHBOARD + '/ccpl/sessions', {
    headers: { cookie },
  })
  if (!res.ok) die(`List failed: ${res.status} ${await res.text()}`)
  const { sessions } = (await res.json()) as {
    sessions: Array<{
      name: string
      cwd: string
      cc_session_uuid: string | null
      online: boolean
    }>
  }
  if (asJson) {
    console.log(JSON.stringify(sessions, null, 2))
    return
  }
  console.log('NAME'.padEnd(16) + 'STATE'.padEnd(10) + 'CWD'.padEnd(40) + 'CC_UUID')
  for (const s of sessions) {
    const state = s.online ? 'live' : 'offline'
    console.log(
      `${s.name.padEnd(16)}${state.padEnd(10)}${String(s.cwd).padEnd(40)}${s.cc_session_uuid || '-'}`,
    )
  }
}

async function cmdForget(name: string): Promise<void> {
  validateName(name)
  const token = readToken(name)
  if (!token) {
    removeToken(name)
    console.log(`(no local token for '${name}'; nothing to remove)`)
    return
  }
  const res = await api(`/ccpl/session/${encodeURIComponent(name)}`, { method: 'DELETE' }, token)
  if (!res.ok && res.status !== 401) {
    die(`Forget failed: ${res.status} ${await res.text()}`)
  }
  removeToken(name)
  console.log(`Forgot '${name}'.`)
}

async function cmdRotate(name: string): Promise<void> {
  validateName(name)
  const token = readToken(name)
  if (!token) die(`No token on disk for '${name}'.`)
  const res = await api(
    `/ccpl/session/${encodeURIComponent(name)}/rotate`,
    { method: 'POST' },
    token,
  )
  if (!res.ok) die(`Rotate failed: ${res.status} ${await res.text()}`)
  const { token: newToken } = (await res.json()) as { token: string }
  writeToken(name, newToken)
  console.log(`Rotated token for '${name}'.`)
}

function printHelp(): void {
  console.log(`Usage:
  ccpl new <name> [--cwd DIR]    Register a new session
  ccpl list [--json]             List all sessions (requires PARTY_LINE_DASHBOARD_PASSWORD)
  ccpl forget <name>             Delete a session and its token
  ccpl rotate <name>             Rotate the token for a session
  ccpl <name> [-- <claude args>] Launch Claude Code with this session.
                                 Args after '--' are passed through to claude
                                 verbatim (e.g. --model, --channels).

Environment:
  PARTY_LINE_SWITCHBOARD_URL     Base URL of the dashboard (default: https://localhost:3400)
  PARTY_LINE_DASHBOARD_PASSWORD  Password for 'list' command
  NODE_TLS_REJECT_UNAUTHORIZED   Defaults to '0' to accept self-signed certs`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  // Split at `--`: everything after is passthrough to claude on the launch
  // path. Subcommands (new/list/forget/rotate) don't accept passthrough and
  // ignore the split — they only consume their own flags.
  const ddIdx = argv.indexOf('--')
  const own = ddIdx >= 0 ? argv.slice(0, ddIdx) : argv
  const passthrough = ddIdx >= 0 ? argv.slice(ddIdx + 1) : []

  const [sub, ...rest] = own
  if (!sub || sub === '-h' || sub === '--help') {
    printHelp()
    process.exit(sub ? 0 : 1)
  }
  if (sub === 'new') {
    const name = rest[0]
    if (!name) die('Usage: ccpl new <name> [--cwd DIR]')
    const cwdIdx = rest.indexOf('--cwd')
    const cwd = cwdIdx >= 0 ? rest[cwdIdx + 1] : undefined
    await cmdNew(name, cwd)
    return
  }
  if (sub === 'list') {
    await cmdList(rest.includes('--json'))
    return
  }
  if (sub === 'forget') {
    const name = rest[0]
    if (!name) die('Usage: ccpl forget <name>')
    await cmdForget(name)
    return
  }
  if (sub === 'rotate') {
    const name = rest[0]
    if (!name) die('Usage: ccpl rotate <name>')
    await cmdRotate(name)
    return
  }
  // Launch path. Reject unexpected positional args before `--` to avoid
  // silently swallowing typos (e.g. `ccpl foo bar` shouldn't run as launch
  // with bar as some implicit flag).
  if (rest.length > 0) {
    die(`Unexpected args: ${rest.join(' ')}. Use 'ccpl <name> [-- <claude args>]'.`)
  }
  await cmdLaunch(sub, passthrough)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
