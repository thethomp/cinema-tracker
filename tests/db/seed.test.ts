import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/db/client.js'
import { venues } from '../../src/db/schema.js'
import { seedVenues } from '../../src/db/seed.js'
import { createAdapters, allVenues } from '../../src/adapters/index.js'
import { Fetcher } from '../../src/fetch/fetcher.js'

describe('seedVenues', () => {
  it('inserts every adapter venue', async () => {
    const { db } = createDatabase(':memory:')
    const expected = allVenues(createAdapters(new Fetcher()))

    await seedVenues(db, expected)

    expect(await db.select().from(venues)).toHaveLength(expected.length)
  })

  it('is idempotent', async () => {
    const { db } = createDatabase(':memory:')
    const expected = allVenues(createAdapters(new Fetcher()))

    await seedVenues(db, expected)
    await seedVenues(db, expected)

    expect(await db.select().from(venues)).toHaveLength(expected.length)
  })

  it('applies a changed weight or timezone on re-seed', async () => {
    const { db } = createDatabase(':memory:')
    const venue = {
      id: 'siff-uptown',
      name: 'SIFF Cinema Uptown',
      chain: 'Cinemark', // weight 0
      timezone: 'America/New_York',
      sourceVenueId: 'siff-cinema-uptown',
    }

    await seedVenues(db, [venue])
    await seedVenues(db, [{ ...venue, chain: 'SIFF', timezone: 'America/Los_Angeles' }])

    const rows = await db.select().from(venues)
    expect(rows[0]!.weight).toBe(15)
    expect(rows[0]!.timezone).toBe('America/Los_Angeles')
  })

  it('weights SIFF and Seattle Magic above the chains', async () => {
    const { db } = createDatabase(':memory:')
    await seedVenues(db, allVenues(createAdapters(new Fetcher())))

    const rows = await db.select().from(venues)
    const siff = rows.find((v) => v.id === 'siff-uptown')!
    const cinemark = rows.find((v) => v.id === 'cinemark-lincoln-square')!
    expect(siff.weight).toBeGreaterThan(cinemark.weight)
  })
})
