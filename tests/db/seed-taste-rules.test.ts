import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDatabase } from '../../src/db/client.js'
import { tasteRules } from '../../src/db/schema.js'
import { seedTasteRules } from '../../src/db/seed.js'

describe('seedTasteRules', () => {
  it('seeds every weight in the scoring model', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      await seedTasteRules(db)
      const rows = await db.select().from(tasteRules)
      const byKey = new Map(rows.map((r) => [`${r.kind}:${r.value}`, r.weight]))

      expect(byKey.get('watchlist:match')).toBe(100)
      expect(byKey.get('declared:Horror')).toBe(60)
      for (const tag of ['70MM', '35MM', 'LIVE_SCORE', 'Q_AND_A', 'ANNIVERSARY']) {
        expect(byKey.get(`tag:${tag}`)).toBe(50)
      }
      expect(byKey.get('language:non-english')).toBe(20)
      expect(byKey.get('venue:SIFF')).toBe(15)
      expect(byKey.get('venue:Independent')).toBe(15)
      expect(byKey.get('tag:IMAX')).toBe(10)
      expect(byKey.get('watched:seen')).toBe(-80)
      expect(rows.every((r) => r.enabled)).toBe(true)
    } finally {
      close()
    }
  })

  it('places the declared preference above the highlight threshold', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      await seedTasteRules(db)
      const [horror] = await db.select().from(tasteRules).where(eq(tasteRules.kind, 'declared'))
      // Horror must reach the feed unaided. 60 > 40 is the whole point.
      expect(horror!.weight).toBeGreaterThan(40)
    } finally {
      close()
    }
  })

  it('is idempotent', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      await seedTasteRules(db)
      const first = await db.select().from(tasteRules)
      await seedTasteRules(db)
      expect(await db.select().from(tasteRules)).toHaveLength(first.length)
    } finally {
      close()
    }
  })

  it('never overwrites a weight the owner has edited', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      await seedTasteRules(db)
      await db.update(tasteRules).set({ weight: 5 }).where(eq(tasteRules.kind, 'declared'))
      await db.update(tasteRules).set({ enabled: false }).where(eq(tasteRules.value, 'IMAX'))

      await seedTasteRules(db)

      const rows = await db.select().from(tasteRules)
      // The table is documented as editable. A re-seed that resets it would
      // silently undo every tuning the owner had done.
      expect(rows.find((r) => r.kind === 'declared')!.weight).toBe(5)
      expect(rows.find((r) => r.value === 'IMAX')!.enabled).toBe(false)
    } finally {
      close()
    }
  })
})
