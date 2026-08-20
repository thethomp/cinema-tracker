import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { films, titleOverrides } from '../../src/db/schema.js'
import { resolveTitle, type ResolveResult } from '../../src/resolve/resolver.js'
import type { TmdbCandidate, TmdbFilm } from '../../src/tmdb/client.js'

function stubClient(candidates: TmdbCandidate[], detail?: Partial<TmdbFilm>) {
  return {
    searchMovies: vi.fn(async () => candidates),
    getMovie: vi.fn(async (id: number): Promise<TmdbFilm> => ({
      tmdbId: id, title: 'Detail', genres: [], ...detail,
    })),
  }
}

const candidate = (over: Partial<TmdbCandidate> = {}): TmdbCandidate => ({
  tmdbId: 1, title: 'The Odyssey', year: 2026, popularity: 50, ...over,
})

/**
 * `expect(result.status).toBe('resolved')` asserts but does not narrow, so the
 * discriminated union still hides `tmdbId` from the compiler. These narrow and
 * assert in one step; the throw is unreachable once the expect has passed, and
 * carries the other branch's diagnostic field so a failure says why.
 */
function expectResolved(result: ResolveResult): Extract<ResolveResult, { status: 'resolved' }> {
  expect(result.status).toBe('resolved')
  if (result.status !== 'resolved') throw new Error(`unresolved: ${result.reason}`)
  return result
}

function expectUnresolved(result: ResolveResult): Extract<ResolveResult, { status: 'unresolved' }> {
  expect(result.status).toBe('unresolved')
  if (result.status !== 'unresolved') throw new Error(`resolved to tmdb ${result.tmdbId}`)
  return result
}

let db: Db
beforeEach(() => { db = createDatabase(':memory:').db })

describe('resolveTitle', () => {
  it('prefers a manual override and never calls TMDB search', async () => {
    await db.insert(titleOverrides).values({ rawTitle: 'Weird Title', venueId: null, tmdbId: 42 })
    const client = stubClient([])

    const result = expectResolved(await resolveTitle(db, client as never, 'Weird Title'))

    expect(result.tmdbId).toBe(42)
    expect(result.via).toBe('override')
    expect(client.searchMovies).not.toHaveBeenCalled()
  })

  it('reuses an already-resolved film by match key without hitting TMDB', async () => {
    await db.insert(films).values({ tmdbId: 99, title: 'The Odyssey', year: 2026, genres: [] })
    const client = stubClient([])

    const result = expectResolved(await resolveTitle(db, client as never, 'Odyssey (70mm)'))

    expect(result.tmdbId).toBe(99)
    expect(result.via).toBe('cache')
    expect(client.searchMovies).not.toHaveBeenCalled()
  })

  it('accepts a confident TMDB match on exact normalized title', async () => {
    const client = stubClient([candidate({ tmdbId: 7, title: 'The Odyssey' })])

    const result = expectResolved(await resolveTitle(db, client as never, 'The Odyssey (70mm)'))

    expect(result.tmdbId).toBe(7)
    expect(result.via).toBe('search')
  })

  it('rejects a low-confidence match rather than guessing', async () => {
    const client = stubClient([candidate({ tmdbId: 8, title: 'Something Else Entirely' })])

    const result = expectUnresolved(await resolveTitle(db, client as never, 'The Odyssey (70mm)'))

    expect(result.reason).toContain('no confident match')
  })

  // Verified live on 2026-08-19: TMDB serves the UK primary title for this film,
  // so an exact-match-only rule would reject a title that is plainly the same.
  it('accepts a regional title variant on high token overlap', async () => {
    const client = stubClient([
      candidate({ tmdbId: 671, title: "Harry Potter and the Philosopher's Stone", year: 2001 }),
    ])

    const result = expectResolved(
      await resolveTitle(db, client as never, "Harry Potter and the Sorcerer's Stone"),
    )

    expect(result.tmdbId).toBe(671)
    expect(result.via).toBe('search')
  })

  it('does not accept a short title on partial overlap', async () => {
    // Two shared tokens out of three is above the ratio but below the absolute
    // floor — "DC Returns" is not "DC League of Super-Pets".
    const client = stubClient([candidate({ tmdbId: 9, title: 'DC Returns' })])

    expect((await resolveTitle(db, client as never, 'DC')).status).toBe('unresolved')
  })

  it('prefers an exact match over a merely similar one', async () => {
    const client = stubClient([
      candidate({ tmdbId: 1, title: "Harry Potter and the Philosopher's Stone", popularity: 99 }),
      candidate({ tmdbId: 2, title: "Harry Potter and the Sorcerer's Stone", popularity: 1 }),
    ])

    const result = expectResolved(
      await resolveTitle(db, client as never, "Harry Potter and the Sorcerer's Stone"),
    )
    expect(result.tmdbId).toBe(2)
  })

  it('does not pass a re-release year as a TMDB year hint', async () => {
    const client = stubClient([candidate({ tmdbId: 671, title: 'Harry Potter and the Goblet of Fire', year: 2005 })])

    await resolveTitle(db, client as never, 'Harry Potter and the Goblet of Fire (2026 Re-Release)')

    expect(client.searchMovies).toHaveBeenCalledWith('Harry Potter and the Goblet of Fire', undefined)
  })

  it('breaks ties on popularity when several titles match exactly', async () => {
    const client = stubClient([
      candidate({ tmdbId: 1, title: 'The Odyssey', popularity: 3 }),
      candidate({ tmdbId: 2, title: 'The Odyssey', popularity: 90 }),
    ])

    expect(expectResolved(await resolveTitle(db, client as never, 'The Odyssey')).tmdbId).toBe(2)
  })

  it('reports unresolved when TMDB returns nothing', async () => {
    const client = stubClient([])

    const result = expectUnresolved(await resolveTitle(db, client as never, 'Nonexistent Film'))

    expect(result.reason).toContain('no results')
  })

  it('scopes an override to a venue when one is given', async () => {
    await db.insert(titleOverrides).values({ rawTitle: 'DC', venueId: 'cinemark-totem-lake', tmdbId: 5 })
    const client = stubClient([])

    const scoped = expectResolved(await resolveTitle(db, client as never, 'DC', 'cinemark-totem-lake'))
    expect(scoped.tmdbId).toBe(5)
    expectUnresolved(await resolveTitle(db, client as never, 'DC', 'siff-uptown'))
  })
})
