import { describe, it, expect } from 'vitest'
import { getHighlights } from '../../src/read/highlights.js'
import {
  NOW,
  addOdysseyFilm,
  addScreenings,
  emptyDb,
  setLastVisit,
  type ScreeningSpec,
} from './fixture.js'
import type { Db } from '../../src/db/client.js'

const TO = new Date('2026-09-30T00:00:00Z')
const WINDOW = { from: NOW, to: TO }

/**
 * The Odyssey plays four venues. It is one film and must be one entry — the
 * live database has 151 showtimes of it across five venues.
 */
const ODYSSEY: ScreeningSpec[] = [
  {
    rawTitle: 'The Odyssey (70mm)',
    venueId: 'siff-uptown',
    filmId: 1,
    startsAt: '2026-08-23T02:00:00Z',
    localDate: '2026-08-22',
    score: 95,
    tags: ['70MM'],
    reasons: [
      { signal: 'special-event', detail: '70MM', weight: 50 },
      { signal: 'affinity', detail: 'director Christopher Nolan', weight: 30 },
      { signal: 'venue', detail: 'SIFF', weight: 15 },
    ],
    ticketUrl: 'https://siff.example/odyssey-70mm',
  },
  {
    rawTitle: 'The Odyssey',
    venueId: 'amc-pacific-place',
    filmId: 1,
    startsAt: '2026-08-23T03:00:00Z',
    localDate: '2026-08-22',
    score: 45,
    tags: ['ARTHOUSE'],
    reasons: [{ signal: 'affinity', detail: 'director Christopher Nolan', weight: 30 }],
  },
  {
    rawTitle: 'The Odyssey',
    venueId: 'amc-alderwood',
    filmId: 1,
    startsAt: '2026-08-24T02:00:00Z',
    localDate: '2026-08-23',
    score: 45,
    tags: ['ARTHOUSE'],
  },
  {
    rawTitle: 'The Odyssey',
    venueId: 'cinemark-lincoln-square',
    filmId: 1,
    startsAt: '2026-08-24T03:00:00Z',
    localDate: '2026-08-23',
    score: 45,
    tags: ['IMAX'],
  },
]

/**
 * The two chains name the same double feature differently and neither is
 * resolved, so `film_id` is null on all three rows. Grouping on `film_id`
 * alone put every one of these on its own line.
 */
const STAR_TREK: ScreeningSpec[] = [
  {
    rawTitle: "Space Seed + Star Trek II: The Wrath of Khan - Director's Cut 60th Anniversary Event",
    venueId: 'amc-alderwood',
    startsAt: '2026-09-05T23:00:00Z',
    localDate: '2026-09-05',
    score: 80,
    tags: ['ANNIVERSARY', 'EVENT'],
  },
  {
    rawTitle: "Space Seed + Star Trek II: The Wrath of Khan - Director's Cut 60th Anniversary Event",
    venueId: 'amc-alderwood',
    startsAt: '2026-09-08T23:00:00Z',
    localDate: '2026-09-08',
    score: 80,
    tags: ['ANNIVERSARY', 'EVENT'],
  },
  {
    rawTitle:
      'Star Trek Double Feature - Space Seed & Star Trek II: The Wrath of Khan Director’s Cut - 60th Anniversary Event',
    venueId: 'cinemark-lincoln-square',
    startsAt: '2026-09-05T23:30:00Z',
    localDate: '2026-09-05',
    score: 50,
    tags: ['ANNIVERSARY'],
  },
]

async function loaded(): Promise<{ db: Db; close: () => void }> {
  const { db, close } = await emptyDb()
  await addOdysseyFilm(db)
  await addScreenings(db, [...ODYSSEY, ...STAR_TREK])
  return { db, close }
}

