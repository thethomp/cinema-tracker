import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/db/client.js'
import { films, titleOverrides } from '../../src/db/schema.js'

describe('film schema', () => {
  it('stores a film with json genres', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(films).values({
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
    })
    const rows = await db.select().from(films)
    expect(rows[0]!.genres).toEqual(['Adventure', 'Fantasy'])
    expect(rows[0]!.tmdbId).toBe(671)
  })

  it('enforces one row per tmdb id', async () => {
    const { db } = createDatabase(':memory:')
    const row = { tmdbId: 671, title: 'X', genres: [] as string[] }
    await db.insert(films).values(row)
    await expect(db.insert(films).values(row)).rejects.toThrow()
  })

  it('stores a venue-scoped title override', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(titleOverrides).values({
      rawTitle: 'The Odyssey (70mm)',
      venueId: null,
      tmdbId: 12345,
    })
    const rows = await db.select().from(titleOverrides)
    expect(rows[0]!.tmdbId).toBe(12345)
  })
})
