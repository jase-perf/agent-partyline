import { createNotifications } from './notifications.js'
import {
  loadDismissed,
  saveDismissed,
  pickLruEvictionVictim,
  filterStripSessions,
  shouldBumpUnread,
  TAB_DOM_LRU_CAP,
} from './tabs-state.js'
import {
  groupSequentialToolCalls,
  summarizeToolGroup,
  shouldExtendToolRun,
  TOOL_GROUP_MIN_RUN,
} from './transcript-grouping.js'

const busFeed = document.getElementById('busFeed')
const connStatus = document.getElementById('connStatus')
const showHeartbeats = document.getElementById('showHeartbeats')
const showAnnounce = document.getElementById('showAnnounce')
const autoscroll = document.getElementById('autoscroll')

let totalMessages = 0
let ws
let contextOverrides = {}
let lastSessions = []
let sessionsReady = false
let pendingRouteState = null // if set, applyRoute will re-fire once sessions arrive
var sessionRevisions = new Map() // name -> last applied revision (from /ws/observer session-delta stream)

// Service Worker registration promise. Used by notifications.js to call
// registration.showNotification(). Null if SW isn't supported (e.g. non-secure
// context on older browsers).
let swRegistration = null

if ('serviceWorker' in navigator) {
  // Register as a module so sw.js can `export` notificationRouteFromData for
  // unit tests. Chrome 80+, Safari 15.4+, Firefox 113+ all support this.
  swRegistration = navigator.serviceWorker
    .register('/sw.js', { scope: '/', type: 'module' })
    .then((reg) => reg)
    .catch((err) => {
      console.error('[sw] registration failed:', err)
      return null
    })
}
// --- Mobile soft-keyboard handling ---------------------------------------
// On iOS/iPadOS the on-screen keyboard scrolls the entire layout viewport
// upward to make the focused input visible. With a fixed-shell layout
// (overflow:hidden body), this leaves blank space at top + content cut off.
// Track the visible height via visualViewport, expose it as --vv-height
// (consumed by dashboard.css), and force-scroll the layout viewport back
// to (0,0) whenever iOS lets it drift. Browsers without visualViewport
// just keep the 100dvh fallback in CSS.
function applyVisualViewportHeight() {
  const vv = window.visualViewport
  if (!vv) return
  document.documentElement.style.setProperty('--vv-height', vv.height + 'px')
  if (window.scrollY !== 0 || window.scrollX !== 0) {
    window.scrollTo(0, 0)
  }
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', applyVisualViewportHeight)
  window.visualViewport.addEventListener('scroll', applyVisualViewportHeight)
  applyVisualViewportHeight()
}

// When the composer takes focus, ensure the latest transcript entry stays
// visible above the (now-rising) keyboard. Two RAFs to wait until both the
// keyboard animation and the visualViewport listener above have settled.
document.addEventListener('focusin', (e) => {
  const target = e.target
  if (!target || typeof target.closest !== 'function') return
  if (!target.closest('.detail-send')) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const stream = focusedStream()
      if (stream) stream.scrollTop = stream.scrollHeight
    })
  })
})

let sessionSources = {} // session name -> source string, populated from session-update events
let currentView = 'switchboard'
let localMachineId = null
let sessionMachines = {} // session name -> machine_id
let sessionActiveSubagents = {} // session name -> count of active subagents

// --- Tab registry ---

/**
 * @typedef {{
 *   name: string,                // ccpl session name (key) — '' for Switchboard home tab
 *   contentEl: HTMLElement | null, // mounted .session-tab-content clone, or null when evicted
 *   stripTab: HTMLElement | null,  // the strip button DOM, or null when not in strip
 *   streamKeys: Set<string>,
 *   lastRenderedUuid: string | null,
 *   scrollTop: number,
 *   agentId: string | null,
 *   archiveUuid: string | null,
 *   subagents: unknown[],
 *   lastViewedAt: number,
 *   online: boolean,
 *   evictionTimer: ReturnType<typeof setTimeout> | null,
 *   pendingAttachments: Array<{id: string|null, localId?: string, name: string, size: number, kind: string, media_type: string, url: string|null, objectUrl?: string, status: 'uploading'|'ready'|'error'}>,
 * }} Tab
 */

/** @type {Map<string, Tab>} keyed by session name. The Switchboard home tab uses '' as its key. */
const tabRegistry = new Map()

/** @type {Set<string>} */
let dismissedTabs = loadDismissed()

/** Currently focused tab name (may be '' for Switchboard). */
let focusedTabName = ''

function currentTab() {
  return tabRegistry.get(focusedTabName) || null
}

/**
 * Stream element of the currently focused session tab, or null on Switchboard / no clone.
 * @returns {HTMLElement | null}
 */
function focusedStream() {
  const tab = currentTab()
  if (!tab || tab.name === '' || !tab.contentEl) return null
  const el = scopedById(tab.contentEl, 'detail-stream')
  return el instanceof HTMLElement ? el : null
}

/** 5 minutes — how long an offline session stays in the strip before eviction. */
const OFFLINE_GRACE_MS = 5 * 60 * 1000

/** Maximum parallel prefetch fetches at dashboard load. */
const PREFETCH_PARALLELISM = 4

// --- localStorage UI state helpers ---

const UI_STATE_KEY = 'partyLine.ui.state'

function loadUiState() {
  try {
    return JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveUiState(state) {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify(state))
  } catch {}
}

function getLastViewedAt(sessionName) {
  const s = loadUiState()
  return (s.lastViewedAt && s.lastViewedAt[sessionName]) || 0
}

function markSessionViewed(sessionName) {
  const s = loadUiState()
  s.lastViewedAt = s.lastViewedAt || {}
  s.lastViewedAt[sessionName] = Date.now()
  saveUiState(s)
}

// --- Unread count state ---

let unreadCounts = {} // session_name -> integer
let seededOnce = false

function bumpUnread(sessionKey) {
  if (!sessionKey) return
  // Don't bump for the currently-focused tab — focusing already cleared it.
  if (sessionKey === focusedTabName) return
  unreadCounts[sessionKey] = (unreadCounts[sessionKey] || 0) + 1
  updateSessions(lastSessions)
  const tab = tabRegistry.get(sessionKey)
  if (tab) refreshUnreadPill(tab)
}

function resolveNameFromJsonlPath(path) {
  if (!path) return null
  const m = path.match(/\/([0-9a-f-]+)\.jsonl$/)
  if (!m) return null
  const sid = m[1]
  // Check metadata.status.sessionId first (populated after first session-update).
  // Fall back to cc_session_uuid from the snapshot so JSONL events that arrive
  // before the first session-update are not silently dropped.
  const found = lastSessions.find(
    (s) =>
      (s.metadata && s.metadata.status && s.metadata.status.sessionId === sid) ||
      s.cc_session_uuid === sid,
  )
  return found ? found.name : null
}

fetch('/api/self')
  .then((r) => r.json())
  .then((data) => {
    localMachineId = data.machine_id
  })
  .catch(() => {})
let currentSessionSubagents = []

// --- URL Router ---

function parseUrl() {
  const path = window.location.pathname
  // /session/<name>/archive/<uuid>  (must come BEFORE the /agent/ branch)
  let m = path.match(/^\/session\/([^/]+)\/archive\/([^/]+)\/?$/)
  if (m) {
    return {
      view: 'session-detail',
      sessionName: decodeURIComponent(m[1]),
      agentId: null,
      archiveUuid: decodeURIComponent(m[2]),
    }
  }
  // /session/<name>/agent/<id>
  m = path.match(/^\/session\/([^/]+)\/agent\/([^/]+)\/?$/)
  if (m) return { view: 'session-detail', sessionName: decodeURIComponent(m[1]), agentId: m[2] }
  // /session/<name>
  m = path.match(/^\/session\/([^/]+)\/?$/)
  if (m) return { view: 'session-detail', sessionName: decodeURIComponent(m[1]), agentId: null }
  // /history/<sub>
  m = path.match(/^\/history\/([^/]+)\/?$/)
  if (m) return { view: 'history', subtab: m[1] }
  // /history
  if (path === '/history' || path === '/history/') return { view: 'history', subtab: 'events' }
  // default
  return { view: 'switchboard' }
}

function urlForView(state) {
  if (!state) return '/'
  if (state.view === 'switchboard') return '/'
  if (state.view === 'history') {
    return state.subtab && state.subtab !== 'events' ? '/history/' + state.subtab : '/history'
  }
  if (state.view === 'session-detail') {
    const enc = encodeURIComponent(state.sessionName || '')
    if (state.archiveUuid)
      return '/session/' + enc + '/archive/' + encodeURIComponent(state.archiveUuid)
    return state.agentId
      ? '/session/' + enc + '/agent/' + encodeURIComponent(state.agentId)
      : '/session/' + enc
  }
  return '/'
}

function pushRoute(state) {
  const url = urlForView(state)
  if (window.location.pathname + window.location.search !== url) {
    window.history.pushState(state, '', url)
  }
}

function applyRoute(state, opts) {
  opts = opts || {}
  if (state.view === 'session-detail' && state.sessionName) {
    // Pin if not already in the strip; clear dismissal (URL beats dismissal).
    if (dismissedTabs.has(state.sessionName)) {
      dismissedTabs.delete(state.sessionName)
      saveDismissed(dismissedTabs)
    }
    if (!tabRegistry.has(state.sessionName)) {
      // Tab doesn't exist yet — pin it. The tab will reflect online state
      // when sessions-snapshot arrives (Task 9).
      pinTab(state.sessionName)
    }
    const tab = tabRegistry.get(state.sessionName)
    if (tab) {
      tab.agentId = state.agentId || null
      tab.archiveUuid = state.archiveUuid || null
    }
    focusTab(state.sessionName, { pushHistory: !opts.skipPush })
    return
  }
  if (state.view === 'history') {
    renderView('history')
    if (state.subtab) {
      const subBtn = document.querySelector(
        '#history-subtabs button[data-subtab="' + state.subtab + '"]',
      )
      if (subBtn instanceof HTMLElement) subBtn.click()
    }
    if (!opts.skipPush) pushRoute(state)
    return
  }
  // Default: switchboard
  focusTab('', { pushHistory: !opts.skipPush })
}

function navigate(state) {
  applyRoute(state, { skipPush: false })
}

// --- Tab router ---

function renderView(view) {
  currentView = view
  document.querySelectorAll('.view').forEach(function (el) {
    el.classList.remove('active')
    el.hidden = true
  })
  var active = document.querySelector('.view[data-view="' + view + '"]')
  if (active) {
    active.classList.add('active')
    active.hidden = false
  }
  // Run view-specific init
  if (view === 'history') loadHistoryView()
  if (view === 'session-detail' && focusedTabName) {
    markSessionViewed(focusedTabName)
    unreadCounts[focusedTabName] = 0
    updateSessions(lastSessions)
    loadSessionDetailView()
  }
}

// Legacy #tabs click handler removed — Task 3 replaced .tabs with the
// .tab-strip nav, and Task 8's strip click delegation handles tab focus,
// X close, and overflow menu navigation. Calling getElementById('tabs')
// after Task 3 returned null and the .addEventListener threw on init.

function esc(s) {
  const el = document.createElement('span')
  el.textContent = s
  return el.innerHTML
}

// Keepalive state for the current observer WebSocket.
// A zombie WS (TCP dropped, browser hasn't noticed) stays OPEN indefinitely:
// onclose never fires, visibilitychange sees OPEN, updates stop silently.
// Sending a ping every PING_INTERVAL_MS and expecting a pong within PONG_TIMEOUT_MS
// ensures we detect and close dead connections within ~35 seconds.
const PING_INTERVAL_MS = 25_000
const PONG_TIMEOUT_MS = 20_000
let wsGen = 0 // bumped on each new socket; stale handlers compare before acting
let reconnectTimer = null
let pingInterval = null
let pongTimer = null

function clearKeepalive() {
  if (pingInterval !== null) {
    clearInterval(pingInterval)
    pingInterval = null
  }
  if (pongTimer !== null) {
    clearTimeout(pongTimer)
    pongTimer = null
  }
}

function startKeepalive(socket, gen) {
  clearKeepalive()
  pingInterval = setInterval(() => {
    if (gen !== wsGen || socket.readyState !== WebSocket.OPEN) {
      clearKeepalive()
      return
    }
    try {
      socket.send(JSON.stringify({ type: 'ping' }))
    } catch {
      return
    }
    // If no pong arrives within PONG_TIMEOUT_MS, the connection is a zombie:
    // close it so onclose fires and schedules a fresh reconnect.
    pongTimer = setTimeout(() => {
      if (gen !== wsGen) return
      try {
        socket.close(1001, 'pong timeout')
      } catch {
        /* ignore */
      }
    }, PONG_TIMEOUT_MS)
  }, PING_INTERVAL_MS)
}

function connect() {
  // Cancel any pending auto-reconnect.
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  // Don't stack connections: if one is already opening or open, bail.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  clearKeepalive()
  const gen = ++wsGen
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(proto + '//' + location.host + '/ws/observer')
  ws = socket

  socket.onopen = function () {
    if (gen !== wsGen) return // superseded by a later connect()
    connStatus.textContent = 'connected'
    connStatus.style.color = '#3fb950'
    startKeepalive(socket, gen)
  }

  socket.onclose = function (e) {
    if (gen !== wsGen) return // stale socket — a newer one owns the session
    clearKeepalive()
    // Auth failure: only the explicit 4401 close code from the switchboard
    // indicates the dashboard cookie was rejected. Code 1006 means "abnormal
    // closure" and fires on every mobile background/screen-lock/network blip
    // — treating it as auth failure forced a re-login every time the user
    // came back to the tab on Android. Just reconnect on 1006; let the next
    // /ws/observer handshake decide whether the cookie is still valid (which
    // would close cleanly with 4401 if it isn't).
    if (e.code === 4401) {
      var nextPath = location.pathname + location.hash
      location.href = '/login?next=' + encodeURIComponent(nextPath)
      return
    }
    connStatus.textContent = 'reconnecting\u2026'
    connStatus.style.color = 'var(--yellow)'
    sessionsReady = false
    reconnectTimer = setTimeout(connect, 2000)
  }

  socket.onmessage = function (e) {
    if (gen !== wsGen) return // stale socket — drop its messages
    var data
    try {
      data = JSON.parse(e.data)
    } catch (err) {
      return
    }

    // While viewing an archive, drop live updates that target the same
    // session — the archive is a frozen snapshot and shouldn't move.
    var route = parseUrl()
    if (route.view === 'session-detail' && route.archiveUuid) {
      if (
        (data.type === 'envelope' &&
          (data.from === route.sessionName || data.to === route.sessionName)) ||
        (data.type === 'session-delta' && data.session === route.sessionName) ||
        (data.type === 'user-prompt' && data.data && data.data.session_name === route.sessionName)
      ) {
        return
      }
    }

    if (data.type === 'pong') {
      // Clear the pong timeout so the connection isn't force-closed.
      if (pongTimer !== null) {
        clearTimeout(pongTimer)
        pongTimer = null
      }
      return
    }

    if (data.type === 'sessions-snapshot') {
      handleSessionsSnapshot(data.sessions)
    } else if (data.type === 'session-delta') {
      applySessionDelta(data)
    } else if (data.type === 'session-removed') {
      handleSessionRemoved(data.session)
    } else if (data.type === 'envelope') {
      // Adapt switchboard wire shape (envelope_type) back to legacy shape (type)
      // so existing renderers keep working.
      var adapted = {
        id: data.id,
        ts: new Date(data.ts).toISOString(),
        from: data.from,
        to: data.to,
        type: data.envelope_type,
        body: data.body == null ? '' : data.body,
        callback_id: data.callback_id,
        response_to: data.response_to,
        attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
      }
      addMessage(adapted)
      addMessageToBus(adapted)
      try {
        notif.onPartyLineMessage(adapted)
      } catch (err) {
        console.error('[notifications] onPartyLineMessage threw', err)
      }
      // Fan the envelope into every tab whose session matches (focused or not).
      for (const tab of tabRegistry.values()) {
        if (tab.name === '') continue
        if (!tab.contentEl) continue
        if (adapted.from !== tab.name && adapted.to !== tab.name) continue
        const streamRoot = scopedById(tab.contentEl, 'detail-stream')
        if (streamRoot instanceof HTMLElement)
          appendEnvelopeToStreamForTab(adapted, tab, streamRoot)
      }
    } else if (data.type === 'permission-request') {
      const payload = data.data || data
      try {
        notif.onPermissionRequest(payload)
      } catch (err) {
        console.error('[notifications] onPermissionRequest threw', err)
      }
      for (const tab of tabRegistry.values()) {
        if (tab.name === '') continue
        if (!tab.contentEl) continue
        if (tab.name !== payload.session) continue
        const streamRoot = scopedById(tab.contentEl, 'detail-stream')
        if (streamRoot instanceof HTMLElement) renderPermissionCard(payload, streamRoot)
      }
    } else if (data.type === 'permission-resolved') {
      try {
        notif.onPermissionResolved(data.data || data)
      } catch (err) {
        console.error('[notifications] onPermissionResolved threw', err)
      }
      updatePermissionCardResolved(data.data || data)
    } else if (data.type === 'notification-dismiss') {
      try {
        notif.onNotificationDismiss(data)
      } catch (err) {
        console.error('[notifications] onNotificationDismiss threw', err)
      }
    } else if (data.type === 'quota') {
      updateQuota(data.data)
    } else if (data.type === 'overrides') {
      contextOverrides = data.data
      updateSessions(lastSessions)
    } else if (data.type === 'session-update') {
      handleSessionUpdate(data.data)
      try {
        notif.onSessionUpdate(data.data)
      } catch (err) {
        console.error('[notifications] onSessionUpdate threw', err)
      }
    } else if (data.type === 'jsonl') {
      handleJsonlEvent(data.data)
    } else if (data.type === 'hook-event') {
      handleHookEvent(data.data)
      maybeHandleCompactForCurrentView(data.data)
      // Unread counter: only bump for events that represent the agent
      // needing the user — finished a turn (Stop) or asking for input /
      // permission (Notification). Lifecycle (SessionEnd), per-tool events,
      // and inter-agent party-line envelopes deliberately do NOT count;
      // they were noisy enough to drown the badge under multi-agent
      // traffic. See shouldBumpUnread() in tabs-state.js for the
      // authoritative classifier.
      if (
        data.data &&
        data.data.session_name &&
        shouldBumpUnread({ kind: 'hook-event', hookEvent: data.data.hook_event })
      ) {
        bumpUnread(data.data.session_name)
      }
    } else if (data.type === 'stream-reset') {
      handleStreamReset(data.data)
    } else if (data.type === 'user-prompt') {
      handleUserPromptLive(data.data)
    } else if (data.type === 'api-error') {
      handleApiError(data.data)
    }
    // Old frame types (sessions, cross-call) are no longer emitted by /ws/observer.
    // Handlers kept as no-ops for any remaining bootstrap callers.
  }
}

function handleCrossCall(call) {
  if (currentView !== 'switchboard') return
  var overlay = document.getElementById('cross-call-overlay')
  if (!overlay) return
  var fromCard = document.querySelector('[data-session-id="' + CSS.escape(call.from) + '"]')
  var toCard = document.querySelector('[data-session-id="' + CSS.escape(call.to) + '"]')
  if (!fromCard || !toCard) return

  var oRect = overlay.getBoundingClientRect()
  var fRect = fromCard.getBoundingClientRect()
  var tRect = toCard.getBoundingClientRect()
  var fx = fRect.left + fRect.width / 2 - oRect.left
  var fy = fRect.top + fRect.height / 2 - oRect.top
  var tx = tRect.left + tRect.width / 2 - oRect.left
  var ty = tRect.top + tRect.height / 2 - oRect.top

  var colorClass = call.envelope_type
  var markerId =
    'arrow-' + (colorClass === 'message' ? 'blue' : colorClass === 'request' ? 'yellow' : 'green')
  var ns = 'http://www.w3.org/2000/svg'
  var line = document.createElementNS(ns, 'path')
  line.setAttribute('class', 'arrow ' + colorClass)
  line.setAttribute('d', 'M ' + fx + ',' + fy + ' L ' + tx + ',' + ty)
  line.setAttribute('marker-end', 'url(#' + markerId + ')')
  overlay.appendChild(line)

  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      line.classList.add('fade')
    })
  })
  setTimeout(function () {
    line.remove()
  }, 4500)
}

