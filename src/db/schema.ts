import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const venues = sqliteTable('venues', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  chain: text('chain').notNull(),
  timezone: text('timezone').notNull(),
  sourceVenueId: text('source_venue_id').notNull(),
  weight: real('weight').notNull().default(0),
})

export const screenings = sqliteTable(
  'screenings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    venueId: text('venue_id').notNull().references(() => venues.id),
    filmId: integer('film_id'),
    rawTitle: text('raw_title').notNull(),
    startsAtUtc: integer('starts_at_utc', { mode: 'timestamp_ms' }).notNull(),
    localDate: text('local_date').notNull(),
    ticketUrl: text('ticket_url').notNull(),
    sourceScreeningId: text('source_screening_id').notNull(),
    formatHints: text('format_hints', { mode: 'json' }).notNull().$type<string[]>(),
    tags: text('tags', { mode: 'json' }).notNull().$type<string[]>(),
    runtimeMinutes: integer('runtime_minutes'),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    missedSweeps: integer('missed_sweeps').notNull().default(0),
    cancelled: integer('cancelled', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => ({
    /** Upsert identity: one row per source screening per venue. */
    sourceIdx: uniqueIndex('screenings_source_idx').on(
      table.venueId,
      table.sourceScreeningId,
    ),
  }),
)

export const sourceRuns = sqliteTable('source_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  status: text('status', { enum: ['ok', 'failed'] }).notNull(),
  itemCount: integer('item_count').notNull().default(0),
  error: text('error'),
})

export const films = sqliteTable('films', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tmdbId: integer('tmdb_id').unique(),
  title: text('title').notNull(),
  year: integer('year'),
  runtimeMinutes: integer('runtime_minutes'),
  originalLanguage: text('original_language'),
  genres: text('genres', { mode: 'json' }).notNull().$type<string[]>(),
  director: text('director'),
  posterUrl: text('poster_url'),
  synopsis: text('synopsis'),
  usReleaseDate: text('us_release_date'),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }),
})

export const titleOverrides = sqliteTable('title_overrides', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  rawTitle: text('raw_title').notNull(),
  /** Null means the override applies at every venue. */
  venueId: text('venue_id'),
  tmdbId: integer('tmdb_id').notNull(),
})
