const feed = document.getElementById('feed');
const sessionList = document.getElementById('sessionList');
const connStatus = document.getElementById('connStatus');
const msgCount = document.getElementById('msgCount');
const showHeartbeats = document.getElementById('showHeartbeats');
const showAnnounce = document.getElementById('showAnnounce');
const autoscroll = document.getElementById('autoscroll');
const sendTo = document.getElementById('sendTo');
const sendType = document.getElementById('sendType');
const sendMsg = document.getElementById('sendMsg');
const sendBtn = document.getElementById('sendBtn');

let totalMessages = 0;
let ws;
let contextOverrides = {};
let lastSessions = [];
let sessionSources = {};  // session name -> source string, populated from session-update events
let currentView = 'switchboard';
let localMachineId = null;
let sessionMachines = {};  // session name -> machine_id

// --- localStorage UI state helpers ---

const UI_STATE_KEY = 'partyLine.ui.state';

function loadUiState() {
  try { return JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}'); }
  catch { return {}; }
}

function saveUiState(state) {
  try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(state)); } catch {}
}

function getLastViewedAt(sessionName) {
  const s = loadUiState();
  return (s.lastViewedAt && s.lastViewedAt[sessionName]) || 0;
}

function markSessionViewed(sessionName) {
  const s = loadUiState();
  s.lastViewedAt = s.lastViewedAt || {};
  s.lastViewedAt[sessionName] = Date.now();
  saveUiState(s);
}

// --- Unread count state ---

let unreadCounts = {};  // session_name -> integer
let seededOnce = false;

function bumpUnread(sessionKey) {
  if (!sessionKey) return;
  unreadCounts[sessionKey] = (unreadCounts[sessionKey] || 0) + 1;
  updateSessions(lastSessions);
}

function resolveNameFromJsonlPath(path) {
  if (!path) return null;
  const m = path.match(/\/([0-9a-f-]+)\.jsonl$/);
  if (!m) return null;
  const sid = m[1];
  const found = lastSessions.find(s => s.metadata && s.metadata.status && s.metadata.status.sessionId === sid);
  return found ? found.name : null;
}

fetch('/api/self')
  .then(r => r.json())
  .then(data => { localMachineId = data.machine_id; })
  .catch(() => {});
let selectedSessionId = null;
var historyBuffer = [];

// --- Tab router ---

function renderView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(function(el) {
    el.classList.remove('active');
    el.hidden = true;
  });
  var active = document.querySelector('.view[data-view="' + view + '"]');
  if (active) {
    active.classList.add('active');
    active.hidden = false;
  }
  // Run view-specific init
  if (view === 'history') loadHistoryView();
  if (view === 'session-detail' && selectedSessionId) {
    markSessionViewed(selectedSessionId);
    unreadCounts[selectedSessionId] = 0;
    updateSessions(lastSessions);
    loadSessionDetailView();
  }
}

document.getElementById('tabs').addEventListener('click', function(e) {
  var btn = e.target.closest('button[data-view]');
  if (!btn || btn.disabled) return;
  document.querySelectorAll('.tabs button').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  renderView(btn.dataset.view);
});

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');

  ws.onopen = function() {
    connStatus.textContent = 'connected';
    connStatus.style.color = '#3fb950';
  };

  ws.onclose = function() {
    connStatus.textContent = 'disconnected \u2014 reconnecting...';
    connStatus.style.color = '#f85149';
    setTimeout(connect, 2000);
  };

  ws.onmessage = function(e) {
    var data = JSON.parse(e.data);
    if (data.type === 'sessions') updateSessions(data.data);
    else if (data.type === 'message') { addMessage(data.data); addMessageToBus(data.data); if (data.data.to && data.data.to !== 'all') bumpUnread(data.data.to); }
    else if (data.type === 'quota') updateQuota(data.data);
    else if (data.type === 'overrides') { contextOverrides = data.data; updateSessions(lastSessions); }
    else if (data.type === 'session-update') { handleSessionUpdate(data.data); bumpUnread(data.data.name); }
    else if (data.type === 'jsonl') { handleJsonlEvent(data.data); bumpUnread(resolveNameFromJsonlPath(data.data.file_path) || data.data.session_id); }
  };
}

function formatUptime(ms) {
  if (!ms) return '';
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  return Math.round(n / 1000) + 'k';
}

function getEffectiveContextLimit(name, st) {
  // Override from user config takes priority
  if (contextOverrides[name] && contextOverrides[name].contextLimit) {
    return contextOverrides[name].contextLimit;
  }
  // Derive from model: Opus defaults to 1M, everything else 200k
  var model = (st && st.model) ? st.model : '';
  if (model.indexOf('opus') !== -1) return 1000000;
  return 200000;
}

