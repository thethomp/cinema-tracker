import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDatabase, type Db } from '../../src/db/client.js'
import { venues, screenings } from '../../src/db/schema.js'
import { upsertScreenings, markMissing } from '../../src/store/screenings.js'
import type { RawScreening } from '../../src/core/types.js'

/** The window the sweep asked for; `raw()`'s localDate falls inside it. */
const WINDOW = { from: '2026-08-16', to: '2026-09-06' }

function raw(overrides: Partial<RawScreening> = {}): RawScreening {
  return {
    rawTitle: 'The Odyssey (70mm)',
    startsAt: new Date('2026-08-21T02:15:00.000Z'),
    localDate: '2026-08-20',
    venueId: 'siff-downtown',
    ticketUrl: 'https://www.siff.net/cinema/in-theaters/the-odyssey-70mm',
    sourceScreeningId: 'abc123',
    formatHints: ['70MM'],
    ...overrides,
  }
}

let db: Db

beforeEach(async () => {
  db = createDatabase(':memory:').db
  await db.insert(venues).values({
    id: 'siff-downtown',
    name: 'SIFF Cinema Downtown',
    chain: 'SIFF',
    timezone: 'America/Los_Angeles',
    sourceVenueId: 'siff-cinema-downtown',
    weight: 15,
  })
})

describe('upsertScreenings', () => {
  it('inserts new screenings', async () => {
    const result = await upsertScreenings(db, [raw()], new Date('2026-08-16T12:00:00Z'))

    expect(result.inserted).toBe(1)
    expect(result.updated).toBe(0)
    const rows = await db.select().from(screenings)
    expect(rows[0]!.rawTitle).toBe('The Odyssey (70mm)')
    expect(rows[0]!.formatHints).toEqual(['70MM'])
  })

  it('preserves first_seen_at across re-sweeps', async () => {
    const first = new Date('2026-08-16T12:00:00Z')
    const second = new Date('2026-08-17T12:00:00Z')

    await upsertScreenings(db, [raw()], first)
    const result = await upsertScreenings(db, [raw()], second)

    expect(result.inserted).toBe(0)
    expect(result.updated).toBe(1)
    const rows = await db.select().from(screenings)
    expect(rows[0]!.firstSeenAt.getTime()).toBe(first.getTime())
    expect(rows[0]!.lastSeenAt.getTime()).toBe(second.getTime())
  })

  it('treats the same source id at a different venue as a distinct screening', async () => {
    await db.insert(venues).values({
      id: 'siff-uptown',
      name: 'SIFF Cinema Uptown',
      chain: 'SIFF',
      timezone: 'America/Los_Angeles',
      sourceVenueId: 'siff-cinema-uptown',
      weight: 15,
    })

    await upsertScreenings(db, [raw()], new Date())
    await upsertScreenings(db, [raw({ venueId: 'siff-uptown' })], new Date())

    expect(await db.select().from(screenings)).toHaveLength(2)
  })

  it('updates a changed start time on an existing screening', async () => {
    await upsertScreenings(db, [raw()], new Date('2026-08-16T12:00:00Z'))
    await upsertScreenings(
      db,
      [raw({ startsAt: new Date('2026-08-21T03:00:00.000Z') })],
      new Date('2026-08-17T12:00:00Z'),
    )

    const rows = await db.select().from(screenings)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.startsAtUtc.toISOString()).toBe('2026-08-21T03:00:00.000Z')
  })

  it('resets missed_sweeps when a screening reappears', async () => {
    await upsertScreenings(db, [raw()], new Date('2026-08-16T12:00:00Z'))
    await markMissing(db, 'siff-downtown', ['other-id'], WINDOW)
    await upsertScreenings(db, [raw()], new Date('2026-08-17T12:00:00Z'))

    const rows = await db.select().from(screenings)
    expect(rows[0]!.missedSweeps).toBe(0)
    expect(rows[0]!.cancelled).toBe(false)
  })
})

describe('markMissing', () => {
  it('does not cancel after a single miss', async () => {
    await upsertScreenings(db, [raw()], new Date())
    await markMissing(db, 'siff-downtown', [], WINDOW)

    const rows = await db.select().from(screenings)
    expect(rows[0]!.missedSweeps).toBe(1)
    expect(rows[0]!.cancelled).toBe(false)
  })

  it('cancels after two consecutive misses', async () => {
    await upsertScreenings(db, [raw()], new Date())
    await markMissing(db, 'siff-downtown', [], WINDOW)
    await markMissing(db, 'siff-downtown', [], WINDOW)

    const rows = await db.select().from(screenings)
    expect(rows[0]!.missedSweeps).toBe(2)
    expect(rows[0]!.cancelled).toBe(true)
  })

  it('leaves screenings at other venues untouched', async () => {
    await upsertScreenings(db, [raw()], new Date())
    await markMissing(db, 'cinemark-lincoln-square', [], WINDOW)

    const rows = await db.select().from(screenings)
    expect(rows[0]!.missedSweeps).toBe(0)
  })

  it('leaves screenings outside the fetch window alone', async () => {
    // A screening that has simply happened drops out of the source listing.
    // Counting that as a miss would cancel every past show within a day of it
    // taking place and destroy the signal that marks a real cancellation.
    await upsertScreenings(
      db,
      [raw({ sourceScreeningId: 'past1', localDate: '2026-08-10' }), raw()],
      new Date(),
    )

    await markMissing(db, 'siff-downtown', [], WINDOW)

    const rows = await db.select().from(screenings)
    const past = rows.find((r) => r.sourceScreeningId === 'past1')!
    const inWindow = rows.find((r) => r.sourceScreeningId === 'abc123')!
    expect(past.missedSweeps).toBe(0)
    expect(past.cancelled).toBe(false)
    expect(inWindow.missedSweeps).toBe(1)
  })

  it('never cancels a screening the source still lists', async () => {
    await upsertScreenings(db, [raw()], new Date())
    // A high miss count on a row that is present again: reachable only through
    // a caller that does not upsert first, which is exactly the invariant the
    // cancel predicate must not rely on.
    await db
      .update(screenings)
      .set({ missedSweeps: 5 })
      .where(eq(screenings.sourceScreeningId, 'abc123'))

    await markMissing(db, 'siff-downtown', ['abc123'], WINDOW)

    const rows = await db.select().from(screenings)
    expect(rows[0]!.cancelled).toBe(false)
    expect(rows[0]!.missedSweeps).toBe(5)
  })
})
