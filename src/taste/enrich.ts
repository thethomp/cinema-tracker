import { sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { films, letterboxdEntries } from '../db/schema.js'
import { upsertFilm } from '../store/films.js'
import type { TmdbClient } from '../tmdb/client.js'

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