function showContextMenu(e, sessionName, model) {
  e.preventDefault();
  var menu = document.getElementById('ctxMenu');
  var isOpus = model && model.indexOf('opus') !== -1;
  menu.textContent = '';

  if (isOpus) {
    var header = document.createElement('div');
    header.className = 'ctx-menu-header';
    header.textContent = 'Context Window';
    menu.appendChild(header);

    // Find the session's status from lastSessions
    var sessionSt = null;
    for (var i = 0; i < lastSessions.length; i++) {
      if (lastSessions[i].name === sessionName) {
        sessionSt = lastSessions[i].metadata && lastSessions[i].metadata.status;
        break;
      }
    }
    var currentLimit = getEffectiveContextLimit(sessionName, sessionSt);

    [{ label: '1M tokens', value: 1000000 }, { label: '200k tokens', value: 200000 }].forEach(function(opt) {
      var item = document.createElement('div');
      item.className = 'ctx-menu-item';
      item.textContent = opt.label;
      if (currentLimit === opt.value) {
        var check = document.createElement('span');
        check.className = 'check';
        check.textContent = '\u2713';
        item.appendChild(check);
      }
      item.addEventListener('click', function() {
        fetch('/api/overrides', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ session: sessionName, contextLimit: opt.value }) });
        contextOverrides[sessionName] = { contextLimit: opt.value };
        menu.classList.remove('visible');
        updateSessions(lastSessions);
      });
      menu.appendChild(item);
    });
  } else {
    var noOpt = document.createElement('div');
    noOpt.className = 'ctx-menu-header';
    noOpt.textContent = 'No options for ' + (model || 'unknown model');
    menu.appendChild(noOpt);
  }

  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('visible');
}

// Close context menu on click elsewhere
document.addEventListener('click', function() {
  document.getElementById('ctxMenu').classList.remove('visible');
});

// Session detail modal
function showSessionModal(s) {
  var st = (s.metadata && s.metadata.status) ? s.metadata.status : null;
  document.getElementById('modalTitle').textContent = s.name;

  // Meta tags
  var metaEl = document.getElementById('modalMeta');
  metaEl.textContent = '';
  if (st) {
    var tags = [];
    if (st.state) tags.push(['state', st.state]);
    if (st.model) {
      var display = st.model.replace('claude-', '').replace(/-(\d+)-(\d+)/, ' $1.$2');
      tags.push(['model', display]);
    }
    if (st.gitBranch) tags.push(['branch', st.gitBranch]);
    if (st.contextTokens !== null && st.contextTokens !== undefined) {
      var effLimit = getEffectiveContextLimit(s.name, st);
      var pct = Math.round((st.contextTokens / effLimit) * 100);
      tags.push(['context', formatTokens(st.contextTokens) + '/' + formatTokens(effLimit) + ' (' + pct + '%)']);
    }
    if (st.messageCount) tags.push(['messages', st.messageCount]);
    if (st.uptimeMs) tags.push(['uptime', formatUptime(st.uptimeMs)]);
    if (st.cwd) tags.push(['cwd', st.cwd]);

    tags.forEach(function(pair) {
      var span = document.createElement('span');
      var label = document.createElement('span');
      label.textContent = pair[0] + ': ';
      var val = document.createElement('span');
      val.className = 'meta-tag';
      val.textContent = pair[1];
      span.appendChild(label);
      span.appendChild(val);
      metaEl.appendChild(span);
    });
  }

  // Body — last response text
  var bodyEl = document.getElementById('modalBody');
  bodyEl.textContent = (st && st.lastText) ? st.lastText : '(no response text available)';

  document.getElementById('modalOverlay').classList.add('visible');
}

document.getElementById('modalClose').addEventListener('click', function() {
  document.getElementById('modalOverlay').classList.remove('visible');
});
document.getElementById('modalOverlay').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('visible');
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') document.getElementById('modalOverlay').classList.remove('visible');
});

