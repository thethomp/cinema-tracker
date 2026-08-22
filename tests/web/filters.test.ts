import { describe, expect, it } from 'vitest'
import type { AgendaDay, FilmEntry } from '../../web/src/api'
import {
  applyFilters,
  countEntries,
  emptyFilters,
  isOnWatchlist,
  parseFilters,
  serializeFilters,
  type Filters,
} from '../../web/src/filters'

function entry(partial: Partial<FilmEntry> & { title: string }): FilmEntry {
  return {
    filmId: null,
    rawTitle: partial.title,
    score: 0,
    reasons: [],
    tags: [],
    venues: [],
    showtimes: [],
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    isNew: false,
    ...partial,
  }
}

const odyssey = entry({
  title: 'The Odyssey',
  tags: ['70MM', 'ARTHOUSE'],
  venues: [
    { id: 'siff-uptown', name: 'SIFF Cinema Uptown', chain: 'SIFF' },
    { id: 'amc-alderwood', name: 'AMC Alderwood Mall 16', chain: 'AMC' },
  ],
  showtimes: [
    { id: 1, startsAtUtc: '2026-08-23T02:00:00.000Z', localDate: '2026-08-22', ticketUrl: 'u1', venueId: 'siff-uptown' },
    { id: 2, startsAtUtc: '2026-08-23T04:00:00.000Z', localDate: '2026-08-22', ticketUrl: 'u2', venueId: 'amc-alderwood' },
  ],
})

const samurai = entry({
  title: 'The Samurai and the Prisoner',
  reasons: [{ label: 'on the watchlist', weight: 100 }],
  venues: [{ id: 'siff-uptown', name: 'SIFF Cinema Uptown', chain: 'SIFF' }],
  showtimes: [
    { id: 3, startsAtUtc: '2026-08-23T03:00:00.000Z', localDate: '2026-08-22', ticketUrl: 'u3', venueId: 'siff-uptown' },
  ],
})

const days: AgendaDay[] = [
  { date: '2026-08-22', entries: [odyssey, samurai] },
  {
    date: '2026-08-23',
    entries: [
      entry({
        title: 'Colony',
        venues: [{ id: 'amc-alderwood', name: 'AMC Alderwood Mall 16', chain: 'AMC' }],
        showtimes: [
          { id: 4, startsAtUtc: '2026-08-24T01:00:00.000Z', localDate: '2026-08-23', ticketUrl: 'u4', venueId: 'amc-alderwood' },
        ],
      }),
    ],
  },
]

describe('parseFilters / serializeFilters', () => {
  it('round-trips a full filter set', () => {
    const filters: Filters = { venue: 'siff-uptown', tag: '70MM', watchlistOnly: true }
    expect(parseFilters(serializeFilters(filters))).toEqual(filters)
  })

  it('omits absent filters from the query string, so a clean view has a clean URL', () => {
    expect(serializeFilters(emptyFilters())).toBe('')
    expect(serializeFilters({ venue: '', tag: '70MM', watchlistOnly: false })).toBe('?tag=70MM')
  })

  it('reads an empty or unrelated query string as no filters', () => {
    expect(parseFilters('')).toEqual(emptyFilters())
    expect(parseFilters('?utm_source=mail')).toEqual(emptyFilters())
  })

  it('treats watchlist=0 as off rather than as present-therefore-true', () => {
    expect(parseFilters('?watchlist=0').watchlistOnly).toBe(false)
    expect(parseFilters('?watchlist=1').watchlistOnly).toBe(true)
  })
})

describe('isOnWatchlist', () => {
  it('recognises the scorer\'s watchlist reason whatever case it arrives in', () => {
    expect(isOnWatchlist(samurai)).toBe(true)
    expect(isOnWatchlist(entry({ title: 'x', reasons: [{ label: 'On The Watchlist', weight: 100 }] }))).toBe(true)
    expect(isOnWatchlist(odyssey)).toBe(false)
  })
})

describe('applyFilters', () => {
  it('returns the days untouched when nothing is filtered', () => {
    expect(applyFilters(days, emptyFilters())).toEqual(days)
  })

  it('narrows an entry to the selected venue rather than keeping all its times', () => {
    const [first] = applyFilters(days, { venue: 'siff-uptown', tag: '', watchlistOnly: false })
    expect(first!.entries).toHaveLength(2)
    const filtered = first!.entries[0]!
    expect(filtered.showtimes.map((s) => s.id)).toEqual([1])
    expect(filtered.venues.map((v) => v.id)).toEqual(['siff-uptown'])
  })

  it('drops a day that has nothing left, rather than rendering it empty', () => {
    const result = applyFilters(days, { venue: 'siff-uptown', tag: '', watchlistOnly: false })
    expect(result.map((day) => day.date)).toEqual(['2026-08-22'])
  })

  it('filters by tag', () => {
    const result = applyFilters(days, { venue: '', tag: '70MM', watchlistOnly: false })
    expect(result).toHaveLength(1)
    expect(result[0]!.entries.map((e) => e.title)).toEqual(['The Odyssey'])
  })

  it('filters to the watchlist', () => {
    const result = applyFilters(days, { venue: '', tag: '', watchlistOnly: true })
    expect(result[0]!.entries.map((e) => e.title)).toEqual(['The Samurai and the Prisoner'])
  })

  it('combines filters as AND, and can legitimately return nothing', () => {
    expect(applyFilters(days, { venue: 'amc-alderwood', tag: '70MM', watchlistOnly: true })).toEqual([])
  })

  it('does not mutate the days it was given', () => {
    applyFilters(days, { venue: 'siff-uptown', tag: '', watchlistOnly: false })
    expect(odyssey.showtimes).toHaveLength(2)
    expect(odyssey.venues).toHaveLength(2)
  })
})

describe('countEntries', () => {
  it('counts entries across every day', () => {
    expect(countEntries(days)).toBe(3)
    expect(countEntries([])).toBe(0)
  })
})
