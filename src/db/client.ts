import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import {
  drizzle,
  type BetterSQLite3Database,
  type BetterSQLiteTransaction,
} from 'drizzle-orm/better-sqlite3'
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
  `CREATE TABLE IF NOT EXISTS films (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     tmdb_id INTEGER UNIQUE,
     title TEXT NOT NULL,
     year INTEGER,
     runtime_minutes INTEGER,
     original_language TEXT,
     genres TEXT NOT NULL,
     director TEXT,
     poster_url TEXT,
     synopsis TEXT,
     us_release_date TEXT,
     fetched_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS title_overrides (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     raw_title TEXT NOT NULL,
     venue_id TEXT,
     tmdb_id INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS title_overrides_key
     ON title_overrides (raw_title, IFNULL(venue_id, ''))`,
  `CREATE TABLE IF NOT EXISTS letterboxd_entries (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     film_slug TEXT NOT NULL,
     tmdb_id INTEGER,
     title TEXT NOT NULL,
     year INTEGER,
     member_rating REAL,
     watched_date TEXT,
     rewatch INTEGER NOT NULL DEFAULT 0,
     liked INTEGER NOT NULL DEFAULT 0,
     synced_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS letterboxd_entries_key
     ON letterboxd_entries (kind, film_slug, IFNULL(watched_date, ''))`,
  `CREATE TABLE IF NOT EXISTS watchlist (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     film_id INTEGER,
     title_pattern TEXT NOT NULL,
     year INTEGER,
     added_at INTEGER NOT NULL,
     notes TEXT,
     source TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS watchlist_key
     ON watchlist (title_pattern, IFNULL(year, 0))`,
  `CREATE TABLE IF NOT EXISTS taste_affinities (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     dimension TEXT NOT NULL,
     value TEXT NOT NULL,
     mean_rating REAL NOT NULL,
     sample_count INTEGER NOT NULL,
     weight REAL NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS taste_affinities_key
     ON taste_affinities (dimension, value)`,
  `CREATE TABLE IF NOT EXISTS taste_rules (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     value TEXT NOT NULL,
     weight REAL NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS app_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
]

/**
 * Columns added to a table that already exists in the user's live database.
 *
 * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`: the statement
 * throws `duplicate column name` on every run after the first, and this DDL
 * runs on every open. So check `PRAGMA table_info` first rather than catching
 * the error — a blanket catch here would also swallow genuine corruption.
 */
const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [
  // AMC's programming strands ("AMC Artisan Films", "Event") arrive on
  // RawScreening.description and were discarded at the store boundary until
  // this column existed.
  { table: 'screenings', column: 'description', type: 'TEXT' },
  // Written by the score pass. Null means "not scored yet", which is a real
  // state: a fresh sweep adds rows the scorer has not seen.
  { table: 'screenings', column: 'score', type: 'REAL' },
  { table: 'screenings', column: 'reasons', type: 'TEXT' },
]

function addMissingColumns(sqlite: Database.Database): void {
  for (const { table, column, type } of ADDED_COLUMNS) {
    const existing = sqlite.pragma(`table_info(${table})`) as { name: string }[]
    if (existing.some((c) => c.name === column)) continue
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

export type Db = BetterSQLite3Database<typeof schema>

/** A transaction handle on `Db`. */
export type Tx = BetterSQLiteTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>

/**
 * A database handle or a transaction on one. better-sqlite3 transactions are
 * synchronous, so store functions that must be able to run inside one take
 * this rather than `Db`.
 */
export type DbLike = Db | Tx

export function createDatabase(path: string): { db: Db; close: () => void } {
  // better-sqlite3 will not create a missing directory, and `data/` is
  // gitignored — without this, `npm run sweep` fails on a fresh clone.
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  for (const statement of CREATE_STATEMENTS) sqlite.exec(statement)
  addMissingColumns(sqlite)

  return {
    db: drizzle(sqlite, { schema }),
    close: () => sqlite.close(),
  }
}