function updateSessions(sessions) {
  lastSessions = sessions;
  if (!seededOnce && lastSessions.length > 0) {
    seededOnce = true;
    seedUnreadCounts();  // fires once, async
  }
  updateOverviewGrid(sessions);
  if (sessions.length === 0) {
    sessionList.textContent = 'no sessions';
    return;
  }
  // Build DOM safely without innerHTML
  sessionList.textContent = '';
  sessions.forEach(function(s) {
    var item = document.createElement('div');
    item.className = 'session-item';
    item.addEventListener('click', function() {
      showSessionModal(s);
    });

    var st = (s.metadata && s.metadata.status) ? s.metadata.status : null;
    var stModel = st ? (st.model || '') : '';

    item.addEventListener('contextmenu', function(e) {
      showContextMenu(e, s.name, stModel);
    });

    // Header row: dot + name + branch
    var dot = document.createElement('span');
    dot.className = 'status-dot online';
    item.appendChild(dot);

    var nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = s.name;
    item.appendChild(nameEl);

    if (st && st.gitBranch) {
      var branchEl = document.createElement('span');
      branchEl.className = 'meta';
      branchEl.textContent = ' [' + st.gitBranch + ']';
      item.appendChild(branchEl);
    }

    // Model label
    if (st && stModel) {
      var effectiveLimit = getEffectiveContextLimit(s.name, st);
      var modelEl = document.createElement('div');
      modelEl.className = 'status-line';
      // Clean up for display: "claude-opus-4-6" -> "opus 4.6"
      var display = stModel
        .replace('claude-', '')
        .replace(/-(\d+)-(\d+)/, ' $1.$2');
      // Add context variant for Opus
      if (stModel.indexOf('opus') !== -1) {
        display += effectiveLimit === 1000000 ? ' [1M]' : ' [200k]';
      }
      modelEl.textContent = display;
      modelEl.style.color = stModel.indexOf('opus') !== -1 ? 'var(--purple)' : stModel.indexOf('sonnet') !== -1 ? 'var(--accent)' : 'var(--cyan)';
      item.appendChild(modelEl);
    }

    // Status row: state+tool on left, uptime+msgs on right
    if (st) {
      var statusRow = document.createElement('div');
      statusRow.className = 'status-row';

      var stateEl = document.createElement('span');
      stateEl.className = 'state state-' + st.state;
      var stateText = st.state;
      if (st.state === 'working' && st.currentTool) {
        stateText += ' (' + st.currentTool + ')';
      }
      stateEl.textContent = stateText;
      statusRow.appendChild(stateEl);

      var rightEl = document.createElement('span');
      rightEl.className = 'status-right';
      var rightParts = [];
      if (st.uptimeMs) rightParts.push('up ' + formatUptime(st.uptimeMs));
      if (st.messageCount) rightParts.push(st.messageCount + ' msgs');
      rightEl.textContent = rightParts.join(' \u00b7 ');
      statusRow.appendChild(rightEl);

      item.appendChild(statusRow);

      // Context bar — use effective limit from overrides
      if (st.contextTokens !== null && st.contextTokens !== undefined) {
        var effLimit = getEffectiveContextLimit(s.name, st);
        var effPercent = Math.round((st.contextTokens / effLimit) * 100);

        var barBg = document.createElement('div');
        barBg.className = 'ctx-bar-bg';
        var barFg = document.createElement('div');
        barFg.className = 'ctx-bar-fg';
        if (effPercent > 90) barFg.className += ' crit';
        else if (effPercent > 70) barFg.className += ' warn';
        barFg.style.width = Math.min(effPercent, 100) + '%';
        barBg.appendChild(barFg);

        // Add 200k marker for 1M context sessions
        if (effLimit > 200000) {
          var mark = document.createElement('div');
          mark.className = 'ctx-bar-mark';
          mark.style.left = Math.round((200000 / effLimit) * 100) + '%';
          barBg.appendChild(mark);
        }

        item.appendChild(barBg);

        var ctxLabel = document.createElement('div');
        ctxLabel.className = 'status-line';
        ctxLabel.textContent = 'ctx: ' + formatTokens(st.contextTokens) + '/' + formatTokens(effLimit) + ' (' + effPercent + '%)';
        item.appendChild(ctxLabel);
      }

      // Last text snippet
      if (st.lastText) {
        var lastTextEl = document.createElement('div');
        lastTextEl.className = 'last-text';
        lastTextEl.textContent = '\u201c' + st.lastText.slice(0, 80) + '\u201d';
        item.appendChild(lastTextEl);
      }
    } else if (s.metadata && s.metadata.description) {
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = s.metadata.description;
      item.appendChild(meta);
    }

    sessionList.appendChild(item);
  });
}

function addMessage(msg) {
  totalMessages++;
  msgCount.textContent = totalMessages + ' messages';

  if (msg.type === 'heartbeat' && !showHeartbeats.checked) return;
  if (msg.type === 'announce' && !showAnnounce.checked) return;

  var time = new Date(msg.ts).toLocaleTimeString();

  var el = document.createElement('div');
  el.className = 'msg';

  var timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = time;
  el.appendChild(timeSpan);

  el.appendChild(document.createTextNode(' '));

  var typeSpan = document.createElement('span');
  typeSpan.className = 'type type-' + msg.type;
  typeSpan.textContent = msg.type;
  el.appendChild(typeSpan);

  el.appendChild(document.createTextNode(' '));

  var routeSpan = document.createElement('span');
  routeSpan.className = 'route';
  routeSpan.textContent = msg.from + ' \u2192 ' + msg.to;
  el.appendChild(routeSpan);

  if (msg.callback_id) {
    var cbTag = document.createElement('span');
    cbTag.className = 'tag';
    cbTag.textContent = ' [cb:' + msg.callback_id + ']';
    el.appendChild(cbTag);
  }

  if (msg.response_to) {
    var respTag = document.createElement('span');
    respTag.className = 'tag';
    respTag.textContent = ' [\u21a9' + msg.response_to + ']';
    el.appendChild(respTag);
  }

  el.appendChild(document.createTextNode(' '));

  var bodySpan = document.createElement('span');
  bodySpan.className = 'body';  // Use textContent — body is untrusted
  bodySpan.textContent = msg.body;
  el.appendChild(bodySpan);

  feed.appendChild(el);

  if (autoscroll.checked) {
    feed.scrollTop = feed.scrollHeight;
  }
}