function formatUptime(ms) {
  if (!ms) return ''
  var s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  var m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  var h = Math.floor(m / 60)
  return h + 'h ' + (m % 60) + 'm'
}

function formatTokens(n) {
  if (!n) return '0'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  return Math.round(n / 1000) + 'k'
}

// 1M is the default context limit for all models — the session state
// doesn't reliably report whether a 1M or 200k window is in effect, and a
// user who's running 1M models gets misleading "85% full" readouts if we
// guess 200k. Users can override per-session from the ⋯ menu.
var DEFAULT_CONTEXT_LIMIT = 1000000

function getEffectiveContextLimit(name, _st) {
  if (contextOverrides[name] && contextOverrides[name].contextLimit) {
    return contextOverrides[name].contextLimit
  }
  return DEFAULT_CONTEXT_LIMIT
}

var CONTEXT_LIMIT_OPTIONS = [
  { label: '1M tokens', value: 1000000 },
  { label: '200k tokens', value: 200000 },
]

function setContextLimit(sessionName, value) {
  fetch('/api/overrides', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionName, contextLimit: value }),
  })
  contextOverrides[sessionName] = { contextLimit: value }
  if (typeof updateSessions === 'function') updateSessions(lastSessions)
  if (focusedTabName === sessionName && typeof renderDetailHeader === 'function') {
    for (var i = 0; i < lastSessions.length; i++) {
      if (lastSessions[i].name === sessionName) {
        renderDetailHeader(lastSessions[i])
        break
      }
    }
  }
}

function appendContextLimitItems(menu, sessionName) {
  var header = document.createElement('div')
  header.className = 'ctx-menu-header'
  header.textContent = 'Context window'
  menu.appendChild(header)
  var currentLimit = getEffectiveContextLimit(sessionName, null)
  CONTEXT_LIMIT_OPTIONS.forEach(function (opt) {
    var item = document.createElement('div')
    item.className = 'ctx-menu-item'
    item.textContent = opt.label
    if (currentLimit === opt.value) {
      var check = document.createElement('span')
      check.className = 'check'
      check.textContent = '\u2713'
      item.appendChild(check)
    }
    item.addEventListener('click', function (ev) {
      ev.stopPropagation()
      setContextLimit(sessionName, opt.value)
      document.getElementById('ctxMenu').classList.remove('visible')
    })
    menu.appendChild(item)
  })
}

function showContextMenu(e, sessionName /*, model */) {
  e.preventDefault()
  var menu = document.getElementById('ctxMenu')
  menu.textContent = ''
  appendContextLimitItems(menu, sessionName)
  menu.style.left = e.clientX + 'px'
  menu.style.top = e.clientY + 'px'
  menu.classList.add('visible')
}

// Close context menu on click elsewhere
document.addEventListener('click', function () {
  document.getElementById('ctxMenu').classList.remove('visible')
})

// --- Session actions: context menu + confirm-remove modal ---
// Reuses the #ctxMenu div with a distinct set of items. Triggered by
// right-click / long-press on session cards and the ⋯ button in the
// session-detail header. Dismissed on click-outside, Escape, and scroll.

function hideCtxMenu() {
  document.getElementById('ctxMenu').classList.remove('visible')
}

function showSessionActionsMenu(sessionName, x, y) {
  const menu = document.getElementById('ctxMenu')
  if (!menu) return
  menu.textContent = ''

  const items = [
    {
      label: 'Open',
      action: () => openSessionDetail(sessionName),
    },
    {
      label: 'Archive current conversation',
      action: () => archiveSessionAction(sessionName),
    },
    {
      label: 'Remove session…',
      danger: true,
      action: () => confirmRemoveSession(sessionName),
    },
  ]

  for (const spec of items) {
    const item = document.createElement('div')
    item.className = 'ctx-menu-item'
    if (spec.danger) item.classList.add('ctx-menu-item-danger')
    item.textContent = spec.label
    item.addEventListener('click', (ev) => {
      ev.stopPropagation()
      hideCtxMenu()
      try {
        spec.action()
      } catch (err) {
        console.error('[session-actions] item failed:', err)
      }
    })
    menu.appendChild(item)
  }

  // Context-window override sits alongside archive/remove. Claude Code's
  // session state doesn't report the active window size, so we default all
  // sessions to 1M and let the user override per session here.
  const separator = document.createElement('div')
  separator.className = 'ctx-menu-separator'
  menu.appendChild(separator)
  appendContextLimitItems(menu, sessionName)

  // Clamp to viewport so the menu never pops off-screen on mobile.
  menu.style.left = Math.max(0, x) + 'px'
  menu.style.top = Math.max(0, y) + 'px'
  menu.classList.add('visible')

  // Re-measure and nudge back on screen if needed (bounded by layout pass).
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let nx = r.left
    let ny = r.top
    if (r.right > vw) nx = Math.max(0, vw - r.width - 4)
    if (r.bottom > vh) ny = Math.max(0, vh - r.height - 4)
    menu.style.left = nx + 'px'
    menu.style.top = ny + 'px'
  })
}

async function archiveSessionAction(sessionName) {
  try {
    const res = await fetch('/api/session/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sessionName }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      console.warn('[session-actions] archive failed:', res.status, body)
      // nothing_to_archive is common (session never connected) — silent.
      if (body && body.error !== 'nothing_to_archive') {
        alert('Archive failed: ' + (body.error || res.status))
      }
    }
    // Success path: server broadcasts session-delta with cc_session_uuid=null
    // and the existing applySessionDelta handler updates the UI.
  } catch (err) {
    console.error('[session-actions] archive error:', err)
    alert('Archive failed: ' + (err.message || 'network error'))
  }
}

function confirmRemoveSession(sessionName) {
  const overlay = document.getElementById('confirmOverlay')
  const title = document.getElementById('confirmTitle')
  const bodyEl = document.getElementById('confirmBody')
  const okBtn = document.getElementById('confirmOk')
  const cancelBtn = document.getElementById('confirmCancel')
  if (!overlay || !okBtn || !cancelBtn || !bodyEl) {
    // Fallback to window.confirm if modal markup is missing.
    if (window.confirm('Remove session "' + sessionName + '"? This cannot be undone.')) {
      removeSessionAction(sessionName)
    }
    return
  }
  title.textContent = 'Remove session?'
  bodyEl.textContent = ''
  const p1 = document.createElement('p')
  p1.append('Permanently remove ')
  const strong = document.createElement('strong')
  strong.textContent = sessionName
  p1.appendChild(strong)
  p1.append('?')
  const p2 = document.createElement('p')
  p2.style.marginTop = '10px'
  p2.style.color = 'var(--text-dim)'
  p2.style.fontSize = '12px'
  p2.textContent =
    'The session row, its archived UUIDs, and the local token file will be deleted. An open WebSocket connection will be closed. This cannot be undone.'
  bodyEl.appendChild(p1)
  bodyEl.appendChild(p2)

  okBtn.textContent = 'Remove'
  okBtn.disabled = false

  function close() {
    overlay.classList.remove('visible')
    okBtn.removeEventListener('click', onOk)
    cancelBtn.removeEventListener('click', onCancel)
    overlay.removeEventListener('click', onOverlay)
    document.removeEventListener('keydown', onKey)
  }
  function onOverlay(ev) {
    if (ev.target === overlay) close()
  }
  function onKey(ev) {
    if (ev.key === 'Escape') close()
  }
  async function onOk() {
    okBtn.disabled = true
    okBtn.textContent = 'Removing…'
    try {
      await removeSessionAction(sessionName)
    } finally {
      close()
    }
  }
  function onCancel() {
    close()
  }

  okBtn.addEventListener('click', onOk)
  cancelBtn.addEventListener('click', onCancel)
  overlay.addEventListener('click', onOverlay)
  document.addEventListener('keydown', onKey)
  overlay.classList.add('visible')
  cancelBtn.focus()
}

async function removeSessionAction(sessionName) {
  try {
    const res = await fetch('/api/session/remove', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sessionName }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      alert('Remove failed: ' + (body.error || res.status))
      return
    }
    // Success: server broadcasts session-removed; handleSessionRemoved will
    // drop the card and route away from the detail view if needed.
  } catch (err) {
    console.error('[session-actions] remove error:', err)
    alert('Remove failed: ' + (err.message || 'network error'))
  }
}

function handleSessionRemoved(name) {
  if (!name) return
  // Drop from in-memory state so subsequent grid updates don't re-add a card.
  lastSessions = lastSessions.filter((s) => s.name !== name)
  sessionRevisions.delete(name)
  delete sessionSources[name]
  delete sessionMachines[name]
  delete sessionActiveSubagents[name]

  // Drop the card from the DOM immediately.
  const grid = document.getElementById('overview-grid')
  if (grid) {
    const card = grid.querySelector('[data-session-id="' + CSS.escape(name) + '"]')
    if (card) card.remove()
  }

  // If currently viewing this session's detail, bounce back to switchboard.
  if (currentView === 'session-detail' && focusedTabName === name) {
    navigate({ view: 'switchboard' })
  }
}

// Wire right-click + long-press on the Switchboard grid (delegated).
;(function wireCardContextMenu() {
  const grid = document.getElementById('overview-grid')
  if (!grid) return

  grid.addEventListener('contextmenu', (ev) => {
    const card = ev.target.closest('.session-card')
    if (!card) return
    ev.preventDefault()
    const name = card.dataset.sessionId
    if (!name) return
    showSessionActionsMenu(name, ev.clientX, ev.clientY)
  })

  // Long-press for touch devices. 500ms. Movement > 10px cancels.
  let pressTimer = null
  let pressStart = null
  let pressSuppressClick = false
  function cancelPress() {
    if (pressTimer) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
    pressStart = null
  }
  grid.addEventListener(
    'touchstart',
    (ev) => {
      if (ev.touches.length !== 1) {
        cancelPress()
        return
      }
      const card = ev.target.closest('.session-card')
      if (!card) return
      const t = ev.touches[0]
      pressStart = { x: t.clientX, y: t.clientY }
      pressTimer = setTimeout(() => {
        const name = card.dataset.sessionId
        if (name) {
          // Block the click that would otherwise open the session detail.
          pressSuppressClick = true
          showSessionActionsMenu(name, pressStart.x, pressStart.y)
        }
        pressTimer = null
      }, 500)
    },
    { passive: true },
  )
  grid.addEventListener(
    'touchmove',
    (ev) => {
      if (!pressStart || ev.touches.length !== 1) return
      const t = ev.touches[0]
      const dx = t.clientX - pressStart.x
      const dy = t.clientY - pressStart.y
      if (dx * dx + dy * dy > 100) cancelPress()
    },
    { passive: true },
  )
  grid.addEventListener('touchend', cancelPress)
  grid.addEventListener('touchcancel', cancelPress)

  // If long-press fired, suppress the synthetic click that follows touchend
  // so we don't immediately open the session detail behind the menu.
  grid.addEventListener(
    'click',
    (ev) => {
      if (pressSuppressClick) {
        ev.stopPropagation()
        ev.preventDefault()
        pressSuppressClick = false
      }
    },
    true,
  )

  // Close the menu on scroll (overview grid itself or window).
  window.addEventListener('scroll', hideCtxMenu, { passive: true, capture: true })
})()

// Close ctx-menu on Escape.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') hideCtxMenu()
})

// Session detail modal
function showSessionModal(s) {
  var st = s.metadata && s.metadata.status ? s.metadata.status : null
  document.getElementById('modalTitle').textContent = s.name

  // Meta tags
  var metaEl = document.getElementById('modalMeta')
  metaEl.textContent = ''
  if (st) {
    var tags = []
    if (st.state) tags.push(['state', st.state])
    if (st.model) {
      var display = st.model.replace('claude-', '').replace(/-(\d+)-(\d+)/, ' $1.$2')
      tags.push(['model', display])
    }
    if (st.gitBranch) tags.push(['branch', st.gitBranch])
    if (st.contextTokens !== null && st.contextTokens !== undefined) {
      var effLimit = getEffectiveContextLimit(s.name, st)
      var pct = Math.round((st.contextTokens / effLimit) * 100)
      tags.push([
        'context',
        formatTokens(st.contextTokens) + '/' + formatTokens(effLimit) + ' (' + pct + '%)',
      ])
    }
    if (st.messageCount) tags.push(['messages', st.messageCount])
    if (st.uptimeMs) tags.push(['uptime', formatUptime(st.uptimeMs)])
    if (st.cwd) tags.push(['cwd', st.cwd])

    tags.forEach(function (pair) {
      var span = document.createElement('span')
      var label = document.createElement('span')
      label.textContent = pair[0] + ': '
      var val = document.createElement('span')
      val.className = 'meta-tag'
      val.textContent = pair[1]
      span.appendChild(label)
      span.appendChild(val)
      metaEl.appendChild(span)
    })
  }

  // Body — last response text
  var bodyEl = document.getElementById('modalBody')
  bodyEl.textContent = st && st.lastText ? st.lastText : '(no response text available)'

  document.getElementById('modalOverlay').classList.add('visible')
}

document.getElementById('modalClose').addEventListener('click', function () {
  document.getElementById('modalOverlay').classList.remove('visible')
})
document.getElementById('modalOverlay').addEventListener('click', function (e) {
  if (e.target === this) this.classList.remove('visible')
})
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') document.getElementById('modalOverlay').classList.remove('visible')
})

function updateSessions(sessions) {
  lastSessions = sessions
  if (!seededOnce && lastSessions.length > 0) {
    seededOnce = true
    seedUnreadCounts() // fires once, async
  }
  updateOverviewGrid(sessions)

  if (!sessionsReady) {
    sessionsReady = true
    if (pendingRouteState) {
      const s = pendingRouteState
      pendingRouteState = null
      applyRoute(s, { skipPush: true })
    }
    // Prefetch on the first snapshot only — runs concurrently with whatever
    // view the user is focused on. Don't await; let it fill in the
    // background.
    void prefetchAllPinnedTabs()
  }
}

// --- /ws/observer session-delta handlers ---

function handleSessionsSnapshot(sessions) {
  // The observer snapshot has minimal data — adapt it to the lastSessions shape
  // the existing card renderers expect.
  var adapted = sessions.map(function (s) {
    return {
      name: s.name,
      lastSeen: Date.now(), // observer doesn't track heartbeats; assume live
      metadata: {
        status: {
          state: s.online ? 'idle' : 'ended',
          sessionId: s.cc_session_uuid,
        },
      },
    }
  })
  sessions.forEach(function (s) {
    const prior = sessionRevisions.has(s.name) ? sessionRevisions.get(s.name) : -1
    sessionRevisions.set(s.name, Math.max(prior, s.revision))
  })
  syncStripFromSessions(sessions)
  updateSessions(adapted)
}

function applySessionDelta(delta) {
  var prior = sessionRevisions.has(delta.session) ? sessionRevisions.get(delta.session) : -1
  if (delta.revision <= prior) return
  sessionRevisions.set(delta.session, delta.revision)

  var row = null
  for (var i = 0; i < lastSessions.length; i++) {
    if (lastSessions[i].name === delta.session) {
      row = lastSessions[i]
      break
    }
  }
  if (!row) {
    row = { name: delta.session, metadata: { status: {} } }
    lastSessions.push(row)
  }
  var md = (row.metadata = row.metadata || {})
  var status = (md.status = md.status || {})
  var c = delta.changes || {}
  var uuidRotated = false
  if ('online' in c) status.state = c.online ? 'idle' : 'ended'
  if ('cc_session_uuid' in c) {
    var prevUuid = status.sessionId || null
    status.sessionId = c.cc_session_uuid
    // A non-null → non-null change is a /clear-style rotation. null → id is a
    // first-connect and we don't want to force-reload on that.
    if (prevUuid && c.cc_session_uuid && prevUuid !== c.cc_session_uuid) {
      uuidRotated = true
    }
  }
  if ('state' in c) status.state = c.state
  if ('current_tool' in c) status.currentTool = c.current_tool
  if ('last_text' in c) status.lastText = c.last_text
  if ('context_tokens' in c) status.contextTokens = c.context_tokens

  updateOverviewGrid(lastSessions)
  const liveRow = lastSessions.find((s) => s.name === delta.session)
  if (liveRow) {
    // Derive the strip-compatible shape from the adapted lastSessions row.
    // online = any state except 'ended'; state comes from metadata.status.state.
    const stripSessions = lastSessions.map((s) => {
      const st = s.metadata && s.metadata.status && s.metadata.status.state
      return { name: s.name, online: st !== 'ended', state: st || undefined }
    })
    syncStripFromSessions(stripSessions)
  }
  if (currentView === 'session-detail' && focusedTabName === delta.session) {
    try {
      if (typeof renderDetailHeader === 'function') renderDetailHeader(row)
    } catch (err) {
      /* ignore */
    }
    // On a /clear rotation, the old JSONL is no longer the live conversation;
    // blow away the rendered transcript and re-fetch from the new UUID.
    if (uuidRotated && typeof renderStream === 'function') {
      lastRenderedUuid = null
      renderedEntryKeys = new Set()
      renderStream({ force: true })
    }
  }
}

function addMessage(msg) {
  totalMessages++
  var busMsgCount = document.getElementById('busMsgCount')
  if (busMsgCount) busMsgCount.textContent = totalMessages + ' messages'

  if (msg.type === 'heartbeat' && showHeartbeats && !showHeartbeats.checked) return
  if (msg.type === 'announce' && showAnnounce && !showAnnounce.checked) return

  var time = new Date(msg.ts).toLocaleTimeString()

  var el = document.createElement('div')
  el.className = 'msg'

  var timeSpan = document.createElement('span')
  timeSpan.className = 'time'
  timeSpan.textContent = time
  el.appendChild(timeSpan)

  el.appendChild(document.createTextNode(' '))

  var typeSpan = document.createElement('span')
  typeSpan.className = 'type type-' + msg.type
  typeSpan.textContent = msg.type
  el.appendChild(typeSpan)

  el.appendChild(document.createTextNode(' '))

  var routeSpan = document.createElement('span')
  routeSpan.className = 'route'
  routeSpan.textContent = msg.from + ' \u2192 ' + msg.to
  el.appendChild(routeSpan)

  if (msg.callback_id) {
    var cbTag = document.createElement('span')
    cbTag.className = 'tag'
    cbTag.textContent = ' [cb:' + msg.callback_id + ']'
    el.appendChild(cbTag)
  }

  if (msg.response_to) {
    var respTag = document.createElement('span')
    respTag.className = 'tag'
    respTag.textContent = ' [\u21a9' + msg.response_to + ']'
    el.appendChild(respTag)
  }

  el.appendChild(document.createTextNode(' '))

  var bodySpan = document.createElement('span')
  bodySpan.className = 'body' // Use textContent — body is untrusted
  bodySpan.textContent = msg.body
  el.appendChild(bodySpan)

  busFeed.appendChild(el)

  if (autoscroll && autoscroll.checked) {
    busFeed.scrollTop = busFeed.scrollHeight
  }
}

function doBusSend() {
  const to = document.getElementById('busSendTo').value.trim()
  const msg = document.getElementById('busSendMsg').value.trim()
  const type = document.getElementById('busSendType').value
  if (!to || !msg) return
  fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, message: msg, type }),
  }).catch(function (err) {
    console.error('[bus] send failed', err)
  })
  document.getElementById('busSendMsg').value = ''
}

