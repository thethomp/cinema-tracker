import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { films, letterboxdEntries } from '../../src/db/schema.js'
import { backfillDiaryTmdbIds } from '../../src/taste/enrich.js'
import type { TmdbCandidate, TmdbFilm } from '../../src/tmdb/client.js'

function stubClient(byQuery: Record<string, TmdbCandidate[]>) {
  return {
    searchMovies: vi.fn(async (q: string) => byQuery[q] ?? []),
    getMovie: vi.fn(
      async (id: number): Promise<TmdbFilm> => ({
        tmdbId: id,
        title: `Film ${id}`,
        year: 1999,
        genres: ['Horror'],
      }),
    ),
  }
}

const candidate = (over: Partial<TmdbCandidate> = {}): TmdbCandidate => ({
  tmdbId: 1,
  title: 'The Thing',
  year: 1982,
  popularity: 20,
  ...over,
})

let db: Db
beforeEach(() => {
  db = createDatabase(':memory:').db
})

async function addEntry(over: Record<string, unknown> = {}) {
  await db.insert(letterboxdEntries).values({
    kind: 'diary',
    filmSlug: 'the-thing',
    tmdbId: null,
    title: 'The Thing',
    year: 1982,
    memberRating: 5,
    watchedDate: '2026-01-01',
    rewatch: false,
    liked: true,
    syncedAt: new Date(),
    ...over,
  } as never)
}

describe('backfillDiaryTmdbIds', () => {
  it('resolves a rated entry by title and year and writes the id back', async () => {
    await addEntry()
    const client = stubClient({ 'The Thing': [candidate({ tmdbId: 1091 })] })

    const summary = await backfillDiaryTmdbIds(db, client as never, new Date())

    expect(summary.resolved).toBe(1)
    expect((await db.select().from(letterboxdEntries))[0]!.tmdbId).toBe(1091)
    expect(await db.select().from(films)).toHaveLength(1)
  })

  it('passes the entry year as a search hint', async () => {
    await addEntry()
    const client = stubClient({ 'The Thing': [candidate({ tmdbId: 1091 })] })

    await backfillDiaryTmdbIds(db, client as never, new Date())

    expect(client.searchMovies).toHaveBeenCalledWith('The Thing', 1982)
  })

  it('rejects a candidate whose year does not match', async () => {
    await addEntry()
    const client = stubClient({ 'The Thing': [candidate({ tmdbId: 2, year: 2011 })] })

    const summary = await backfillDiaryTmdbIds(db, client as never, new Date())

    expect(summary.resolved).toBe(0)
    expect(summary.unresolved).toContain('The Thing (1982)')
    expect((await db.select().from(letterboxdEntries))[0]!.tmdbId).toBeNull()
  })

  it('rejects a candidate whose title does not match', async () => {
    await addEntry()
    const client = stubClient({ 'The Thing': [candidate({ tmdbId: 3, title: 'Something Else' })] })

    expect((await backfillDiaryTmdbIds(db, client as never, new Date())).resolved).toBe(0)
  })

  it('tolerates punctuation and article differences via the match key', async () => {
    await addEntry({ title: 'WALL-E', filmSlug: 'wall-e', year: 2008 })
    const client = stubClient({ 'WALL-E': [candidate({ tmdbId: 10681, title: 'WALL·E', year: 2008 })] })

    expect((await backfillDiaryTmdbIds(db, client as never, new Date())).resolved).toBe(1)
  })

  it('skips entries that already have a tmdb id', async () => {
    await addEntry({ tmdbId: 999 })
    const client = stubClient({})

    const summary = await backfillDiaryTmdbIds(db, client as never, new Date())

    expect(summary.resolved).toBe(0)
    expect(client.searchMovies).not.toHaveBeenCalled()
  })

  it('skips unrated entries', async () => {
    await addEntry({ memberRating: null })
    const client = stubClient({ 'The Thing': [candidate({ tmdbId: 1091 })] })

    await backfillDiaryTmdbIds(db, client as never, new Date())

    expect(client.searchMovies).not.toHaveBeenCalled()
  })

  it('skips entries with no year, since the year is the safety check', async () => {
    await addEntry({ year: null })
    const client = stubClient({ 'The Thing': [candidate({ tmdbId: 1091 })] })

    await backfillDiaryTmdbIds(db, client as never, new Date())

    expect(client.searchMovies).not.toHaveBeenCalled()
  })

  it('is a no-op on a second run', async () => {
    await addEntry()
    const client = stubClient({ 'The Thing': [candidate({ tmdbId: 1091 })] })

    await backfillDiaryTmdbIds(db, client as never, new Date())
    const second = await backfillDiaryTmdbIds(db, client as never, new Date())

    expect(second.resolved).toBe(0)
  })

  it('reports a search failure without aborting the rest', async () => {
    await addEntry()
    await addEntry({ filmSlug: 'alien', title: 'Alien', year: 1979, watchedDate: '2026-01-02' })
    const client = {
      searchMovies: vi.fn(async (q: string) => {
        if (q === 'The Thing') throw new Error('boom')
        return [candidate({ tmdbId: 348, title: 'Alien', year: 1979 })]
      }),
      getMovie: vi.fn(async (id: number) => ({ tmdbId: id, title: 'Alien', year: 1979, genres: [] })),
    }

    const summary = await backfillDiaryTmdbIds(db, client as never, new Date())

    expect(summary.resolved).toBe(1)
    expect(summary.failed).toHaveLength(1)
  })
})
