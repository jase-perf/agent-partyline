PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- No FKs on machine_id / session_id in any of sessions, events, tool_calls,
-- subagents: hook events can arrive before the SessionStart event has
-- created the parent row, and sessions can arrive before machine
-- registration. The aggregator upserts lazily. See Task 10.
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cwd TEXT,
  started_at TEXT,
  last_seen TEXT NOT NULL,
  state TEXT,
  model TEXT,
  git_branch TEXT,
  context_tokens INTEGER,
  message_count INTEGER,
  last_text TEXT,
  source TEXT DEFAULT 'claude-code'
);
CREATE INDEX IF NOT EXISTS idx_sessions_machine ON sessions(machine_id);
CREATE INDEX IF NOT EXISTS idx_sessions_lastseen ON sessions(last_seen);
CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_name TEXT NOT NULL,
  hook_event TEXT NOT NULL,
  ts TEXT NOT NULL,
  agent_id TEXT,
  agent_type TEXT,
  payload_json TEXT NOT NULL,
  source TEXT DEFAULT 'claude-code'
);
CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_hook_ts ON events(hook_event, ts);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id) WHERE agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  tool_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  -- success: 0=false, 1=true, NULL=in-flight
  success INTEGER,
  input_json TEXT,
  output_preview TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, started_at);

CREATE TABLE IF NOT EXISTS subagents (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_type TEXT,
  description TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT
);
CREATE INDEX IF NOT EXISTS idx_subagents_session_started ON subagents(session_id, started_at);

CREATE TABLE IF NOT EXISTS metrics_daily (
  day TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  subagents_spawned INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, session_id)
);
CREATE INDEX IF NOT EXISTS idx_metrics_day ON metrics_daily(day);

CREATE TABLE IF NOT EXISTS ccpl_sessions (
  name TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  cwd TEXT NOT NULL,
  cc_session_uuid TEXT,
  pid INTEGER,
  machine_id TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ccpl_sessions_token ON ccpl_sessions(token);
CREATE INDEX IF NOT EXISTS idx_ccpl_sessions_last_active ON ccpl_sessions(last_active_at);

CREATE TABLE IF NOT EXISTS ccpl_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  old_uuid TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ccpl_archives_name ON ccpl_archives(name);
CREATE INDEX IF NOT EXISTS idx_ccpl_archives_uuid ON ccpl_archives(old_uuid);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  from_name TEXT NOT NULL,
  to_name TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT,
  callback_id TEXT,
  response_to TEXT,
  cc_session_uuid TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_name, ts);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_name, ts);
CREATE INDEX IF NOT EXISTS idx_messages_uuid ON messages(cc_session_uuid, ts);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  cookie TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires ON dashboard_sessions(expires_at);
