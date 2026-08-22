import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/db/client.js'
import { films, letterboxdEntries, tasteAffinities } from '../../src/db/schema.js'
import {
  computeAffinities,
  decadeOf,
  deriveAffinities,
  MIN_SAMPLE_COUNT,
  STRONG_AFFINITY_WEIGHT,
  type RatedFilm,
} from '../../src/taste/affinities.js'

/** A rated film with only the fields a given case cares about. */
function rated(rating: number, overrides: Partial<RatedFilm> = {}): RatedFilm {
  return { rating, genres: [], originalLanguage: null, director: null, year: null, ...overrides }
}

/** n films of one genre, all at the same rating. */
function genreRuns(genre: string, rating: number, count: number): RatedFilm[] {
  return Array.from({ length: count }, () => rated(rating, { genres: [genre] }))
}

describe('computeAffinities', () => {
  it('computes the overall mean across rated films', () => {
    const model = computeAffinities([rated(2), rated(3), rated(4), rated(5)])
    expect(model.overallMean).toBe(3.5)
    expect(model.ratedCount).toBe(4)
  })

  it('promotes a genre with 6 ratings a full star above the mean', () => {
    // Overall mean 3.0; Horror sits at 4.0, a full star clear of it.
    const model = computeAffinities([
      ...genreRuns('Horror', 4, 6),
      ...genreRuns('Drama', 2, 6),
    ])
    expect(model.overallMean).toBe(3)

    const horror = model.affinities.find((a) => a.value === 'Horror')
    expect(horror).toEqual({
      dimension: 'genre',
      value: 'Horror',
      meanRating: 4,
      sampleCount: 6,
      weight: STRONG_AFFINITY_WEIGHT,
    })
    expect(model.affinities.map((a) => a.value)).not.toContain('Drama')
  })

  it('rejects a genre far above the mean but under the sample floor', () => {
    const model = computeAffinities([
      ...genreRuns('Horror', 5, MIN_SAMPLE_COUNT - 1),
      ...genreRuns('Drama', 2, 10),
    ])
    // A 5.0 mean against a ~2.4 overall mean and still no affinity: one
    // enthusiastic weekend must not turn a genre into a highlight generator.
    expect(model.affinities.map((a) => a.value)).not.toContain('Horror')
  })

  it('rejects a genre only 0.2 stars above the mean', () => {
    // Mean 3.4; Horror 3.6 — clears the sample floor, misses the margin.
    const model = computeAffinities([
      ...genreRuns('Horror', 3.6, 5),
      ...genreRuns('Drama', 3.2, 5),
    ])
    expect(model.overallMean).toBeCloseTo(3.4, 10)
    expect(model.affinities.map((a) => a.value)).not.toContain('Horror')
  })

  it('excludes unrated films from every mean', () => {
    const unrated = Array.from({ length: 20 }, () => rated(Number.NaN, { genres: ['Drama'] }))
    const model = computeAffinities([
      ...genreRuns('Horror', 4, 6),
      ...genreRuns('Drama', 2, 6),
      ...unrated.map((f) => ({ ...f, rating: null as unknown as number })),
    ])
    // 20 phantom Drama entries would drag the overall mean and inflate Horror's
    // margin if they counted.
    expect(model.overallMean).toBe(3)
    expect(model.affinities.find((a) => a.value === 'Drama')).toBeUndefined()
  })

  it('credits a multi-genre film to each of its genres', () => {
    const model = computeAffinities([
      ...Array.from({ length: 6 }, () => rated(4.5, { genres: ['Horror', 'Comedy'] })),
      ...genreRuns('Drama', 2, 6),
    ])
    const values = model.affinities.filter((a) => a.dimension === 'genre').map((a) => a.value)
    expect(values.sort()).toEqual(['Comedy', 'Horror'])
  })

  it('derives decade, language, and director dimensions', () => {
    const model = computeAffinities([
      ...Array.from({ length: 6 }, () =>
        rated(5, { year: 1983, originalLanguage: 'ja', director: 'Kiyoshi Kurosawa' }),
      ),
      ...Array.from({ length: 6 }, () =>
        rated(2, { year: 2024, originalLanguage: 'en', director: 'Someone Else' }),
      ),
    ])
    const found = model.affinities.map((a) => `${a.dimension}:${a.value}`).sort()
    expect(found).toEqual(['decade:1980s', 'director:Kiyoshi Kurosawa', 'language:ja'])
  })

  it('returns no affinities and a zero mean when nothing is rated', () => {
    expect(computeAffinities([])).toEqual({ overallMean: 0, ratedCount: 0, affinities: [] })
  })
})

describe('decadeOf', () => {
  it('maps a year to its decade label', () => {
    expect(decadeOf(1983)).toBe('1980s')
    expect(decadeOf(1990)).toBe('1990s')
    expect(decadeOf(2009)).toBe('2000s')
  })

  it('returns undefined for a missing or implausible year', () => {
    expect(decadeOf(null)).toBeUndefined()
    expect(decadeOf(undefined)).toBeUndefined()
    expect(decadeOf(0)).toBeUndefined()
  })
})

