import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { venues, screenings, films } from '../../src/db/schema.js'
import { upsertFilm, linkScreenings, unresolvedTitles } from '../../src/store/films.js'
import type { TmdbFilm } from '../../src/tmdb/client.js'

const FILM: TmdbFilm = {
  tmdbId: 671,
  title: "Harry Potter and the Sorcerer's Stone",
  year: 2001,
  runtimeMinutes: 152,
  originalLanguage: 'en',
  genres: ['Adventure', 'Fantasy'],
  director: 'Chris Columbus',
  posterUrl: 'https://image.tmdb.org/t/p/w500/x.jpg',
  synopsis: 'A boy learns he is a wizard.',
  usReleaseDate: '2001-11-16',
}

let db: Db
beforeEach(async () => {
  db = createDatabase(':memory:').db
  await db.insert(venues).values({
    id: 'v1', name: 'V', chain: 'Test',
    timezone: 'America/Los_Angeles', sourceVenueId: 'v1', weight: 0,
  })
})

async function addScreening(rawTitle: string, sourceId: string) {
  await db.insert(screenings).values({
    venueId: 'v1', filmId: null, rawTitle,
    startsAtUtc: new Date('2026-08-20T02:00:00Z'), localDate: '2026-08-19',
    ticketUrl: 'https://example.com', sourceScreeningId: sourceId,
    formatHints: [], tags: [], firstSeenAt: new Date(), lastSeenAt: new Date(),
  })
}

describe('upsertFilm', () => {
  it('inserts a film and returns its row id', async () => {
    const id = await upsertFilm(db, FILM, new Date())
    const rows = await db.select().from(films)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(id)
    expect(rows[0]!.genres).toEqual(['Adventure', 'Fantasy'])
  })

  it('is idempotent on tmdb id and refreshes metadata', async () => {
    const first = await upsertFilm(db, FILM, new Date('2026-08-19T00:00:00Z'))
    const second = await upsertFilm(db, { ...FILM, runtimeMinutes: 160 }, new Date('2026-08-20T00:00:00Z'))

    expect(second).toBe(first)
    const rows = await db.select().from(films)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.runtimeMinutes).toBe(160)
  })
})

describe('linkScreenings', () => {
  it('links every screening sharing a raw title', async () => {
    await addScreening('Harry Potter', 's1')
    await addScreening('Harry Potter', 's2')
    await addScreening('Other Film', 's3')
    const filmId = await upsertFilm(db, FILM, new Date())

    const count = await linkScreenings(db, 'Harry Potter', filmId)

    expect(count).toBe(2)
    const rows = await db.select().from(screenings)
    expect(rows.filter((r) => r.filmId === filmId)).toHaveLength(2)
    expect(rows.find((r) => r.rawTitle === 'Other Film')!.filmId).toBeNull()
  })
})

describe('unresolvedTitles', () => {
  it('returns distinct unresolved titles with their counts', async () => {
    await addScreening('Alpha', 's1')
    await addScreening('Alpha', 's2')
    await addScreening('Beta', 's3')
    const filmId = await upsertFilm(db, FILM, new Date())
    await linkScreenings(db, 'Beta', filmId)

    const rows = await unresolvedTitles(db)

    expect(rows).toEqual([{ rawTitle: 'Alpha', screeningCount: 2 }])
  })

  it('ignores cancelled screenings', async () => {
    await addScreening('Alpha', 's1')
    await db.update(screenings).set({ cancelled: true })

    expect(await unresolvedTitles(db)).toEqual([])
  })
})
