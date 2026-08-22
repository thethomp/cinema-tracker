import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { venues, screenings, films } from '../../src/db/schema.js'
import { runResolution } from '../../src/resolve/run.js'

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

function stubClient(byTitle: Record<string, number>) {
  return {
    searchMovies: vi.fn(async (q: string) =>
      byTitle[q] !== undefined ? [{ tmdbId: byTitle[q]!, title: q, year: 2026, popularity: 10 }] : [],
    ),
    getMovie: vi.fn(async (id: number) => ({ tmdbId: id, title: `Film ${id}`, genres: ['Drama'] })),
  }
}

describe('runResolution', () => {
  it('resolves and links every screening for a title', async () => {
    await addScreening('Alpha', 's1')
    await addScreening('Alpha', 's2')
    const client = stubClient({ Alpha: 100 })

    const summary = await runResolution(db, client as never, new Date())

    expect(summary.resolved).toBe(1)
    expect(summary.unresolved).toHaveLength(0)
    expect(summary.screeningsLinked).toBe(2)
    const rows = await db.select().from(screenings)
    expect(rows.every((r) => r.filmId !== null)).toBe(true)
    expect(await db.select().from(films)).toHaveLength(1)
  })

  it('reports unresolved titles without failing the run', async () => {
    await addScreening('Alpha', 's1')
    await addScreening('Mystery', 's2')
    const client = stubClient({ Alpha: 100 })

    const summary = await runResolution(db, client as never, new Date())

    expect(summary.resolved).toBe(1)
    expect(summary.unresolved).toEqual([{ rawTitle: 'Mystery', screeningCount: 1 }])
  })

  it('fetches each film detail exactly once per title', async () => {
    await addScreening('Alpha', 's1')
    await addScreening('Alpha', 's2')
    const client = stubClient({ Alpha: 100 })

    await runResolution(db, client as never, new Date())

    expect(client.getMovie).toHaveBeenCalledTimes(1)
  })

  it('is a no-op on a second run', async () => {
    await addScreening('Alpha', 's1')
    const client = stubClient({ Alpha: 100 })

    await runResolution(db, client as never, new Date())
    const second = await runResolution(db, client as never, new Date())

    expect(second.resolved).toBe(0)
    expect(second.screeningsLinked).toBe(0)
  })
})
