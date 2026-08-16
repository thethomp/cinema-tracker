import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { venues, screenings, sourceRuns } from '../../src/db/schema.js'
import { runSweep } from '../../src/sweep/sweep.js'
import type { VenueAdapter, VenueRef, RawScreening } from '../../src/core/types.js'

const TZ = 'America/Los_Angeles'
const venueA: VenueRef = {
  id: 'venue-a', name: 'Venue A', chain: 'Test', timezone: TZ, sourceVenueId: 'a',
}
const venueB: VenueRef = {
  id: 'venue-b', name: 'Venue B', chain: 'Test', timezone: TZ, sourceVenueId: 'b',
}

function screening(id: string, venueId = 'venue-a'): RawScreening {
  return {
    rawTitle: 'Test Film',
    startsAt: new Date('2026-08-21T02:15:00.000Z'),
    localDate: '2026-08-20',
    venueId,
    ticketUrl: 'https://example.com/t',
    sourceScreeningId: id,
    formatHints: [],
  }
}

function stubAdapter(id: string, result: RawScreening[] | Error): VenueAdapter {
  return {
    id,
    venues: [venueA],
    async fetch() {
      if (result instanceof Error) throw result
      return result
    },
  }
}

let db: Db
beforeEach(async () => {
  db = createDatabase(':memory:').db
  await db.insert(venues).values({ ...venueA, weight: 0 })
})

describe('runSweep', () => {
  const range = { from: '2026-08-16', to: '2026-08-20' }

  it('stores screenings and records a successful run', async () => {
    await runSweep(db, [stubAdapter('good', [screening('s1')])], range, new Date())

    expect(await db.select().from(screenings)).toHaveLength(1)
    const runs = await db.select().from(sourceRuns)
    expect(runs[0]!.status).toBe('ok')
    expect(runs[0]!.itemCount).toBe(1)
  })

  it('records a failed run without throwing', async () => {
    await expect(
      runSweep(db, [stubAdapter('bad', new Error('network down'))], range, new Date()),
    ).resolves.toBeDefined()

    const runs = await db.select().from(sourceRuns)
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toContain('network down')
  })

  it('does not mark screenings missing when the adapter failed', async () => {
    await runSweep(db, [stubAdapter('good', [screening('s1')])], range, new Date())
    await runSweep(db, [stubAdapter('good', new Error('network down'))], range, new Date())

    const rows = await db.select().from(screenings)
    expect(rows[0]!.missedSweeps).toBe(0)
    expect(rows[0]!.cancelled).toBe(false)
  })

  it('marks screenings missing after a successful sweep that omits them', async () => {
    await runSweep(db, [stubAdapter('good', [screening('s1')])], range, new Date())
    await runSweep(db, [stubAdapter('good', [screening('s2')])], range, new Date())

    const rows = await db.select().from(screenings)
    const gone = rows.find((r) => r.sourceScreeningId === 's1')!
    expect(gone.missedSweeps).toBe(1)
  })

  it('marks a venue missing even when it returns nothing at all', async () => {
    await db.insert(venues).values({ ...venueB, weight: 0 })

    // Both venues listed on the first sweep...
    const both: VenueAdapter = {
      id: 'good',
      venues: [venueA, venueB],
      async fetch(venue) {
        return venue.id === 'venue-a' ? [screening('a1')] : [screening('b1', 'venue-b')]
      },
    }
    await runSweep(db, [both], range, new Date())

    // ...and on the second, venue-b returns an empty listing. That is exactly
    // what a renamed auditorium looks like, so its rows must age out.
    const silent: VenueAdapter = {
      id: 'good',
      venues: [venueA, venueB],
      async fetch(venue) {
        return venue.id === 'venue-a' ? [screening('a1')] : []
      },
    }
    await runSweep(db, [silent], range, new Date())

    const rows = await db.select().from(screenings)
    expect(rows.find((r) => r.sourceScreeningId === 'b1')!.missedSweeps).toBe(1)
    expect(rows.find((r) => r.sourceScreeningId === 'a1')!.missedSweeps).toBe(0)
  })

  it('continues to later adapters when an earlier one fails', async () => {
    const result = await runSweep(
      db,
      [
        stubAdapter('bad', new Error('boom')),
        stubAdapter('good', [screening('s1')]),
      ],
      range,
      new Date(),
    )

    expect(result.map((r) => r.status).sort()).toEqual(['failed', 'ok'])
    expect(await db.select().from(screenings)).toHaveLength(1)
  })
})
