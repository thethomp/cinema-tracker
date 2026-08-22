import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/db/client.js'
import { films, letterboxdEntries } from '../../src/db/schema.js'
import { enrichWatchedFilms } from '../../src/taste/enrich.js'
import type { TmdbFilm } from '../../src/tmdb/client.js'

function stubClient(overrides: Partial<Record<number, Partial<TmdbFilm>>> = {}) {
  const calls: number[] = []
  return {
    calls,
    async getMovie(tmdbId: number): Promise<TmdbFilm> {
      calls.push(tmdbId)
      const extra = overrides[tmdbId]
      if (extra && 'error' in extra) throw new Error(String((extra as { error: string }).error))
      return {
        tmdbId,
        title: `Film ${tmdbId}`,
        year: 1983,
        genres: ['Horror'],
        originalLanguage: 'en',
        director: 'David Cronenberg',
        ...extra,
      }
    },
  }
}

async function addDiaryEntry(
  db: ReturnType<typeof createDatabase>['db'],
  opts: { slug: string; tmdbId: number | null; rating: number | null; title?: string },
): Promise<void> {
  await db.insert(letterboxdEntries).values({
    kind: 'diary',
    filmSlug: opts.slug,
    tmdbId: opts.tmdbId,
    title: opts.title ?? opts.slug,
    year: 1983,
    memberRating: opts.rating,
    watchedDate: '2026-01-01',
    rewatch: false,
    liked: false,
    syncedAt: new Date(),
  })
}

describe('enrichWatchedFilms', () => {
  it('fetches TMDB metadata for a rated diary film we hold no row for', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      await addDiaryEntry(db, { slug: 'videodrome', tmdbId: 837, rating: 4.5 })
      const client = stubClient()

      const summary = await enrichWatchedFilms(db, client, new Date())

      expect(client.calls).toEqual([837])
      expect(summary).toEqual({ fetched: 1, skipped: 0, failed: [] })
      const rows = await db.select().from(films)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.tmdbId).toBe(837)
      expect(rows[0]!.genres).toEqual(['Horror'])
    } finally {
      close()
    }
  })

  it('does not refetch a film already in the table', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      await db.insert(films).values({
        tmdbId: 837,
        title: 'Videodrome',
        year: 1983,
        genres: ['Horror'],
        originalLanguage: 'en',
        director: 'David Cronenberg',
      })
      await addDiaryEntry(db, { slug: 'videodrome', tmdbId: 837, rating: 4.5 })
      const client = stubClient()

      const summary = await enrichWatchedFilms(db, client, new Date())

      expect(client.calls).toEqual([])
      expect(summary.fetched).toBe(0)
      expect(summary.skipped).toBe(1)
    } finally {
      close()
    }
  })

  it('ignores entries with no TMDB id and entries with no rating', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      // CSV-derived entries carry no id, so there is nothing to fetch by.
      await addDiaryEntry(db, { slug: 'from-csv', tmdbId: null, rating: 4 })
      // Unrated viewings feed already-watched suppression, which matches on the
      // diary row itself and needs no TMDB metadata.
      await addDiaryEntry(db, { slug: 'unrated', tmdbId: 999, rating: null })
      const client = stubClient()

      const summary = await enrichWatchedFilms(db, client, new Date())

      expect(client.calls).toEqual([])
      expect(summary.fetched).toBe(0)
      expect(await db.select().from(films)).toHaveLength(0)
    } finally {
      close()
    }
  })

  it('fetches each film once even when the diary holds several viewings', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      await addDiaryEntry(db, { slug: 'videodrome', tmdbId: 837, rating: 4.5 })
      await db.insert(letterboxdEntries).values({
        kind: 'diary',
        filmSlug: 'videodrome',
        tmdbId: 837,
        title: 'videodrome',
        year: 1983,
        memberRating: 5,
        watchedDate: '2026-06-01',
        rewatch: true,
        liked: true,
        syncedAt: new Date(),
      })
      const client = stubClient()

      await enrichWatchedFilms(db, client, new Date())

      expect(client.calls).toEqual([837])
    } finally {
      close()
    }
  })

  it('keeps going when one film fails and reports the failure', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      await addDiaryEntry(db, { slug: 'a', tmdbId: 1, rating: 4 })
      await addDiaryEntry(db, { slug: 'b', tmdbId: 2, rating: 4 })
      const client = stubClient({ 1: { error: 'TMDB 404' } as Partial<TmdbFilm> })

      const summary = await enrichWatchedFilms(db, client, new Date())

      // A single bad id must not cost us the other 46 films' metadata, and it
      // must not vanish either — a silently short model is the failure mode.
      expect(summary.fetched).toBe(1)
      expect(summary.failed).toEqual([{ tmdbId: 1, error: 'TMDB 404' }])
      expect((await db.select().from(films)).map((f) => f.tmdbId)).toEqual([2])
    } finally {
      close()
    }
  })
})
