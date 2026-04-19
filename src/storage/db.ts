import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(__dirname, 'schema.sql')

export const SCHEMA_VERSION = 2

type Migration = (db: Database) => void
const MIGRATIONS: Record<number, Migration> = {
  2: (db) => {
    db.exec(`
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
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  const schema = readFileSync(SCHEMA_PATH, 'utf-8')
  db.exec(schema)
  applyMigrations(db)
  return db
}

function applyMigrations(db: Database): void {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  let current = row?.user_version ?? 0
  while (current < SCHEMA_VERSION) {
    const next = current + 1
    const migration = MIGRATIONS[next]
    if (migration) migration(db)
    db.exec(`PRAGMA user_version = ${next}`)
    current = next
  }
}