function updateQuota(q) {
  const panel = document.getElementById('quotaPanel')
  if (!panel) return
  panel.hidden = false

  function setPip(pipId, pctId, util, resetTs, windowLabel) {
    const pip = document.getElementById(pipId)
    const label = document.getElementById(pctId)
    if (!pip || !label) return
    const pct = Math.round(util * 100)
    label.textContent = pct + '%'
    pip.classList.remove('ok', 'warn', 'crit')
    if (pct > 90) pip.classList.add('crit')
    else if (pct > 70) pip.classList.add('warn')
    else pip.classList.add('ok')
    pip.style.setProperty('--pct', Math.min(100, Math.max(0, pct)) + '%')
    if (resetTs) {
      const diffMin = Math.max(0, Math.round((resetTs * 1000 - Date.now()) / 60000))
      const h = Math.floor(diffMin / 60)
      const m = diffMin % 60
      let timeStr
      if (windowLabel === '7-day') {
        const d = Math.floor(h / 24)
        const hr = h % 24
        timeStr = d > 0 ? d + 'd ' + hr + 'h' : hr + 'h'
      } else {
        timeStr = h > 0 ? h + 'h ' + m + 'm' : m + 'm'
      }
      pip.title = windowLabel + ' window: ' + pct + '% — resets in ' + timeStr
    }
  }

  setPip('quota5hPip', 'quota5hPct', q.fiveHourUtilization, q.fiveHourReset, '5-hour')
  setPip('quota7dPip', 'quota7dPct', q.sevenDayUtilization, q.sevenDayReset, '7-day')
}

// Tap-to-show on the quota chips for mobile/touch — `title` only fires on
// desktop hover. Toggle a floating popover positioned under the tapped chip
// with the same text title would have shown. Tap elsewhere or the chip
// again to dismiss; auto-hide after 4s.
;(function wireQuotaPipTaps() {
  let activePip = null
  let hideTimer = null
  function ensurePopover() {
    let el = document.getElementById('quota-popover')
    if (el) return el
    el = document.createElement('div')
    el.id = 'quota-popover'
    el.className = 'quota-popover'
    el.hidden = true
    document.body.appendChild(el)
    return el
  }
  function hide() {
    const pop = document.getElementById('quota-popover')
    if (pop) pop.hidden = true
    activePip = null
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null
    const pip = t ? t.closest('.quota-pip') : null
    if (!pip) {
      // Tapped anywhere else — dismiss any open popover.
      hide()
      return
    }
    if (pip === activePip) {
      hide()
      return
    }
    const text = pip instanceof HTMLElement ? pip.title : ''
    if (!text) return
    const pop = ensurePopover()
    pop.textContent = text
    pop.hidden = false
    const rect = pip.getBoundingClientRect()
    // Position below + right-aligned to the pip; clamp into viewport.
    pop.style.top = rect.bottom + 6 + 'px'
    pop.style.left = Math.max(8, Math.min(rect.right - 220, window.innerWidth - 230)) + 'px'
    activePip = pip
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(hide, 4000)
  })
})()

// --- Sparkline ---

// Cache: sessionId -> { buckets: number[], ts: number }
var sparklineCache = {}

function renderSparkline(buckets) {
  if (!buckets || buckets.length === 0) return ''
  var max = Math.max(1, Math.max.apply(null, buckets))
  var w = 60,
    h = 14
  var step = w / buckets.length
  var points = buckets
    .map(function (v, i) {
      var x = i * step
      var y = h - (v / max) * h
      return x.toFixed(1) + ',' + y.toFixed(1)
    })
    .join(' ')
  return (
    '<svg class="sparkline" viewBox="0 0 ' +
    w +
    ' ' +
    h +
    '" width="' +
    w +
    '" height="' +
    h +
    '">' +
    '<polyline points="' +
    points +
    '" fill="none" stroke="currentColor" stroke-width="1"></polyline>' +
    '</svg>'
  )
}

function fetchAndRenderSparkline(sessionId, containerEl) {
  var now = Date.now()
  var cached = sparklineCache[sessionId]
  if (cached && now - cached.ts < 60000) {
    containerEl.innerHTML = renderSparkline(cached.buckets)
    return
  }
  fetch('/api/sparkline?session_id=' + encodeURIComponent(sessionId))
    .then(function (r) {
      return r.json()
    })
    .then(function (data) {
      sparklineCache[sessionId] = { buckets: data.buckets, ts: Date.now() }
      containerEl.innerHTML = renderSparkline(data.buckets)
    })
    .catch(function () {
      /* silently fail — sparkline is non-critical */
    })
}

// --- Overview grid: session cards ---

function sourceBadge(source) {
  var badge = document.createElement('span')
  if (!source || source === 'claude-code') {
    badge.className = 'src-badge src-cc'
    badge.title = 'Claude Code'
    badge.textContent = 'cc'
  } else if (source === 'gemini-cli') {
    badge.className = 'src-badge src-gemini'
    badge.title = 'Gemini CLI'
    badge.textContent = 'gem'
  } else {
    badge.className = 'src-badge'
    badge.title = source
    badge.textContent = source.slice(0, 3)
  }
  return badge
}

function hostBadge(name) {
  var mid = sessionMachines[name]
  if (!mid) return null
  if (localMachineId && mid === localMachineId) return null
  var badge = document.createElement('span')
  badge.className = 'host-badge'
  badge.title = 'Remote: ' + mid
  badge.textContent = mid.slice(0, 3)
  return badge
}

function unreadBadge(name) {
  var n = unreadCounts[name] || 0
  if (n === 0) return null
  var badge = document.createElement('span')
  badge.className = 'unread-badge'
  badge.textContent = n > 99 ? '\u2022' : String(n)
  return badge
}

async function seedUnreadCounts() {
  var state = loadUiState()
  var map = state.lastViewedAt || {}
  // Only these hook events count as "something to look at" — tool calls and
  // user prompts are noise at this level and would push counts into the
  // hundreds within minutes of a session being active.
  var UNREAD_HOOK_EVENTS = { Stop: 1, Notification: 1, SessionEnd: 1 }
  for (var i = 0; i < lastSessions.length; i++) {
    var s = lastSessions[i]
    var since = map[s.name] || 0
    try {
      var r = await fetch('/api/events?session_id=' + encodeURIComponent(s.name) + '&limit=500')
      var rows = await r.json()
      var count = 0
      for (var j = 0; j < rows.length; j++) {
        if (!UNREAD_HOOK_EVENTS[rows[j].hook_event]) continue
        var evTs = new Date(rows[j].ts).getTime()
        if (evTs > since) count++
      }
      unreadCounts[s.name] = count
    } catch (_) {}
  }
  updateSessions(lastSessions)
}

function stateClass(state) {
  if (state === 'working') return 'state-working'
  if (state === 'idle') return 'state-idle'
  if (state === 'errored') return 'state-errored'
  return 'state-ended'
}

function buildCardContents(s) {
  var st = s.metadata && s.metadata.status ? s.metadata.status : null
  var state = st && st.state ? st.state : 'ended'

  // Header — state pill carries the current tool when working, and
  // a short "idle 4m" duration otherwise, so "what's this session doing"
  // reads in one glance instead of scanning multiple lines.
  var header = document.createElement('div')
  header.className = 'card-header'

  var pill = document.createElement('span')
  pill.className = 'state-pill ' + stateClass(state)
  if (state === 'working' && st && st.currentTool) {
    var stateTxt = document.createElement('span')
    stateTxt.className = 'state-pill-state'
    stateTxt.textContent = 'working'
    pill.appendChild(stateTxt)
    var sep = document.createElement('span')
    sep.className = 'state-pill-sep'
    sep.textContent = '·'
    pill.appendChild(sep)
    var toolTxt = document.createElement('span')
    toolTxt.className = 'state-pill-tool'
    toolTxt.textContent = shortToolName(st.currentTool)
    toolTxt.title = st.currentTool
    pill.appendChild(toolTxt)
  } else if (state === 'idle' && st && st.lastActivity) {
    pill.textContent = 'idle ' + shortDuration(Date.now() - Date.parse(st.lastActivity))
  } else if (state === 'ended' && st && st.lastActivity) {
    pill.textContent = 'ended ' + shortDuration(Date.now() - Date.parse(st.lastActivity)) + ' ago'
  } else {
    pill.textContent = state
  }
  header.appendChild(pill)

  if (sessionSources[s.name]) header.appendChild(sourceBadge(sessionSources[s.name]))

  var hb = hostBadge(s.name)
  if (hb) header.appendChild(hb)

  var ub = unreadBadge(s.name)
  if (ub) header.appendChild(ub)

  var nameEl = document.createElement('span')
  nameEl.className = 'session-name'
  nameEl.textContent = s.name
  nameEl.title = s.name
  header.appendChild(nameEl)

  // Bell lives inside the header flex row (with margin-left:auto) so it
  // can't collide with long session names.
  var bell = buildBellButton(s.name)
  header.appendChild(bell)

  // Body
  var body = document.createElement('div')
  body.className = 'card-body'

  if (st && st.cwd) {
    var cwdEl = document.createElement('div')
    cwdEl.className = 'card-cwd'
    cwdEl.textContent = shortenPath(st.cwd)
    cwdEl.title = st.cwd
    body.appendChild(cwdEl)
  }

  if (st && st.lastText) {
    var lastEl = document.createElement('div')
    lastEl.className = 'card-last-text'
    lastEl.textContent = '\u201c' + st.lastText.slice(0, 80) + '\u201d'
    body.appendChild(lastEl)
  }

  var metaEl = document.createElement('div')
  metaEl.className = 'card-meta'

  if (st && st.model) {
    var modelSpan = document.createElement('span')
    modelSpan.className = 'model'
    modelSpan.textContent = st.model.replace(/^claude-/, '')
    metaEl.appendChild(modelSpan)
  }

  // Context-tokens now render as a thin progress bar (color shifts at 70%
  // and 90%). Only the percent shows inline; exact token counts live in
  // the tooltip so the bar itself is the glance-signal.
  var ctxBar = null
  if (st && st.contextTokens !== null && st.contextTokens !== undefined) {
    var effLimit = getEffectiveContextLimit(s.name, st)
    var pct = Math.round((st.contextTokens / effLimit) * 100)
    ctxBar = buildCtxBar(pct, {
      label: 'ctx',
      tokens: st.contextTokens,
      limit: effLimit,
    })
  }

  // Active subagents — broadcast-enriched by the aggregator (active_subagents
  // field on the session row). Show when > 0.
  var subs = sessionActiveSubagents[s.name] || 0
  if (subs > 0) {
    var subSpan = document.createElement('span')
    subSpan.className = 'card-subagents'
    subSpan.title = subs + ' active subagent' + (subs === 1 ? '' : 's')
    subSpan.textContent = '⎇ ' + subs
    metaEl.appendChild(subSpan)
  }

  body.appendChild(metaEl)
  if (ctxBar) body.appendChild(ctxBar)

  // Sparkline slot — populated async after card is in the DOM
  var sparklineSlot = document.createElement('div')
  sparklineSlot.className = 'card-sparkline'
  body.appendChild(sparklineSlot)

  // Bell is now part of the header; return null here to keep the old
  // { header, body, sparklineSlot, bell } shape for callers.
  return { header: header, body: body, sparklineSlot: sparklineSlot, bell: null }
}