function doSend() {
  var to = sendTo.value.trim();
  var message = sendMsg.value.trim();
  var type = sendType.value;
  if (!to || !message) return;

  ws.send(JSON.stringify({ action: 'send', to: to, message: message, type: type }));
  sendMsg.value = '';
  sendMsg.focus();
}

function updateQuota(q) {
  document.getElementById('quotaPanel').style.display = '';

  function setBar(barId, pctId, resetId, util, resetTs) {
    var pct = Math.round(util * 100);
    var bar = document.getElementById(barId);
    var label = document.getElementById(pctId);
    var resetEl = document.getElementById(resetId);

    label.textContent = pct + '%';
    bar.style.width = Math.min(pct, 100) + '%';
    bar.className = 'quota-bar-fg';
    if (pct > 90) bar.className += ' crit';
    else if (pct > 70) bar.className += ' warn';
    else bar.className += ' ok';

    if (resetTs) {
      var resetDate = new Date(resetTs * 1000);
      var now = Date.now();
      var diffMin = Math.max(0, Math.round((resetDate.getTime() - now) / 60000));
      var h = Math.floor(diffMin / 60);
      var m = diffMin % 60;
      var timeStr = h > 0 ? h + 'h ' + m + 'm' : m + 'm';
      resetEl.textContent = 'resets in ' + timeStr;
    }
  }

  setBar('quota5hBar', 'quota5hPct', 'quota5hReset', q.fiveHourUtilization, q.fiveHourReset);
  setBar('quota7dBar', 'quota7dPct', 'quota7dReset', q.sevenDayUtilization, q.sevenDayReset);

  if (q.fetchedAt) {
    var ago = Math.round((Date.now() - new Date(q.fetchedAt).getTime()) / 1000);
    document.getElementById('quotaFetched').textContent = ago < 60 ? 'just now' : Math.round(ago / 60) + 'm ago';
  }
}

// --- Sparkline ---

// Cache: sessionId -> { buckets: number[], ts: number }
var sparklineCache = {};

function renderSparkline(buckets) {
  if (!buckets || buckets.length === 0) return '';
  var max = Math.max(1, Math.max.apply(null, buckets));
  var w = 60, h = 14;
  var step = w / buckets.length;
  var points = buckets.map(function(v, i) {
    var x = i * step;
    var y = h - (v / max) * h;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  return '<svg class="sparkline" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">' +
    '<polyline points="' + points + '" fill="none" stroke="currentColor" stroke-width="1"></polyline>' +
    '</svg>';
}

function fetchAndRenderSparkline(sessionId, containerEl) {
  var now = Date.now();
  var cached = sparklineCache[sessionId];
  if (cached && (now - cached.ts) < 60000) {
    containerEl.innerHTML = renderSparkline(cached.buckets);
    return;
  }
  fetch('/api/sparkline?session_id=' + encodeURIComponent(sessionId))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      sparklineCache[sessionId] = { buckets: data.buckets, ts: Date.now() };
      containerEl.innerHTML = renderSparkline(data.buckets);
    })
    .catch(function() { /* silently fail — sparkline is non-critical */ });
}

// --- Overview grid: session cards ---

function sourceBadge(source) {
  var badge = document.createElement('span');
  if (!source || source === 'claude-code') {
    badge.className = 'src-badge src-cc';
    badge.title = 'Claude Code';
    badge.textContent = 'cc';
  } else if (source === 'gemini-cli') {
    badge.className = 'src-badge src-gemini';
    badge.title = 'Gemini CLI';
    badge.textContent = 'gem';
  } else {
    badge.className = 'src-badge';
    badge.title = source;
    badge.textContent = source.slice(0, 3);
  }
  return badge;
}

function hostBadge(name) {
  var mid = sessionMachines[name];
  if (!mid) return null;
  if (localMachineId && mid === localMachineId) return null;
  var badge = document.createElement('span');
  badge.className = 'host-badge';
  badge.title = 'Remote: ' + mid;
  badge.textContent = mid.slice(0, 3);
  return badge;
}

function unreadBadge(name) {
  var n = unreadCounts[name] || 0;
  if (n === 0) return null;
  var badge = document.createElement('span');
  badge.className = 'unread-badge';
  badge.textContent = n > 99 ? '\u2022' : String(n);
  return badge;
}

