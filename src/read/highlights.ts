import type { Db } from '../db/client.js'
import { HIGHLIGHT_THRESHOLD } from '../score/score.js'
import {
  getLastVisitAt,
  groupByFilm,
  loadScreeningRows,
  type FilmEntry,
  type ReadWindow,
} from './query.js'

export type HighlightEntry = FilmEntry
export type { EntryReason, EntryShowtime, EntryVenue } from './query.js'

export interface HighlightOptions extends ReadWindow {
  /** Maximum entries returned. Entries, not screenings. */
  limit?: number
  /** Lowest entry score that reaches the feed. Defaults to the scorer's threshold. */
  minScore?: number
}

/** How many entries the feed asks for when the caller does not say. */
export const DEFAULT_HIGHLIGHT_LIMIT = 40

/**
 * The highlight feed: the best films on offer in the window, one row per film.
 *
 * A pure read. It never writes, never fetches, and never recomputes a score —
 * it presents what the score pass stored.
 */
export async function getHighlights(
  db: Db,
  options: HighlightOptions,
): Promise<HighlightEntry[]> {
  const limit = options.limit ?? DEFAULT_HIGHLIGHT_LIMIT
  const minScore = options.minScore ?? HIGHLIGHT_THRESHOLD
  if (limit <= 0) return []

  const rows = await loadScreeningRows(db, options)
  const entries = groupByFilm(rows, await getLastVisitAt(db))

  return entries
    .filter((entry) => entry.score >= minScore)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.showtimes[0]!.startsAtUtc.localeCompare(b.showtimes[0]!.startsAtUtc) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, limit)
}