async function seedRatedFilm(
  db: Awaited<ReturnType<typeof createDatabase>>['db'],
  n: number,
  opts: { genres: string[]; rating: number | null; tmdbId: number; year?: number; title?: string },
): Promise<void> {
  await db.insert(films).values({
    tmdbId: opts.tmdbId,
    title: opts.title ?? `Film ${n}`,
    year: opts.year ?? 2000,
    genres: opts.genres,
    originalLanguage: 'en',
    director: 'Dir',
  })
  await db.insert(letterboxdEntries).values({
    kind: 'diary',
    filmSlug: `film-${n}`,
    tmdbId: opts.tmdbId,
    title: opts.title ?? `Film ${n}`,
    year: opts.year ?? 2000,
    memberRating: opts.rating,
    watchedDate: `2026-01-${String(n).padStart(2, '0')}`,
    rewatch: false,
    liked: false,
    syncedAt: new Date(),
  })
}

describe('deriveAffinities', () => {
  it('writes strong affinities and replaces prior rows on recomputation', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      // A stale row that no longer qualifies must be deleted, not left behind.
      await db.insert(tasteAffinities).values({
        dimension: 'genre',
        value: 'Musical',
        meanRating: 5,
        sampleCount: 99,
        weight: STRONG_AFFINITY_WEIGHT,
      })

      for (let i = 1; i <= 6; i++) {
        await seedRatedFilm(db, i, { genres: ['Horror'], rating: 4, tmdbId: 1000 + i })
      }
      for (let i = 7; i <= 12; i++) {
        await seedRatedFilm(db, i, { genres: ['Drama'], rating: 2, tmdbId: 1000 + i })
      }

      const first = await deriveAffinities(db)
      expect(first.overallMean).toBe(3)
      expect(first.affinities.map((a) => `${a.dimension}:${a.value}`)).toContain('genre:Horror')

      const rows = await db.select().from(tasteAffinities)
      expect(rows.map((r) => r.value)).not.toContain('Musical')

      const second = await deriveAffinities(db)
      const after = await db.select().from(tasteAffinities)
      expect(second.affinities).toEqual(first.affinities)
      expect(after).toHaveLength(rows.length)
    } finally {
      close()
    }
  })

  it('counts a film once even when the diary holds several viewings of it', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      for (let i = 1; i <= 6; i++) {
        await seedRatedFilm(db, i, { genres: ['Horror'], rating: 4, tmdbId: 2000 + i })
      }
      for (let i = 7; i <= 12; i++) {
        await seedRatedFilm(db, i, { genres: ['Drama'], rating: 2, tmdbId: 2000 + i })
      }
      // Same film, watched again — a rewatch is not a second sample.
      await db.insert(letterboxdEntries).values({
        kind: 'diary',
        filmSlug: 'film-1',
        tmdbId: 2001,
        title: 'Film 1',
        year: 2000,
        memberRating: 4,
        watchedDate: '2026-06-01',
        rewatch: true,
        liked: false,
        syncedAt: new Date(),
      })

      const model = await deriveAffinities(db)
      expect(model.ratedCount).toBe(12)
      expect(model.affinities.find((a) => a.value === 'Horror')?.sampleCount).toBe(6)
    } finally {
      close()
    }
  })

  it('joins diary entries to films by title and year when no TMDB id is stored', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      // CSV and watchlist entries carry no TMDB id at all. Joining on tmdb_id
      // alone silently drops every one of them.
      for (let i = 1; i <= 6; i++) {
        await db.insert(films).values({
          tmdbId: 3000 + i,
          title: `Csv Film ${i}`,
          year: 1995,
          genres: ['Horror'],
          originalLanguage: 'en',
          director: 'Dir',
        })
        await db.insert(letterboxdEntries).values({
          kind: 'diary',
          filmSlug: `csv-film-${i}`,
          tmdbId: null,
          title: `csv film ${i}`,
          year: 1995,
          memberRating: 4,
          watchedDate: `2026-02-0${i}`,
          rewatch: false,
          liked: false,
          syncedAt: new Date(),
        })
      }
      for (let i = 7; i <= 12; i++) {
        await seedRatedFilm(db, i, { genres: ['Drama'], rating: 2, tmdbId: 3000 + i })
      }

      const model = await deriveAffinities(db)
      expect(model.ratedCount).toBe(12)
      expect(model.affinities.map((a) => a.value)).toContain('Horror')
    } finally {
      close()
    }
  })

  it('returns an empty model when no rated entry matches a film', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      await db.insert(letterboxdEntries).values({
        kind: 'diary',
        filmSlug: 'unknown',
        tmdbId: 999999,
        title: 'Unknown',
        year: 1999,
        memberRating: 5,
        watchedDate: '2026-01-01',
        rewatch: false,
        liked: false,
        syncedAt: new Date(),
      })
      expect(await deriveAffinities(db)).toEqual({ overallMean: 0, ratedCount: 0, affinities: [] })
      expect(await db.select().from(tasteAffinities)).toHaveLength(0)
    } finally {
      close()
    }
  })
})
