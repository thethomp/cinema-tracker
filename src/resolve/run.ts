import type { Db } from '../db/client.js'
import type { TmdbClient } from '../tmdb/client.js'
import { resolveTitle } from './resolver.js'
import { upsertFilm, linkScreenings, unresolvedTitles, type UnresolvedTitle } from '../store/films.js'

export interface ResolutionSummary {
  resolved: number
  screeningsLinked: number
  unresolved: UnresolvedTitle[]
}

/**
 * Resolve every unresolved raw title to a TMDB film and link its screenings.
 * Runs as its own pass rather than inside the sweep, so a TMDB outage cannot
 * fail a sweep and so it can be re-run cheaply after adding overrides.
 */
export async function runResolution(
  db: Db,
  client: TmdbClient,
  now: Date,
): Promise<ResolutionSummary> {
  const pending = await unresolvedTitles(db)
  let resolved = 0
  let screeningsLinked = 0
  const unresolved: UnresolvedTitle[] = []

  for (const entry of pending) {
    const result = await resolveTitle(db, client, entry.rawTitle)
    if (result.status === 'unresolved') {
      unresolved.push(entry)
      continue
    }

    const film = await client.getMovie(result.tmdbId)
    const filmId = await upsertFilm(db, film, now)
    screeningsLinked += await linkScreenings(db, entry.rawTitle, filmId)
    resolved += 1
  }

  return { resolved, screeningsLinked, unresolved }
}
