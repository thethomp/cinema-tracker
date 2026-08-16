import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/db/client.js'
import { venues } from '../../src/db/schema.js'

describe('createDatabase', () => {
  it('creates an in-memory database with the schema applied', async () => {
    const { db } = createDatabase(':memory:')

    await db.insert(venues).values({
      id: 'siff-uptown',
      name: 'SIFF Cinema Uptown',
      chain: 'SIFF',
      timezone: 'America/Los_Angeles',
      sourceVenueId: 'siff-cinema-uptown',
      weight: 15,
    })

    const rows = await db.select().from(venues)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('SIFF Cinema Uptown')
  })
})
