import { and, eq, gte } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { films, letterboxdEntries, screenings, tasteRules, venues, watchlist } from '../db/schema.js'
import { matchKey, normalizeTitle } from '../resolve/normalize.js'
import { deriveAffinities } from '../taste/affinities.js'
import type { TagExtractor, Tag } from '../tags/extract.js'
import { score, type ScoringModel } from './score.js'
import type { ScoreReason } from '../core/types.js'

/** One line in the highlight feed: a run of showtimes that all score alike. */
export interface HighlightGroup {
  rawTitle: string
  /** Resolved film title, when the resolver matched one. */
  filmTitle: string | null
  score: number
  tags: Tag[]
  reasons: ScoreReason[]
  /** How many showtimes this group covers. */
  showtimes: number
  venueNames: string[]
  /** Local date of the earliest showtime in the group. */
  firstDate: string
  ticketUrl: string
}

export interface ScoreRunSummary {
  scored: number
  highlights: number
  affinities: number
  overallMean: number
  /** Highlight groups, best first. */
  groups: HighlightGroup[]
}

/**
 * Title-keyed membership for the watchlist and the diary.
 *
 * Titles are the only handle we have for a screening the resolver never
 * matched, and the watchlist carries no TMDB ids at all. Format decoration is
 * stripped before keying, so "American Astronaut (35mm)" finds the watchlist's
 * "American Astronaut".
 */
interface Lookup {
  /** Keys that match with no year constraint. */
  loose: Set<string>
  /** `key|year` pairs. */
  exact: Set<string>
}

function emptyLookup(): Lookup {
  return { loose: new Set(), exact: new Set() }
}

function addToLookup(lookup: Lookup, title: string, year: number | null | undefined): void {
  const key = matchKey(normalizeTitle(title).title)
  if (!key) return
  if (year == null) lookup.loose.add(key)
  else lookup.exact.add(`${key}|${year}`)
}

/**
 * A screening matches when the title agrees and either side is year-less.
 * Requiring both years to agree would drop every unresolved screening, since a
 * raw title carries no year at all.
 */
function lookupHit(lookup: Lookup, titles: string[], year: number | null | undefined): boolean {
  for (const title of titles) {
    const key = matchKey(normalizeTitle(title).title)
    if (!key) continue
    if (lookup.loose.has(key)) return true
    if (year != null && lookup.exact.has(`${key}|${year}`)) return true
    // The stored side has a year and this side does not: still the same film as
    // far as we can tell, so accept it rather than losing the signal.
    if (year == null && [...lookup.exact].some((entry) => entry.startsWith(`${key}|`))) return true
  }
  return false
}

/**
 * Tag and score every future screening.
 *
 * Rules, affinities, the watchlist and the diary are loaded once and the
 * scoring itself is the pure `score()` — the database is read before the loop
 * and written after it, never inside the scorer.
 */
