import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS venues (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     chain TEXT NOT NULL,
     timezone TEXT NOT NULL,
     source_venue_id TEXT NOT NULL,
     weight REAL NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS screenings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     venue_id TEXT NOT NULL REFERENCES venues(id),
     film_id INTEGER,
     raw_title TEXT NOT NULL,
     starts_at_utc INTEGER NOT NULL,
     local_date TEXT NOT NULL,
     ticket_url TEXT NOT NULL,
     source_screening_id TEXT NOT NULL,
     format_hints TEXT NOT NULL,
     tags TEXT NOT NULL,
     runtime_minutes INTEGER,
     first_seen_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     missed_sweeps INTEGER NOT NULL DEFAULT 0,
     cancelled INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS screenings_source_idx
     ON screenings (venue_id, source_screening_id)`,
  `CREATE TABLE IF NOT EXISTS source_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     status TEXT NOT NULL,
     item_count INTEGER NOT NULL DEFAULT 0,
     error TEXT
   )`,
]

export type Db = BetterSQLite3Database<typeof schema>

export function createDatabase(path: string): { db: Db; close: () => void } {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  for (const statement of CREATE_STATEMENTS) sqlite.exec(statement)

  return {
    db: drizzle(sqlite, { schema }),
    close: () => sqlite.close(),
  }
}