// Build a labeled context progress bar with overlay text. opts.label is the
// short prefix (e.g. "ctx"). opts.tokens / opts.limit drive the tooltip and
// the displayed "Nk / Mk" suffix. The bar uses a translucent fill underlay
// with foreground text on top so the percentage stays readable across all
// fill states without resorting to mix-blend-mode.
function buildCtxBar(pct, opts) {
  opts = opts || {}
  var clamped = Math.min(100, Math.max(0, pct))
  var wrap = document.createElement('div')
  wrap.className = 'ctx-bar ' + (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok')
  wrap.style.setProperty('--pct', clamped + '%')
  var fill = document.createElement('div')
  fill.className = 'ctx-bar-fill'
  wrap.appendChild(fill)
  var text = document.createElement('span')
  text.className = 'ctx-bar-text'
  var inside = pct + '%'
  if (opts.tokens != null && opts.limit != null) {
    inside =
      (opts.label ? opts.label + ' ' : '') +
      formatTokens(opts.tokens) +
      ' / ' +
      formatTokens(opts.limit) +
      ' (' +
      pct +
      '%)'
    wrap.title =
      formatTokens(opts.tokens) + ' / ' + formatTokens(opts.limit) + ' tokens (' + pct + '%)'
  } else if (opts.label) {
    inside = opts.label + ' ' + pct + '%'
  }
  text.textContent = inside
  wrap.appendChild(text)
  return wrap
}

// Strip the "mcp__plugin_<server>__" prefix from tool names so long names
// like "mcp__plugin_discord_discord__reply" render as "discord: reply".
function shortToolName(name) {
  if (!name) return ''
  var m = name.match(/^mcp__(?:plugin_)?([^_]+)(?:_[^_]+)?__(.+)$/)
  if (m) return m[1] + ': ' + m[2]
  return name
}

// Human-readable short duration: 45s, 12m, 3h, 2d.
function shortDuration(ms) {
  if (!ms || ms < 0) return ''
  var s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  var m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  var h = Math.floor(m / 60)
  if (h < 48) return h + 'h'
  var d = Math.floor(h / 24)
  return d + 'd'
}

// Shorten an absolute path for compact card display:
//   /home/claude/projects/x  -> ~/projects/x
//   /home/claude/a/b/c/d/e   -> .../c/d/e  (deeper than 3 segments)
function shortenPath(p) {
  if (!p) return ''
  var home = '/home/claude'
  var out = p
  if (out === home) return '~'
  if (out.indexOf(home + '/') === 0) out = '~/' + out.slice(home.length + 1)
  var segs = out.split('/').filter(Boolean)
  var maxSegs = 3
  if (segs.length > maxSegs) return '.../' + segs.slice(-maxSegs).join('/')
  return out
}

function buildBellButton(sessionName) {
  var on = notif ? notif.isEnabled(sessionName) : false
  var permDenied = !notif || notif.getPermissionState() !== 'granted'
  var bell = document.createElement('button')
  bell.type = 'button'
  bell.className = 'notif-bell notif-bell-' + (on ? 'on' : 'off')
  if (permDenied) bell.classList.add('notif-bell-disabled')
  bell.dataset.session = sessionName
  bell.title = permDenied ? 'Enable notifications first' : 'Toggle notifications for ' + sessionName
  bell.setAttribute('aria-label', 'Notifications for ' + sessionName + ': ' + (on ? 'on' : 'off'))
  bell.textContent = on ? '🔔' : '🔕'
  return bell
}

function buildSessionCard(s) {
  var card = document.createElement('div')
  card.className = 'session-card'
  // Use session name as ID key (party-line sessions don't have DB IDs)
  card.dataset.sessionId = s.name

  var parts = buildCardContents(s)
  card.appendChild(parts.header)
  card.appendChild(parts.body)
  if (parts.bell) card.appendChild(parts.bell)

  // Fetch sparkline async — uses session name as session_id proxy for party-line sessions
  // For DB sessions (with status), use session_id if available
  var sparkId =
    s.metadata && s.metadata.status && s.metadata.status.sessionId
      ? s.metadata.status.sessionId
      : s.name
  fetchAndRenderSparkline(sparkId, parts.sparklineSlot)

  card.addEventListener('click', (e) => {
    if (e.target.closest('.notif-bell')) return
    openSessionFromSwitchboard(s.name)
  })

  return card
}

function updateOverviewGrid(sessions) {
  var grid = document.getElementById('overview-grid')
  if (!grid) return

  sessions.forEach(function (s) {
    if (s.name === 'dashboard') return
    var existing = grid.querySelector('[data-session-id="' + CSS.escape(s.name) + '"]')
    if (existing) {
      // Update in place
      existing.textContent = ''
      var parts = buildCardContents(s)
      existing.appendChild(parts.header)
      existing.appendChild(parts.body)
      if (parts.bell) existing.appendChild(parts.bell)
      // Re-attach sparkline (uses cache — won't re-fetch if within 60s)
      var sparkId =
        s.metadata && s.metadata.status && s.metadata.status.sessionId
          ? s.metadata.status.sessionId
          : s.name
      fetchAndRenderSparkline(sparkId, parts.sparklineSlot)
    } else {
      grid.appendChild(buildSessionCard(s))
    }
  })

  // Remove cards for sessions that are no longer present
  var sessionNames = sessions.map(function (s) {
    return s.name
  })
  grid.querySelectorAll('.session-card').forEach(function (card) {
    if (sessionNames.indexOf(card.dataset.sessionId) === -1) {
      card.remove()
    }
  })
}

// --- WebSocket event handlers for new message types ---

function handleSessionUpdate(session) {
  // Update the card in the overview grid if it exists
  // session here is an aggregated DB session with session_id, not the heartbeat session
  if (!session || !session.session_id) return

  // Record source for this session (keyed by name for card rendering)
  if (session.name && session.source) {
    sessionSources[session.name] = session.source
  }
  if (session.name && session.machine_id) {
    sessionMachines[session.name] = session.machine_id
  }
  if (session.name && typeof session.active_subagents === 'number') {
    sessionActiveSubagents[session.name] = session.active_subagents
  }

  // Patch overview-card state + metadata for this session name. session-delta
  // only carries online/offline; session-update is the only channel that
  // carries model / context_tokens / cwd / last_text from the aggregator, so
  // propagate all of them into the card's status object here.
  if (session.name) {
    for (let i = 0; i < lastSessions.length; i++) {
      if (lastSessions[i].name !== session.name) continue
      const md = (lastSessions[i].metadata = lastSessions[i].metadata || {})
      const status = (md.status = md.status || {})
      if (session.state) status.state = session.state
      if (session.session_id) status.sessionId = session.session_id
      if (session.cwd) status.cwd = session.cwd
      if (session.model) status.model = session.model
      if (typeof session.context_tokens === 'number') {
        status.contextTokens = session.context_tokens
      }
      if (typeof session.last_text === 'string' && session.last_text) {
        status.lastText = session.last_text
      }
      if (typeof session.last_seen === 'string') status.lastActivity = session.last_seen
      break
    }
    updateOverviewGrid(lastSessions)
  }

  // Live-patch the session detail view when the viewed session receives an update
  if (currentView === 'session-detail' && session && session.name === focusedTabName) {
    renderDetailHeader(session)
    fetch('/api/session?id=' + encodeURIComponent(focusedTabName))
      .then((r) => r.json())
      .then((data) => {
        currentSessionSubagents = data.subagents || []
        renderAgentTree()
      })
      .catch(() => {})
    // Also refresh the transcript incrementally — the session update often
    // accompanies new JSONL content (tool calls, responses, etc.).
    renderStream({ incremental: true })
  }
}

// Live-inject a user prompt into the session-detail transcript the moment
// the UserPromptSubmit hook fires, instead of waiting for JSONL poll +
// transcript refetch. The canonical JSONL entry, when it later arrives,
// dedupes against this pending entry via the 'user-text:' key (renderStream).
/**
 * @param {{ session_name?: string, [key: string]: unknown }} data
 * @param {HTMLElement | null} [rootOverride]
 */
function handleUserPromptLive(data, rootOverride) {
  if (!data || !data.session_name || typeof data.prompt !== 'string') return
  const entry = {
    uuid: 'pending:' + (data.session_id || '') + ':' + data.ts,
    ts: data.ts || new Date().toISOString(),
    type: 'user',
    text: data.prompt,
  }
  const textKey = 'user-text:' + data.prompt
  // Fan into every matching tab (focused or background).
  for (const tab of tabRegistry.values()) {
    if (tab.name === '') continue
    if (!tab.contentEl) continue
    if (data.session_name !== tab.name) continue
    // Dedup via per-tab streamKeys (both the text key and the uuid).
    if (tab.streamKeys.has(textKey) || tab.streamKeys.has(entry.uuid)) continue
    tab.streamKeys.add(textKey)
    tab.streamKeys.add(entry.uuid)
    const root = rootOverride || scopedById(tab.contentEl, 'detail-stream')
    if (!(root instanceof HTMLElement)) continue
    // Capture BEFORE the append — see appendEnvelopeToStreamForTab.
    const wasNearBottom = isNearBottom(root)
    appendEntryWithGrouping(root, entry)
    if (tab.name !== focusedTabName) {
      // Background tabs follow the tail unconditionally.
      root.scrollTop = root.scrollHeight
    } else if (wasNearBottom) {
      // Focused tab: only auto-scroll if user wasn't actively scrolled up.
      root.scrollTop = root.scrollHeight
    } else {
      updateScrollToBottomButton(1)
    }
  }
  // Also update the global focused-session path so renderedEntryKeys stays in
  // sync for the incremental dedup in renderStream (used when the JSONL fetch
  // later arrives with the same entry).
  if (data.session_name === focusedTabName) {
    renderedEntryKeys.add(textKey)
    renderedEntryKeys.add(entry.uuid)
  }
}

// Claude Code API errors (overloaded / rate-limit) don't fire a Stop hook —
// without this, sessions stay "working" forever. The backend classifies the
// JSONL record and emits an `api-error` frame; here we notify and bump unread
// the same way we treat a Stop.
function handleApiError(data) {
  if (!data || !data.session_name) return
  if (shouldBumpUnread({ kind: 'api-error' })) bumpUnread(data.session_name)
  try {
    notif.onApiError(data)
  } catch (err) {
    console.error('[notifications] onApiError threw', err)
  }
}

function handleJsonlEvent(update) {
  if (!update) return
  const sessionName = resolveNameFromJsonlPath(update.file_path)
  const sessionId = update.session_id
  // Fan into every matching tab (focused or background).
  for (const tab of tabRegistry.values()) {
    if (tab.name === '') continue
    if (!tab.contentEl) continue
    if (sessionName !== tab.name && sessionId !== tab.name) continue
    if (tab.name === focusedTabName) {
      // Focused tab: use the existing global renderStream path so its
      // incremental cursor (lastRenderedUuid, renderedEntryKeys) stays correct.
      const agentMatches = tab.agentId && sessionId === tab.agentId
      if (sessionName === focusedTabName || sessionId === focusedTabName || agentMatches) {
        renderStream({ incremental: true })
      }
    } else {
      // Background tab: incremental fetch into this tab's own stream root,
      // using the tab's own lastRenderedUuid to avoid re-fetching everything.
      void renderStreamForTab(tab)
    }
  }
}

/**
 * Handle a stream-reset notification — fired by the JSONL observer when a
 * session transcript file shrinks (compaction / file replacement).
 * If the affected file belongs to the currently-viewed session, force a full
 * transcript re-fetch so the client doesn't display stale or gap content.
 */
function handleStreamReset(data) {
  if (!focusedTabName) return
  if (!data || !data.file_path) return
  const sessionName = resolveNameFromJsonlPath(data.file_path)
  const sessionId = (data.file_path.match(/\/([0-9a-f-]+)\.jsonl$/) || [])[1]
  if (sessionName !== focusedTabName && sessionId !== focusedTabName) return
  renderStream({ force: true })
}

/**
 * Check if a SessionStart hook event with source='compact' matches the
 * currently-viewed session (by UUID or name). If so, force a full re-fetch
 * to recover after the JSONL was rewritten by compaction.
 *
 * Called from the hook-event WebSocket branch. Exported as a module-level
 * function so it can be unit-tested (or called directly from tests).
 */
function maybeHandleCompactForCurrentView(evPayload) {
  if (!evPayload) return
  if (evPayload.hook_event !== 'SessionStart') return
  const payload = evPayload.payload
  if (!payload || payload.source !== 'compact') return
  if (!focusedTabName) return

  // Match by session UUID or session name (whichever the event carries).
  const matchesId = evPayload.session_id && evPayload.session_id === focusedTabName
  const matchesName = evPayload.session_name && evPayload.session_name === focusedTabName
  if (!matchesId && !matchesName) return

  // Compaction rewrites the JSONL — our lastRenderedUuid is now stale.
  // Force a complete re-fetch so the stream reflects the new file.
  renderStream({ force: true })
}

/**
 * Per-tab variant for envelope live-injection. Uses the tab's own streamKeys
 * for dedup (not the global renderedEntryKeys) so background tabs stay live
 * without disturbing the focused tab's dedup state.
 *
 * @param {object} envelope
 * @param {Tab} tab
 * @param {HTMLElement} root
 */
function appendEnvelopeToStreamForTab(envelope, tab, root) {
  if (!envelope) return
  if (envelope.type === 'heartbeat' || envelope.type === 'announce') return
  const key = envelope.id
  if (tab.streamKeys.has(key)) return
  const isSent = envelope.from === tab.name
  const fromDashboardToSelf = envelope.from === 'dashboard' && envelope.to === tab.name
  let entry
  if (fromDashboardToSelf) {
    entry = {
      uuid: envelope.id,
      ts: envelope.ts,
      type: 'user',
      text: envelope.body,
      attachments: envelope.attachments,
    }
  } else {
    entry = {
      uuid: envelope.id,
      ts: envelope.ts,
      type: isSent ? 'party-line-send' : 'party-line-receive',
      envelope_id: envelope.id,
      other_session: isSent ? envelope.to : envelope.from,
      body: envelope.body,
      callback_id: envelope.callback_id || undefined,
      envelope_type: envelope.type,
      attachments: envelope.attachments,
    }
  }
  // Capture scroll state BEFORE the append — appending grows scrollHeight
  // so an after-append isNearBottom check would think the user just
  // scrolled up by the height of the new entry.
  const wasNearBottom = isNearBottom(root)
  tab.streamKeys.add(key)
  appendEntryWithGrouping(root, entry)
  if (tab.name !== focusedTabName) {
    // Background tabs always follow the tail — when the user switches
    // back, the latest is what they see. The "scrolled up reading"
    // pause is a focused-tab-only concern.
    root.scrollTop = root.scrollHeight
  } else if (fromDashboardToSelf || isSent || wasNearBottom) {
    // Focused tab: scroll if self-sent OR user was already near bottom
    // before this entry landed. Don't fight a user who's actively
    // scrolled up reading history.
    root.scrollTop = root.scrollHeight
    missedWhileScrolledUp = 0
  } else {
    updateScrollToBottomButton(1)
  }
  // Mirror into the global renderedEntryKeys so the focused-tab dedup
  // path in renderStream doesn't re-append the same envelope on next fetch.
  if (tab.name === focusedTabName) renderedEntryKeys.add(key)
}

/**
 * Incremental transcript fetch for a background tab. Uses the tab's own
 * lastRenderedUuid cursor and streamKeys dedup set, completely independent
 * of the global renderStream state machine. Called by handleJsonlEvent for
 * every tab that is not currently focused.
 *
 * @param {Tab} tab
 */
async function renderStreamForTab(tab) {
  if (!tab.contentEl) return
  const root = scopedById(tab.contentEl, 'detail-stream')
  if (!(root instanceof HTMLElement)) return
  const sessionKey = tab.name
  let qs = 'session_id=' + encodeURIComponent(sessionKey) + '&limit=300'
  if (tab.lastRenderedUuid) {
    qs += '&after_uuid=' + encodeURIComponent(tab.lastRenderedUuid)
  }
  let entries
  try {
    const r = await fetch('/api/transcript?' + qs)
    entries = await r.json()
  } catch {
    return
  }
  if (!Array.isArray(entries) || entries.length === 0) return
  // Guard: tab may have been evicted or navigated away while fetch was in flight.
  if (!tab.contentEl) return
  for (const e of entries) {
    const key = e.uuid || e.ts + '|' + e.type + '|' + (e.envelope_id || '')
    const textKey = e.type === 'user' && e.text ? 'user-text:' + e.text : null
    if (tab.streamKeys.has(key)) continue
    if (textKey && tab.streamKeys.has(textKey)) continue
    tab.streamKeys.add(key)
    if (textKey) tab.streamKeys.add(textKey)
    if (e.uuid) tab.lastRenderedUuid = e.uuid
    appendEntryWithGrouping(root, e)
  }
  // Snap to bottom after the initial fetch (background tabs always; the
  // focused tab also wants the latest at first paint).
  root.scrollTop = root.scrollHeight
  if (tab.name === focusedTabName) {
    missedWhileScrolledUp = 0
    updateScrollToBottomButton(0)
  }
}

// --- Session detail view ---

function hookClass(hookEvent) {
  if (!hookEvent) return 'hook-default'
  if (hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse') return 'hook-PreToolUse'
  if (hookEvent === 'Stop') return 'hook-Stop'
  if (hookEvent === 'SubagentStart' || hookEvent === 'SubagentStop') return 'hook-SubagentStart'
  if (hookEvent === 'Notification') return 'hook-Notification'
  return 'hook-default'
}

function makeEmptyLi(text) {
  var li = document.createElement('li')
  li.className = 'empty-msg'
  li.textContent = text
  return li
}

function buildTimelineItem(ev) {
  var li = document.createElement('li')
  li.className = 'timeline-event'

  var ts = document.createElement('span')
  ts.className = 'ts'
  ts.textContent = ev.ts ? new Date(ev.ts).toLocaleTimeString() : ''
  li.appendChild(ts)

  var hook = document.createElement('span')
  hook.className = 'hook ' + hookClass(ev.hook_event)
  hook.textContent = ev.hook_event || 'event'
  li.appendChild(hook)

  var detail = document.createElement('span')
  detail.className = 'detail'
  var detailText = ''
  if (ev.tool_name) {
    detailText = 'tool: ' + ev.tool_name
  } else if (ev.payload) {
    try {
      var p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload
      if (p.tool_name) detailText = 'tool: ' + p.tool_name
      else if (p.message) detailText = String(p.message).slice(0, 80)
    } catch (e2) {
      detailText = ''
    }
  }
  detail.textContent = detailText
  li.appendChild(detail)

  if (ev.payload) {
    var det = document.createElement('details')
    det.className = 'payload'
    var sum = document.createElement('summary')
    sum.textContent = 'payload'
    det.appendChild(sum)
    var pre = document.createElement('pre')
    var payloadStr =
      typeof ev.payload === 'string' ? ev.payload : JSON.stringify(ev.payload, null, 2)
    pre.textContent = payloadStr
    det.appendChild(pre)
    li.appendChild(det)
  }

  return li
}

function buildSubagentItem(sub) {
  var li = document.createElement('li')
  li.className = 'subagent'

  var statusEl = document.createElement('span')
  var subState = sub.state || 'running'
  statusEl.className = 'status status-' + subState
  statusEl.textContent = subState
  li.appendChild(statusEl)

  var typeEl = document.createElement('span')
  typeEl.className = 'agent-type'
  typeEl.textContent = sub.agent_type || 'Agent'
  li.appendChild(typeEl)

  var descEl = document.createElement('span')
  descEl.className = 'agent-desc'
  descEl.textContent = sub.description || sub.task_description || ''
  li.appendChild(descEl)

  var durEl = document.createElement('span')
  durEl.className = 'agent-dur'
  durEl.textContent = sub.started_at
    ? 'started ' + new Date(sub.started_at).toLocaleTimeString()
    : ''
  li.appendChild(durEl)

  return li
}

function populateDetailHeader(session) {
  var stateEl = document.getElementById('detail-state')
  var nameEl = document.getElementById('detail-name')
  var cwdEl = document.getElementById('detail-cwd')
  var modelEl = document.getElementById('detail-model')
  var ctxEl = document.getElementById('detail-ctx')
  if (!stateEl) return

  if (!session) {
    stateEl.textContent = ''
    stateEl.className = 'state-pill'
    if (nameEl) nameEl.textContent = focusedTabName || ''
    if (cwdEl) cwdEl.textContent = ''
    if (modelEl) modelEl.textContent = ''
    if (ctxEl) ctxEl.textContent = ''
    return
  }

  var state = session.state || 'ended'
  stateEl.textContent = state
  stateEl.className = 'state-pill ' + stateClass(state)
  if (nameEl) nameEl.textContent = session.session_name || session.session_id || ''
  if (cwdEl) cwdEl.textContent = session.cwd ? 'cwd: ' + session.cwd : ''
  if (modelEl) {
    modelEl.textContent = session.model
      ? 'model: ' + session.model.replace('claude-', '').replace(/-(\d+)-(\d+)/, ' $1.$2')
      : ''
  }
  if (ctxEl) {
    ctxEl.textContent =
      session.context_tokens !== null && session.context_tokens !== undefined
        ? 'ctx: ' + formatTokens(session.context_tokens)
        : ''
  }
}

function updateDetailHeader(session) {
  if (!session || !focusedTabName) return
  var sessionKey = session.session_id || session.session_name
  if (sessionKey !== focusedTabName) return
  populateDetailHeader(session)
}

function prependTimelineEvent(event) {
  var timeline = document.getElementById('detail-timeline')
  if (!timeline) return
  var emptyMsg = timeline.querySelector('.empty-msg')
  if (emptyMsg) emptyMsg.remove()
  timeline.insertBefore(buildTimelineItem(event), timeline.firstChild)
}

function openSessionDetail(sessionName) {
  navigate({ view: 'session-detail', sessionName, agentId: null })
}

/**
 * Pin (idempotent), clear dismissal, and focus a session — the entry
 * path used when the user clicks a session card on the Switchboard view.
 *
 * @param {string} name
 */
function openSessionFromSwitchboard(name) {
  if (dismissedTabs.has(name)) {
    dismissedTabs.delete(name)
    saveDismissed(dismissedTabs)
  }
  pinTab(name)
  focusTab(name, { pushHistory: true })
}

/**
 * Scope-aware element lookup. For `document`, uses getElementById.
 * For an HTMLElement (per-tab clone), tries `#id` first then falls back
 * to `[data-orig-id="id"]` — pinTab strips IDs from clones and stashes
 * them in data-orig-id to avoid duplicate-id collisions across tabs.
 *
 * @param {Document | HTMLElement} scope
 * @param {string} id
 * @returns {HTMLElement | null}
 */
function scopedById(scope, id) {
  if (scope === document) return document.getElementById(id)
  const root = /** @type {HTMLElement} */ (scope)
  const direct = root.querySelector('#' + CSS.escape(id))
  if (direct instanceof HTMLElement) return direct
  const orig = root.querySelector('[data-orig-id="' + CSS.escape(id) + '"]')
  return orig instanceof HTMLElement ? orig : null
}

/**
 * @param {{
 *   sessionKey?: string,
 *   agentId?: string | null,
 *   archiveUuid?: string | null,
 *   contentRoot?: HTMLElement,
 * }} [opts]
 */
async function loadSessionDetailView(opts) {
  opts = opts || {}
  const sessionKey = opts.sessionKey ?? focusedTabName
  if (!sessionKey) return
  const agentId = opts.agentId ?? tabRegistry.get(focusedTabName)?.agentId ?? null
  const archiveUuid = opts.archiveUuid ?? null
  /** @type {Document | HTMLElement} */
  const root = opts.contentRoot || document

  const nameEl = scopedById(root, 'detail-name')
  if (nameEl) nameEl.textContent = sessionKey
  updateDetailBell(sessionKey)
  // Reflect archive mode in the URL even before fetches complete.
  setArchiveMode(sessionKey, archiveUuid)

  // Wipe the previous session's content synchronously, before any awaits.
  // On slow networks the /api/session and /api/transcript fetches can take
  // several seconds; without an upfront reset the user sees the previous
  // session's transcript and sidebar agents under the new session's header.
  resetDetailViewForSwitch(root)

  const isIsolated = !!opts.contentRoot
  const tab = isIsolated ? tabRegistry.get(sessionKey) : null
  try {
    const r = await fetch('/api/session?id=' + encodeURIComponent(sessionKey))
    const data = await r.json()
    // The user may have navigated to a different session by the time this
    // resolves — drop the response if the selection has moved on.
    if (!isIsolated && focusedTabName !== sessionKey) return
    const subs = data.subagents || []
    if (tab) tab.subagents = subs
    if (!isIsolated || focusedTabName === sessionKey) currentSessionSubagents = subs
    if (data.session) renderDetailHeader(data.session, root)
    renderAgentTree(root)
  } catch (e) {
    console.warn('session fetch failed', e)
  }

  if (!isIsolated && focusedTabName !== sessionKey) return
  renderHistorySidebar(sessionKey, archiveUuid, root)

  // agentId is set by the router before loadSessionDetailView is called;
  // do not reset it here so deep-linked agent views are honoured.
  if (tab) {
    // Per-tab path: use the tab-local renderer so concurrent prefetches
    // don't trample the global renderedStreamKey/renderedEntryKeys/
    // lastRenderedUuid cursor that renderStream relies on. tab.streamKeys
    // + tab.lastRenderedUuid keep each tab independent.
    await renderStreamForTab(tab)
  } else {
    await renderStream({
      root: scopedById(root, 'detail-stream'),
      sessionKey,
      agentId,
      archiveUuid,
    })
  }
}

/**
 * Synchronously wipe the session-detail view's stale content + show the
 * loading state. Called at the start of loadSessionDetailView so the user
 * never sees the prior session's transcript / sidebar / header data while
 * the new session's fetches are in flight.
 * @param {Document | HTMLElement} [scope]
 */
function resetDetailViewForSwitch(scope) {
  scope = scope || document
  const stream = scopedById(scope, 'detail-stream')
  if (stream) {
    stream.replaceChildren()
    const loading = document.createElement('p')
    loading.style.color = 'var(--text-dim)'
    loading.textContent = 'Loading…'
    stream.appendChild(loading)
  }
  // Reset renderStream's dedup cursor so its incremental path doesn't
  // believe the new session's first entries are duplicates.
  renderedEntryKeys = new Set()
  renderedStreamKey = null
  lastRenderedUuid = null

  // Sidebar agent tree — currentSessionSubagents holds the prior session's
  // rows until /api/session resolves.
  currentSessionSubagents = []
  renderAgentTree(scope)

  // Sidebar history rows — renderHistorySidebar will repopulate them once
  // /api/archives resolves.
  const hist = scopedById(scope, 'detail-history')
  if (hist) hist.replaceChildren()

  // Header data fields except the name (set by the caller above).
  const stateEl = scopedById(scope, 'detail-state')
  if (stateEl) {
    stateEl.textContent = ''
    stateEl.className = 'state-pill'
  }
  for (const id of [
    'detail-cwd',
    'detail-model',
    'detail-host',
    'detail-subagents',
    'detail-last',
    'detail-ctx',
  ]) {
    const el = scopedById(scope, id)
    if (el) el.textContent = ''
  }
}

/**
 * @param {{name?: string, state?: string, cwd?: string, model?: string,
 *   context_tokens?: number | null, machine_id?: string,
 *   active_subagents?: number, last_text?: string}} session
 * @param {Document | HTMLElement} [scope]
 */
function renderDetailHeader(session, scope) {
  scope = scope || document
  const pill = scopedById(scope, 'detail-state')
  if (!pill) return
  pill.className = 'state-pill state-' + (session.state || 'idle')
  pill.textContent = (session.state || 'idle').toUpperCase()
  const cwdEl = scopedById(scope, 'detail-cwd')
  if (cwdEl) cwdEl.textContent = session.cwd || ''

  // Fall back to multicast status for ctx/model since the aggregator's
  // sessions table doesn't capture those from hook payloads.
  const name = session.name || focusedTabName
  const multicast = (lastSessions || []).find((x) => x.name === name)
  const st = multicast && multicast.metadata && multicast.metadata.status

  const model = session.model || (st && st.model)
  const modelEl = scopedById(scope, 'detail-model')
  if (modelEl) modelEl.textContent = model ? model.replace('claude-', '') : ''

  const ctxTokens = (st && st.contextTokens) || session.context_tokens
  const ctxEl = scopedById(scope, 'detail-ctx')
  if (ctxEl) {
    if (ctxTokens) {
      const limit = getEffectiveContextLimit(name, st)
      const pct = Math.round((ctxTokens / limit) * 100)
      ctxEl.textContent = ''
      ctxEl.appendChild(buildCtxBar(pct, { label: 'ctx', tokens: ctxTokens, limit }))
    } else {
      ctxEl.textContent = ''
    }
  }

  const hostEl = scopedById(scope, 'detail-host')
  if (hostEl) {
    if (session.machine_id && localMachineId && session.machine_id !== localMachineId) {
      hostEl.textContent = 'host: ' + session.machine_id.slice(0, 8)
    } else {
      hostEl.textContent = ''
    }
  }

  // Active subagents for this session (the aggregator enriches session-update
  // with active_subagents; fall back to the cached per-name count).
  const subEl = scopedById(scope, 'detail-subagents')
  if (subEl) {
    const n =
      typeof session.active_subagents === 'number'
        ? session.active_subagents
        : sessionActiveSubagents[name] || 0
    subEl.textContent = n > 0 ? '⎇ ' + n + ' subagent' + (n === 1 ? '' : 's') : ''
  }

  // Last message / tool excerpt — what is the session actually doing right now?
  const lastEl = scopedById(scope, 'detail-last')
  if (lastEl) {
    let snippet = ''
    if (session.state === 'working' && st && st.currentTool) {
      snippet = 'running ' + shortToolName(st.currentTool)
    } else {
      const txt = session.last_text || (st && st.lastText) || ''
      if (txt) snippet = '“' + txt.slice(0, 90) + (txt.length > 90 ? '…' : '') + '”'
    }
    lastEl.textContent = snippet
    lastEl.title = snippet
  }

  updateDetailBell(session.name || focusedTabName)
}

function updateDetailBell(sessionName) {
  const bell = document.getElementById('detail-bell')
  if (!bell || !sessionName) return
  const permDenied = notif.getPermissionState() !== 'granted'
  const on = notif.isEnabled(sessionName)
  bell.hidden = false
  bell.classList.toggle('notif-bell-on', on)
  bell.classList.toggle('notif-bell-off', !on)
  bell.classList.toggle('notif-bell-disabled', permDenied)
  bell.textContent = on ? '🔔' : '🔕'
  bell.setAttribute('aria-label', 'Notifications for ' + sessionName + ': ' + (on ? 'on' : 'off'))
  bell.setAttribute('data-session', sessionName)
  bell.disabled = permDenied
}

/**
 * @param {Document | HTMLElement} [scope]
 */
function renderAgentTree(scope) {
  scope = scope || document
  const ul = scopedById(scope, 'detail-tree')
  if (!ul) return
  ul.replaceChildren()

  // 'main' row — always visible at top
  const currentAgentId = tabRegistry.get(focusedTabName)?.agentId ?? null
  const mainLi = document.createElement('li')
  mainLi.dataset.agentId = ''
  mainLi.textContent = '▸ main'
  if (!currentAgentId) mainLi.classList.add('active')
  mainLi.addEventListener('click', () => {
    navigate({ view: 'session-detail', sessionName: focusedTabName, agentId: null })
    const sidebar = document.getElementById('detail-sidebar')
    if (sidebar) sidebar.classList.remove('open')
  })
  ul.appendChild(mainLi)

  // Partition subagents into running vs completed
  const running = []
  const completed = []
  for (const sa of currentSessionSubagents) {
    const status = sa.status || 'running'
    if (status === 'running') running.push(sa)
    else completed.push(sa)
  }

  // Sort most-recent-first for both (by started_at descending)
  running.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))
  completed.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))

  // Running — individual rows
  for (const sa of running) {
    ul.appendChild(buildAgentLi(sa))
  }

  // Completed — collapsed under a details/summary group
  if (completed.length > 0) {
    const groupLi = document.createElement('li')
    groupLi.className = 'agent-group'
    groupLi.style.paddingLeft = '0'
    const details = document.createElement('details')
    // Auto-open when the selected subagent is inside the completed group
    if (currentAgentId && completed.some((sa) => sa.agent_id === currentAgentId)) {
      details.open = true
    }
    const summary = document.createElement('summary')
    const cancelledCount = completed.filter((sa) => sa.status === 'cancelled').length
    summary.textContent =
      cancelledCount > 0
        ? 'Past (' + completed.length + ', ' + cancelledCount + ' cancelled)'
        : 'Past (' + completed.length + ')'
    details.appendChild(summary)
    const subUl = document.createElement('ul')
    subUl.className = 'agent-group-list'
    for (const sa of completed) {
      subUl.appendChild(buildAgentLi(sa))
    }
    details.appendChild(subUl)
    groupLi.appendChild(details)
    ul.appendChild(groupLi)
  }
}

