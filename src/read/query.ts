import { and, asc, eq, gt, lte } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { appState, films, screenings, venues } from '../db/schema.js'
import { matchKey, normalizeTitle } from '../resolve/normalize.js'
import type { ScoreReason } from '../core/types.js'

/**
 * The window a read model covers, as absolute instants.
 *
 * `from` is deliberately an instant and not a local date. "Future" has to mean
 * `starts_at_utc > from`: a 7pm screening is over by 9pm, but its `local_date`
 * is still today, so a date-based filter keeps offering tickets to a film that
 * has already started.
 */
export interface ReadWindow {
  /** Exclusive lower bound. Callers pass `now`. */
  from: Date
  /** Inclusive upper bound. */
  to: Date
}

/** One firing signal, flattened for display. */
export interface EntryReason {
  label: string
  weight: number
}

export interface EntryVenue {
  id: string
  name: string
  chain: string
}

export interface EntryShowtime {
  id: number
  startsAtUtc: string
  localDate: string
  ticketUrl: string
  venueId: string
}

/**
 * One film, with every venue and showtime it is playing in the window.
 *
 * The unit of the feed is the film, not the screening. The live database has
 * 151 showtimes of The Odyssey across five venues; as screenings they fill the
 * whole page and say one thing.
 */
export interface FilmEntry {
  filmId: number | null
  /** Resolved film title when the resolver matched one, else the raw title. */
  title: string
  rawTitle: string
  year?: number
  director?: string
  runtimeMinutes?: number
  posterUrl?: string
  score: number
  reasons: EntryReason[]
  tags: string[]
  venues: EntryVenue[]
  showtimes: EntryShowtime[]
  firstSeenAt: string
  /** `firstSeenAt` is later than `app_state.last_visit_at`. */
  isNew: boolean
}

export interface ScreeningRow {
  id: number
  venueId: string
  venueName: string
  venueChain: string
  filmId: number | null
  rawTitle: string
  startsAtUtc: Date
  localDate: string
  ticketUrl: string
  tags: string[] | null
  score: number | null
  reasons: ScoreReason[] | null
  runtimeMinutes: number | null
  firstSeenAt: Date
  filmTitle: string | null
  filmYear: number | null
  filmDirector: string | null
  filmRuntimeMinutes: number | null
  filmPosterUrl: string | null
}

/**
 * Every live screening in the window, earliest first.
 *
 * Cancelled rows are dropped here rather than by each caller, so a cancellation
 * cannot leak into one read model and not another.
 */
export async function loadScreeningRows(db: Db, window: ReadWindow): Promise<ScreeningRow[]> {
  return db
    .select({
      id: screenings.id,
      venueId: screenings.venueId,
      venueName: venues.name,
      venueChain: venues.chain,
      filmId: screenings.filmId,
      rawTitle: screenings.rawTitle,
      startsAtUtc: screenings.startsAtUtc,
      localDate: screenings.localDate,
      ticketUrl: screenings.ticketUrl,
      tags: screenings.tags,
      score: screenings.score,
      reasons: screenings.reasons,
      runtimeMinutes: screenings.runtimeMinutes,
      firstSeenAt: screenings.firstSeenAt,
      filmTitle: films.title,
      filmYear: films.year,
      filmDirector: films.director,
      filmRuntimeMinutes: films.runtimeMinutes,
      filmPosterUrl: films.posterUrl,
    })
    .from(screenings)
    .innerJoin(venues, eq(screenings.venueId, venues.id))
    .leftJoin(films, eq(screenings.filmId, films.id))
    .where(
      and(
        eq(screenings.cancelled, false),
        gt(screenings.startsAtUtc, window.from),
        lte(screenings.startsAtUtc, window.to),
      ),
    )
    .orderBy(asc(screenings.startsAtUtc), asc(screenings.id))
}

/**
 * The last time the owner looked, or null when they never have.
 *
 * Null must stay null all the way to `isNew`. Substituting the epoch — or
 * "now" — either marks every one of 2,199 screenings as new on a first run, or
 * marks none of them ever again.
 */
