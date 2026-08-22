import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { ScoreReason } from '../core/types.js'

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
    /** Source-supplied blurb, e.g. AMC's programming strand "AMC Artisan Films". */
    description: text('description'),
    /** Last computed highlight score. Null until the score pass has run. */
    score: real('score'),
    /** JSON `Reason[]` explaining the score, for the UI to render. */
    reasons: text('reasons', { mode: 'json' }).$type<ScoreReason[]>(),
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

export const letterboxdEntries = sqliteTable('letterboxd_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['diary', 'watchlist'] }).notNull(),
  filmSlug: text('film_slug').notNull(),
  tmdbId: integer('tmdb_id'),
  title: text('title').notNull(),
  year: integer('year'),
  memberRating: real('member_rating'),
  watchedDate: text('watched_date'),
  rewatch: integer('rewatch', { mode: 'boolean' }).notNull().default(false),
  liked: integer('liked', { mode: 'boolean' }).notNull().default(false),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
})

export const watchlist = sqliteTable('watchlist', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filmId: integer('film_id'),
  titlePattern: text('title_pattern').notNull(),
  year: integer('year'),
  addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull(),
  notes: text('notes'),
  source: text('source', { enum: ['manual', 'letterboxd'] }).notNull(),
})

export const tasteAffinities = sqliteTable('taste_affinities', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dimension: text('dimension', { enum: ['genre', 'language', 'director', 'decade'] }).notNull(),
  value: text('value').notNull(),
  meanRating: real('mean_rating').notNull(),
  sampleCount: integer('sample_count').notNull(),
  weight: real('weight').notNull(),
})

export const tasteRules = sqliteTable('taste_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /**
   * `watchlist` and `watched` name the two signals that are not a property of
   * the film itself. They live here rather than as constants so that every
   * weight in the scoring model — including the −80 already-watched penalty —
   * is editable in one place. The strong-affinity bonus is the exception: it
   * is carried by `taste_affinities.weight`, per row.
   */
  kind: text('kind', {
    enum: ['declared', 'genre', 'language', 'venue', 'tag', 'watchlist', 'watched'],
  }).notNull(),
  value: text('value').notNull(),
  weight: real('weight').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
})

export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