function buildAgentLi(sa) {
  const li = document.createElement('li')
  li.dataset.agentId = sa.agent_id
  const status = sa.status || 'running'
  const label = sa.agent_type || sa.agent_id.slice(0, 6)
  const desc = sa.description ? ' — ' + sa.description.slice(0, 50) : ''
  const labelNode = document.createTextNode('└ ' + label + desc + ' ')
  const dot = document.createElement('span')
  dot.className = 'dot ' + status
  li.appendChild(labelNode)
  li.appendChild(dot)
  if ((tabRegistry.get(focusedTabName)?.agentId ?? null) === sa.agent_id) li.classList.add('active')
  li.addEventListener('click', (e) => {
    e.stopPropagation() // don't bubble up and toggle the parent details group
    navigate({ view: 'session-detail', sessionName: focusedTabName, agentId: sa.agent_id })
    const sidebar = document.getElementById('detail-sidebar')
    if (sidebar) sidebar.classList.remove('open')
  })
  return li
}

// Tracks UUIDs already rendered for the currently-displayed stream, so updates
// only append new entries instead of wiping the DOM (avoids flash + scroll jump).
let renderedEntryKeys = new Set()
let renderedStreamKey = null // sessionId + '|' + (agentId || '') — resets on switch
let missedWhileScrolledUp = 0 // count of entries appended while user was scrolled up
// lastRenderedUuid: the uuid of the most recently appended transcript entry.
// Used by incremental renderStream calls to fetch only new entries via ?after_uuid=.
// Reset to null whenever the stream is fully re-rendered (new session, force fetch).
let lastRenderedUuid = null

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

/**
 * Resolve the focused tab's stream + scroll-to-bottom button. Returns
 * null when no per-tab clone is active (e.g., Switchboard view) or when
 * lookups fail. Per-tab scope; the legacy single-tab path is gone.
 *
 * @returns {{ btn: HTMLElement, stream: HTMLElement } | null}
 */
function focusedTabScrollEls() {
  const tab = tabRegistry.get(focusedTabName)
  if (!tab || !tab.contentEl) return null
  const btn = scopedById(tab.contentEl, 'scroll-to-bottom')
  const stream = scopedById(tab.contentEl, 'detail-stream')
  if (!(btn instanceof HTMLElement) || !(stream instanceof HTMLElement)) return null
  return { btn, stream }
}

function updateScrollToBottomButton(newlyMissed) {
  const els = focusedTabScrollEls()
  if (!els) return
  const { btn, stream } = els
  const near = isNearBottom(stream)
  if (near) {
    missedWhileScrolledUp = 0
    btn.hidden = true
    return
  }
  if (newlyMissed) missedWhileScrolledUp += newlyMissed
  btn.hidden = false
  btn.textContent = missedWhileScrolledUp > 0 ? '↓ ' + missedWhileScrolledUp + ' new' : '↓ Latest'
}

/**
 * @param {{
 *   root?: HTMLElement | null,
 *   sessionKey?: string,
 *   agentId?: string | null,
 *   archiveUuid?: string | null,
 *   incremental?: boolean,
 *   force?: boolean,
 * }} [opts]
 */
async function renderStream(opts) {
  opts = opts || {}
  // Backwards-compat fallback: if no root passed, use the legacy single
  // detail-stream element. Task 7 wires per-tab roots; until then this
  // branch lights the existing single-session path.
  const root = opts.root || document.getElementById('detail-stream')
  if (!root) return
  const sessionKey = opts.sessionKey ?? focusedTabName
  const agentId = opts.agentId ?? tabRegistry.get(focusedTabName)?.agentId ?? null
  const archiveUuid = opts.archiveUuid ?? null
  if (!sessionKey) {
    root.replaceChildren()
    return
  }

  const streamKey = sessionKey + '|' + (agentId || '') + '|' + (archiveUuid || '')
  const isNewStream = streamKey !== renderedStreamKey
  const force = opts && opts.force
  // Incremental mode: only fetch entries after the last rendered uuid.
  // Disabled when: no prior uuid, new stream, force refetch, or viewing an
  // archive (archives are immutable — always fetch the full transcript).
  const incremental =
    opts && opts.incremental && !isNewStream && !force && lastRenderedUuid && !archiveUuid

  if (isNewStream || force) {
    // Full rebuild path — show loading + replace everything.
    root.replaceChildren()
    renderedEntryKeys = new Set()
    renderedStreamKey = streamKey
    lastRenderedUuid = null // reset incremental cursor
    const loading = document.createElement('p')
    loading.style.color = 'var(--text-dim)'
    loading.textContent = 'Loading...'
    root.appendChild(loading)
  }

  const wasNearBottom = !isNewStream && isNearBottom(root)

  // Build query string. When doing an incremental update, pass after_uuid so
  // the server only returns entries appended since the last render — this avoids
  // re-reading and re-parsing the entire JSONL for every heartbeat update.
  // The server falls back to the full transcript if after_uuid is not found
  // (e.g., after compaction), so clients don't need special stale-uuid logic.
  let qs =
    'session_id=' +
    encodeURIComponent(sessionKey) +
    (agentId ? '&agent_id=' + encodeURIComponent(agentId) : '') +
    '&limit=300'
  if (archiveUuid) {
    qs += '&uuid=' + encodeURIComponent(archiveUuid)
  } else if (incremental && lastRenderedUuid) {
    qs += '&after_uuid=' + encodeURIComponent(lastRenderedUuid)
  }

  let entries
  try {
    const r = await fetch('/api/transcript?' + qs)
    entries = await r.json()
  } catch (e) {
    if (isNewStream || force) {
      root.replaceChildren()
      const err = document.createElement('p')
      err.style.color = 'var(--red)'
      err.textContent = 'Failed to load transcript.'
      root.appendChild(err)
    }
    return
  }

  // Make sure this response is still relevant (user may have navigated away).
  if (streamKey !== renderedStreamKey) return

  if (isNewStream || force) {
    root.replaceChildren()
    renderedEntryKeys = new Set()
    lastRenderedUuid = null
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    if (isNewStream) {
      const empty = document.createElement('p')
      empty.style.color = 'var(--text-dim)'
      empty.textContent = 'No entries yet.'
      root.appendChild(empty)
    }
    return
  }

  // Append only missing entries (keyed by uuid, falling back to ts+type).
  // Track the uuid of the last entry appended so future incremental calls
  // can pass ?after_uuid= to skip already-rendered content.
  // For user entries, also key by text so a live-injected "pending" entry
  // (from UserPromptSubmit hook) dedupes against the canonical JSONL entry
  // once the transcript refetch picks it up.
  //
  // Tool-call grouping: on a full rebuild, we group the entire entry list up
  // front via groupSequentialToolCalls (pure, tested). On an incremental
  // append, we use appendEntryWithGrouping per entry, which inspects the DOM
  // tail to extend the in-progress run — that way a streaming series of
  // tool-use entries folds into the same `.tool-group` as it grows.
  let appendedCount = 0
  const isFullRebuildPath = isNewStream || force
  /** @type {typeof entries} */
  const newEntries = []
  for (const e of entries) {
    const key = e.uuid || e.ts + '|' + e.type + '|' + (e.envelope_id || '')
    const textKey = e.type === 'user' && e.text ? 'user-text:' + e.text : null
    if (renderedEntryKeys.has(key)) continue
    if (textKey && renderedEntryKeys.has(textKey)) continue
    renderedEntryKeys.add(key)
    if (textKey) renderedEntryKeys.add(textKey)
    newEntries.push(e)
    appendedCount++
    if (e.uuid) lastRenderedUuid = e.uuid
  }
  if (newEntries.length > 0) {
    if (isFullRebuildPath) {
      renderGroupedItems(root, groupSequentialToolCalls(newEntries))
    } else {
      for (const e of newEntries) appendEntryWithGrouping(root, e)
    }
  }

  // Scroll to bottom only if it's a fresh stream OR the user was already near
  // the bottom when the update arrived. Otherwise preserve their position.
  if (isNewStream || force) {
    root.scrollTop = root.scrollHeight
    missedWhileScrolledUp = 0
  } else if (appendedCount > 0 && wasNearBottom) {
    root.scrollTop = root.scrollHeight
  } else if (appendedCount > 0 && !wasNearBottom) {
    // User is scrolled up and new content arrived — show the jump button.
    updateScrollToBottomButton(appendedCount)
  }
  // Also refresh button visibility based on current position.
  updateScrollToBottomButton(0)
}

function renderEntry(e) {
  const wrap = document.createElement('div')
  wrap.className = 'entry entry-' + e.type
  wrap.dataset.uuid = e.uuid || ''

  if (e.type === 'user') {
    appendLabel(wrap, 'you:')
    appendMarkdownBody(wrap, e.text || '')
    if (Array.isArray(e.attachments) && e.attachments.length > 0) {
      wrap.appendChild(renderAttachments(e.attachments))
    }
  } else if (e.type === 'assistant-text') {
    appendLabel(wrap, 'assistant:')
    appendMarkdownBody(wrap, e.text || '')
    const btn = document.createElement('button')
    btn.className = 'copy-btn'
    btn.dataset.src = e.text || ''
    btn.textContent = 'copy raw'
    wrap.appendChild(btn)
  } else if (e.type === 'tool-use') {
    appendToolUse(wrap, e)
  } else if (e.type === 'subagent-spawn') {
    appendSpawnMarker(wrap, e)
  } else if (e.type === 'party-line-send' || e.type === 'party-line-receive') {
    appendPartyLineEntry(wrap, e)
  }

  return wrap
}

// --- Sequential tool-call grouping ---
//
// Default-state policy (matches spec):
//   - run length 1 → no wrapper at all (handled by groupSequentialToolCalls)
//   - run length 2 → wrapped, but expanded by default (low value to hide just two)
//   - run length ≥ 3 → wrapped and collapsed by default
// The threshold is intentionally conservative so the user's eye still lands on
// the assistant's prose and prompts, not on a wall of Bash/Read/Edit summaries.

/**
 * Build a `<div class="tool-group">` containing a `<details>` whose body holds
 * the individual tool-use entries (rendered via the existing renderEntry path,
 * so nothing about per-call rendering changes).
 */
function renderToolGroup(entries) {
  const wrap = document.createElement('div')
  wrap.className = 'tool-group'
  const details = document.createElement('details')
  // Always closed by default — even pairs add visual noise when expanded
  // through long sessions. User can click to open.
  const summary = document.createElement('summary')
  updateToolGroupSummary(summary, entries.length, entries)
  details.appendChild(summary)
  const body = document.createElement('div')
  body.className = 'tool-group-body'
  for (const e of entries) {
    body.appendChild(renderEntry(e))
  }
  details.appendChild(body)
  wrap.appendChild(details)
  return wrap
}

/** Set the summary's text content to reflect the current tool-call count + names. */
function updateToolGroupSummary(summary, count, entries) {
  summary.replaceChildren()
  const arrow = document.createTextNode('▸ ')
  const countSpan = document.createElement('strong')
  countSpan.textContent = count + ' tool call' + (count === 1 ? '' : 's')
  const detail = document.createTextNode(' (' + summarizeToolGroup(entries) + ')')
  summary.appendChild(arrow)
  summary.appendChild(countSpan)
  summary.appendChild(detail)
}

/**
 * Append one transcript entry to `root`, folding sequential tool-use entries
 * into a `.tool-group` wrapper. Derives the current run state from the DOM tail
 * so it works identically for full-rebuild and incremental-append paths, and
 * for live-injection paths (handleUserPromptLive / appendEnvelopeToStreamForTab).
 */
function appendEntryWithGrouping(root, e) {
  if (e.type !== 'tool-use') {
    root.appendChild(renderEntry(e))
    return
  }
  const tail = root.lastElementChild
  // Case 1: tail is an existing tool-group → extend it.
  if (tail && tail.classList && tail.classList.contains('tool-group')) {
    const body = tail.querySelector('.tool-group-body')
    const summary = tail.querySelector('summary')
    if (body && summary) {
      body.appendChild(renderEntry(e))
      // Recompute summary from the live DOM so it stays accurate as the run grows.
      const liveEntries = collectToolGroupEntries(body)
      updateToolGroupSummary(summary, liveEntries.length, liveEntries)
      return
    }
  }
  // Case 2: tail is a single tool-use entry → promote it + this one into a group.
  if (
    tail &&
    tail.classList &&
    tail.classList.contains('entry-tool-use') &&
    tail.dataset &&
    tail.dataset.toolEntry
  ) {
    // We need the original entry data to rebuild renderEntry-style children;
    // simplest correct move: lift the existing DOM into the group body verbatim,
    // then append the new entry via renderEntry. Tracked entries (via
    // dataset.toolEntry) carry enough metadata for summary generation.
    const prevEntries = [JSON.parse(tail.dataset.toolEntry)]
    prevEntries.push(_serializeToolEntry(e))

    const group = document.createElement('div')
    group.className = 'tool-group'
    const details = document.createElement('details')
    // Always closed by default — see renderToolGroup.
    const summary = document.createElement('summary')
    updateToolGroupSummary(summary, prevEntries.length, prevEntries)
    details.appendChild(summary)
    const body = document.createElement('div')
    body.className = 'tool-group-body'

    // Move the existing tool-use DOM into the body (preserves any open state).
    root.replaceChild(group, tail)
    body.appendChild(tail)
    body.appendChild(renderEntry(e))
    details.appendChild(body)
    group.appendChild(details)
    return
  }
  // Case 3: no run in progress → append as a singleton tool entry.
  // Tag with dataset.toolEntry so a future tool-use can promote it into a group.
  const wrap = renderEntry(e)
  wrap.dataset.toolEntry = JSON.stringify(_serializeToolEntry(e))
  root.appendChild(wrap)
}

/** Minimal serialization of a tool-use entry for summary regeneration. */
function _serializeToolEntry(e) {
  return { type: 'tool-use', tool_name: e.tool_name || '' }
}

/** Walk a tool-group body and pull the tool_name from each child for summary text. */
function collectToolGroupEntries(body) {
  const out = []
  for (const child of body.children) {
    if (child.dataset && child.dataset.toolEntry) {
      try {
        out.push(JSON.parse(child.dataset.toolEntry))
        continue
      } catch {
        /* fall through */
      }
    }
    // Fallback: pull the tool name from the inline <code> in the summary.
    const code = child.querySelector('details > summary code')
    out.push({ type: 'tool-use', tool_name: code ? code.textContent || '' : '' })
  }
  return out
}

/**
 * Render a list of grouped items (from `groupSequentialToolCalls`) under `root`.
 * Used by the full-rebuild path in renderStream.
 */
function renderGroupedItems(root, items) {
  for (const item of items) {
    if (item.kind === 'tool-group') {
      root.appendChild(renderToolGroup(item.entries))
    } else {
      const wrap = renderEntry(item.entry)
      // Tag tool-use singletons so a future incremental append can promote
      // them into a group if another tool-use lands next.
      if (item.entry.type === 'tool-use') {
        wrap.dataset.toolEntry = JSON.stringify(_serializeToolEntry(item.entry))
      }
      root.appendChild(wrap)
    }
  }
}

// Re-export sanity: shouldExtendToolRun + TOOL_GROUP_MIN_RUN are documented
// in the helper module and exercised by tests; the runtime path here uses
// groupSequentialToolCalls (full rebuild) and DOM-tail inspection (incremental).
void TOOL_GROUP_MIN_RUN
void shouldExtendToolRun

function appendLabel(wrap, text) {
  const lab = document.createElement('div')
  lab.className = 'entry-label'
  lab.textContent = text
  wrap.appendChild(lab)
}

function appendMarkdownBody(wrap, src) {
  const body = document.createElement('div')
  body.className = 'entry-body'
  renderMarkdownInto(body, src)
  wrap.appendChild(body)
}

function renderMarkdownInto(container, src) {
  container.replaceChildren()
  if (!src) return
  let html
  try {
    html = marked.parse(src, { breaks: true, gfm: true })
    html = DOMPurify.sanitize(html)
  } catch {
    const pre = document.createElement('pre')
    pre.textContent = src
    container.appendChild(pre)
    return
  }
  // Insert sanitized markup via insertAdjacentHTML (avoids innerHTML = assignment).
  container.insertAdjacentHTML('beforeend', html)
  // Post-process: wrap each <pre> in a .code-block with a copy button.
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains('code-block')) return
    const wrap = document.createElement('div')
    wrap.className = 'code-block'
    const btn = document.createElement('button')
    btn.className = 'code-copy-btn'
    btn.textContent = 'copy'
    pre.parentNode.insertBefore(wrap, pre)
    wrap.appendChild(btn)
    wrap.appendChild(pre)
  })
}

