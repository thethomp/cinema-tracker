import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db, DbLike } from '../db/client.js'
import { letterboxdEntries, watchlist } from '../db/schema.js'
import { recordRun } from '../store/runs.js'
import { parseLetterboxdRss } from './rss.js'
import { parseWatchlistPage } from './watchlist.js'
import { parseLetterboxdCsv } from './csv.js'

/**
 * The only part of Letterboxd handling that does I/O.
 *
 * Order is deliberate: CSV backfill (deep history, no TMDB ids) first, then
 * RSS (50 most recent, with TMDB ids), then the watchlist crawl. RSS runs
 * after the CSV so the fresher source wins on any film both describe.
 *
 * It records a `source_runs` row exactly like a venue adapter, so a Letterboxd
 * failure shows up in the health view rather than quietly leaving taste data
 * frozen at whatever the last good sync stored.
 */
export interface TextFetcher {
  text(url: string): Promise<string>
}

export interface LetterboxdSyncOptions {
  username: string
  /** Directory holding an unzipped Letterboxd export. Absent is normal. */
  csvDir?: string
}

export interface LetterboxdSyncResult {
  source: 'letterboxd'
  status: 'ok' | 'failed'
  /** Distinct diary entries seen this run, across CSV and RSS. */
  diaryEntries: number
  watchlistEntries: number
  pagesFetched: number
  error?: string
}

export const LETTERBOXD_SOURCE = 'letterboxd'

/**
 * Sanity ceiling on the watchlist crawl. At one request per two seconds a
 * misread page count is expensive, and a watchlist past this size means the
 * pagination markup changed rather than that the owner got ambitious.
 */
const MAX_WATCHLIST_PAGES = 50

interface IncomingEntry {
  filmSlug: string
  tmdbId?: number
  title: string
  year?: number
  memberRating?: number
  watchedDate?: string
  /** Absent on watchlist entries: the watchlist page carries neither signal. */
  rewatch?: boolean
  liked?: boolean
}

function entryKey(kind: 'diary' | 'watchlist', entry: IncomingEntry): string {
  return `${kind}|${entry.filmSlug}|${entry.watchedDate ?? ''}`
}

/**
 * Upsert on (kind, film_slug, watched_date) — the same identity as the unique
 * index, so a re-sync refreshes a row instead of stacking copies of it.
 */
function upsertEntries(
  db: DbLike,
  kind: 'diary' | 'watchlist',
  entries: IncomingEntry[],
  now: Date,
): void {
  for (const entry of entries) {
    const existing = db
      .select({ id: letterboxdEntries.id, tmdbId: letterboxdEntries.tmdbId })
      .from(letterboxdEntries)
      .where(
        and(
          eq(letterboxdEntries.kind, kind),
          eq(letterboxdEntries.filmSlug, entry.filmSlug),
          entry.watchedDate === undefined
            ? isNull(letterboxdEntries.watchedDate)
            : eq(letterboxdEntries.watchedDate, entry.watchedDate),
        ),
      )
      .limit(1)
      .all()

    const current = existing[0]
    if (current) {
      db
        .update(letterboxdEntries)
        .set({
          // The CSV export carries no TMDB ids at all, so a missing id is
          // never news — never let it erase one RSS already supplied.
          tmdbId: entry.tmdbId ?? current.tmdbId,
          title: entry.title,
          year: entry.year ?? null,
          memberRating: entry.memberRating ?? null,
          rewatch: entry.rewatch ?? false,
          liked: entry.liked ?? false,
          syncedAt: now,
        })
        .where(eq(letterboxdEntries.id, current.id))
        .run()
    } else {
      db
        .insert(letterboxdEntries)
        .values({
          kind,
          filmSlug: entry.filmSlug,
          tmdbId: entry.tmdbId ?? null,
          title: entry.title,
          year: entry.year ?? null,
          memberRating: entry.memberRating ?? null,
          watchedDate: entry.watchedDate ?? null,
          rewatch: entry.rewatch ?? false,
          liked: entry.liked ?? false,
          syncedAt: now,
        })
        .run()
    }
  }
}

/**
 * Mirror watchlist films into the `watchlist` table.
 *
 * **A manual row is never touched.** The owner's hand-entered entries — with
 * their notes and their original added-at — are the one thing in this table a
 * sync must not be able to damage, so an existing row of any source is left
 * exactly as it stands and only genuinely new films are inserted.
 *
 * Nothing is deleted either. A film dropped from the Letterboxd watchlist
 * lingers here until someone prunes it; deleting on absence would empty the
 * table the first time a crawl came back short.
 */
