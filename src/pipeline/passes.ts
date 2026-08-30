/**
 * The four passes, as functions.
 *
 * `npm run sweep|sync|resolve|score` and the in-process scheduler behind
 * `npm run serve` must do exactly the same work, so the work lives here and
 * the callers own only their reporting. Nothing in this module prints; a CLI
 * wants a formatted report and a long-running server wants one line per pass,
 * and baking either in would force the other to parse it back out.
 */
import { DateTime } from 'luxon'
import type { Db } from '../db/client.js'
import type { UnconfiguredSource } from '../core/types.js'
import { createAdapters, allVenues, unconfiguredAdapters } from '../adapters/index.js'
import { seedTasteRules, seedVenues } from '../db/seed.js'
import { Fetcher } from '../fetch/fetcher.js'
import { runSweep } from '../sweep/sweep.js'
import {
  syncLetterboxd,
  LETTERBOXD_SOURCE,
  type LetterboxdSyncResult,
  type TextFetcher,
} from '../letterboxd/sync.js'
import { evaluateHealth, type SourceHealth } from '../store/runs.js'
import { TmdbClient } from '../tmdb/client.js'
import { runResolution } from '../resolve/run.js'
import { backfillDiaryTmdbIds, enrichWatchedFilms } from '../taste/enrich.js'
import { RuleTagExtractor } from '../tags/extract.js'
import { runScoring } from '../score/run.js'

/** How far ahead a sweep asks each source to look. */
export const FETCH_WINDOW_DAYS = 21

/** Every venue in this project is in Seattle. */
export const TZ = 'America/Los_Angeles'

/**
 * Where an unzipped Letterboxd export is expected to sit.
 *
 * One constant for the CLI and the scheduler both, because they must read the
 * same export: a scheduled sync that quietly skipped the CSV would see only
 * the 50 entries in the RSS window and hand the taste model a fraction of the
 * rating history the CLI gives it. A missing directory is not an error.
 */
export const DEFAULT_LETTERBOXD_CSV_DIR = 'data/letterboxd'

export interface AdapterConfig {
  amcApiKey?: string
}

export interface PassConfig extends AdapterConfig {
  tmdbApiKey?: string
  letterboxdUsername?: string
}

/**
 * The source ids this process is configured to run.
 *
 * Built rather than listed, so it reflects the adapters that actually exist —
 * including the fact that AMC is omitted entirely when its vendor key is
 * absent. The health report unions this with its own known set, so a source
 * dropped here still shows up as not running rather than disappearing.
 *
 * Letterboxd is in the list too, and not an adapter: it records `source_runs`
 * rows like a venue and is swept on the same schedule, so the health report
 * has to expect it *before* its first successful run. Without that, a sync
 * that has never once succeeded reads as a source nobody asked for.
 */
export function configuredSourceIds(config: PassConfig = {}): string[] {
  return [
    ...createAdapters(new Fetcher(), config).map((adapter) => adapter.id),
    ...(config.letterboxdUsername ? [LETTERBOXD_SOURCE] : []),
  ]
}

/**
 * Every integration this process is configured *not* to run, and why.
 *
 * Both halves were previously silent. Without `AMC_API_KEY` the AMC adapter is
 * never built, so it records no run and leaves no trace; without
 * `TMDB_API_KEY` the resolve pass is skipped with a `console.warn` in a server
 * log nobody reads. The owner ran `npm run serve` for a week in exactly that
 * state: two venues unswept, `films.fetched_at` frozen, 73 screenings of one
 * title unlinked, and a health view showing green throughout.
 *
 * `resolve` is not a swept source and writes no `source_runs` rows, so it
 * appears in the health report *only* when it cannot run. Listing it always
 * would mean listing it as "never run" forever.
 *
 * Letterboxd is listed in pipeline order, between the sweep and the resolve
 * it runs between. It does write `source_runs` rows, so when it is configured
 * `configuredSourceIds` carries it and the staleness check judges it like any
 * venue; only the unconfigured case belongs here.
 */
export function unconfiguredIntegrations(config: PassConfig = {}): UnconfiguredSource[] {
  return [
    ...unconfiguredAdapters(config),
    ...(config.letterboxdUsername
      ? []
      : [{ source: LETTERBOXD_SOURCE, variable: 'LETTERBOXD_USERNAME' }]),
    ...(config.tmdbApiKey ? [] : [{ source: 'resolve', variable: 'TMDB_API_KEY' }]),
  ]
}

