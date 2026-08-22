import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDatabase, type Db } from '../../src/db/client.js'
import {
  films,
  letterboxdEntries,
  screenings,
  tasteAffinities,
  venues,
  watchlist,
} from '../../src/db/schema.js'
import { seedTasteRules } from '../../src/db/seed.js'
import { RuleTagExtractor } from '../../src/tags/extract.js'
import { runScoring } from '../../src/score/run.js'

const NOW = new Date('2026-08-22T12:00:00Z')
const SOON = new Date('2026-08-25T02:00:00Z')
const PAST = new Date('2026-08-01T02:00:00Z')

async function fixture(): Promise<{ db: Db; close: () => void }> {
  const { db, close } = createDatabase(':memory:')
  await seedTasteRules(db)
  await db.insert(venues).values([
    {
      id: 'siff-uptown',
      name: 'SIFF Cinema Uptown',
      chain: 'SIFF',
      timezone: 'America/Los_Angeles',
      sourceVenueId: '1',
      weight: 15,
    },
    {
      id: 'amc-pacific-place',
      name: 'AMC Pacific Place 11',
      chain: 'AMC',
      timezone: 'America/Los_Angeles',
      sourceVenueId: '2',
      weight: 0,
    },
  ])
  return { db, close }
}

async function addFilm(
  db: Db,
  opts: { tmdbId: number; title: string; year?: number; genres?: string[]; language?: string },
): Promise<number> {
  await db.insert(films).values({
    tmdbId: opts.tmdbId,
    title: opts.title,
    year: opts.year ?? 2026,
    genres: opts.genres ?? [],
    originalLanguage: opts.language ?? 'en',
    director: 'Dir',
  })
  const [row] = await db.select({ id: films.id }).from(films).where(eq(films.tmdbId, opts.tmdbId))
  return row!.id
}

async function addScreening(
  db: Db,
  opts: {
    rawTitle: string
    venueId: string
    filmId?: number | null
    formatHints?: string[]
    startsAt?: Date
    cancelled?: boolean
    sourceScreeningId: string
    description?: string
  },
): Promise<void> {
  await db.insert(screenings).values({
    venueId: opts.venueId,
    filmId: opts.filmId ?? null,
    rawTitle: opts.rawTitle,
    startsAtUtc: opts.startsAt ?? SOON,
    localDate: '2026-08-24',
    ticketUrl: 'https://example.com',
    sourceScreeningId: opts.sourceScreeningId,
    formatHints: opts.formatHints ?? [],
    tags: [],
    description: opts.description ?? null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    missedSweeps: 0,
    cancelled: opts.cancelled ?? false,
  })
}