function formatToolResponse(resp) {
  if (resp == null) return ''
  // String response (e.g. Bash stdout)
  if (typeof resp === 'string') return resp
  // Common shape: { content: string }
  if (typeof resp === 'object' && typeof resp.content === 'string') {
    return resp.content
  }
  // Anthropic tool_result format: { content: [ { type: 'text', text: '...' }, ... ] }
  if (typeof resp === 'object' && Array.isArray(resp.content)) {
    const texts = []
    for (const blk of resp.content) {
      if (blk && typeof blk === 'object' && typeof blk.text === 'string') {
        texts.push(blk.text)
      } else if (typeof blk === 'string') {
        texts.push(blk)
      }
    }
    if (texts.length > 0) return texts.join('\n')
  }
  // Fallback: JSON
  try {
    return JSON.stringify(resp, null, 2)
  } catch {
    return String(resp)
  }
}

function appendToolUse(wrap, e) {
  const details = document.createElement('details')
  details.className = 'tool-use'
  const summary = document.createElement('summary')
  // Structural parts via textContent; the small arrow + <code> tag needs inline HTML.
  // Use element construction to keep it safe.
  const arrow = document.createTextNode('▸ ')
  const name = document.createElement('code')
  name.textContent = e.tool_name || ''
  const colon = document.createTextNode(': ' + summarizeToolInput(e.tool_name, e.tool_input))
  summary.appendChild(arrow)
  summary.appendChild(name)
  summary.appendChild(colon)
  details.appendChild(summary)

  const inputDiv = document.createElement('div')
  inputDiv.className = 'tool-input'
  const inputLabel = document.createElement('strong')
  inputLabel.textContent = 'input:'
  inputDiv.appendChild(inputLabel)
  const inputPre = document.createElement('pre')
  inputPre.textContent = JSON.stringify(e.tool_input, null, 2)
  inputDiv.appendChild(inputPre)
  details.appendChild(inputDiv)

  const respDiv = document.createElement('div')
  respDiv.className = 'tool-response'
  const respLabel = document.createElement('strong')
  respLabel.textContent = 'response:'
  respDiv.appendChild(respLabel)
  if (e.tool_response !== undefined) {
    const respPre = document.createElement('pre')
    respPre.textContent = formatToolResponse(e.tool_response)
    respDiv.appendChild(respPre)
  } else {
    const em = document.createElement('em')
    em.textContent = '(no response yet)'
    respDiv.appendChild(em)
  }
  details.appendChild(respDiv)

  wrap.appendChild(details)
}

function summarizeToolInput(name, input) {
  if (!input) return ''
  try {
    if (name === 'Bash' && input.command) return String(input.command).slice(0, 80)
    if (name === 'Read' && input.file_path) return String(input.file_path)
    if (name === 'Write' && input.file_path) return String(input.file_path)
    if (name === 'Edit' && input.file_path) return String(input.file_path)
    if (name === 'Grep' && input.pattern) return String(input.pattern).slice(0, 60)
    if (name === 'Glob' && input.pattern) return String(input.pattern)
    return JSON.stringify(input).slice(0, 80)
  } catch {
    return ''
  }
}

function appendSpawnMarker(wrap, e) {
  const details = document.createElement('details')
  details.className = 'spawn-marker'
  if (e.agent_id) details.dataset.agentId = e.agent_id

  const summary = document.createElement('summary')
  const title = document.createElement('strong')
  title.textContent = '▸ spawned ' + (e.agent_type || 'subagent')
  summary.appendChild(title)
  if (e.description) {
    const short = e.description.length > 80 ? e.description.slice(0, 80) + '…' : e.description
    const sep = document.createTextNode(': ')
    const desc = document.createElement('span')
    desc.className = 'spawn-desc-inline'
    desc.textContent = short
    summary.appendChild(sep)
    summary.appendChild(desc)
  }
  details.appendChild(summary)

  // Body: full description (if long) + "View this agent" action.
  if (e.description && e.description.length > 80) {
    const full = document.createElement('div')
    full.className = 'spawn-desc-full'
    full.textContent = e.description
    details.appendChild(full)
  }
  if (e.agent_id) {
    const viewBtn = document.createElement('button')
    viewBtn.type = 'button'
    viewBtn.className = 'view-agent'
    viewBtn.dataset.agentId = e.agent_id
    viewBtn.textContent = 'View this agent →'
    details.appendChild(viewBtn)
  }
  wrap.appendChild(details)
}

function appendPartyLineEntry(wrap, e) {
  const block = document.createElement('div')
  const ty = e.envelope_type || 'message'
  block.className = 'pl-entry pl-' + ty
  block.dataset.otherSession = e.other_session || ''
  const header = document.createElement('strong')
  const arrow = e.type === 'party-line-send' ? '→ sent' : '← received'
  const dir = e.type === 'party-line-send' ? 'to' : 'from'
  header.textContent = arrow + ' ' + ty + ' ' + dir + ' ' + (e.other_session || '')
  block.appendChild(header)
  if (e.callback_id) {
    const cb = document.createTextNode(' [cb:' + e.callback_id.slice(0, 8) + ']')
    block.appendChild(cb)
  }
  if (e.body) {
    const body = document.createElement('div')
    body.className = 'pl-body'
    renderMarkdownInto(body, e.body)
    block.appendChild(body)
  }
  if (Array.isArray(e.attachments) && e.attachments.length > 0) {
    block.appendChild(renderAttachments(e.attachments))
  }
  wrap.appendChild(block)
}

// --- Attachments: render + send-form handling ---

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function renderAttachments(atts) {
  const wrap = document.createElement('div')
  wrap.className = 'entry-attachments'
  for (const a of atts) {
    if (a.kind === 'image') {
      const img = document.createElement('img')
      img.className = 'entry-att-image'
      img.src = a.url
      img.alt = a.name
      img.title = a.name + ' (' + formatFileSize(a.size) + ')'
      img.addEventListener('click', () => openLightbox(a))
      wrap.appendChild(img)
    } else {
      const link = document.createElement('a')
      link.className = 'entry-att-file'
      link.href = a.url
      link.download = a.name
      link.rel = 'noopener'
      const icon = document.createElement('span')
      icon.className = 'att-icon'
      icon.textContent = '📎'
      const name = document.createElement('span')
      name.textContent = a.name
      const size = document.createElement('span')
      size.className = 'att-size'
      size.textContent = formatFileSize(a.size)
      link.appendChild(icon)
      link.appendChild(name)
      link.appendChild(size)
      wrap.appendChild(link)
    }
  }
  return wrap
}

function openLightbox(att) {
  const lb = document.getElementById('lightbox')
  const img = document.getElementById('lightbox-img')
  const dl = document.getElementById('lightbox-download')
  if (!lb || !img || !dl) return
  img.src = att.url
  img.alt = att.name || ''
  dl.href = att.url
  dl.setAttribute('download', att.name || '')
  lb.hidden = false
}
function closeLightbox() {
  const lb = document.getElementById('lightbox')
  if (!lb) return
  lb.hidden = true
  const img = document.getElementById('lightbox-img')
  if (img) img.src = ''
}
;(function wireLightbox() {
  document.getElementById('lightbox-close')?.addEventListener('click', closeLightbox)
  document.getElementById('lightbox')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'lightbox') closeLightbox()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('lightbox')?.hidden) closeLightbox()
  })
})()

// Pending attachments live on each Tab (tab.pendingAttachments).
// Each is { id, name, size, kind, media_type, url, objectUrl?, status }.

function renderAttachChips(tab) {
  if (!tab || !tab.contentEl) return
  const wrap = scopedById(tab.contentEl, 'detail-attach-chips')
  if (!wrap) return
  wrap.replaceChildren()
  if (tab.pendingAttachments.length === 0) {
    wrap.hidden = true
    return
  }
  wrap.hidden = false
  for (const p of tab.pendingAttachments) {
    const chip = document.createElement('span')
    chip.className =
      'attach-chip' +
      (p.status === 'uploading' ? ' uploading' : '') +
      (p.status === 'error' ? ' errored' : '')
    if (p.kind === 'image' && (p.objectUrl || p.url)) {
      const img = document.createElement('img')
      img.src = p.objectUrl || p.url
      img.alt = ''
      chip.appendChild(img)
    }
    const name = document.createElement('span')
    name.className = 'attach-name'
    name.textContent = p.name
    chip.appendChild(name)
    const size = document.createElement('span')
    size.className = 'attach-size'
    size.textContent = p.status === 'uploading' ? '…' : formatFileSize(p.size)
    chip.appendChild(size)
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'attach-chip-x'
    x.textContent = '×'
    x.addEventListener('click', () => {
      tab.pendingAttachments = tab.pendingAttachments.filter((q) => q !== p)
      if (p.objectUrl) URL.revokeObjectURL(p.objectUrl)
      renderAttachChips(tab)
    })
    chip.appendChild(x)
    wrap.appendChild(chip)
  }
}

async function uploadPending(tab, file) {
  const localId = Math.random().toString(36).slice(2)
  const placeholder = {
    localId,
    id: null,
    name: file.name || 'pasted-image',
    size: file.size,
    media_type: file.type || 'application/octet-stream',
    kind: (file.type || '').startsWith('image/') ? 'image' : 'file',
    objectUrl: URL.createObjectURL(file),
    url: null,
    status: 'uploading',
  }
  tab.pendingAttachments.push(placeholder)
  renderAttachChips(tab)
  try {
    const form = new FormData()
    form.append('file', file, placeholder.name)
    const res = await fetch('/api/upload', { method: 'POST', body: form })
    if (!res.ok) throw new Error('upload failed: ' + res.status)
    const meta = await res.json()
    placeholder.id = meta.id
    placeholder.url = meta.url
    placeholder.kind = meta.kind
    placeholder.media_type = meta.media_type
    placeholder.size = meta.size
    placeholder.status = 'ready'
  } catch (err) {
    placeholder.status = 'error'
    console.error('[attach] upload failed', err)
  } finally {
    renderAttachChips(tab)
  }
}

function addFiles(tab, fileList) {
  if (!tab) return
  for (const f of Array.from(fileList)) {
    if (tab.pendingAttachments.length >= 5) {
      console.warn('[attach] max 5 attachments; ignoring', f.name)
      break
    }
    uploadPending(tab, f)
  }
}

/**
 * @param {HTMLFormElement} form
 */
function doDetailSend(form) {
  // Per-tab clones have a .session-tab-content[data-tab-name="X"] wrapper;
  // derive the target session from there, falling back to focusedTabName for
  // the (rare) case of a form not inside a per-tab content wrapper.
  const tabContent = form.closest('.session-tab-content')
  const targetName =
    (tabContent instanceof HTMLElement && tabContent.dataset.tabName) || focusedTabName
  if (!targetName) return
  const tab = tabRegistry.get(targetName)
  if (!tab) return
  const textarea = /** @type {HTMLTextAreaElement | null} */ (
    form.querySelector('#detail-send-msg, [data-orig-id="detail-send-msg"]')
  )
  if (!textarea) return
  const msg = textarea.value.trim()
  const readyAtts = tab.pendingAttachments.filter((p) => p.status === 'ready' && p.id)
  if (!msg && readyAtts.length === 0) return
  const uploading = tab.pendingAttachments.some((p) => p.status === 'uploading')
  if (uploading) {
    // Let the upload finish first — user can retry Send.
    console.warn('[detail-send] waiting for uploads')
    return
  }
  const payload = {
    to: targetName,
    message: msg,
    type: 'message',
    attachment_ids: readyAtts.map((p) => p.id),
  }
  fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(function (err) {
    console.error('[detail-send] send failed', err)
  })
  textarea.value = ''
  autosizeDetailSend(textarea)
  textarea.focus()
  // Clear chips (revoke object URLs).
  for (const p of tab.pendingAttachments) if (p.objectUrl) URL.revokeObjectURL(p.objectUrl)
  tab.pendingAttachments = []
  renderAttachChips(tab)
}

/**
 * Auto-resize the session send textarea up to ~4 lines, then scroll.
 * Pass a specific textarea element, or omit to fall back to document lookup.
 * @param {HTMLElement | null} [ta]
 */
function autosizeDetailSend(ta) {
  if (!ta) return
  ta.style.height = 'auto'
  const max = 4 * parseFloat(getComputedStyle(ta).lineHeight || '20') + 16
  ta.style.height = Math.min(ta.scrollHeight, max) + 'px'
}

// --- History view ---

var historyEvents = []
var historyHooksSeen = new Set()
var historyLoaded = false

function buildHistoryItem(ev) {
  var li = document.createElement('li')
  li.className = 'history-event'
  li.dataset.session = ev.session_name || ev.session_id || ''
  li.dataset.hook = ev.hook_event || ''
  li.dataset.search = JSON.stringify(ev).toLowerCase()

  var ts = document.createElement('span')
  ts.className = 'ts'
  ts.textContent = ev.ts ? new Date(ev.ts).toLocaleTimeString() : ''
  li.appendChild(ts)

  if (ev.session_name || ev.session_id) {
    var stag = document.createElement('span')
    stag.className = 'session-tag'
    stag.textContent = ev.session_name || ev.session_id
    li.appendChild(stag)
  }

  var hook = document.createElement('span')
  hook.className = 'hook ' + hookClass(ev.hook_event)
  hook.textContent = ev.hook_event || 'event'
  li.appendChild(hook)

  var detail = document.createElement('span')
  detail.className = 'detail'
  var detailText = ''
  if (ev.tool_name) {
    detailText = 'tool: ' + ev.tool_name
  } else if (ev.payload) {
    try {
      var p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload
      if (p.tool_name) detailText = 'tool: ' + p.tool_name
      else if (p.message) detailText = String(p.message).slice(0, 80)
    } catch (e3) {
      detailText = ''
    }
  }
  detail.textContent = detailText
  li.appendChild(detail)

  return li
}

function applyHistoryFilters() {
  var filterText = document.getElementById('history-filter').value.toLowerCase()
  var filterHook = document.getElementById('history-hook-filter').value
  var list = document.getElementById('history-list')
  if (!list) return
  list.querySelectorAll('.history-event').forEach(function (li) {
    var hookMatch = !filterHook || li.dataset.hook === filterHook
    var textMatch = !filterText || li.dataset.search.indexOf(filterText) !== -1
    li.classList.toggle('hidden', !(hookMatch && textMatch))
  })
}

function addHookOption(hookEvent) {
  if (!hookEvent || historyHooksSeen.has(hookEvent)) return
  historyHooksSeen.add(hookEvent)
  var sel = document.getElementById('history-hook-filter')
  if (!sel) return
  var opt = document.createElement('option')
  opt.value = hookEvent
  opt.textContent = hookEvent
  sel.appendChild(opt)
}

// Live-append a new hook event to the History → Events list when it arrives
// via WebSocket. Always records to historyEvents so loadHistoryView() can
// render them later; only mutates the DOM if the history list is already
// loaded (historyLoaded guard was previously on the outer function which
// silently dropped events from all other paths — unread counters, etc.).
function handleHookEvent(ev) {
  addHookOption(ev.hook_event)
  historyEvents.unshift(ev)
  if (!historyLoaded) return
  var list = document.getElementById('history-list')
  if (!list) return
  // Skip the "No events" placeholder if present.
  var placeholder = list.querySelector('.history-empty')
  if (placeholder) placeholder.remove()
  var li = buildHistoryItem(ev)
  if (list.firstChild) list.insertBefore(li, list.firstChild)
  else list.appendChild(li)
  // Respect current filters so an off-filter event stays hidden.
  applyHistoryFilters()
}

function loadHistoryView() {
  var filterInput = document.getElementById('history-filter')
  var hookSelect = document.getElementById('history-hook-filter')
  var list = document.getElementById('history-list')
  if (!list) return

  if (!historyLoaded) {
    list.textContent = ''
    list.appendChild(makeEmptyLi('Loading...'))

    fetch('/api/events?limit=500')
      .then(function (r) {
        return r.json()
      })
      .then(function (events) {
        historyEvents = events || []
        list.textContent = ''
        if (historyEvents.length === 0) {
          list.appendChild(makeEmptyLi('No events recorded yet.'))
        } else {
          historyEvents.forEach(function (ev) {
            addHookOption(ev.hook_event)
            list.appendChild(buildHistoryItem(ev))
          })
        }
        historyLoaded = true
      })
      .catch(function () {
        list.textContent = ''
        list.appendChild(makeEmptyLi('Failed to load history.'))
      })
  }

  // Wire up filter controls (safe to do multiple times — handlers are idempotent after first load)
  if (filterInput && !filterInput.dataset.wired) {
    filterInput.dataset.wired = '1'
    filterInput.addEventListener('input', applyHistoryFilters)
  }
  if (hookSelect && !hookSelect.dataset.wired) {
    hookSelect.dataset.wired = '1'
    hookSelect.addEventListener('change', applyHistoryFilters)
  }
}

// Wire party-line bus in History > Bus sub-tab
function addMessageToBus(msg) {
  // addMessage already appends to busFeed and updates busMsgCount — no separate action needed.
}

document.getElementById('history-subtabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-subtab]')
  if (!btn) return
  document.querySelectorAll('#history-subtabs button').forEach((b) => b.classList.remove('active'))
  btn.classList.add('active')
  const sub = btn.dataset.subtab
  document.querySelectorAll('section[data-view="history"] .subview').forEach((v) => {
    v.hidden = v.dataset.subview !== sub
  })
  // Update URL without remounting the view
  const url = sub === 'events' ? '/history' : '/history/' + sub
  window.history.replaceState({ view: 'history', subtab: sub }, '', url)
})

window.addEventListener('popstate', (e) => {
  const state = e.state && typeof e.state === 'object' ? e.state : parseUrl()
  applyRoute(state, { skipPush: true })
})

// --- Browser notifications ---

// Expose inline-handler targets on window so they remain callable from
// onsubmit= attributes now that dashboard.js loads as an ES module.
window.doBusSend = doBusSend
window.doDetailSend = doDetailSend

const notif = createNotifications({
  swRegistration,
  NotificationPermission: typeof Notification !== 'undefined' ? Notification : undefined,
  localStorage: window.localStorage,
  doc: document,
  win: window,
  sendWsFrame: (frame) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
  },
  getCurrentRoute: () => window.location.pathname,
  navigate: (route) => {
    // Accept '/#/session/foo' or '/session/foo'
    const cleaned = route.replace(/^\/#/, '')
    const m = cleaned.match(/^\/session\/(.+)$/)
    if (m) navigate({ view: 'session-detail', sessionName: decodeURIComponent(m[1]) })
    else navigate({ view: 'switchboard' })
  },
  fetch: window.fetch.bind(window),
})

// --- Tab lifecycle ---

/**
 * Insert the Switchboard home tab into the registry. The home tab has no
 * cloned content — it points at the existing static .view[data-view="switchboard"]
 * element. Idempotent.
 */
function ensureSwitchboardTabRegistered() {
  if (tabRegistry.has('')) return
  const stripTab = document.getElementById('tab-strip-switchboard')
  /** @type {Tab} */
  const home = {
    name: '',
    contentEl: null, // home doesn't clone — it shows the existing switchboard view
    stripTab,
    streamKeys: new Set(),
    lastRenderedUuid: null,
    scrollTop: 0,
    agentId: null,
    archiveUuid: null,
    subagents: [],
    lastViewedAt: Date.now(),
    online: true,
    evictionTimer: null,
    pendingAttachments: [],
  }
  tabRegistry.set('', home)
  focusedTabName = ''
}

/**
 * Wire submit + keyboard + file-picker + drag-and-drop handlers on the
 * send form inside a cloned .session-tab-content element. Called by
 * pinTab (initial mount) and the LRU re-mount path in focusTab.
 *
 * @param {HTMLElement} contentEl
 */