async function seedUnreadCounts() {
  var state = loadUiState();
  var map = state.lastViewedAt || {};
  for (var i = 0; i < lastSessions.length; i++) {
    var s = lastSessions[i];
    var since = map[s.name] || 0;
    try {
      var r = await fetch('/api/events?session_id=' + encodeURIComponent(s.name) + '&limit=500');
      var rows = await r.json();
      var count = 0;
      for (var j = 0; j < rows.length; j++) {
        var evTs = new Date(rows[j].ts).getTime();
        if (evTs > since) count++;
      }
      unreadCounts[s.name] = count;
    } catch (_) {}
  }
  updateSessions(lastSessions);
}

function stateClass(state) {
  if (state === 'working') return 'state-working';
  if (state === 'idle') return 'state-idle';
  if (state === 'errored') return 'state-errored';
  return 'state-ended';
}

function buildCardContents(s) {
  var st = (s.metadata && s.metadata.status) ? s.metadata.status : null;
  var state = (st && st.state) ? st.state : 'ended';

  // Header
  var header = document.createElement('div');
  header.className = 'card-header';

  var pill = document.createElement('span');
  pill.className = 'state-pill ' + stateClass(state);
  pill.textContent = state;
  header.appendChild(pill);

  header.appendChild(sourceBadge(sessionSources[s.name]));

  var hb = hostBadge(s.name);
  if (hb) header.appendChild(hb);

  var ub = unreadBadge(s.name);
  if (ub) header.appendChild(ub);

  var nameEl = document.createElement('span');
  nameEl.className = 'session-name';
  nameEl.textContent = s.name;
  header.appendChild(nameEl);

  // Body
  var body = document.createElement('div');
  body.className = 'card-body';

  if (st && st.state === 'working' && st.currentTool) {
    var toolEl = document.createElement('div');
    toolEl.className = 'card-tool';
    toolEl.appendChild(document.createTextNode('running '));
    var codeEl = document.createElement('code');
    codeEl.textContent = st.currentTool;
    toolEl.appendChild(codeEl);
    body.appendChild(toolEl);
  }

  if (st && st.lastText) {
    var lastEl = document.createElement('div');
    lastEl.className = 'card-last-text';
    lastEl.textContent = '\u201c' + st.lastText.slice(0, 60) + '\u201d';
    body.appendChild(lastEl);
  }

  var metaEl = document.createElement('div');
  metaEl.className = 'card-meta';

  if (st && st.contextTokens !== null && st.contextTokens !== undefined) {
    var effLimit = getEffectiveContextLimit(s.name, st);
    var pct = Math.round((st.contextTokens / effLimit) * 100);
    var ctxSpan = document.createElement('span');
    ctxSpan.className = 'ctx';
    ctxSpan.textContent = 'ctx ' + formatTokens(st.contextTokens) + ' (' + pct + '%)';
    metaEl.appendChild(ctxSpan);
  }

  var subsSpan = document.createElement('span');
  subsSpan.className = 'subs';
  subsSpan.textContent = '0 subagents';
  metaEl.appendChild(subsSpan);

  body.appendChild(metaEl);

  // Sparkline slot — populated async after card is in the DOM
  var sparklineSlot = document.createElement('div');
  sparklineSlot.className = 'card-sparkline';
  body.appendChild(sparklineSlot);

  return { header: header, body: body, sparklineSlot: sparklineSlot };
}

function buildSessionCard(s) {
  var card = document.createElement('div');
  card.className = 'session-card';
  // Use session name as ID key (party-line sessions don't have DB IDs)
  card.dataset.sessionId = s.name;

  var parts = buildCardContents(s);
  card.appendChild(parts.header);
  card.appendChild(parts.body);

  // Fetch sparkline async — uses session name as session_id proxy for party-line sessions
  // For DB sessions (with status), use session_id if available
  var sparkId = (s.metadata && s.metadata.status && s.metadata.status.sessionId) ? s.metadata.status.sessionId : s.name;
  fetchAndRenderSparkline(sparkId, parts.sparklineSlot);

  card.addEventListener('click', function() {
    selectedSessionId = s.name;
    // Select visual state
    document.querySelectorAll('.session-card').forEach(function(c) { c.classList.remove('selected'); });
    card.classList.add('selected');
    // Enable and switch to session-detail tab
    var detailBtn = document.querySelector('.tabs button[data-view="session-detail"]');
    if (detailBtn) {
      detailBtn.disabled = false;
      document.querySelectorAll('.tabs button').forEach(function(b) { b.classList.remove('active'); });
      detailBtn.classList.add('active');
    }
    renderView('session-detail');
  });

  return card;
}

