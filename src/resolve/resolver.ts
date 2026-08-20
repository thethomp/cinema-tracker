import { and, eq, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { films, titleOverrides } from '../db/schema.js'
import type { TmdbClient } from '../tmdb/client.js'
import { normalizeTitle, matchKey } from './normalize.js'

/**
 * Token-overlap floor for accepting a non-exact title.
 *
 * Recomputed against the current `matchKey`, which elides apostrophes rather
 * than spacing them: "Harry Potter and the Sorcerer's Stone" keys to six tokens
 * [harry potter and the sorcerers stone] and the TMDB-served UK primary title
 * keys to six [harry potter and the philosophers stone]. Five are shared, so
 * dice = 2*5/(6+6) = 0.833 — comfortably above this floor.
 *
 * The negative cases stay rejected: "The Odyssey" vs "Something Else Entirely"
 * shares nothing (dice 0.0), and "DC" vs "DC Returns" scores dice 0.667.
 */
const SIMILARITY_THRESHOLD = 0.75

/**
 * Absolute floor on shared tokens, so short titles cannot pass on ratio alone.
 * Without it, "DC" vs "DC Returns" scores 0.667 on one shared token — under the
 * ratio here, but a two-token title with one shared token would clear a laxer
 * ratio, so the count floor is the guard that actually holds for short titles.
 */
const MIN_SHARED_TOKENS = 3

export type ResolveResult =
  | { status: 'resolved'; tmdbId: number; via: 'override' | 'cache' | 'search' }
  | { status: 'unresolved'; reason: string }

export async function resolveTitle(
  db: Db,
  client: Pick<TmdbClient, 'searchMovies'>,
  rawTitle: string,
  venueId?: string,
): Promise<ResolveResult> {
  const override = await findOverride(db, rawTitle, venueId)
  if (override !== undefined) return { status: 'resolved', tmdbId: override, via: 'override' }

  const normalized = normalizeTitle(rawTitle)
  const key = matchKey(normalized.title)

  const cached = (await db.select().from(films)).find((film) => matchKey(film.title) === key)
  if (cached?.tmdbId != null) return { status: 'resolved', tmdbId: cached.tmdbId, via: 'cache' }

  // A re-release marker carries the reissue year, not the film's year, so it is
  // never a usable hint. Goblet of Fire "(2026 Re-Release)" is the 2005 film.
  const candidates = await client.searchMovies(normalized.title, undefined)
  if (candidates.length === 0) return { status: 'unresolved', reason: 'no results from TMDB' }

  // Exact normalized match wins outright. Several candidates can tie here —
  // "The Odyssey" really does return two distinct 2026 films — so break on
  // popularity.
  const exact = candidates.filter((c) => matchKey(c.title) === key)
  if (exact.length > 0) {
    const best = exact.reduce((a, b) => (b.popularity > a.popularity ? b : a))
    return { status: 'resolved', tmdbId: best.tmdbId, via: 'search' }
  }

  // Fall back to token overlap, for regional title variants. TMDB serves UK
  // primary titles, so "Sorcerer's Stone" comes back as "Philosopher's Stone" —
  // plainly the same film, but not an exact match.
  const similar = candidates
    .map((c) => ({ candidate: c, ...titleSimilarity(key, matchKey(c.title)) }))
    .filter((s) => s.dice >= SIMILARITY_THRESHOLD && s.shared >= MIN_SHARED_TOKENS)
    .sort((a, b) => b.dice - a.dice || b.candidate.popularity - a.candidate.popularity)

  const winner = similar[0]
  if (winner) {
    return { status: 'resolved', tmdbId: winner.candidate.tmdbId, via: 'search' }
  }

  return { status: 'unresolved', reason: `no confident match among ${candidates.length} candidates` }
}

/** Dice coefficient over word tokens, plus the raw count of shared tokens. */
function titleSimilarity(a: string, b: string): { dice: number; shared: number } {
  const left = new Set(a.split(' ').filter(Boolean))
  const right = new Set(b.split(' ').filter(Boolean))
  if (left.size === 0 || right.size === 0) return { dice: 0, shared: 0 }

  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return { dice: (2 * shared) / (left.size + right.size), shared }
}

async function findOverride(db: Db, rawTitle: string, venueId?: string): Promise<number | undefined> {
  const rows = await db
    .select()
    .from(titleOverrides)
    .where(
      and(
        eq(titleOverrides.rawTitle, rawTitle),
        venueId === undefined
          ? isNull(titleOverrides.venueId)
          : or(isNull(titleOverrides.venueId), eq(titleOverrides.venueId, venueId)),
      ),
    )

  // A venue-specific override beats a global one.
  return rows.sort((a, b) => (b.venueId ? 1 : 0) - (a.venueId ? 1 : 0))[0]?.tmdbId
}