describe('getHighlights', () => {
  it('returns an empty list on an empty database', async () => {
    const { db, close } = await emptyDb()
    try {
      expect(await getHighlights(db, WINDOW)).toEqual([])
    } finally {
      close()
    }
  })

  it('collapses one film at four venues into a single entry', async () => {
    const { db, close } = await loaded()
    try {
      const entries = await getHighlights(db, WINDOW)
      const odyssey = entries.filter((e) => e.filmId === 1)
      expect(odyssey).toHaveLength(1)

      const entry = odyssey[0]!
      expect(entry.title).toBe('The Odyssey')
      expect(entry.rawTitle).toBe('The Odyssey (70mm)')
      expect(entry.year).toBe(2026)
      expect(entry.director).toBe('Christopher Nolan')
      expect(entry.runtimeMinutes).toBe(168)
      expect(entry.posterUrl).toBe('https://image.tmdb.org/t/p/w500/odyssey.jpg')

      // The best offer sets the score: a 70mm print is the reason this film is
      // in the feed, and averaging it with three digital showings would bury it.
      expect(entry.score).toBe(95)
      // Tag-shaped reasons are spelled the way the page spells them; the
      // rest are already prose and pass through untouched.
      expect(entry.reasons).toEqual([
        { label: '70mm', weight: 50 },
        { label: 'director Christopher Nolan', weight: 30 },
        { label: 'SIFF', weight: 15 },
      ])
      // Union across the group, so the entry advertises the 70mm print it
      // actually has on offer somewhere.
      expect(entry.tags).toEqual(['70MM', 'ARTHOUSE', 'IMAX'])

      expect(entry.venues.map((v) => v.id)).toEqual([
        'siff-uptown',
        'amc-pacific-place',
        'amc-alderwood',
        'cinemark-lincoln-square',
      ])
      expect(entry.venues[0]).toEqual({
        id: 'siff-uptown',
        name: 'SIFF Cinema Uptown',
        chain: 'SIFF',
      })

      expect(entry.showtimes).toHaveLength(4)
      expect(entry.showtimes.map((s) => s.startsAtUtc)).toEqual([
        '2026-08-23T02:00:00.000Z',
        '2026-08-23T03:00:00.000Z',
        '2026-08-24T02:00:00.000Z',
        '2026-08-24T03:00:00.000Z',
      ])
      expect(entry.showtimes[0]!.venueId).toBe('siff-uptown')
      expect(entry.showtimes[0]!.localDate).toBe('2026-08-22')
      expect(entry.showtimes[0]!.ticketUrl).toBe('https://siff.example/odyssey-70mm')
      expect(entry.showtimes[0]!.id).toBeTypeOf('number')
    } finally {
      close()
    }
  })

  it('spells a tag reason the way the page spells it, and leaves prose alone', async () => {
    // The WHY row was printing "Q_AND_A +50" under a stamp reading "Q & A".
    // Only the two signals whose detail *is* a tag identifier get formatted:
    // "on the watchlist", "director Christopher Nolan" and a bare language
    // code are already human-readable, and a blanket underscore-to-space pass
    // over every label would be the wrong tool applied to all of them.
    const { db, close } = await emptyDb()
    try {
      await addScreenings(db, [
        {
          rawTitle: 'Blue Velvet + Q&A with Kyle MacLachlan',
          venueId: 'siff-uptown',
          startsAt: '2026-08-23T02:00:00Z',
          localDate: '2026-08-22',
          score: 215,
          tags: ['Q_AND_A', 'RE_RELEASE', 'EVENT'],
          reasons: [
            { signal: 'watchlist', detail: 'on the watchlist', weight: 100 },
            { signal: 'special-event', detail: 'Q_AND_A, LIVE_SCORE', weight: 50 },
            { signal: 'affinity', detail: 'director Christopher Nolan', weight: 30 },
            { signal: 'language', detail: 'ja', weight: 20 },
            { signal: 'tag', detail: 'RE_RELEASE', weight: 15 },
          ],
        },
      ])

      const entries = await getHighlights(db, WINDOW)
      expect(entries).toHaveLength(1)
      expect(entries[0]!.reasons).toEqual([
        { label: 'on the watchlist', weight: 100 },
        { label: 'Q & A, Live score', weight: 50 },
        { label: 'director Christopher Nolan', weight: 30 },
        { label: 'ja', weight: 20 },
        { label: 'Re-release', weight: 15 },
      ])
      // The identifiers still travel raw where they are identifiers.
      expect(entries[0]!.tags).toEqual(['EVENT', 'Q_AND_A', 'RE_RELEASE'])
    } finally {
      close()
    }
  })

  it('falls back to the signal name when a reason carries no detail', async () => {
    const { db, close } = await emptyDb()
    try {
      await addScreenings(db, [
        {
          rawTitle: 'Coyote vs. Acme',
          venueId: 'siff-uptown',
          startsAt: '2026-08-23T02:00:00Z',
          localDate: '2026-08-22',
          score: 60,
          reasons: [{ signal: 'declared', detail: '   ', weight: 60 }],
        },
      ])
      const entries = await getHighlights(db, WINDOW)
      expect(entries[0]!.reasons).toEqual([{ label: 'declared', weight: 60 }])
    } finally {
      close()
    }
  })

  it('groups unresolved screenings by raw title, so a double feature appears once', async () => {
    const { db, close } = await loaded()
    try {
      const entries = await getHighlights(db, WINDOW)
      const trek = entries.filter((e) => e.rawTitle.includes('Star Trek'))

      // Three rows, two raw titles: the AMC pairing appears once with both of
      // its dates, and Cinemark's differently-named copy stands beside it.
      expect(trek).toHaveLength(2)
      expect(trek.map((e) => e.showtimes.length)).toEqual([2, 1])
      expect(trek[0]!.filmId).toBeNull()
      expect(trek[0]!.title).toBe(
        "Space Seed + Star Trek II: The Wrath of Khan - Director's Cut 60th Anniversary Event",
      )
      expect(trek[0]!.venues.map((v) => v.id)).toEqual(['amc-alderwood'])
      expect(trek[0]!.showtimes.map((s) => s.localDate)).toEqual(['2026-09-05', '2026-09-08'])
    } finally {
      close()
    }
  })

  it('orders by score descending, then by earliest showtime', async () => {
    const { db, close } = await loaded()
    try {
      const entries = await getHighlights(db, WINDOW)
      expect(entries.map((e) => e.score)).toEqual([95, 80, 50])
      expect(entries.map((e) => e.showtimes[0]!.startsAtUtc)).toEqual([
        '2026-08-23T02:00:00.000Z',
        '2026-09-05T23:00:00.000Z',
        '2026-09-05T23:30:00.000Z',
      ])
    } finally {
      close()
    }
  })

  it('excludes screenings below the highlight threshold', async () => {
    const { db, close } = await emptyDb()
    try {
      await addScreenings(db, [
        {
          rawTitle: 'PAW Patrol: The Dino Movie',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-23T02:00:00Z',
          localDate: '2026-08-22',
          score: 0,
        },
        {
          rawTitle: 'Never Scored',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-23T02:00:00Z',
          localDate: '2026-08-22',
          score: null,
        },
        {
          rawTitle: 'Just Under',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-23T02:00:00Z',
          localDate: '2026-08-22',
          score: 39,
        },
        {
          rawTitle: 'Just Over',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-23T02:00:00Z',
          localDate: '2026-08-22',
          score: 40,
        },
      ])
      const entries = await getHighlights(db, WINDOW)
      expect(entries.map((e) => e.title)).toEqual(['Just Over'])
    } finally {
      close()
    }
  })

  it('excludes screenings that have already started and ones that are cancelled', async () => {
    const { db, close } = await emptyDb()
    try {
      await addScreenings(db, [
        {
          // 7pm yesterday: still today's `local_date` window in a date-based
          // filter, but long over.
          rawTitle: 'Already Over',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-22T02:00:00Z',
          localDate: '2026-08-21',
          score: 100,
        },
        {
          rawTitle: 'Starting Now',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-22T18:00:00Z',
          localDate: '2026-08-22',
          score: 100,
        },
        {
          rawTitle: 'Cancelled',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-25T02:00:00Z',
          localDate: '2026-08-24',
          score: 100,
          cancelled: true,
        },
        {
          rawTitle: 'Beyond The Window',
          venueId: 'amc-alderwood',
          startsAt: '2026-10-05T02:00:00Z',
          localDate: '2026-10-04',
          score: 100,
        },
        {
          rawTitle: 'Still To Come',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-25T02:00:00Z',
          localDate: '2026-08-24',
          score: 100,
        },
      ])
      expect((await getHighlights(db, WINDOW)).map((e) => e.title)).toEqual(['Still To Come'])
    } finally {
      close()
    }
  })

  it('drops a cancelled showtime from a film that also has live ones', async () => {
    const { db, close } = await emptyDb()
    try {
      await addOdysseyFilm(db)
      await addScreenings(db, [
        { ...ODYSSEY[0]!, cancelled: true },
        ODYSSEY[1]!,
      ])
      const [entry] = await getHighlights(db, WINDOW)
      expect(entry!.showtimes).toHaveLength(1)
      expect(entry!.venues.map((v) => v.id)).toEqual(['amc-pacific-place'])
      // Score follows the surviving showtimes, not the cancelled 70mm one.
      expect(entry!.score).toBe(45)
      expect(entry!.tags).toEqual(['ARTHOUSE'])
    } finally {
      close()
    }
  })

  it('respects limit, keeping the highest scores', async () => {
    const { db, close } = await loaded()
    try {
      const entries = await getHighlights(db, { ...WINDOW, limit: 2 })
      expect(entries).toHaveLength(2)
      expect(entries.map((e) => e.score)).toEqual([95, 80])
    } finally {
      close()
    }
  })

  it('marks nothing new when no visit has ever been recorded', async () => {
    const { db, close } = await loaded()
    try {
      const entries = await getHighlights(db, WINDOW)
      expect(entries).toHaveLength(3)
      // A first run that flags all 2,199 screenings as new is noise, not news.
      expect(entries.every((e) => e.isNew === false)).toBe(true)
    } finally {
      close()
    }
  })

  it('marks only entries first seen after the last visit as new', async () => {
    const { db, close } = await emptyDb()
    try {
      await setLastVisit(db, '2026-08-20T00:00:00Z')
      await addScreenings(db, [
        {
          rawTitle: 'Seen Before',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-25T02:00:00Z',
          localDate: '2026-08-24',
          score: 100,
          firstSeenAt: '2026-08-19T00:00:00Z',
        },
        {
          rawTitle: 'Brand New',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-26T02:00:00Z',
          localDate: '2026-08-25',
          score: 90,
          firstSeenAt: '2026-08-21T00:00:00Z',
        },
        {
          // Same title as "Seen Before", added since. The entry is not new:
          // the owner has already been shown this film.
          rawTitle: 'Seen Before',
          venueId: 'amc-pacific-place',
          startsAt: '2026-08-27T02:00:00Z',
          localDate: '2026-08-26',
          score: 100,
          firstSeenAt: '2026-08-21T00:00:00Z',
        },
      ])

      const entries = await getHighlights(db, WINDOW)
      const byTitle = new Map(entries.map((e) => [e.title, e]))
      expect(byTitle.get('Seen Before')!.isNew).toBe(false)
      expect(byTitle.get('Seen Before')!.firstSeenAt).toBe('2026-08-19T00:00:00.000Z')
      expect(byTitle.get('Brand New')!.isNew).toBe(true)
      expect(byTitle.get('Brand New')!.firstSeenAt).toBe('2026-08-21T00:00:00.000Z')
    } finally {
      close()
    }
  })
})