function updateOverviewGrid(sessions) {
  var grid = document.getElementById('overview-grid');
  if (!grid) return;

  sessions.forEach(function(s) {
    var existing = grid.querySelector('[data-session-id="' + CSS.escape(s.name) + '"]');
    if (existing) {
      // Update in place
      existing.textContent = '';
      var parts = buildCardContents(s);
      existing.appendChild(parts.header);
      existing.appendChild(parts.body);
      // Re-attach sparkline (uses cache — won't re-fetch if within 60s)
      var sparkId = (s.metadata && s.metadata.status && s.metadata.status.sessionId) ? s.metadata.status.sessionId : s.name;
      fetchAndRenderSparkline(sparkId, parts.sparklineSlot);
    } else {
      grid.appendChild(buildSessionCard(s));
    }
  });

  // Remove cards for sessions that are no longer present
  var sessionNames = sessions.map(function(s) { return s.name; });
  grid.querySelectorAll('.session-card').forEach(function(card) {
    if (sessionNames.indexOf(card.dataset.sessionId) === -1) {
      card.remove();
    }
  });
}

// --- WebSocket event handlers for new message types ---

function handleSessionUpdate(session) {
  // Update the card in the overview grid if it exists
  // session here is an aggregated DB session with session_id, not the heartbeat session
  if (!session || !session.session_id) return;

  // Record source for this session (keyed by name for card rendering)
  if (session.name && session.source) {
    sessionSources[session.name] = session.source;
  }
  if (session.name && session.machine_id) {
    sessionMachines[session.name] = session.machine_id;
  }

  // Update detail view header if we're viewing this session
  if (currentView === 'session-detail' && selectedSessionId === session.session_id) {
    updateDetailHeader(session);
  }
}

function handleJsonlEvent(event) {
  if (!event) return;
  // Append to timeline if we're viewing the relevant session
  if (currentView === 'session-detail' && selectedSessionId) {
    if (event.session_id === selectedSessionId || event.session_name === selectedSessionId) {
      prependTimelineEvent(event);
    }
  }
  // Append to history list if loaded
  if (historyLoaded) {
    var list = document.getElementById('history-list');
    var emptyMsg = list && list.querySelector('.empty-msg');
    if (emptyMsg) emptyMsg.remove();
    addHookOption(event.hook_event);
    if (list) list.appendChild(buildHistoryItem(event));
    applyHistoryFilters();
  }
}

// --- Session detail view ---

