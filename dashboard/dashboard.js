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
let currentView = 'overview';
let selectedSessionId = null;

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
  if (view === 'machines') loadMachinesView();
  if (view === 'history') loadHistoryView();
  if (view === 'session-detail' && selectedSessionId) loadSessionDetailView();
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
    else if (data.type === 'message') addMessage(data.data);
    else if (data.type === 'quota') updateQuota(data.data);
    else if (data.type === 'overrides') { contextOverrides = data.data; updateSessions(lastSessions); }
    else if (data.type === 'session-update') handleSessionUpdate(data.data);
    else if (data.type === 'jsonl') handleJsonlEvent(data.data);
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

// --- WebSocket event handlers for new message types ---

function handleSessionUpdate(session) { /* Step 3/4 fills this in */ }
function handleJsonlEvent(event) { /* Step 4/6 fills this in */ }

// --- Placeholder view loaders (filled in later steps) ---

function loadMachinesView() { /* Step 5 */ }
function loadHistoryView() { /* Step 6 */ }
function loadSessionDetailView() { /* Step 4 */ }

sendBtn.addEventListener('click', doSend);
sendMsg.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSend(); });

connect();
