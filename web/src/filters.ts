import type { AgendaDay, FilmEntry } from './api'

/**
 * Agenda filters.
 *
 * Client-side over the fetched days: the agenda is a few hundred entries, and
 * a round trip per checkbox would buy nothing but latency and a second copy of
 * the filtering rules on the server.
 */
export interface Filters {
  /** Venue id, or '' for all. */
  venue: string
  /** Tag, or '' for all. */
  tag: string
  watchlistOnly: boolean
}

export function emptyFilters(): Filters {
  return { venue: '', tag: '', watchlistOnly: false }
}

const VENUE_PARAM = 'venue'
const TAG_PARAM = 'tag'
const WATCHLIST_PARAM = 'watchlist'

/** Read filters out of a `location.search`, so a filtered view is linkable. */
export function parseFilters(search: string): Filters {
  const params = new URLSearchParams(search)
  return {
    venue: params.get(VENUE_PARAM) ?? '',
    tag: params.get(TAG_PARAM) ?? '',
    // Presence is not truth: `?watchlist=0` is a link someone shared with the
    // box unticked and must not come back ticked.
    watchlistOnly: params.get(WATCHLIST_PARAM) === '1',
  }
}

/** The query string for these filters, or '' when nothing is set. */
export function serializeFilters(filters: Filters): string {
  const params = new URLSearchParams()
  if (filters.venue) params.set(VENUE_PARAM, filters.venue)
  if (filters.tag) params.set(TAG_PARAM, filters.tag)
  if (filters.watchlistOnly) params.set(WATCHLIST_PARAM, '1')
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

/**
 * Whether the scorer flagged this as a watchlist title.
 *
 * The read model flattens a `ScoreReason` to `detail || signal`, so the signal
 * family is gone by the time it reaches the browser and the label is all there
 * is to match on. Matched loosely and case-insensitively so a reworded detail
 * string degrades to "the filter still works" rather than "the filter silently
 * matches nothing".
 */
export function isOnWatchlist(entry: FilmEntry): boolean {
  return entry.reasons.some((reason) => /\bwatchlist\b/i.test(reason.label))
}

/**
 * Apply filters to fetched agenda days.
 *
 * Pure: the argument is never mutated, because the unfiltered days are held in
 * state and re-filtered on every change.
 *
 * Selecting a venue narrows an entry's showtimes *and* its venue list rather
 * than merely keeping the entry. A film at four multiplexes filtered to SIFF
 * Uptown that still printed all four venues' times would be answering a
 * different question than the one asked.
 */
export function applyFilters(days: readonly AgendaDay[], filters: Filters): AgendaDay[] {
  const result: AgendaDay[] = []

  for (const day of days) {
    const entries: FilmEntry[] = []

    for (const entry of day.entries) {
      if (filters.tag && !entry.tags.includes(filters.tag)) continue
      if (filters.watchlistOnly && !isOnWatchlist(entry)) continue

      if (!filters.venue) {
        entries.push(entry)
        continue
      }

      const showtimes = entry.showtimes.filter((showtime) => showtime.venueId === filters.venue)
      if (showtimes.length === 0) continue
      entries.push({
        ...entry,
        showtimes,
        venues: entry.venues.filter((venue) => venue.id === filters.venue),
      })
    }

    // An empty day is omitted, matching the read model's own contract: the UI
    // never has to render a blank panel to say "nothing".
    if (entries.length > 0) result.push({ date: day.date, entries })
  }

  return result
}

export function countEntries(days: readonly AgendaDay[]): number {
  return days.reduce((total, day) => total + day.entries.length, 0)
}

export interface FilterOption {
  value: string
  label: string
  count: number
}

/**
 * The venues and tags actually present in the fetched window.
 *
 * Derived from the data rather than from a fixed list so the controls can
 * never offer a filter that returns nothing.
 */
export function filterOptions(days: readonly AgendaDay[]): {
  venues: FilterOption[]
  tags: FilterOption[]
} {
  const venues = new Map<string, FilterOption>()
  const tags = new Map<string, FilterOption>()

  for (const day of days) {
    for (const entry of day.entries) {
      for (const venue of entry.venues) {
        const existing = venues.get(venue.id)
        if (existing) existing.count += 1
        else venues.set(venue.id, { value: venue.id, label: venue.name, count: 1 })
      }
      for (const tag of entry.tags) {
        const existing = tags.get(tag)
        if (existing) existing.count += 1
        else tags.set(tag, { value: tag, label: tag, count: 1 })
      }
    }
  }

  return {
    venues: [...venues.values()].sort((a, b) => a.label.localeCompare(b.label)),
    tags: [...tags.values()].sort((a, b) => a.label.localeCompare(b.label)),
  }
}