function hookClass(hookEvent) {
  if (!hookEvent) return 'hook-default';
  if (hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse') return 'hook-PreToolUse';
  if (hookEvent === 'Stop') return 'hook-Stop';
  if (hookEvent === 'SubagentStart' || hookEvent === 'SubagentStop') return 'hook-SubagentStart';
  if (hookEvent === 'Notification') return 'hook-Notification';
  return 'hook-default';
}

function makeEmptyLi(text) {
  var li = document.createElement('li');
  li.className = 'empty-msg';
  li.textContent = text;
  return li;
}

function buildTimelineItem(ev) {
  var li = document.createElement('li');
  li.className = 'timeline-event';

  var ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = ev.ts ? new Date(ev.ts).toLocaleTimeString() : '';
  li.appendChild(ts);

  var hook = document.createElement('span');
  hook.className = 'hook ' + hookClass(ev.hook_event);
  hook.textContent = ev.hook_event || 'event';
  li.appendChild(hook);

  var detail = document.createElement('span');
  detail.className = 'detail';
  var detailText = '';
  if (ev.tool_name) {
    detailText = 'tool: ' + ev.tool_name;
  } else if (ev.payload) {
    try {
      var p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
      if (p.tool_name) detailText = 'tool: ' + p.tool_name;
      else if (p.message) detailText = String(p.message).slice(0, 80);
    } catch (e2) { detailText = ''; }
  }
  detail.textContent = detailText;
  li.appendChild(detail);

  if (ev.payload) {
    var det = document.createElement('details');
    det.className = 'payload';
    var sum = document.createElement('summary');
    sum.textContent = 'payload';
    det.appendChild(sum);
    var pre = document.createElement('pre');
    var payloadStr = typeof ev.payload === 'string' ? ev.payload : JSON.stringify(ev.payload, null, 2);
    pre.textContent = payloadStr;
    det.appendChild(pre);
    li.appendChild(det);
  }

  return li;
}

function buildSubagentItem(sub) {
  var li = document.createElement('li');
  li.className = 'subagent';

  var statusEl = document.createElement('span');
  var subState = sub.state || 'running';
  statusEl.className = 'status status-' + subState;
  statusEl.textContent = subState;
  li.appendChild(statusEl);

  var typeEl = document.createElement('span');
  typeEl.className = 'agent-type';
  typeEl.textContent = sub.agent_type || 'Agent';
  li.appendChild(typeEl);

  var descEl = document.createElement('span');
  descEl.className = 'agent-desc';
  descEl.textContent = sub.description || sub.task_description || '';
  li.appendChild(descEl);

  var durEl = document.createElement('span');
  durEl.className = 'agent-dur';
  durEl.textContent = sub.started_at ? 'started ' + new Date(sub.started_at).toLocaleTimeString() : '';
  li.appendChild(durEl);

  return li;
}

function populateDetailHeader(session) {
  var stateEl = document.getElementById('detail-state');
  var nameEl = document.getElementById('detail-name');
  var cwdEl = document.getElementById('detail-cwd');
  var modelEl = document.getElementById('detail-model');
  var ctxEl = document.getElementById('detail-ctx');
  if (!stateEl) return;

  if (!session) {
    stateEl.textContent = '';
    stateEl.className = 'state-pill';
    if (nameEl) nameEl.textContent = selectedSessionId || '';
    if (cwdEl) cwdEl.textContent = '';
    if (modelEl) modelEl.textContent = '';
    if (ctxEl) ctxEl.textContent = '';
    return;
  }

  var state = session.state || 'ended';
  stateEl.textContent = state;
  stateEl.className = 'state-pill ' + stateClass(state);
  if (nameEl) nameEl.textContent = session.session_name || session.session_id || '';
  if (cwdEl) cwdEl.textContent = session.cwd ? 'cwd: ' + session.cwd : '';
  if (modelEl) {
    modelEl.textContent = session.model
      ? 'model: ' + session.model.replace('claude-', '').replace(/-(\d+)-(\d+)/, ' $1.$2')
      : '';
  }
  if (ctxEl) {
    ctxEl.textContent = (session.context_tokens !== null && session.context_tokens !== undefined)
      ? 'ctx: ' + formatTokens(session.context_tokens)
      : '';
  }
}

function updateDetailHeader(session) {
  if (!session || !selectedSessionId) return;
  var sessionKey = session.session_id || session.session_name;
  if (sessionKey !== selectedSessionId) return;
  populateDetailHeader(session);
}

function prependTimelineEvent(event) {
  var timeline = document.getElementById('detail-timeline');
  if (!timeline) return;
  var emptyMsg = timeline.querySelector('.empty-msg');
  if (emptyMsg) emptyMsg.remove();
  timeline.insertBefore(buildTimelineItem(event), timeline.firstChild);
}

function loadSessionDetailView() {
  if (!selectedSessionId) return;

  var stateEl = document.getElementById('detail-state');
  if (stateEl) { stateEl.textContent = '...'; stateEl.className = 'state-pill'; }
  var nameEl = document.getElementById('detail-name');
  if (nameEl) nameEl.textContent = selectedSessionId;
  var cwdEl = document.getElementById('detail-cwd');
  if (cwdEl) cwdEl.textContent = '';
  var modelEl = document.getElementById('detail-model');
  if (modelEl) modelEl.textContent = '';
  var ctxEl = document.getElementById('detail-ctx');
  if (ctxEl) ctxEl.textContent = '';

  var subList = document.getElementById('detail-subagents');
  var timeline = document.getElementById('detail-timeline');
  if (subList) { subList.textContent = ''; subList.appendChild(makeEmptyLi('Loading...')); }
  if (timeline) { timeline.textContent = ''; timeline.appendChild(makeEmptyLi('Loading...')); }

  fetch('/api/session?id=' + encodeURIComponent(selectedSessionId))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      populateDetailHeader(data.session);
      if (subList) {
        subList.textContent = '';
        var subs = data.subagents || [];
        if (subs.length === 0) {
          subList.appendChild(makeEmptyLi('No subagents.'));
        } else {
          subs.forEach(function(sub) { subList.appendChild(buildSubagentItem(sub)); });
        }
      }
    })
    .catch(function() {
      if (subList) { subList.textContent = ''; subList.appendChild(makeEmptyLi('Failed to load.')); }
    });

  fetch('/api/events?session_id=' + encodeURIComponent(selectedSessionId) + '&limit=200')
    .then(function(r) { return r.json(); })
    .then(function(events) {
      if (timeline) {
        timeline.textContent = '';
        if (!events || events.length === 0) {
          timeline.appendChild(makeEmptyLi('No events yet.'));
        } else {
          events.forEach(function(ev) { timeline.appendChild(buildTimelineItem(ev)); });
        }
      }
    })
    .catch(function() {
      if (timeline) { timeline.textContent = ''; timeline.appendChild(makeEmptyLi('Failed to load events.')); }
    });
}

// --- History view ---

var historyEvents = [];
var historyHooksSeen = new Set();
var historyLoaded = false;

