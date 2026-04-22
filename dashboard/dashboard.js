import { createNotifications } from './notifications.js'

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
  swRegistration = navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((reg) => reg)
    .catch((err) => {
      console.error('[sw] registration failed:', err)
      return null
    })
}
let sessionSources = {} // session name -> source string, populated from session-update events
let currentView = 'switchboard'
let localMachineId = null
let sessionMachines = {} // session name -> machine_id
let sessionActiveSubagents = {} // session name -> count of active subagents

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
  unreadCounts[sessionKey] = (unreadCounts[sessionKey] || 0) + 1
  updateSessions(lastSessions)
}

function resolveNameFromJsonlPath(path) {
  if (!path) return null
  const m = path.match(/\/([0-9a-f-]+)\.jsonl$/)
  if (!m) return null
  const sid = m[1]
  const found = lastSessions.find(
    (s) => s.metadata && s.metadata.status && s.metadata.status.sessionId === sid,
  )
  return found ? found.name : null
}

fetch('/api/self')
  .then((r) => r.json())
  .then((data) => {
    localMachineId = data.machine_id
  })
  .catch(() => {})
let selectedSessionId = null
let selectedAgentId = null
let currentSessionSubagents = []
var historyBuffer = []

// --- URL Router ---

function parseUrl() {
  const path = window.location.pathname
  // /session/<name>/agent/<id>
  let m = path.match(/^\/session\/([^/]+)\/agent\/([^/]+)\/?$/)
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
  const sessionDetailTab = document.querySelector('button[data-view="session-detail"]')

  if (state.view === 'session-detail') {
    if (!state.sessionName) {
      applyRoute({ view: 'switchboard' }, { skipPush: true })
      return
    }
    const known =
      Array.isArray(lastSessions) && lastSessions.some((s) => s.name === state.sessionName)
    selectedSessionId = state.sessionName
    selectedAgentId = state.agentId || null
    notif.dispatchSessionViewed(state.sessionName)
    if (sessionDetailTab) {
      sessionDetailTab.disabled = false
    }
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'))
    if (sessionDetailTab) sessionDetailTab.classList.add('active')
    renderView('session-detail')
    if (!known) {
      if (!sessionsReady) {
        // Defer the "unknown session" UI until we've heard from the server at least once.
        pendingRouteState = state
        const stream = document.getElementById('detail-stream')
        if (stream) {
          stream.replaceChildren()
          const p = document.createElement('p')
          p.style.color = 'var(--text-dim)'
          p.textContent = 'Loading session…'
          stream.appendChild(p)
        }
        return
      }
      // Sessions are loaded and this name is genuinely unknown — render the fallback.
      setTimeout(() => {
        const stream = document.getElementById('detail-stream')
        if (!stream) return
        stream.replaceChildren()
        const p = document.createElement('p')
        p.style.color = 'var(--text-dim)'
        p.textContent =
          'Session "' +
          state.sessionName +
          '" is not currently known to the dashboard. It may have ended or the name may have changed. '
        const back = document.createElement('a')
        back.href = '/'
        back.textContent = 'Back to Switchboard'
        back.addEventListener('click', (e) => {
          e.preventDefault()
          navigate({ view: 'switchboard' })
        })
        p.appendChild(back)
        stream.appendChild(p)
      }, 100)
    }
  } else if (state.view === 'history') {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'))
    const histTab = document.querySelector('button[data-view="history"]')
    if (histTab) histTab.classList.add('active')
    renderView('history')
    if (state.subtab) {
      const subBtn = document.querySelector(
        '#history-subtabs button[data-subtab="' + state.subtab + '"]',
      )
      if (subBtn) subBtn.click()
    }
  } else {
    // switchboard
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'))
    const swTab = document.querySelector('button[data-view="switchboard"]')
    if (swTab) swTab.classList.add('active')
    renderView('switchboard')
  }

  if (!opts.skipPush) pushRoute(state)
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
  if (view === 'session-detail' && selectedSessionId) {
    markSessionViewed(selectedSessionId)
    unreadCounts[selectedSessionId] = 0
    updateSessions(lastSessions)
    loadSessionDetailView()
  }
}