function wireTabFormHandlers(contentEl) {
  const clonedForm = contentEl.querySelector('[data-orig-id="detail-send"]')
  if (!(clonedForm instanceof HTMLFormElement)) return
  // Tab for this clone is derived from contentEl.dataset.tabName at event time
  // (registry lookup, not capture, so re-mount/eviction is handled correctly).
  const tabForEl = () => tabRegistry.get(contentEl.dataset.tabName || '') || null
  clonedForm.addEventListener('submit', (e) => {
    e.preventDefault()
    doDetailSend(clonedForm)
  })
  const clonedTa = /** @type {HTMLTextAreaElement | null} */ (
    clonedForm.querySelector('[data-orig-id="detail-send-msg"]')
  )
  if (clonedTa) {
    clonedTa.addEventListener('input', () => autosizeDetailSend(clonedTa))
    clonedTa.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault()
        doDetailSend(clonedForm)
      }
    })
  }
  const clonedAttachBtn = clonedForm.querySelector('[data-orig-id="detail-attach-btn"]')
  const clonedAttachInput = /** @type {HTMLInputElement | null} */ (
    clonedForm.querySelector('[data-orig-id="detail-attach-input"]')
  )
  if (clonedAttachBtn && clonedAttachInput) {
    clonedAttachBtn.addEventListener('click', () => clonedAttachInput.click())
    clonedAttachInput.addEventListener('change', () => {
      if (clonedAttachInput.files && clonedAttachInput.files.length > 0)
        addFiles(tabForEl(), clonedAttachInput.files)
      clonedAttachInput.value = ''
    })
  }
  if (clonedTa) {
    clonedTa.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files = []
      for (const it of items)
        if (it.kind === 'file') {
          const f = it.getAsFile()
          if (f) files.push(f)
        }
      if (files.length > 0) {
        e.preventDefault()
        addFiles(tabForEl(), files)
      }
    })
  }
  let dropDepth = 0
  clonedForm.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return
    e.preventDefault()
    dropDepth++
    clonedForm.classList.add('drop-target')
  })
  clonedForm.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))
      e.preventDefault()
  })
  clonedForm.addEventListener('dragleave', () => {
    dropDepth = Math.max(0, dropDepth - 1)
    if (dropDepth === 0) clonedForm.classList.remove('drop-target')
  })
  clonedForm.addEventListener('drop', (e) => {
    e.preventDefault()
    dropDepth = 0
    clonedForm.classList.remove('drop-target')
    const files = e.dataTransfer?.files
    if (files && files.length > 0) addFiles(tabForEl(), files)
  })

  // Scroll-to-bottom button + stream-scroll listener — per-tab clone
  // owns its own pair, so wire here rather than at module init (the
  // template's hidden copy gets the global listeners but they never fire).
  const clonedStream = scopedById(contentEl, 'detail-stream')
  const clonedScrollBtn = scopedById(contentEl, 'scroll-to-bottom')
  if (clonedStream instanceof HTMLElement && clonedScrollBtn instanceof HTMLElement) {
    clonedScrollBtn.addEventListener('click', () => {
      clonedStream.scrollTop = clonedStream.scrollHeight
      missedWhileScrolledUp = 0
      clonedScrollBtn.hidden = true
    })
    clonedStream.addEventListener('scroll', () => updateScrollToBottomButton(0))
  }

  if (clonedStream) {
    clonedStream.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target)
      const btn = target.closest('.copy-btn')
      if (btn) {
        const src = btn.dataset.src
        if (src)
          navigator.clipboard.writeText(src).then(() => {
            btn.textContent = 'copied'
            setTimeout(() => {
              btn.textContent = 'copy raw'
            }, 1200)
          })
        return
      }
      const codeBtn = target.closest('.code-copy-btn')
      if (codeBtn) {
        const pre = codeBtn.parentElement.querySelector('pre')
        if (pre)
          navigator.clipboard.writeText(pre.textContent || '').then(() => {
            codeBtn.textContent = 'copied'
            setTimeout(() => {
              codeBtn.textContent = 'copy'
            }, 1200)
          })
        return
      }
      const viewAgentBtn = target.closest('.view-agent')
      if (viewAgentBtn && viewAgentBtn.dataset.agentId) {
        e.preventDefault()
        const tabName = contentEl.dataset.tabName || focusedTabName
        navigate({
          view: 'session-detail',
          sessionName: tabName,
          agentId: viewAgentBtn.dataset.agentId,
        })
        return
      }
      const pl = target.closest('.pl-entry')
      if (pl && pl.dataset.otherSession) {
        navigate({ view: 'session-detail', sessionName: pl.dataset.otherSession, agentId: null })
        return
      }
    })
  }

  // Back button
  const backBtn = scopedById(contentEl, 'detail-back')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      const stripBtn = document.querySelector('button[data-view="switchboard"]')
      if (stripBtn instanceof HTMLElement) stripBtn.click()
    })
  }

  // Drawer toggle (mobile sidebar)
  const drawerBtn = scopedById(contentEl, 'detail-drawer-toggle')
  const sidebar = scopedById(contentEl, 'detail-sidebar')
  if (drawerBtn && sidebar) {
    drawerBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open')
    })
  }

  // Kebab menu
  const actionsBtn = scopedById(contentEl, 'detail-actions')
  if (actionsBtn) {
    actionsBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const tabName = contentEl.dataset.tabName
      if (!tabName) return
      const r = actionsBtn.getBoundingClientRect()
      showSessionActionsMenu(tabName, r.left, r.bottom + 4)
    })
  }

  // Bell toggle
  const bellEl = scopedById(contentEl, 'detail-bell')
  if (bellEl) {
    bellEl.addEventListener('click', () => {
      const session = bellEl.getAttribute('data-session')
      if (!session) return
      handleBellClick(bellEl, session)
    })
  }
}

/**
 * Add a session tab to the registry + insert a strip button + clone the
 * session-tab-content template into the stack. Idempotent — if the tab
 * already exists, this is a no-op (returns the existing record).
 *
 * Caller is responsible for clearing the dismissal flag if appropriate.
 *
 * TODO: click handlers inside renderAgentTree / buildAgentLi still hit
 * document.getElementById('detail-sidebar') at event time. They will need
 * scoping when per-tab clones land (Task 11).
 *
 * @param {string} name
 * @returns {Tab}
 */
function pinTab(name) {
  const existing = tabRegistry.get(name)
  if (existing) return existing

  // Clone the content template
  const template = document.querySelector('.session-tab-content[data-tab-content-template]')
  if (!template) throw new Error('session-tab-content template missing from DOM')
  const contentEl = /** @type {HTMLElement} */ (template.cloneNode(true))
  contentEl.removeAttribute('hidden')
  contentEl.removeAttribute('data-tab-content-template')
  contentEl.dataset.tabName = name

  // Strip away the original IDs inside the clone — they would collide
  // with the template's hidden copy. Stash them in data-orig-id for
  // refactored code that wants to look them up via per-tab querySelector.
  for (const el of contentEl.querySelectorAll('[id]')) {
    const oldId = el.id
    el.removeAttribute('id')
    el.setAttribute('data-orig-id', oldId)
  }

  const stack = document.getElementById('session-tab-stack')
  if (!stack) throw new Error('#session-tab-stack missing from DOM')
  stack.appendChild(contentEl)

  // Wire submit + keyboard + file + drag handlers on the cloned send form.
  wireTabFormHandlers(contentEl)

  // Strip button
  const stripTab = document.createElement('button')
  stripTab.type = 'button'
  stripTab.className = 'tab-strip-tab'
  stripTab.dataset.tabName = name
  const dot = document.createElement('span')
  dot.className = 'state-dot offline'
  const label = document.createElement('span')
  label.className = 'tab-strip-label'
  label.textContent = name
  const pill = document.createElement('span')
  pill.className = 'unread-pill'
  pill.hidden = true
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'tab-close'
  close.textContent = '×'
  close.setAttribute('aria-label', 'Close ' + name)
  stripTab.append(dot, label, pill, close)

  document.getElementById('tab-strip-sessions')?.appendChild(stripTab)

  /** @type {Tab} */
  const tab = {
    name,
    contentEl,
    stripTab,
    streamKeys: new Set(),
    lastRenderedUuid: null,
    scrollTop: 0,
    agentId: null,
    archiveUuid: null,
    subagents: [],
    lastViewedAt: 0, // 0 = never focused, won't be picked by LRU
    online: false,
    evictionTimer: null,
    pendingAttachments: [],
  }
  tabRegistry.set(name, tab)
  return tab
}

/**
 * Make `name` the active tab. Hides all other tab content (and the legacy
 * static views), updates aria-current on strip buttons, sets lastViewedAt,
 * resets the unread count, and triggers a content-load if the tab is empty.
 *
 * @param {string} name '' for Switchboard, otherwise a session name
 * @param {{ pushHistory?: boolean }} [opts]
 */
function focusTab(name, opts) {
  opts = opts || {}
  currentView = name === '' ? 'switchboard' : 'session-detail'
  const tab = tabRegistry.get(name)
  if (!tab) {
    console.warn('focusTab called with unknown name', name)
    return
  }

  // If this tab was evicted by the LRU sweep (DOM destroyed), re-mount the
  // template clone before showing it. Mirrors pinTab's clone-and-strip-ids
  // logic. wireTabFormHandlers re-attaches submit/keyboard/file/drag handlers
  // so the composer works immediately after re-focus.
  if (name !== '' && tab.contentEl === null) {
    const template = document.querySelector('.session-tab-content[data-tab-content-template]')
    if (template) {
      const cloned = /** @type {HTMLElement} */ (template.cloneNode(true))
      cloned.removeAttribute('hidden')
      cloned.removeAttribute('data-tab-content-template')
      cloned.dataset.tabName = name
      for (const el of cloned.querySelectorAll('[id]')) {
        const oldId = el.id
        el.removeAttribute('id')
        el.setAttribute('data-orig-id', oldId)
      }
      document.getElementById('session-tab-stack')?.appendChild(cloned)
      wireTabFormHandlers(cloned)
      tab.contentEl = cloned
    }
  }

  // Mark every strip button non-current
  for (const btn of document.querySelectorAll('.tab-strip-tab')) {
    btn.removeAttribute('aria-current')
  }
  if (tab.stripTab) tab.stripTab.setAttribute('aria-current', 'page')

  // Hide all per-tab content clones; activate this one (or none, for home).
  for (const c of document.querySelectorAll('.session-tab-stack > .session-tab-content')) {
    c.removeAttribute('data-active')
  }
  if (tab.contentEl) tab.contentEl.setAttribute('data-active', 'true')

  // Show only the right legacy .view[data-view] section.
  for (const v of document.querySelectorAll('section.view[data-view]')) {
    v.removeAttribute('hidden')
    v.classList.remove('active')
  }
  if (name === '') {
    // Show switchboard view (legacy static)
    const sw = document.querySelector('section.view[data-view="switchboard"]')
    if (sw) sw.classList.add('active')
    for (const v of document.querySelectorAll('section.view[data-view]')) {
      if (v !== sw) v.setAttribute('hidden', '')
    }
  } else {
    // Show the session-detail wrapping section — the per-tab clone inside
    // #session-tab-stack is what the user sees, but the wrapping section
    // is the only [data-view] we mark active so existing CSS keeps working.
    const sd = document.querySelector('section.view[data-view="session-detail"]')
    if (sd) sd.classList.add('active')
    for (const v of document.querySelectorAll('section.view[data-view]')) {
      if (v !== sd) v.setAttribute('hidden', '')
    }
  }

  focusedTabName = name
  tab.lastViewedAt = Date.now()
  unreadCounts[name] = 0
  refreshUnreadPill(tab)
  // Snap the focused tab's transcript to the bottom on every focus —
  // the latest message is always the relevant one. Any "scrolled up
  // reading history" pause is reset by navigating away and back.
  if (tab.contentEl) {
    const stream = scopedById(tab.contentEl, 'detail-stream')
    if (stream instanceof HTMLElement) {
      stream.scrollTop = stream.scrollHeight
    }
  }
  missedWhileScrolledUp = 0
  updateScrollToBottomButton(0)

  // URL update
  const url = name === '' ? '/' : '/session/' + encodeURIComponent(name)
  if (opts.pushHistory) {
    history.pushState({ tab: name }, '', url)
  } else {
    history.replaceState({ tab: name }, '', url)
  }

  // Lazy load the content if not already populated for this tab
  if (name !== '' && tab.contentEl && !tab.contentEl.dataset.loaded) {
    tab.contentEl.dataset.loaded = 'true'
    void loadSessionDetailView({
      sessionKey: name,
      agentId: tab.agentId,
      archiveUuid: tab.archiveUuid,
      contentRoot: tab.contentEl,
    })
  }

  // LRU sweep: if the registry has grown past the cap, evict the
  // least-recently-focused tab's DOM (keep its strip entry). Re-focusing
  // later will trigger a fresh loadSessionDetailView via the re-mount
  // branch above.
  maybeEvictByLru()
}

/**
 * @param {Tab} tab
 */
function refreshUnreadPill(tab) {
  if (!tab.stripTab) return
  const pill = tab.stripTab.querySelector('.unread-pill')
  if (!(pill instanceof HTMLElement)) return
  const count = unreadCounts[tab.name] || 0
  if (count > 0) {
    pill.hidden = false
    pill.textContent = String(count)
  } else {
    pill.hidden = true
    pill.textContent = ''
  }
}

/**
 * Remove a session tab's strip entry + DOM, and add it to the dismissal
 * set so it doesn't auto-re-pin the next time it appears in
 * sessions-snapshot. The Switchboard tab cannot be dismissed.
 *
 * @param {string} name
 */
function dismissTab(name) {
  if (name === '') return
  const tab = tabRegistry.get(name)
  if (!tab) return
  // Stop any pending offline-eviction timer
  if (tab.evictionTimer) {
    clearTimeout(tab.evictionTimer)
    tab.evictionTimer = null
  }
  if (tab.contentEl && tab.contentEl.parentNode) tab.contentEl.parentNode.removeChild(tab.contentEl)
  if (tab.stripTab && tab.stripTab.parentNode) tab.stripTab.parentNode.removeChild(tab.stripTab)
  tabRegistry.delete(name)
  dismissedTabs.add(name)
  saveDismissed(dismissedTabs)
  // Move focus to the next tab on the right, or Switchboard if none
  if (focusedTabName === name) {
    const next = pickFocusAfterDismiss(name)
    focusTab(next, { pushHistory: false })
  }
}

/**
 * Like dismissTab but does NOT add the session to the dismissal set —
 * it just removes the tab from the strip + DOM. Used when the offline
 * grace timer expires; the tab auto-pins again next time the session
 * comes online.
 *
 * @param {string} name
 */
function unpinTabAfterOfflineEviction(name) {
  if (name === '') return
  const tab = tabRegistry.get(name)
  if (!tab) return
  if (tab.contentEl?.parentNode) tab.contentEl.parentNode.removeChild(tab.contentEl)
  if (tab.stripTab?.parentNode) tab.stripTab.parentNode.removeChild(tab.stripTab)
  tabRegistry.delete(name)
  if (focusedTabName === name) {
    const next = pickFocusAfterDismiss(name)
    focusTab(next, { pushHistory: false })
  }
}

/**
 * Soft-evict the LRU tab's DOM, keeping its strip entry intact.
 * Called after every focusTab to enforce TAB_DOM_LRU_CAP.
 * The evicted tab's contentEl is set to null; re-focusing it later
 * triggers a fresh clone + loadSessionDetailView in focusTab.
 */
function maybeEvictByLru() {
  /** @type {Map<string, { lastViewedAt: number }>} */
  const candidates = new Map()
  for (const [name, tab] of tabRegistry) {
    if (name === '') continue // never evict Switchboard
    if (!tab.contentEl) continue // already evicted
    candidates.set(name, { lastViewedAt: tab.lastViewedAt })
  }
  const victim = pickLruEvictionVictim(candidates, TAB_DOM_LRU_CAP)
  if (!victim) return
  const t = tabRegistry.get(victim)
  if (!t || !t.contentEl) return
  if (t.contentEl.parentNode) t.contentEl.parentNode.removeChild(t.contentEl)
  t.contentEl = null
  t.streamKeys = new Set()
  t.lastRenderedUuid = null
  t.subagents = []
  // Strip entry stays (greyed if offline, normal otherwise). Clicking it
  // re-creates the content via pinTab + lazy-load (see focusTab).
}

/**
 * Reconcile the tab strip against the latest list of ccpl sessions.
 * Adds tabs for online + non-dismissed sessions that aren't yet pinned;
 * updates the state dot + offline class on every existing tab.
 * Does NOT remove offline tabs immediately — that's the 5-min eviction
 * timer's job (Task 12).
 *
 * @param {Array<{ name: string, online: boolean, state?: string }>} sessions
 */
function syncStripFromSessions(sessions) {
  const visible = filterStripSessions(sessions, dismissedTabs)
  for (const s of visible) {
    if (!tabRegistry.has(s.name)) {
      pinTab(s.name)
    }
  }
  for (const s of sessions) {
    const tab = tabRegistry.get(s.name)
    if (!tab) continue
    setTabOnlineState(tab, s.online, s.state)
  }
}

/**
 * Run an async task per item with a parallelism cap. Resolves once all
 * tasks have completed (or rejected). Errors from individual tasks are
 * swallowed (logged via console.warn) — one failed prefetch must not
 * block the others.
 *
 * @template T
 * @param {T[]} items
 * @param {number} cap
 * @param {(item: T) => Promise<void>} run
 */
async function runWithCap(items, cap, run) {
  let i = 0
  /** @type {Promise<void>[]} */
  const workers = []
  const next = async () => {
    while (i < items.length) {
      const idx = i++
      try {
        await run(items[idx])
      } catch (err) {
        console.warn('[prefetch] task failed for', items[idx], err)
      }
    }
  }
  for (let w = 0; w < Math.max(1, cap); w++) workers.push(next())
  await Promise.all(workers)
}

/**
 * For every pinned, non-focused, content-empty tab, kick off a
 * loadSessionDetailView so its DOM is populated by the time the user
 * focuses it. Capped at PREFETCH_PARALLELISM concurrent fetches.
 */
async function prefetchAllPinnedTabs() {
  /** @type {Tab[]} */
  const targets = []
  for (const tab of tabRegistry.values()) {
    if (tab.name === '') continue // Switchboard home doesn't load
    if (!tab.contentEl) continue // evicted — skip
    if (tab.contentEl.dataset.loaded === 'true') continue
    targets.push(tab)
  }
  await runWithCap(targets, PREFETCH_PARALLELISM, async (tab) => {
    if (!tab.contentEl) return
    tab.contentEl.dataset.loaded = 'true'
    await loadSessionDetailView({
      sessionKey: tab.name,
      agentId: tab.agentId,
      archiveUuid: tab.archiveUuid,
      contentRoot: tab.contentEl,
    })
  })
}

/**
 * @param {Tab} tab
 * @param {boolean} online
 * @param {string | undefined} state
 */
function setTabOnlineState(tab, online, state) {
  const wasOnline = tab.online
  tab.online = online
  if (tab.stripTab) {
    const dot = tab.stripTab.querySelector('.state-dot')
    if (dot instanceof HTMLElement) {
      dot.classList.remove('idle', 'working', 'offline')
      if (!online) dot.classList.add('offline')
      else if (state === 'working') dot.classList.add('working')
      else dot.classList.add('idle')
    }
    tab.stripTab.classList.toggle('tab-offline', !online)
  }
  if (online && tab.evictionTimer) {
    // Came back online within the grace window — cancel eviction.
    clearTimeout(tab.evictionTimer)
    tab.evictionTimer = null
  } else if (!online && wasOnline && !tab.evictionTimer) {
    // Just went offline — start the 5-min eviction timer.
    tab.evictionTimer = setTimeout(() => {
      tab.evictionTimer = null
      // Only evict if still offline.
      if (!tab.online) unpinTabAfterOfflineEviction(tab.name)
    }, OFFLINE_GRACE_MS)
  }
}

/**
 * @param {string} dismissedName
 * @returns {string}
 */
function pickFocusAfterDismiss(dismissedName) {
  // Prefer the strip tab to the right of the one being dismissed; fall
  // back to the one to its left; finally fall back to Switchboard ('').
  const buttons = Array.from(document.querySelectorAll('#tab-strip-sessions .tab-strip-tab'))
  const idx = buttons.findIndex(
    (b) => /** @type {HTMLElement} */ (b).dataset.tabName === dismissedName,
  )
  if (idx === -1) return ''
  const right = buttons[idx + 1]
  if (right) return /** @type {HTMLElement} */ (right).dataset.tabName || ''
  const left = buttons[idx - 1]
  if (left) return /** @type {HTMLElement} */ (left).dataset.tabName || ''
  return ''
}