export interface SweepPassOptions extends AdapterConfig {
  now?: Date
  windowDays?: number
}

export interface SweepPassResult {
  range: { from: string; to: string }
  results: Awaited<ReturnType<typeof runSweep>>
  /** Verdict per source after the sweep, including sources that did not run. */
  health: SourceHealth[]
}

export async function sweepPass(db: Db, options: SweepPassOptions = {}): Promise<SweepPassResult> {
  const now = options.now ?? new Date()
  const fetcher = new Fetcher()
  const adapters = createAdapters(fetcher, { amcApiKey: options.amcApiKey })
  await seedVenues(db, allVenues(adapters))

  const today = DateTime.fromJSDate(now).setZone(TZ)
  const range = {
    from: today.toISODate()!,
    to: today.plus({ days: options.windowDays ?? FETCH_WINDOW_DAYS }).toISODate()!,
  }

  const results = await runSweep(db, adapters, range, now)
  // Adapters that were not built are appended rather than dropped: a source
  // this sweep could not even attempt is exactly what the caller needs told.
  const health = [
    ...(await evaluateHealth(db, adapters.map((adapter) => adapter.id), { now })),
    ...unconfiguredAdapters({ amcApiKey: options.amcApiKey }).map((entry) => ({
      source: entry.source,
      healthy: false,
      reason: `not configured: ${entry.variable} is not set`,
    })),
  ]

  return { range, results, health }
}

export interface SyncPassOptions {
  username: string
  /** Defaults to `DEFAULT_LETTERBOXD_CSV_DIR`. A missing directory is a no-op. */
  csvDir?: string
  now?: Date
  /**
   * The only I/O this pass does, injected so tests never touch the network.
   * Callers pass nothing and get the rate-limited default.
   */
  fetcher?: TextFetcher
}

/**
 * Pull the Letterboxd diary and watchlist.
 *
 * This runs on the sweep schedule, as the design spec always intended --- "the
 * diary feed at letterboxd.com/<user>/rss/ is polled on the normal sweep
 * schedule". Until it did, `runPipeline` swept, resolved and scored while the
 * only path to a sync was `npm run sync` by hand, so the taste model scored
 * three weeks of showtimes against whatever ratings the owner last remembered
 * to fetch. The staleness check made that visible rather than causing it.
 *
 * **It cannot throw.** `syncLetterboxd` turns a failure into a `failed`
 * result and its own `source_runs` row, which is what lets the scheduler call
 * it without a guard: a Letterboxd outage costs this pass and leaves the
 * sweep, the resolve and the score untouched.
 */
export async function syncPass(db: Db, options: SyncPassOptions): Promise<LetterboxdSyncResult> {
  return syncLetterboxd(
    db,
    options.fetcher ?? new Fetcher(),
    { username: options.username, csvDir: options.csvDir ?? DEFAULT_LETTERBOXD_CSV_DIR },
    options.now ?? new Date(),
  )
}

export interface ResolvePassResult {
  resolution: Awaited<ReturnType<typeof runResolution>>
  backfill: Awaited<ReturnType<typeof backfillDiaryTmdbIds>>
  enrichment: Awaited<ReturnType<typeof enrichWatchedFilms>>
}

export async function resolvePass(
  db: Db,
  tmdbApiKey: string,
  options: { now?: Date } = {},
): Promise<ResolvePassResult> {
  const now = options.now ?? new Date()
  const client = new TmdbClient(new Fetcher({ minIntervalMs: 300 }), tmdbApiKey)

  const resolution = await runResolution(db, client, now)

  // The taste model reads `films`, which the pass above fills only with titles
  // currently on sale. Without this the owner's diary joins to a dozen rows
  // and every affinity falls under the sample floor. A CSV export carries the
  // full rating history but no TMDB ids, so those entries get ids first.
  const backfill = await backfillDiaryTmdbIds(db, client, now)
  const enrichment = await enrichWatchedFilms(db, client, now)

  return { resolution, backfill, enrichment }
}

export async function scorePass(
  db: Db,
  options: { now?: Date } = {},
): Promise<Awaited<ReturnType<typeof runScoring>>> {
  // Seeding is insert-when-absent, so this picks up new rules without ever
  // stepping on a weight the operator has hand-edited.
  await seedTasteRules(db)
  return runScoring(db, new RuleTagExtractor(), options.now ?? new Date())
}
