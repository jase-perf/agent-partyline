import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(__dirname, 'schema.sql')

export const SCHEMA_VERSION = 4

type Migration = (db: Database) => void

// Keys are target versions. MIGRATIONS[n] brings a v(n-1) DB to vn.
const MIGRATIONS: Record<number, Migration> = {
  // v1→v2: v1 DBs had only a bare `events(id, hook_event, ts)` table.
  // Recreate events with the full schema and add all other tables.
  2: (db) => {
    // Drop the bare v1 events table and recreate with the full column set.
    // This is safe: v1 was pre-production and the data is not worth preserving.
    db.exec(`
      DROP TABLE IF EXISTS events;

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        hook_event TEXT NOT NULL,
        ts TEXT NOT NULL,
        agent_id TEXT,
        agent_type TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);
      CREATE INDEX IF NOT EXISTS idx_events_hook_ts ON events(hook_event, ts);
      CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id) WHERE agent_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        hostname TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );

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
        last_text TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_machine ON sessions(machine_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_lastseen ON sessions(last_seen);
      CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        tool_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
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
    `)
  },

  // v2→v3: add `source` columns to events and sessions.
  // Idempotent: checks for column existence before ALTER TABLE because
  // SQLite lacks "ALTER TABLE ADD COLUMN IF NOT EXISTS".
  3: (db) => {
    const eventsCols = db.query('PRAGMA table_info(events)').all() as Array<{ name: string }>
    if (!eventsCols.find((c) => c.name === 'source')) {
      db.exec("ALTER TABLE events ADD COLUMN source TEXT DEFAULT 'claude-code'")
    }
    const sessionsCols = db.query('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    if (!sessionsCols.find((c) => c.name === 'source')) {
      db.exec("ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'claude-code'")
    }
  },

  // v3→v4: add hub-and-spoke transport tables (Phase C).
  // ccpl_sessions: registered party-line sessions (name, token, cwd, etc.).
  // ccpl_archives: history of retired name/uuid bindings.
  // messages: durable store of channel messages for history/replay.
  // dashboard_sessions: web dashboard auth cookies.
  4: (db) => {
    db.exec(`
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
    `)
  },
}

function getUserVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  return row?.user_version ?? 0
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  const currentVersion = getUserVersion(db)

  if (currentVersion === 0) {
    // Fresh DB: apply the full declarative schema in one transaction and stamp
    // user_version so future opens skip migration entirely.
    const schema = readFileSync(SCHEMA_PATH, 'utf-8')
    db.transaction(() => {
      db.exec(schema)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })()
  } else if (currentVersion < SCHEMA_VERSION) {
    // Existing DB at an older version: run only the incremental migrations.
    applyMigrations(db, currentVersion)
  } else if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `DB at ${path} has user_version=${currentVersion} which is newer than this build's SCHEMA_VERSION=${SCHEMA_VERSION}. Refusing to open.`,
    )
  }
  // currentVersion === SCHEMA_VERSION: already current, nothing to do.

  return db
}

function applyMigrations(db: Database, fromVersion: number): void {
  for (let v = fromVersion; v < SCHEMA_VERSION; v++) {
    const targetVersion = v + 1
    const step = MIGRATIONS[targetVersion]
    if (!step) throw new Error(`No migration registered for v${v} → v${targetVersion}`)
    db.transaction(() => {
      step(db)
      db.exec(`PRAGMA user_version = ${targetVersion}`)
    })()
  }
}