document.getElementById('tabs').addEventListener('click', function (e) {
  var btn = e.target.closest('button[data-view]')
  if (!btn || btn.disabled) return
  const view = btn.dataset.view
  if (view === 'switchboard') navigate({ view: 'switchboard' })
  else if (view === 'history') navigate({ view: 'history' })
  else if (view === 'session-detail' && selectedSessionId)
    navigate({ view: 'session-detail', sessionName: selectedSessionId, agentId: selectedAgentId })
})

function esc(s) {
  const el = document.createElement('span')
  el.textContent = s
  return el.innerHTML
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(proto + '//' + location.host + '/ws/observer')

  ws.onopen = function () {
    connStatus.textContent = 'connected'
    connStatus.style.color = '#3fb950'
  }

  ws.onclose = function (e) {
    // Auth failure (1006 abnormal close during handshake, or 4401) → redirect to login.
    if (e.code === 1006 || e.code === 4401) {
      var nextPath = location.pathname + location.hash
      location.href = '/login?next=' + encodeURIComponent(nextPath)
      return
    }
    connStatus.textContent = 'reconnecting\u2026'
    connStatus.style.color = 'var(--yellow)'
    setTimeout(connect, 2000)
  }

  ws.onmessage = function (e) {
    var data
    try {
      data = JSON.parse(e.data)
    } catch (err) {
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
      if (adapted.to && adapted.to !== 'all') bumpUnread(adapted.to)
      try {
        notif.onPartyLineMessage(adapted)
      } catch (err) {
        console.error('[notifications] onPartyLineMessage threw', err)
      }
      if (
        currentView === 'session-detail' &&
        selectedSessionId &&
        (adapted.from === selectedSessionId || adapted.to === selectedSessionId)
      ) {
        appendEnvelopeToStream(adapted)
      }
    } else if (data.type === 'permission-request') {
      try {
        notif.onPermissionRequest(data.data || data)
      } catch (err) {
        console.error('[notifications] onPermissionRequest threw', err)
      }
      renderPermissionCard(data.data || data)
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
      // Unread counter: ONLY bump on events that represent a real
      // "something you should look at" moment — session finished turn (Stop),
      // Notification hook (model asked for input), or session-end. Tool
      // calls, user prompts, subagent spawns, etc. don't count.
      if (
        data.data &&
        data.data.session_name &&
        (data.data.hook_event === 'Stop' ||
          data.data.hook_event === 'Notification' ||
          data.data.hook_event === 'SessionEnd')
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

function getEffectiveContextLimit(name, st) {
  // Override from user config takes priority
  if (contextOverrides[name] && contextOverrides[name].contextLimit) {
    return contextOverrides[name].contextLimit
  }
  // Derive from model: Opus defaults to 1M, everything else 200k
  var model = st && st.model ? st.model : ''
  if (model.indexOf('opus') !== -1) return 1000000
  return 200000
}

function showContextMenu(e, sessionName, model) {
  e.preventDefault()
  var menu = document.getElementById('ctxMenu')
  var isOpus = model && model.indexOf('opus') !== -1
  menu.textContent = ''

  if (isOpus) {
    var header = document.createElement('div')
    header.className = 'ctx-menu-header'
    header.textContent = 'Context Window'
    menu.appendChild(header)

    // Find the session's status from lastSessions
    var sessionSt = null
    for (var i = 0; i < lastSessions.length; i++) {
      if (lastSessions[i].name === sessionName) {
        sessionSt = lastSessions[i].metadata && lastSessions[i].metadata.status
        break
      }
    }
    var currentLimit = getEffectiveContextLimit(sessionName, sessionSt)

    ;[
      { label: '1M tokens', value: 1000000 },
      { label: '200k tokens', value: 200000 },
    ].forEach(function (opt) {
      var item = document.createElement('div')
      item.className = 'ctx-menu-item'
      item.textContent = opt.label
      if (currentLimit === opt.value) {
        var check = document.createElement('span')
        check.className = 'check'
        check.textContent = '\u2713'
        item.appendChild(check)
      }
      item.addEventListener('click', function () {
        fetch('/api/overrides', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: sessionName, contextLimit: opt.value }),
        })
        contextOverrides[sessionName] = { contextLimit: opt.value }
        menu.classList.remove('visible')
        updateSessions(lastSessions)
      })
      menu.appendChild(item)
    })
  } else {
    var noOpt = document.createElement('div')
    noOpt.className = 'ctx-menu-header'
    noOpt.textContent = 'No options for ' + (model || 'unknown model')
    menu.appendChild(noOpt)
  }

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
  if (currentView === 'session-detail' && selectedSessionId === name) {
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
      pressCard = card
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

// Kebab on the session-detail header.
document.getElementById('detail-actions')?.addEventListener('click', (ev) => {
  ev.stopPropagation()
  if (!selectedSessionId) return
  const btn = ev.currentTarget
  const r = btn.getBoundingClientRect()
  showSessionActionsMenu(selectedSessionId, r.left, r.bottom + 4)
})

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
  sessionRevisions.clear()
  sessions.forEach(function (s) {
    sessionRevisions.set(s.name, s.revision)
  })
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
  if (currentView === 'session-detail' && selectedSessionId === delta.session) {
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
    var ctxPctSpan = document.createElement('span')
    ctxPctSpan.className = 'ctx-pct'
    ctxPctSpan.textContent = 'ctx ' + pct + '%'
    ctxPctSpan.title =
      formatTokens(st.contextTokens) + ' / ' + formatTokens(effLimit) + ' tokens (' + pct + '%)'
    metaEl.appendChild(ctxPctSpan)
    ctxBar = buildCtxBar(pct)
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

function buildCtxBar(pct) {
  var wrap = document.createElement('div')
  wrap.className = 'card-ctx-bar'
  var fill = document.createElement('div')
  fill.className = 'card-ctx-bar-fill ' + (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok')
  fill.style.width = Math.min(100, Math.max(0, pct)) + '%'
  wrap.appendChild(fill)
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
    openSessionDetail(s.name)
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
  if (currentView === 'session-detail' && session && session.name === selectedSessionId) {
    renderDetailHeader(session)
    fetch('/api/session?id=' + encodeURIComponent(selectedSessionId))
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
function handleUserPromptLive(data) {
  if (!data || !data.session_name || typeof data.prompt !== 'string') return
  if (currentView !== 'session-detail') return
  if (data.session_name !== selectedSessionId) return
  const root = document.getElementById('detail-stream')
  if (!root) return
  const textKey = 'user-text:' + data.prompt
  if (renderedEntryKeys.has(textKey)) return
  renderedEntryKeys.add(textKey)
  const entry = {
    uuid: 'pending:' + (data.session_id || '') + ':' + data.ts,
    ts: data.ts || new Date().toISOString(),
    type: 'user',
    text: data.prompt,
  }
  renderedEntryKeys.add(entry.uuid)
  const wasNearBottom = isNearBottom(root)
  root.appendChild(renderEntry(entry))
  if (wasNearBottom) root.scrollTop = root.scrollHeight
}

// Claude Code API errors (overloaded / rate-limit) don't fire a Stop hook —
// without this, sessions stay "working" forever. The backend classifies the
// JSONL record and emits an `api-error` frame; here we notify and bump unread
// the same way we treat a Stop.
function handleApiError(data) {
  if (!data || !data.session_name) return
  bumpUnread(data.session_name)
  try {
    notif.onApiError(data)
  } catch (err) {
    console.error('[notifications] onApiError threw', err)
  }
}

function handleJsonlEvent(update) {
  if (currentView !== 'session-detail') return
  if (!update) return
  const parentMatches =
    update.session_id === selectedSessionId ||
    resolveNameFromJsonlPath(update.file_path) === selectedSessionId
  const agentMatches = selectedAgentId && update.session_id === selectedAgentId
  if (!parentMatches && !agentMatches) return
  // Use incremental mode: only fetch entries appended since the last render.
  // renderStream will fall back to a full fetch if lastRenderedUuid is null
  // (first load) or if the server can't find the uuid (post-compaction).
  renderStream({ incremental: true })
}

/**
 * Handle a stream-reset notification — fired by the JSONL observer when a
 * session transcript file shrinks (compaction / file replacement).
 * If the affected file belongs to the currently-viewed session, force a full
 * transcript re-fetch so the client doesn't display stale or gap content.
 */
function handleStreamReset(data) {
  if (currentView !== 'session-detail' || !selectedSessionId) return
  if (!data || !data.file_path) return
  const sessionName = resolveNameFromJsonlPath(data.file_path)
  const sessionId = (data.file_path.match(/\/([0-9a-f-]+)\.jsonl$/) || [])[1]
  if (sessionName !== selectedSessionId && sessionId !== selectedSessionId) return
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
  if (currentView !== 'session-detail' || !selectedSessionId) return

  // Match by session UUID or session name (whichever the event carries).
  const matchesId = evPayload.session_id && evPayload.session_id === selectedSessionId
  const matchesName = evPayload.session_name && evPayload.session_name === selectedSessionId
  if (!matchesId && !matchesName) return

  // Compaction rewrites the JSONL — our lastRenderedUuid is now stale.
  // Force a complete re-fetch so the stream reflects the new file.
  renderStream({ force: true })
}

// Append a single party-line envelope directly to the stream without a
// full /api/transcript fetch. Used for instant self-loopback feedback.
function appendEnvelopeToStream(envelope) {
  if (!envelope || !selectedSessionId) return
  // Skip protocol-level chatter — users never want to see these in a session view.
  if (envelope.type === 'heartbeat' || envelope.type === 'announce') return
  const root = document.getElementById('detail-stream')
  if (!root) return
  const key = envelope.id
  if (renderedEntryKeys.has(key)) return
  const isSent = envelope.from === selectedSessionId
  // When the user sends a message from the dashboard's session-detail send box,
  // the envelope comes back as from="dashboard" → viewed session. Render it as
  // a "you:" user entry so it matches how it'll look after a refresh (the
  // recipient's JSONL records the incoming channel message as a user turn).
  const fromDashboardToSelf = envelope.from === 'dashboard' && envelope.to === selectedSessionId
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
  const wasNear = isNearBottom(root)
  renderedEntryKeys.add(key)
  root.appendChild(renderEntry(entry))
  if (wasNear) {
    root.scrollTop = root.scrollHeight
    missedWhileScrolledUp = 0
  } else {
    updateScrollToBottomButton(1)
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
    if (nameEl) nameEl.textContent = selectedSessionId || ''
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
  if (!session || !selectedSessionId) return
  var sessionKey = session.session_id || session.session_name
  if (sessionKey !== selectedSessionId) return
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

async function loadSessionDetailView() {
  if (!selectedSessionId) return
  const sessionKey = selectedSessionId

  document.getElementById('detail-name').textContent = sessionKey
  updateDetailBell(sessionKey)

  try {
    const r = await fetch('/api/session?id=' + encodeURIComponent(sessionKey))
    const data = await r.json()
    currentSessionSubagents = data.subagents || []
    if (data.session) renderDetailHeader(data.session)
    renderAgentTree()
  } catch (e) {
    console.warn('session fetch failed', e)
  }

  // selectedAgentId is set by the router before loadSessionDetailView is called;
  // do not reset it here so deep-linked agent views are honoured.
  await renderStream()
}

function renderDetailHeader(session) {
  const pill = document.getElementById('detail-state')
  pill.className = 'state-pill state-' + (session.state || 'idle')
  pill.textContent = (session.state || 'idle').toUpperCase()
  document.getElementById('detail-cwd').textContent = session.cwd || ''

  // Fall back to multicast status for ctx/model since the aggregator's
  // sessions table doesn't capture those from hook payloads.
  const name = session.name || selectedSessionId
  const multicast = (lastSessions || []).find((x) => x.name === name)
  const st = multicast && multicast.metadata && multicast.metadata.status

  const model = session.model || (st && st.model)
  document.getElementById('detail-model').textContent = model ? model.replace('claude-', '') : ''

  const ctxTokens = (st && st.contextTokens) || session.context_tokens
  const ctxEl = document.getElementById('detail-ctx')
  if (ctxTokens) {
    const limit = getEffectiveContextLimit(name, st)
    const pct = Math.round((ctxTokens / limit) * 100)
    ctxEl.textContent =
      'ctx ' + formatTokens(ctxTokens) + ' / ' + formatTokens(limit) + ' (' + pct + '%)'
  } else {
    ctxEl.textContent = ''
  }

  const hostEl = document.getElementById('detail-host')
  if (session.machine_id && localMachineId && session.machine_id !== localMachineId) {
    hostEl.textContent = 'host: ' + session.machine_id.slice(0, 8)
  } else {
    hostEl.textContent = ''
  }

  // Active subagents for this session (the aggregator enriches session-update
  // with active_subagents; fall back to the cached per-name count).
  const subEl = document.getElementById('detail-subagents')
  if (subEl) {
    const n =
      typeof session.active_subagents === 'number'
        ? session.active_subagents
        : sessionActiveSubagents[name] || 0
    subEl.textContent = n > 0 ? '⎇ ' + n + ' subagent' + (n === 1 ? '' : 's') : ''
  }

  // Last message / tool excerpt — what is the session actually doing right now?
  const lastEl = document.getElementById('detail-last')
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

  updateDetailBell(session.name || selectedSessionId)
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

function renderAgentTree() {
  const ul = document.getElementById('detail-tree')
  ul.replaceChildren()

  // 'main' row — always visible at top
  const mainLi = document.createElement('li')
  mainLi.dataset.agentId = ''
  mainLi.textContent = '▸ main'
  if (!selectedAgentId) mainLi.classList.add('active')
  mainLi.addEventListener('click', () => {
    selectedAgentId = null
    navigate({ view: 'session-detail', sessionName: selectedSessionId, agentId: null })
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
    if (selectedAgentId && completed.some((sa) => sa.agent_id === selectedAgentId)) {
      details.open = true
    }
    const summary = document.createElement('summary')
    summary.textContent = 'Completed (' + completed.length + ')'
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
  if (selectedAgentId === sa.agent_id) li.classList.add('active')
  li.addEventListener('click', (e) => {
    e.stopPropagation() // don't bubble up and toggle the parent details group
    selectedAgentId = sa.agent_id
    navigate({ view: 'session-detail', sessionName: selectedSessionId, agentId: sa.agent_id })
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

function updateScrollToBottomButton(newlyMissed) {
  const btn = document.getElementById('scroll-to-bottom')
  const stream = document.getElementById('detail-stream')
  if (!btn || !stream) return
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

;(function wireScrollToBottom() {
  const btn = document.getElementById('scroll-to-bottom')
  const stream = document.getElementById('detail-stream')
  if (!btn || !stream) return
  btn.addEventListener('click', () => {
    stream.scrollTop = stream.scrollHeight
    missedWhileScrolledUp = 0
    btn.hidden = true
  })
  stream.addEventListener('scroll', () => updateScrollToBottomButton(0))
})()

async function renderStream(opts) {
  const root = document.getElementById('detail-stream')
  if (!root) return
  if (!selectedSessionId) {
    root.replaceChildren()
    return
  }

  const streamKey = selectedSessionId + '|' + (selectedAgentId || '')
  const isNewStream = streamKey !== renderedStreamKey
  const force = opts && opts.force
  // Incremental mode: only fetch entries after the last rendered uuid.
  // Disabled when: no prior uuid, new stream, or force refetch.
  const incremental = opts && opts.incremental && !isNewStream && !force && lastRenderedUuid

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
    encodeURIComponent(selectedSessionId) +
    (selectedAgentId ? '&agent_id=' + encodeURIComponent(selectedAgentId) : '') +
    '&limit=300'
  if (incremental && lastRenderedUuid) {
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
  let appendedCount = 0
  for (const e of entries) {
    const key = e.uuid || e.ts + '|' + e.type + '|' + (e.envelope_id || '')
    const textKey = e.type === 'user' && e.text ? 'user-text:' + e.text : null
    if (renderedEntryKeys.has(key)) continue
    if (textKey && renderedEntryKeys.has(textKey)) continue
    renderedEntryKeys.add(key)
    if (textKey) renderedEntryKeys.add(textKey)
    root.appendChild(renderEntry(e))
    appendedCount++
    // Update the incremental cursor to the newest entry's uuid.
    if (e.uuid) lastRenderedUuid = e.uuid
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

// Pending attachments per send-form. Each is { id, name, size, kind, media_type, url, objectUrl?, status }.
let pendingAttachments = []

function renderAttachChips() {
  const wrap = document.getElementById('detail-attach-chips')
  if (!wrap) return
  wrap.replaceChildren()
  if (pendingAttachments.length === 0) {
    wrap.hidden = true
    return
  }
  wrap.hidden = false
  for (const p of pendingAttachments) {
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
      pendingAttachments = pendingAttachments.filter((q) => q !== p)
      if (p.objectUrl) URL.revokeObjectURL(p.objectUrl)
      renderAttachChips()
    })
    chip.appendChild(x)
    wrap.appendChild(chip)
  }
}

async function uploadPending(file) {
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
  pendingAttachments.push(placeholder)
  renderAttachChips()
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
    renderAttachChips()
  }
}

function addFiles(fileList) {
  for (const f of Array.from(fileList)) {
    if (pendingAttachments.length >= 5) {
      console.warn('[attach] max 5 attachments; ignoring', f.name)
      break
    }
    uploadPending(f)
  }
}

function doDetailSend() {
  if (!selectedSessionId) return
  const textarea = document.getElementById('detail-send-msg')
  const msg = textarea.value.trim()
  const readyAtts = pendingAttachments.filter((p) => p.status === 'ready' && p.id)
  if (!msg && readyAtts.length === 0) return
  const uploading = pendingAttachments.some((p) => p.status === 'uploading')
  if (uploading) {
    // Let the upload finish first — user can retry Send.
    console.warn('[detail-send] waiting for uploads')
    return
  }
  const payload = {
    to: selectedSessionId,
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
  autosizeDetailSend()
  textarea.focus()
  // Clear chips (revoke object URLs).
  for (const p of pendingAttachments) if (p.objectUrl) URL.revokeObjectURL(p.objectUrl)
  pendingAttachments = []
  renderAttachChips()
}

// Auto-resize the session send textarea up to ~4 lines, then scroll.
function autosizeDetailSend() {
  const ta = document.getElementById('detail-send-msg')
  if (!ta) return
  ta.style.height = 'auto'
  const max = 4 * parseFloat(getComputedStyle(ta).lineHeight || '20') + 16
  ta.style.height = Math.min(ta.scrollHeight, max) + 'px'
}

// Wire textarea behaviors once.
;(function wireDetailSend() {
  const ta = document.getElementById('detail-send-msg')
  if (!ta) return
  ta.addEventListener('input', autosizeDetailSend)
  ta.addEventListener('keydown', (e) => {
    // Enter inserts a newline (default textarea behavior); Ctrl+Enter or
    // Cmd+Enter sends. The Send button works on any device.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault()
      doDetailSend()
    }
  })

  // File picker
  const btn = document.getElementById('detail-attach-btn')
  const input = document.getElementById('detail-attach-input')
  if (btn && input) {
    btn.addEventListener('click', () => input.click())
    input.addEventListener('change', () => {
      if (input.files && input.files.length > 0) addFiles(input.files)
      input.value = ''
    })
  }

  // Paste: intercept clipboard items that are files (screenshot, copied image, etc.)
  ta.addEventListener('paste', (e) => {
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
      addFiles(files)
    }
  })

  // Drag-and-drop onto the send form
  const form = document.getElementById('detail-send')
  if (form) {
    let depth = 0
    const enter = (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return
      e.preventDefault()
      depth++
      form.classList.add('drop-target')
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) form.classList.remove('drop-target')
    }
    form.addEventListener('dragenter', enter)
    form.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))
        e.preventDefault()
    })
    form.addEventListener('dragleave', leave)
    form.addEventListener('drop', (e) => {
      e.preventDefault()
      depth = 0
      form.classList.remove('drop-target')
      const files = e.dataTransfer?.files
      if (files && files.length > 0) addFiles(files)
    })
  }
})()

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
// via WebSocket. Noop until the list has been loaded at least once.
function handleHookEvent(ev) {
  if (!historyLoaded) return
  var list = document.getElementById('history-list')
  if (!list) return
  // Skip the "No events" placeholder if present.
  var placeholder = list.querySelector('.history-empty')
  if (placeholder) placeholder.remove()
  addHookOption(ev.hook_event)
  historyEvents.unshift(ev)
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

document.getElementById('detail-back').addEventListener('click', function () {
  var tab = document.querySelector('button[data-view="switchboard"]')
  if (tab) tab.click()
})

document.getElementById('detail-drawer-toggle').addEventListener('click', () => {
  document.getElementById('detail-sidebar').classList.toggle('open')
})

document.getElementById('detail-stream').addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn')
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
  const codeBtn = e.target.closest('.code-copy-btn')
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

  // Spawn marker: summary toggle (native <details>); only the explicit
  // "View this agent" button navigates to the subagent.
  const viewAgentBtn = e.target.closest('.view-agent')
  if (viewAgentBtn && viewAgentBtn.dataset.agentId) {
    e.preventDefault()
    navigate({
      view: 'session-detail',
      sessionName: selectedSessionId,
      agentId: viewAgentBtn.dataset.agentId,
    })
    return
  }

  const pl = e.target.closest('.pl-entry')
  if (pl && pl.dataset.otherSession) {
    navigate({ view: 'session-detail', sessionName: pl.dataset.otherSession, agentId: null })
    return
  }
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

// Apply the initial route from URL
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
    const stream = document.getElementById('detail-stream')
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
  const text = banner.querySelector('.notif-banner-text')
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

// Session Detail header bell toggle.
document.getElementById('detail-bell')?.addEventListener('click', (ev) => {
  const bell = ev.currentTarget
  if (!(bell instanceof HTMLElement)) return
  const session = bell.getAttribute('data-session')
  if (!session) return
  handleBellClick(bell, session)
})

// --- Permission request cards ---

function renderPermissionCard(data) {
  if (currentView !== 'session-detail') return
  if (selectedSessionId !== data.session) return
  const stream = document.getElementById('detail-stream')
  if (!stream) return

  const existing = document.querySelector(
    `.perm-card[data-request-id="${CSS.escape(data.request_id)}"]`,
  )
  if (existing) return // idempotent

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

  const wasNear = isNearBottom(stream)
  stream.appendChild(card)
  if (wasNear) stream.scrollTop = stream.scrollHeight
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
  const card = document.querySelector(
    `.perm-card[data-request-id="${CSS.escape(data.request_id)}"]`,
  )
  if (!card) return
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

// When the tab becomes visible again, dispatch session-viewed for the current
// session (if any) so any pending notifications for it get dismissed.
// Also refresh permission state in case it changed in another tab.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  if (currentView !== 'session-detail' || !selectedSessionId) return
  notif.dispatchSessionViewed(selectedSessionId)
  refreshNotifState()
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