function buildHistoryItem(ev) {
  var li = document.createElement('li');
  li.className = 'history-event';
  li.dataset.session = ev.session_name || ev.session_id || '';
  li.dataset.hook = ev.hook_event || '';
  li.dataset.search = JSON.stringify(ev).toLowerCase();

  var ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = ev.ts ? new Date(ev.ts).toLocaleTimeString() : '';
  li.appendChild(ts);

  if (ev.session_name || ev.session_id) {
    var stag = document.createElement('span');
    stag.className = 'session-tag';
    stag.textContent = ev.session_name || ev.session_id;
    li.appendChild(stag);
  }

  var hook = document.createElement('span');
  hook.className = 'hook ' + hookClass(ev.hook_event);
  hook.textContent = ev.hook_event || 'event';
  li.appendChild(hook);

  var detail = document.createElement('span');
  detail.className = 'detail';
  var detailText = '';
  if (ev.tool_name) {
    detailText = 'tool: ' + ev.tool_name;
  } else if (ev.payload) {
    try {
      var p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
      if (p.tool_name) detailText = 'tool: ' + p.tool_name;
      else if (p.message) detailText = String(p.message).slice(0, 80);
    } catch (e3) { detailText = ''; }
  }
  detail.textContent = detailText;
  li.appendChild(detail);

  return li;
}

function applyHistoryFilters() {
  var filterText = document.getElementById('history-filter').value.toLowerCase();
  var filterHook = document.getElementById('history-hook-filter').value;
  var list = document.getElementById('history-list');
  if (!list) return;
  list.querySelectorAll('.history-event').forEach(function(li) {
    var hookMatch = !filterHook || li.dataset.hook === filterHook;
    var textMatch = !filterText || li.dataset.search.indexOf(filterText) !== -1;
    li.classList.toggle('hidden', !(hookMatch && textMatch));
  });
}

function addHookOption(hookEvent) {
  if (!hookEvent || historyHooksSeen.has(hookEvent)) return;
  historyHooksSeen.add(hookEvent);
  var sel = document.getElementById('history-hook-filter');
  if (!sel) return;
  var opt = document.createElement('option');
  opt.value = hookEvent;
  opt.textContent = hookEvent;
  sel.appendChild(opt);
}

function loadHistoryView() {
  var filterInput = document.getElementById('history-filter');
  var hookSelect = document.getElementById('history-hook-filter');
  var list = document.getElementById('history-list');
  if (!list) return;

  if (!historyLoaded) {
    list.textContent = '';
    list.appendChild(makeEmptyLi('Loading...'));

    fetch('/api/events?limit=500')
      .then(function(r) { return r.json(); })
      .then(function(events) {
        historyEvents = events || [];
        list.textContent = '';
        if (historyEvents.length === 0) {
          list.appendChild(makeEmptyLi('No events recorded yet.'));
        } else {
          historyEvents.forEach(function(ev) {
            addHookOption(ev.hook_event);
            list.appendChild(buildHistoryItem(ev));
          });
        }
        historyLoaded = true;
      })
      .catch(function() {
        list.textContent = '';
        list.appendChild(makeEmptyLi('Failed to load history.'));
      });
  }

  // Wire up filter controls (safe to do multiple times — handlers are idempotent after first load)
  if (filterInput && !filterInput.dataset.wired) {
    filterInput.dataset.wired = '1';
    filterInput.addEventListener('input', applyHistoryFilters);
  }
  if (hookSelect && !hookSelect.dataset.wired) {
    hookSelect.dataset.wired = '1';
    hookSelect.addEventListener('change', applyHistoryFilters);
  }
}

// Wire party-line bus in History view (mirrors addMessage to feed2)
function addMessageToBus(msg) {
  var feed2 = document.getElementById('feed2');
  if (!feed2) return;
  var showHB = document.getElementById('showHeartbeats2');
  var showAnn = document.getElementById('showAnnounce2');
  if (msg.type === 'heartbeat' && showHB && !showHB.checked) return;
  if (msg.type === 'announce' && showAnn && !showAnn.checked) return;

  var busCount = document.getElementById('bus-count');
  if (busCount) busCount.textContent = String(parseInt(busCount.textContent || '0', 10) + 1);

  var time = new Date(msg.ts).toLocaleTimeString();
  var el = document.createElement('div');
  el.className = 'msg';

  var timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = time;
  el.appendChild(timeSpan);
  el.appendChild(document.createTextNode(' '));

  var typeSpan = document.createElement('span');
  typeSpan.className = 'type type-' + msg.type;
  typeSpan.textContent = msg.type;
  el.appendChild(typeSpan);
  el.appendChild(document.createTextNode(' '));

  var routeSpan = document.createElement('span');
  routeSpan.className = 'route';
  routeSpan.textContent = msg.from + ' \u2192 ' + msg.to;
  el.appendChild(routeSpan);
  el.appendChild(document.createTextNode(' '));

  var bodySpan = document.createElement('span');
  bodySpan.className = 'body';
  bodySpan.textContent = msg.body;
  el.appendChild(bodySpan);

  feed2.appendChild(el);
  feed2.scrollTop = feed2.scrollHeight;
}

sendBtn.addEventListener('click', doSend);
sendMsg.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSend(); });

connect();