function mirrorWatchlist(db: DbLike, entries: IncomingEntry[], now: Date): void {
  for (const entry of entries) {
    const existing = db
      .select({ id: watchlist.id })
      .from(watchlist)
      .where(
        and(
          eq(watchlist.titlePattern, entry.title),
          // Matches the unique index, which keys on IFNULL(year, 0).
          entry.year === undefined ? isNull(watchlist.year) : eq(watchlist.year, entry.year),
        ),
      )
      .limit(1)
      .all()

    if (existing.length > 0) continue

    db
      .insert(watchlist)
      .values({
        filmId: null,
        titlePattern: entry.title,
        year: entry.year ?? null,
        addedAt: now,
        notes: null,
        source: 'letterboxd',
      })
      .run()
  }
}

interface CsvExport {
  diary: IncomingEntry[]
  watchlist: IncomingEntry[]
}

/** Filenames in a Letterboxd export, mapped to the kind they hold. */
const CSV_FILES: { name: string; kind: 'diary' | 'watchlist' }[] = [
  { name: 'ratings.csv', kind: 'diary' },
  { name: 'diary.csv', kind: 'diary' },
  { name: 'watchlist.csv', kind: 'watchlist' },
]

/**
 * Read an export directory if there is one. **A missing directory is not an
 * error** — the export is optional and the sync proceeds on RSS alone.
 */
async function readCsvExport(dir: string | undefined): Promise<CsvExport> {
  const empty: CsvExport = { diary: [], watchlist: [] }
  if (!dir) return empty

  let present: string[]
  try {
    present = await readdir(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return empty
    throw error
  }

  const byLowerName = new Map(present.map((name) => [name.toLowerCase(), name]))
  const result: CsvExport = { diary: [], watchlist: [] }

  for (const { name, kind } of CSV_FILES) {
    const actual = byLowerName.get(name)
    if (!actual) continue
    const text = await readFile(join(dir, actual), 'utf8')
    result[kind].push(...parseLetterboxdCsv(text, kind))
  }

  return result
}

export async function syncLetterboxd(
  db: Db,
  fetcher: TextFetcher,
  options: LetterboxdSyncOptions,
  now: Date,
): Promise<LetterboxdSyncResult> {
  const startedAt = new Date()
  const base = `https://letterboxd.com/${options.username}`
  const diaryKeys = new Set<string>()
  const watchlistKeys = new Set<string>()
  let pagesFetched = 0

  const store = (kind: 'diary' | 'watchlist', entries: IncomingEntry[]): void => {
    db.transaction((tx) => {
      upsertEntries(tx, kind, entries, now)
      if (kind === 'watchlist') mirrorWatchlist(tx, entries, now)
    })
    const keys = kind === 'diary' ? diaryKeys : watchlistKeys
    for (const entry of entries) keys.add(entryKey(kind, entry))
  }

  try {
    const csv = await readCsvExport(options.csvDir)
    store('diary', csv.diary)
    store('watchlist', csv.watchlist)

    store('diary', parseLetterboxdRss(await fetcher.text(`${base}/rss/`)))

    // Page 1 declares how many there are. Crawling only page 1 would store 28
    // of ~240 films and look entirely healthy, so the page count is read from
    // the markup rather than assumed.
    const first = parseWatchlistPage(await fetcher.text(`${base}/watchlist/page/1/`))
    pagesFetched = 1
    store('watchlist', first.entries)

    if (first.maxPage > MAX_WATCHLIST_PAGES) {
      throw new Error(
        `watchlist advertises ${first.maxPage} pages, over the ${MAX_WATCHLIST_PAGES}-page ceiling`,
      )
    }

    for (let page = 2; page <= first.maxPage; page++) {
      const parsed = parseWatchlistPage(await fetcher.text(`${base}/watchlist/page/${page}/`))
      pagesFetched += 1
      // A Cloudflare interstitial answers 200 with no entries. Keeping the
      // pages we already have would read as a watchlist that shrank.
      if (parsed.entries.length === 0) {
        throw new Error(`watchlist page ${page} of ${first.maxPage} returned no entries`)
      }
      store('watchlist', parsed.entries)
    }

    await recordRun(db, {
      source: LETTERBOXD_SOURCE,
      startedAt,
      finishedAt: new Date(),
      status: 'ok',
      itemCount: diaryKeys.size + watchlistKeys.size,
    })

    return {
      source: LETTERBOXD_SOURCE,
      status: 'ok',
      diaryEntries: diaryKeys.size,
      watchlistEntries: watchlistKeys.size,
      pagesFetched,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await recordRun(db, {
      source: LETTERBOXD_SOURCE,
      startedAt,
      finishedAt: new Date(),
      status: 'failed',
      itemCount: diaryKeys.size + watchlistKeys.size,
      error: message,
    })
    return {
      source: LETTERBOXD_SOURCE,
      status: 'failed',
      diaryEntries: diaryKeys.size,
      watchlistEntries: watchlistKeys.size,
      pagesFetched,
      error: message,
    }
  }
}
