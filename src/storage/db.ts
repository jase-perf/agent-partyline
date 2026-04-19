import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(__dirname, 'schema.sql')

export const SCHEMA_VERSION = 1

type Migration = (db: Database) => void
const MIGRATIONS: Record<number, Migration> = {
  // Example future entry:
  // 2: (db) => { db.exec("ALTER TABLE events ADD COLUMN source TEXT DEFAULT 'claude-code'") },
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