export async function getLastVisitAt(db: Db): Promise<Date | null> {
  const rows = await db.select().from(appState).where(eq(appState.key, 'last_visit_at')).limit(1)
  const value = rows[0]?.value
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * The key two screenings must share to be the same entry.
 *
 * Falls back to the title while a screening is unresolved, which is not a
 * nicety: the eight Star Trek 60th-anniversary double features carry no
 * `film_id` at all, so a `film_id`-only key gives each showtime its own line.
 * The key is normalized rather than raw so that "The Odyssey (70mm)" and "The
 * Odyssey" are one film, and so a chain's smart apostrophe does not split a
 * title in two.
 */
export function entryKey(filmId: number | null, rawTitle: string): string {
  if (filmId != null) return `film:${filmId}`
  const normalized = matchKey(normalizeTitle(rawTitle).title)
  return `title:${normalized || rawTitle.trim().toLowerCase()}`
}

function toReasons(reasons: ScoreReason[] | null): EntryReason[] {
  return (reasons ?? []).map((reason) => ({
    label: reason.detail?.trim() || reason.signal,
    weight: reason.weight,
  }))
}

/**
 * Collapse screenings into one entry per film.
 *
 * `rows` must already be ordered by start time — venue and showtime order, and
 * the choice of representative raw title, all follow that order.
 *
 * The score is the *best* offer, not the average: a 70mm print of The Odyssey
 * at SIFF and three digital showings of it elsewhere are one entry worth 95,
 * because the 70mm print is the reason it belongs in the feed at all. The
 * reasons come from that same best screening, while tags are the union across
 * the group so the entry advertises the print it actually has on offer.
 */
export function groupByFilm(rows: ScreeningRow[], lastVisitAt: Date | null): FilmEntry[] {
  const entries = new Map<string, FilmEntry>()
  const best = new Map<string, number>()

  for (const row of rows) {
    const key = entryKey(row.filmId, row.rawTitle)
    const score = row.score ?? 0
    const showtime: EntryShowtime = {
      id: row.id,
      startsAtUtc: row.startsAtUtc.toISOString(),
      localDate: row.localDate,
      ticketUrl: row.ticketUrl,
      venueId: row.venueId,
    }

    const existing = entries.get(key)
    if (!existing) {
      entries.set(key, {
        filmId: row.filmId,
        title: row.filmTitle ?? row.rawTitle,
        rawTitle: row.rawTitle,
        ...(row.filmYear != null ? { year: row.filmYear } : {}),
        ...(row.filmDirector != null ? { director: row.filmDirector } : {}),
        ...((row.filmRuntimeMinutes ?? row.runtimeMinutes) != null
          ? { runtimeMinutes: (row.filmRuntimeMinutes ?? row.runtimeMinutes)! }
          : {}),
        ...(row.filmPosterUrl != null ? { posterUrl: row.filmPosterUrl } : {}),
        score,
        reasons: toReasons(row.reasons),
        tags: [...(row.tags ?? [])],
        venues: [{ id: row.venueId, name: row.venueName, chain: row.venueChain }],
        showtimes: [showtime],
        firstSeenAt: row.firstSeenAt.toISOString(),
        isNew: false,
      })
      best.set(key, score)
      continue
    }

    existing.showtimes.push(showtime)
    if (!existing.venues.some((venue) => venue.id === row.venueId)) {
      existing.venues.push({ id: row.venueId, name: row.venueName, chain: row.venueChain })
    }
    for (const tag of row.tags ?? []) {
      if (!existing.tags.includes(tag)) existing.tags.push(tag)
    }
    if (score > best.get(key)!) {
      best.set(key, score)
      existing.score = score
      existing.reasons = toReasons(row.reasons)
    }
    const firstSeen = row.firstSeenAt.toISOString()
    // The earliest, not the latest: a film whose entry the owner has already
    // seen does not become new again because a showtime was added to it.
    if (firstSeen < existing.firstSeenAt) existing.firstSeenAt = firstSeen
  }

  const visit = lastVisitAt?.toISOString() ?? null
  for (const entry of entries.values()) {
    entry.tags.sort()
    entry.isNew = visit != null && entry.firstSeenAt > visit
  }

  return [...entries.values()]
}