document.getElementById('tab-strip')?.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target)
  // Close X
  if (target.classList.contains('tab-close')) {
    e.stopPropagation()
    const btn = target.closest('.tab-strip-tab')
    const name = btn instanceof HTMLElement ? btn.dataset.tabName || '' : ''
    if (name) dismissTab(name)
    return
  }
  // Tab focus
  const btn = target.closest('.tab-strip-tab')
  if (btn instanceof HTMLElement) {
    e.preventDefault()
    const name = btn.dataset.tabName ?? ''
    focusTab(name, { pushHistory: true })
    return
  }
  // Overflow menu Machines / History (only History exists today)
  const overflowBtn = target.closest('.tab-strip-overflow-menu button')
  if (overflowBtn instanceof HTMLElement) {
    const view = overflowBtn.dataset.view
    if (view === 'history') navigate({ view: 'history' })
    // Close the <details> after click
    document.getElementById('tab-strip-overflow')?.removeAttribute('open')
  }
})

// --- Tab keyboard navigation ---
// Alt+Left / Alt+Right: navigate between tabs. Intercepted in capture phase
// so it fires even when a textarea has focus, overriding macOS word-jump
// (as specified). Switches use replaceState so back/forward doesn't walk
// every individual Alt+Right one-by-one.
// Esc: focus Switchboard, unless focus is inside the composer send area.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      e.stopPropagation()
      const buttons = Array.from(document.querySelectorAll('#tab-strip .tab-strip-tab'))
      if (buttons.length === 0) return
      const idx = buttons.findIndex(
        (b) => /** @type {HTMLElement} */ (b).getAttribute('aria-current') === 'page',
      )
      const dir = e.key === 'ArrowRight' ? 1 : -1
      const len = buttons.length
      const nextIdx = ((idx === -1 ? 0 : idx) + dir + len) % len
      const nextBtn = /** @type {HTMLElement} */ (buttons[nextIdx])
      const name = nextBtn.dataset.tabName ?? ''
      focusTab(name, { pushHistory: false }) // replaceState per spec
      return
    }
    if (e.key === 'Escape') {
      // Don't fight a textarea / overflow menu / open <details>; only
      // intercept if focus is NOT inside the composer send area.
      const t = /** @type {HTMLElement} */ (e.target)
      if (t && t.closest && t.closest('.detail-send')) return
      e.preventDefault()
      focusTab('', { pushHistory: false })
    }
  },
  true, // capture phase — beat in-component handlers
)

// Apply the initial route from URL
ensureSwitchboardTabRegistered()
applyRoute(parseUrl(), { skipPush: true })

// --- Mobile keyboard handling ---
// On iOS Safari the on-screen keyboard is an overlay that does not affect
// 100dvh, so a sticky-positioned send bar ends up behind the keyboard and the
// user sees empty padding after the keyboard dismisses. Track the visual
// viewport and resize the body to match. Preserve stream scroll position
// across the resize so the user doesn't get yanked to the top.
if (window.visualViewport) {
  const vv = window.visualViewport
  function updateViewportHeight() {
    // Record stream scroll bottom-distance before the resize changes heights.
    const stream = focusedStream()
    const bottomDist = stream ? stream.scrollHeight - stream.scrollTop - stream.clientHeight : null
    document.body.style.height = vv.height + 'px'
    // Restore relative bottom-anchor after reflow.
    if (stream && bottomDist !== null && bottomDist < 80) {
      // User was near bottom → keep them there as heights shift.
      requestAnimationFrame(() => {
        stream.scrollTop = stream.scrollHeight - stream.clientHeight
      })
    }
  }
  vv.addEventListener('resize', updateViewportHeight)
  vv.addEventListener('scroll', updateViewportHeight)
  updateViewportHeight()
}

function updateBanner() {
  const banner = document.getElementById('notif-banner')
  if (!banner) return
  const text = document.getElementById('notif-banner-text')
  const btn = document.getElementById('notif-banner-btn')
  if (!text || !btn) return

  const dismissed = localStorage.getItem('partyLineNotifBannerDismissed') === '1'
  const insecure = !window.isSecureContext
  const state = notif.getPermissionState()

  // Hide banner entirely when permission is granted OR user dismissed it (for
  // default state only).
  if (state === 'granted') {
    banner.hidden = true
    return
  }
  if (state === 'default' && dismissed) {
    banner.hidden = true
    return
  }
  if (state === 'default') {
    // Quiet hint only, no button. User enables via clicking a bell.
    banner.hidden = false
    text.textContent = '🔔 Click a session bell to enable notifications for that session.'
    btn.hidden = true
    return
  }

  // state === 'denied' OR insecure context
  banner.hidden = false
  if (insecure) {
    text.textContent =
      '🔔 Notifications require HTTPS. Reach the dashboard at https:// (or via a tunnel) to enable.'
    btn.hidden = true
  } else {
    // denied
    text.textContent =
      "🔔 Notifications blocked. Re-enable in your browser's site settings for this page."
    btn.hidden = true
  }
}

document.getElementById('notif-banner-dismiss')?.addEventListener('click', () => {
  localStorage.setItem('partyLineNotifBannerDismissed', '1')
  updateBanner()
})

updateBanner()

// Shared helpers for bell interaction — must be called synchronously from a click handler
// so that requestPermission() fires inside the user gesture (Safari + Chromium requirement).

function handleBellClick(bellEl, session) {
  const state = notif.getPermissionState()

  if (state === 'default') {
    // SYNCHRONOUS requestPermission — no await before this call.
    // Don't flip the bell until permission resolves.
    const p = notif.requestPermission()
    p.then((result) => {
      if (result === 'granted') {
        notif.setEnabled(session, true)
      }
      updateBellUIEverywhere(session)
      updateBanner()
    })
    return
  }

  if (state === 'granted') {
    const next = !notif.isEnabled(session)
    notif.setEnabled(session, next)
    updateBellUIEverywhere(session)
    return
  }

  // state === 'denied' or 'unsupported': clicks do nothing beyond visual feedback.
  updateBellUIEverywhere(session)
}

function updateBellUIEverywhere(session) {
  const on = notif.isEnabled(session)
  const state = notif.getPermissionState()
  const disabled = state !== 'granted'
  const esc = CSS.escape(session)
  const sel = `.notif-bell[data-session="${esc}"], .notif-bell-detail[data-session="${esc}"]`
  document.querySelectorAll(sel).forEach((bell) => {
    bell.classList.toggle('notif-bell-on', on)
    bell.classList.toggle('notif-bell-off', !on)
    bell.classList.toggle('notif-bell-disabled', disabled)
    bell.textContent = on ? '🔔' : '🔕'
    bell.setAttribute('aria-label', 'Notifications for ' + session + ': ' + (on ? 'on' : 'off'))
  })
}

function refreshNotifState() {
  updateBanner()
  // Re-render every bell — the disabled class depends on permission state.
  document.querySelectorAll('.notif-bell').forEach((bell) => {
    const session = bell.getAttribute('data-session')
    if (session) updateBellUIEverywhere(session)
  })
}

// Delegated bell-toggle handler on the Switchboard grid.
document.getElementById('overview-grid')?.addEventListener('click', (ev) => {
  const target = ev.target
  if (!(target instanceof HTMLElement)) return
  const bell = target.closest('.notif-bell')
  if (!bell) return
  ev.stopPropagation()

  const session = bell.getAttribute('data-session')
  if (!session) return

  handleBellClick(bell, session)
})

// --- Permission request cards ---

function renderPermissionCard(data, streamRoot) {
  if (!streamRoot) return

  const existing = streamRoot.querySelector(
    `.perm-card[data-request-id="${CSS.escape(data.request_id)}"]`,
  )
  if (existing) return // idempotent (per stream)

  const card = document.createElement('div')
  card.className = 'perm-card perm-card-pending'
  card.setAttribute('data-request-id', data.request_id)

  const header = document.createElement('div')
  header.className = 'perm-card-header'
  header.append('🔐 Permission requested: ')
  const toolStrong = document.createElement('strong')
  toolStrong.textContent = data.tool_name
  header.appendChild(toolStrong)
  card.appendChild(header)

  const descr = document.createElement('div')
  descr.className = 'perm-card-descr'
  descr.textContent = data.description
  card.appendChild(descr)

  const details = document.createElement('details')
  details.className = 'perm-card-details'
  const summary = document.createElement('summary')
  summary.textContent = 'Show input preview'
  details.appendChild(summary)
  const pre = document.createElement('pre')
  pre.className = 'perm-card-input'
  let pretty = data.input_preview
  try {
    pretty = JSON.stringify(JSON.parse(data.input_preview), null, 2)
  } catch {
    /* keep as-is if not JSON */
  }
  pre.textContent = pretty
  details.appendChild(pre)
  card.appendChild(details)

  const actions = document.createElement('div')
  actions.className = 'perm-card-actions'
  const allowBtn = document.createElement('button')
  allowBtn.className = 'perm-btn perm-btn-allow'
  allowBtn.textContent = '✅ Allow'
  const denyBtn = document.createElement('button')
  denyBtn.className = 'perm-btn perm-btn-deny'
  denyBtn.textContent = '❌ Deny'
  const statusEl = document.createElement('span')
  statusEl.className = 'perm-card-status'
  statusEl.hidden = true
  actions.appendChild(allowBtn)
  actions.appendChild(denyBtn)
  actions.appendChild(statusEl)
  card.appendChild(actions)

  allowBtn.addEventListener('click', () => respondToPermission(data, 'allow', card))
  denyBtn.addEventListener('click', () => respondToPermission(data, 'deny', card))

  const wasNear = isNearBottom(streamRoot)
  streamRoot.appendChild(card)
  if (wasNear) streamRoot.scrollTop = streamRoot.scrollHeight
}

async function respondToPermission(data, behavior, card) {
  const allowBtn = card.querySelector('.perm-btn-allow')
  const denyBtn = card.querySelector('.perm-btn-deny')
  const statusEl = card.querySelector('.perm-card-status')
  if (allowBtn) allowBtn.disabled = true
  if (denyBtn) denyBtn.disabled = true
  try {
    const res = await fetch('/api/permission-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: data.session, request_id: data.request_id, behavior }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    // Success: server will broadcast permission-resolved which updates the card.
  } catch (err) {
    if (allowBtn) allowBtn.disabled = false
    if (denyBtn) denyBtn.disabled = false
    if (statusEl) {
      statusEl.hidden = false
      statusEl.textContent = 'Error: ' + (err.message || 'send failed')
      statusEl.className = 'perm-card-status perm-card-status-error'
    }
  }
}

function updatePermissionCardResolved(data) {
  const cards = document.querySelectorAll(
    `.perm-card[data-request-id="${CSS.escape(data.request_id)}"]`,
  )
  if (cards.length === 0) return
  for (const card of cards) {
    card.classList.remove('perm-card-pending')
    card.classList.add('perm-card-resolved')
    const actions = card.querySelector('.perm-card-actions')
    if (actions) {
      actions.replaceChildren()
      const status = document.createElement('span')
      status.className = 'perm-card-status perm-card-status-' + data.behavior
      status.textContent = data.behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
      actions.appendChild(status)
    }
  }
}

// When the tab becomes visible again, reconnect the observer WebSocket if it
// dropped while backgrounded. On iOS, setTimeout timers are suspended during
// PWA hibernation, so the scheduled 2-second reconnect never fires — the WS
// stays dead until the user force-quits. Checking explicitly on wake fixes this.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    connect()
  }
  if (!focusedTabName) return
  notif.dispatchSessionViewed(focusedTabName)
  refreshNotifState()
})

// pageshow fires when iOS restores a page from bfcache (full JS suspension).
// visibilitychange may already have fired, but ws.readyState check is cheap.
window.addEventListener('pageshow', (e) => {
  if (e.persisted && (!ws || ws.readyState !== WebSocket.OPEN)) {
    connect()
  }
})

window.addEventListener('focus', refreshNotifState)

if (navigator.permissions && navigator.permissions.query) {
  navigator.permissions
    .query({ name: 'notifications' })
    .then((status) => {
      status.onchange = refreshNotifState
    })
    .catch(() => {
      // Some Safari versions throw on name: 'notifications'. Fine — fall through.
    })
}

// --- PWA install prompt ---

let deferredInstallPrompt = null
const installBtn = document.getElementById('pwa-install-btn')

window.addEventListener('beforeinstallprompt', (e) => {
  // Chrome fires this when criteria are met; we stash it and show our own button.
  e.preventDefault()
  deferredInstallPrompt = e
  if (installBtn) installBtn.hidden = false
})

installBtn?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return
  deferredInstallPrompt.prompt()
  const { outcome } = await deferredInstallPrompt.userChoice
  console.log('[pwa] install outcome:', outcome)
  deferredInstallPrompt = null
  installBtn.hidden = true
})

window.addEventListener('appinstalled', () => {
  console.log('[pwa] installed')
  if (installBtn) installBtn.hidden = true
})

// iOS Safari: no beforeinstallprompt. Detect + show a one-time hint.
function maybeShowIosInstallHint() {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const inStandalone = 'standalone' in navigator && navigator['standalone'] === true
  const dismissed = localStorage.getItem('pl-install-hint-dismissed') === '1'
  if (!isIos || inStandalone || dismissed) return

  const hint = document.createElement('div')
  hint.className = 'ios-install-hint'
  hint.textContent = 'Tap Share → Add to Home Screen to install Party Line.'
  const close = document.createElement('button')
  close.className = 'ios-install-hint-close'
  close.textContent = '×'
  close.addEventListener('click', () => {
    localStorage.setItem('pl-install-hint-dismissed', '1')
    hint.remove()
  })
  hint.appendChild(close)
  document.body.appendChild(hint)
}

maybeShowIosInstallHint()

// /ws/observer does NOT push quota or overrides on connect — fetch initial
// state via REST so the UI is populated before (and regardless of) the
// periodic broadcast that serve.ts sends.
fetch('/api/overrides')
  .then(function (r) {
    return r.ok ? r.json() : null
  })
  .then(function (data) {
    if (data) {
      contextOverrides = data
      if (lastSessions.length > 0) updateSessions(lastSessions)
    }
  })
  .catch(function () {
    /* ignore */
  })

fetch('/api/quota')
  .then(function (r) {
    return r.ok ? r.json() : null
  })
  .then(function (data) {
    if (data && !data.error) updateQuota(data)
  })
  .catch(function () {
    /* ignore */
  })

connect()

// --- Session-detail HISTORY sidebar -----------------------------------------
// Renders the right-hand sidebar's HISTORY section with one row per
// live + archived cc_session_uuid for the selected session. Backend endpoints
// /api/archives and /api/archive-label feed this.

/**
 * @param {string} sessionName
 * @param {string | null} currentArchiveUuid
 * @param {Document | HTMLElement} [scope]
 */
async function renderHistorySidebar(sessionName, currentArchiveUuid, scope) {
  scope = scope || document
  var el = scopedById(scope, 'detail-history')
  if (!el) return
  el.replaceChildren()
  var res = await fetch('/api/archives?session=' + encodeURIComponent(sessionName))
  if (!res.ok) {
    var errLi = document.createElement('li')
    errLi.className = 'history-row'
    errLi.style.color = 'var(--text-dim)'
    errLi.textContent = 'unable to load'
    el.appendChild(errLi)
    return
  }
  var data = await res.json()
  if (data.live) {
    el.appendChild(makeHistoryRow(sessionName, data.live, true, currentArchiveUuid))
  }
  for (var i = 0; i < data.archives.length; i++) {
    el.appendChild(makeHistoryRow(sessionName, data.archives[i], false, currentArchiveUuid))
  }
  if (!data.live && data.archives.length === 0) {
    var empty = document.createElement('li')
    empty.className = 'history-row'
    empty.style.color = 'var(--text-dim)'
    empty.textContent = '(no history yet)'
    el.appendChild(empty)
  }
}

function makeHistoryRow(sessionName, item, isLive, selectedUuid) {
  var li = document.createElement('li')
  li.className = 'history-row' + (isLive ? ' history-row-live' : '')
  if ((isLive && !selectedUuid) || item.uuid === selectedUuid) {
    li.classList.add('selected')
  }
  var label = document.createElement('div')
  label.className = 'history-row-label'
  label.textContent = item.label || (isLive ? 'LIVE' : '(no transcript)')
  li.appendChild(label)
  var meta = document.createElement('div')
  meta.className = 'history-row-meta'
  meta.textContent = isLive ? 'LIVE' : relativeTime(item.archived_at)
  li.appendChild(meta)
  li.addEventListener('click', function () {
    var state = isLive
      ? { view: 'session-detail', sessionName: sessionName, agentId: null, archiveUuid: null }
      : {
          view: 'session-detail',
          sessionName: sessionName,
          agentId: null,
          archiveUuid: item.uuid,
        }
    pushRoute(state)
    applyRoute(state, { skipPush: true })
  })
  attachHistoryTooltip(li, item.uuid)
  return li
}

function relativeTime(ms) {
  var diff = Date.now() - ms
  var sec = Math.floor(diff / 1000)
  if (sec < 60) return sec + 's ago'
  var min = Math.floor(sec / 60)
  if (min < 60) return min + 'm ago'
  var hr = Math.floor(min / 60)
  if (hr < 24) return hr + 'h ago'
  var day = Math.floor(hr / 24)
  if (day < 30) return day + 'd ago'
  return new Date(ms).toLocaleDateString()
}

var __historyTooltipCache = {}
function attachHistoryTooltip(li, uuid) {
  var tipEl = null
  var isHovered = false
  li.addEventListener('mouseenter', async function () {
    isHovered = true
    var label = __historyTooltipCache[uuid]
    if (label === undefined) {
      try {
        var r = await fetch('/api/archive-label?uuid=' + encodeURIComponent(uuid))
        if (r.ok) {
          var b = await r.json()
          label = b.label
        } else {
          label = null
        }
      } catch (e) {
        label = null
      }
      __historyTooltipCache[uuid] = label
    }
    // Bail if the user moved away while we were fetching.
    if (!isHovered || !label) return
    tipEl = document.createElement('div')
    tipEl.className = 'history-tooltip'
    tipEl.textContent = label
    document.body.appendChild(tipEl)
    var rect = li.getBoundingClientRect()
    tipEl.style.left = rect.right + 8 + 'px'
    tipEl.style.top = rect.top + 'px'
  })
  li.addEventListener('mouseleave', function () {
    isHovered = false
    if (tipEl && tipEl.parentNode) tipEl.parentNode.removeChild(tipEl)
    tipEl = null
  })
}

// --- Archive view mode: banner + read-only send bar -------------------------
// Toggles the archive banner above the session header and disables the
// send composer so the user can't try to message into a frozen archive.
var __archiveBackHandler = null
function setArchiveMode(sessionName, archiveUuid) {
  var tab = tabRegistry.get(sessionName)
  if (!tab || !tab.contentEl) return
  var banner = scopedById(tab.contentEl, 'archive-banner')
  var sendBar = tab.contentEl.querySelector('.detail-send')
  if (archiveUuid) {
    if (banner) banner.hidden = false
    var txt = scopedById(tab.contentEl, 'archive-banner-text')
    if (txt) txt.textContent = 'Viewing archive · uuid ' + archiveUuid.slice(0, 8) + '…'
    var back = scopedById(tab.contentEl, 'archive-back-link')
    if (back) {
      // Remove any prior handler so we don't accumulate listeners across navigations.
      if (__archiveBackHandler) back.removeEventListener('click', __archiveBackHandler)
      __archiveBackHandler = function (ev) {
        ev.preventDefault()
        var liveState = {
          view: 'session-detail',
          sessionName: sessionName,
          agentId: null,
          archiveUuid: null,
        }
        pushRoute(liveState)
        applyRoute(liveState, { skipPush: true })
      }
      back.addEventListener('click', __archiveBackHandler)
    }
    if (sendBar) {
      sendBar.classList.add('archive-readonly')
      sendBar.setAttribute('aria-hidden', 'true')
    }
  } else {
    if (banner) banner.hidden = true
    if (sendBar) {
      sendBar.classList.remove('archive-readonly')
      sendBar.removeAttribute('aria-hidden')
    }
  }
}