describe('runScoring', () => {
  it('stores tags, score, and reasons on every future screening', async () => {
    const { db, close } = await fixture()
    try {
      const filmId = await addFilm(db, { tmdbId: 1, title: 'The Odyssey' })
      await addScreening(db, {
        rawTitle: 'The Odyssey',
        venueId: 'amc-pacific-place',
        filmId,
        formatHints: ['70MM'],
        sourceScreeningId: 'a',
      })

      const summary = await runScoring(db, new RuleTagExtractor(), NOW)

      expect(summary.scored).toBe(1)
      expect(summary.highlights).toBe(1)

      const [row] = await db.select().from(screenings)
      expect(row!.tags).toEqual(['70MM'])
      expect(row!.score).toBe(50)
      expect(row!.reasons).toEqual([
        { signal: 'special-event', detail: '70MM', weight: 50 },
      ])
    } finally {
      close()
    }
  })

  it('skips screenings that have already started and screenings marked cancelled', async () => {
    const { db, close } = await fixture()
    try {
      await addScreening(db, {
        rawTitle: 'Gone',
        venueId: 'siff-uptown',
        startsAt: PAST,
        sourceScreeningId: 'past',
      })
      await addScreening(db, {
        rawTitle: 'Cancelled',
        venueId: 'siff-uptown',
        cancelled: true,
        sourceScreeningId: 'cancelled',
      })
      await addScreening(db, { rawTitle: 'Live', venueId: 'siff-uptown', sourceScreeningId: 'live' })

      const summary = await runScoring(db, new RuleTagExtractor(), NOW)

      expect(summary.scored).toBe(1)
      const scored = await db.select().from(screenings)
      expect(scored.filter((s) => s.score !== null).map((s) => s.rawTitle)).toEqual(['Live'])
    } finally {
      close()
    }
  })

  it('matches the watchlist on an unresolved raw title, format suffix and all', async () => {
    const { db, close } = await fixture()
    try {
      await db.insert(watchlist).values({
        filmId: null,
        titlePattern: 'American Astronaut',
        year: 2001,
        addedAt: NOW,
        notes: null,
        source: 'letterboxd',
      })
      // No film row: the resolver never matched it. The watchlist must still
      // fire, or the highest-weight signal in the model silently depends on
      // TMDB having recognised the title.
      await addScreening(db, {
        rawTitle: 'American Astronaut (35mm)',
        venueId: 'siff-uptown',
        formatHints: ['35MM'],
        sourceScreeningId: 'aa',
      })

      await runScoring(db, new RuleTagExtractor(), NOW)

      const [row] = await db.select().from(screenings)
      expect(row!.reasons!.map((r) => r.signal)).toContain('watchlist')
      expect(row!.score).toBe(100 + 50 + 15)
    } finally {
      close()
    }
  })

  it('suppresses a film already in the diary, and un-suppresses a special-event print', async () => {
    const { db, close } = await fixture()
    try {
      const filmId = await addFilm(db, {
        tmdbId: 837,
        title: 'Videodrome',
        year: 1983,
        genres: ['Horror'],
      })
      await db.insert(letterboxdEntries).values({
        kind: 'diary',
        filmSlug: 'videodrome',
        tmdbId: 837,
        title: 'Videodrome',
        year: 1983,
        memberRating: 4.5,
        watchedDate: '2026-08-01',
        rewatch: false,
        liked: true,
        syncedAt: NOW,
      })
      await addScreening(db, {
        rawTitle: 'Videodrome',
        venueId: 'amc-pacific-place',
        filmId,
        sourceScreeningId: 'plain',
      })
      await addScreening(db, {
        rawTitle: 'Videodrome (35mm)',
        venueId: 'amc-pacific-place',
        filmId,
        sourceScreeningId: 'print',
      })

      await runScoring(db, new RuleTagExtractor(), NOW)

      const rows = await db.select().from(screenings)
      const plain = rows.find((r) => r.sourceScreeningId === 'plain')!
      const print = rows.find((r) => r.sourceScreeningId === 'print')!
      expect(plain.score).toBe(60 - 80)
      expect(print.score).toBe(60 + 50)
    } finally {
      close()
    }
  })

  it('recomputes affinities before scoring so the model is never a run behind', async () => {
    const { db, close } = await fixture()
    try {
      // A stale affinity nothing in the diary supports any more.
      await db.insert(tasteAffinities).values({
        dimension: 'genre',
        value: 'Musical',
        meanRating: 5,
        sampleCount: 40,
        weight: 30,
      })
      const filmId = await addFilm(db, { tmdbId: 5, title: 'A Musical', genres: ['Musical'] })
      await addScreening(db, {
        rawTitle: 'A Musical',
        venueId: 'amc-pacific-place',
        filmId,
        sourceScreeningId: 'm',
      })

      await runScoring(db, new RuleTagExtractor(), NOW)

      const [row] = await db.select().from(screenings)
      expect(row!.score).toBe(0)
      expect(await db.select().from(tasteAffinities)).toHaveLength(0)
    } finally {
      close()
    }
  })

  it('pays a non-English original language and reports the highlight count', async () => {
    const { db, close } = await fixture()
    try {
      const filmId = await addFilm(db, {
        tmdbId: 9,
        title: 'Your Name.',
        year: 2016,
        language: 'ja',
      })
      await addScreening(db, {
        rawTitle: 'Your Name. 10th Anniversary',
        venueId: 'siff-uptown',
        filmId,
        sourceScreeningId: 'yn',
      })

      const summary = await runScoring(db, new RuleTagExtractor(), NOW)

      const [row] = await db.select().from(screenings)
      expect(row!.tags).toEqual(['ANNIVERSARY', 'RE_RELEASE'])
      expect(row!.score).toBe(50 + 20 + 15)
      expect(summary.highlights).toBe(1)
    } finally {
      close()
    }
  })

  it('merges the raw-title variants of one film into a single feed entry', async () => {
    const { db, close } = await fixture()
    try {
      const filmId = await addFilm(db, {
        tmdbId: 671,
        title: "Harry Potter and the Philosopher's Stone",
        year: 2001,
      })
      // The same event, listed differently by two chains. Two feed lines for
      // one screening event is twenty slots spent on six films.
      await addScreening(db, {
        rawTitle: "Harry Potter and the Sorcerer's Stone 25th Anniversary",
        venueId: 'amc-pacific-place',
        filmId,
        sourceScreeningId: 'hp-a',
      })
      await addScreening(db, {
        rawTitle: "Harry Potter And The Philosopher's Stone: 25th Anniversary",
        venueId: 'amc-pacific-place',
        filmId,
        sourceScreeningId: 'hp-b',
      })

      const summary = await runScoring(db, new RuleTagExtractor(), NOW)

      expect(summary.groups).toHaveLength(1)
      expect(summary.groups[0]!.showtimes).toBe(2)
    } finally {
      close()
    }
  })

  it('keeps a special-event print separate from an ordinary showing of the same film', async () => {
    const { db, close } = await fixture()
    try {
      const filmId = await addFilm(db, { tmdbId: 1, title: 'The Odyssey', genres: ['Horror'] })
      await addScreening(db, {
        rawTitle: 'The Odyssey',
        venueId: 'amc-pacific-place',
        filmId,
        formatHints: ['70MM'],
        sourceScreeningId: '70',
      })
      await addScreening(db, {
        rawTitle: 'The Odyssey',
        venueId: 'amc-pacific-place',
        filmId,
        sourceScreeningId: 'plain',
      })

      const summary = await runScoring(db, new RuleTagExtractor(), NOW)

      // A 70mm print and a Tuesday matinee are different offers.
      expect(summary.groups.map((g) => [g.score, g.tags])).toEqual([
        [110, ['70MM']],
        [60, []],
      ])
    } finally {
      close()
    }
  })

  it('groups the highlight list by title and tags rather than listing every showtime', async () => {
    const { db, close } = await fixture()
    try {
      const filmId = await addFilm(db, { tmdbId: 1, title: 'The Odyssey' })
      for (let i = 0; i < 5; i++) {
        await addScreening(db, {
          rawTitle: 'The Odyssey',
          venueId: 'amc-pacific-place',
          filmId,
          formatHints: ['70MM'],
          sourceScreeningId: `70-${i}`,
        })
      }
      await addScreening(db, {
        rawTitle: 'The Odyssey',
        venueId: 'amc-pacific-place',
        filmId,
        formatHints: ['IMAX'],
        sourceScreeningId: 'imax',
      })

      const summary = await runScoring(db, new RuleTagExtractor(), NOW)

      // Five showtimes of one 70mm run is one thing worth telling the user
      // about, not five entries crowding out everything else.
      expect(summary.highlights).toBe(5)
      expect(summary.groups).toHaveLength(1)
      expect(summary.groups[0]).toMatchObject({
        rawTitle: 'The Odyssey',
        tags: ['70MM'],
        score: 50,
        showtimes: 5,
      })
    } finally {
      close()
    }
  })
})