export async function runScoring(
  db: Db,
  extractor: TagExtractor,
  now: Date,
): Promise<ScoreRunSummary> {
  // Recompute first: a scored feed built on last week's affinities is exactly
  // the kind of stale-but-plausible output this project treats as a bug.
  const affinityModel = await deriveAffinities(db)

  const rules = await db.select().from(tasteRules)
  const model: ScoringModel = {
    rules: rules.map((rule) => ({
      kind: rule.kind,
      value: rule.value,
      weight: rule.weight,
      enabled: rule.enabled,
    })),
    affinities: affinityModel.affinities.map((a) => ({
      dimension: a.dimension,
      value: a.value,
      weight: a.weight,
    })),
  }

  const watchlistLookup = emptyLookup()
  const watchlistFilmIds = new Set<number>()
  for (const row of await db.select().from(watchlist)) {
    addToLookup(watchlistLookup, row.titlePattern, row.year)
    if (row.filmId != null) watchlistFilmIds.add(row.filmId)
  }

  const watchedLookup = emptyLookup()
  const watchedTmdbIds = new Set<number>()
  for (const row of await db.select().from(letterboxdEntries)) {
    if (row.kind !== 'diary') continue
    addToLookup(watchedLookup, row.title, row.year)
    if (row.tmdbId != null) watchedTmdbIds.add(row.tmdbId)
  }

  const rows = await db
    .select({
      id: screenings.id,
      rawTitle: screenings.rawTitle,
      description: screenings.description,
      formatHints: screenings.formatHints,
      localDate: screenings.localDate,
      ticketUrl: screenings.ticketUrl,
      filmId: screenings.filmId,
      venueName: venues.name,
      venueChain: venues.chain,
      filmTitle: films.title,
      filmYear: films.year,
      filmTmdbId: films.tmdbId,
      genres: films.genres,
      originalLanguage: films.originalLanguage,
      director: films.director,
    })
    .from(screenings)
    .innerJoin(venues, eq(screenings.venueId, venues.id))
    .leftJoin(films, eq(screenings.filmId, films.id))
    .where(and(eq(screenings.cancelled, false), gte(screenings.startsAtUtc, now)))

  interface Scored {
    id: number
    rawTitle: string
    filmId: number | null
    filmTitle: string | null
    tags: Tag[]
    score: number
    reasons: ScoreReason[]
    highlight: boolean
    venueName: string
    localDate: string
    ticketUrl: string
  }

  const scored: Scored[] = []
  for (const row of rows) {
    const tags = await extractor.extract({
      rawTitle: row.rawTitle,
      description: row.description ?? undefined,
      formatHints: row.formatHints ?? [],
    })

    const titles = [row.rawTitle, ...(row.filmTitle ? [row.filmTitle] : [])]
    const onWatchlist =
      (row.filmId != null && watchlistFilmIds.has(row.filmId)) ||
      lookupHit(watchlistLookup, titles, row.filmYear)
    const alreadyWatched =
      (row.filmTmdbId != null && watchedTmdbIds.has(row.filmTmdbId)) ||
      lookupHit(watchedLookup, titles, row.filmYear)

    const result = score(
      {
        tags,
        genres: row.genres ?? [],
        originalLanguage: row.originalLanguage,
        director: row.director,
        year: row.filmYear,
        venueChain: row.venueChain,
        onWatchlist,
        alreadyWatched,
      },
      model,
    )

    scored.push({
      id: row.id,
      rawTitle: row.rawTitle,
      filmId: row.filmId,
      filmTitle: row.filmTitle,
      tags,
      score: result.score,
      reasons: result.reasons,
      highlight: result.highlight,
      venueName: row.venueName,
      localDate: row.localDate,
      ticketUrl: row.ticketUrl,
    })
  }

  db.transaction((tx) => {
    for (const row of scored) {
      tx
        .update(screenings)
        .set({ tags: row.tags, score: row.score, reasons: row.reasons })
        .where(eq(screenings.id, row.id))
        .run()
    }
  })

  return {
    scored: scored.length,
    highlights: scored.filter((row) => row.highlight).length,
    affinities: affinityModel.affinities.length,
    overallMean: affinityModel.overallMean,
    groups: groupHighlights(scored.filter((row) => row.highlight)),
  }
}

/**
 * Collapse showtimes into one entry per film+tags+score.
 *
 * The 70mm Odyssey has 66 showtimes in the live database, and one film reaches
 * the feed under several raw titles at once -- "Harry Potter and the
 * Sorcerer's Stone 25th Anniversary" at Cinemark and "Harry Potter And The
 * Philosopher's Stone: 25th Anniversary" at AMC are the same screening event.
 * Grouping on the resolved film (falling back to the normalized title while a
 * screening is unresolved) keeps one film to one line, so a top-20 feed shows
 * twenty things rather than twenty showtimes of six.
 *
 * Tags and score stay in the key: a 70mm print and an ordinary showing of the
 * same film are different offers and must not merge.
 */
function groupHighlights(
  rows: {
    rawTitle: string
    filmId: number | null
    filmTitle: string | null
    tags: Tag[]
    score: number
    reasons: ScoreReason[]
    venueName: string
    localDate: string
    ticketUrl: string
  }[],
): HighlightGroup[] {
  const groups = new Map<string, HighlightGroup>()

  for (const row of rows) {
    const identity = row.filmId != null ? `film:${row.filmId}` : `title:${matchKey(normalizeTitle(row.rawTitle).title)}`
    const key = `${identity}|${row.tags.join(',')}|${row.score}`
    const existing = groups.get(key)
    if (existing) {
      existing.showtimes += 1
      if (!existing.venueNames.includes(row.venueName)) existing.venueNames.push(row.venueName)
      if (row.localDate < existing.firstDate) existing.firstDate = row.localDate
      continue
    }
    groups.set(key, {
      rawTitle: row.rawTitle,
      filmTitle: row.filmTitle,
      score: row.score,
      tags: row.tags,
      reasons: row.reasons,
      showtimes: 1,
      venueNames: [row.venueName],
      firstDate: row.localDate,
      ticketUrl: row.ticketUrl,
    })
  }

  return [...groups.values()].sort(
    (a, b) => b.score - a.score || a.firstDate.localeCompare(b.firstDate) || b.showtimes - a.showtimes,
  )
}
