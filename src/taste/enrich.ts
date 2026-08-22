import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { films, letterboxdEntries } from '../db/schema.js'
import { upsertFilm } from '../store/films.js'
import type { TmdbClient } from '../tmdb/client.js'
import { matchKey } from '../resolve/normalize.js'

export interface EnrichSummary {
  /** Films fetched from TMDB and written to `films` this run. */
  fetched: number
  /** Rated diary films we already held metadata for. */
  skipped: number
  failed: { tmdbId: number; error: string }[]
}

/**
 * Give the rated Letterboxd diary the TMDB metadata the affinity model needs.
 *
 * `films` is otherwise populated only by the resolve pass, which sees nothing
 * but titles currently on sale at a tracked venue. The owner's diary and this
 * month's showtimes barely overlap -- 14 of 47 rated films at the time of
 * writing -- so without this pass `deriveAffinities` computes over a dozen
 * films, clears no sample floor, and returns nothing. The model would look
 * healthy and mean nothing, which is the failure mode this repo cares about.
 *
 * Only *rated* entries are fetched: unrated viewings contribute no signal to
 * the affinity means, and already-watched suppression matches on the diary row
 * itself rather than on a `films` row.
 */
export async function enrichWatchedFilms(
  db: Db,
  client: Pick<TmdbClient, 'getMovie'>,
  now: Date,
): Promise<EnrichSummary> {
  const wanted = await db
    .selectDistinct({ tmdbId: letterboxdEntries.tmdbId })
    .from(letterboxdEntries)
    .where(
      sql`${letterboxdEntries.kind} = 'diary'
          AND ${letterboxdEntries.memberRating} IS NOT NULL
          AND ${letterboxdEntries.tmdbId} IS NOT NULL`,
    )

  const known = new Set(
    (await db.select({ tmdbId: films.tmdbId }).from(films))
      .map((row) => row.tmdbId)
      .filter((id): id is number => id != null),
  )

  const summary: EnrichSummary = { fetched: 0, skipped: 0, failed: [] }

  for (const row of wanted) {
    const tmdbId = row.tmdbId
    if (tmdbId == null) continue
    if (known.has(tmdbId)) {
      summary.skipped += 1
      continue
    }

    try {
      const film = await client.getMovie(tmdbId)
      await upsertFilm(db, film, now)
      known.add(tmdbId)
      summary.fetched += 1
    } catch (error) {
      // One dead id must not cost the other 46 films their metadata, but it is
      // reported rather than swallowed: a quietly short model is exactly the
      // bug this pass exists to prevent.
      summary.failed.push({
        tmdbId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return summary
}


export interface BackfillSummary {
  /** Entries given a TMDB id this run. */
  resolved: number
  /** "Title (Year)" for entries no confident match was found for. */
  unresolved: string[]
  failed: { title: string; error: string }[]
}

/**
 * Give rated diary entries that arrived without a TMDB id one by searching on
 * title and year.
 *
 * The RSS feed carries `tmdb:movieId`, but it reaches back only 50 entries. A
 * CSV export carries the full history and no ids at all, so without this pass
 * the affinity model silently ignores everything beyond the most recent 50
 * viewings -- a taste model that looks populated while representing a fraction
 * of the data.
 *
 * A candidate is accepted only when both the normalized title and the release
 * year match exactly. The year is the safety check: titles repeat across
 * decades, and a wrong film here corrupts the taste model rather than failing
 * loudly. Entries with no year are therefore skipped rather than guessed at.
 */
export async function backfillDiaryTmdbIds(
  db: Db,
  client: Pick<TmdbClient, 'searchMovies' | 'getMovie'>,
  now: Date,
): Promise<BackfillSummary> {
  const pending = await db
    .select()
    .from(letterboxdEntries)
    .where(
      sql`${letterboxdEntries.kind} = 'diary'
          AND ${letterboxdEntries.memberRating} IS NOT NULL
          AND ${letterboxdEntries.tmdbId} IS NULL
          AND ${letterboxdEntries.year} IS NOT NULL`,
    )

  const summary: BackfillSummary = { resolved: 0, unresolved: [], failed: [] }
  const resolvedByKey = new Map<string, number>()

  for (const entry of pending) {
    const year = entry.year
    if (year == null) continue

    const key = `${matchKey(entry.title)}@${year}`
    const already = resolvedByKey.get(key)
    if (already !== undefined) {
      await db
        .update(letterboxdEntries)
        .set({ tmdbId: already })
        .where(eq(letterboxdEntries.id, entry.id))
      summary.resolved += 1
      continue
    }

    try {
      const candidates = await client.searchMovies(entry.title, year)
      const match = candidates.find(
        (candidate) => candidate.year === year && matchKey(candidate.title) === matchKey(entry.title),
      )

      if (!match) {
        summary.unresolved.push(`${entry.title} (${year})`)
        continue
      }

      const film = await client.getMovie(match.tmdbId)
      await upsertFilm(db, film, now)
      await db
        .update(letterboxdEntries)
        .set({ tmdbId: match.tmdbId })
        .where(eq(letterboxdEntries.id, entry.id))

      resolvedByKey.set(key, match.tmdbId)
      summary.resolved += 1
    } catch (error) {
      // One bad title must not cost the rest of the history its metadata, but
      // it is reported rather than swallowed.
      summary.failed.push({
        title: entry.title,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return summary
}
