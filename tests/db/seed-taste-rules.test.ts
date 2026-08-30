import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createDatabase } from '../../src/db/client.js'
import { tasteRules } from '../../src/db/schema.js'
import { seedTasteRules } from '../../src/db/seed.js'
import { HIGHLIGHT_THRESHOLD } from '../../src/score/score.js'

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
      expect(byKey.get('tag:ARTHOUSE')).toBe(15)
      expect(byKey.get('tag:EVENT')).toBe(30)
      expect(byKey.get('watched:seen')).toBe(-80)
      expect(rows.every((r) => r.enabled)).toBe(true)
      // Pin the whole set, not just the rows named above: a seed row added by
      // accident changes every score in the feed and would otherwise pass.
      expect(rows).toHaveLength(14)
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

  it('keeps ARTHOUSE and EVENT below the highlight threshold on their own', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      await seedTasteRules(db)
      const rows = await db.select().from(tasteRules).where(eq(tasteRules.kind, 'tag'))
      const byValue = new Map(rows.map((r) => [r.value, r.weight]))

      // Neither is a reason to cross town by itself. ARTHOUSE is deliberately
      // mild: AMC Artisan Films is a standing programming line (176 live
      // screenings), not a one-off.
      expect(byValue.get('ARTHOUSE')!).toBeLessThan(HIGHLIGHT_THRESHOLD)
      expect(byValue.get('EVENT')!).toBeLessThan(HIGHLIGHT_THRESHOLD)
      expect(byValue.get('ARTHOUSE')!).toBeLessThan(byValue.get('EVENT')!)
    } finally {
      close()
    }
  })

  it('does not double an ARTHOUSE weight the owner has already edited', async () => {
    const { db, close } = createDatabase(':memory:')
    try {
      await seedTasteRules(db)
      await db
        .update(tasteRules)
        .set({ weight: 25 })
        .where(and(eq(tasteRules.kind, 'tag'), eq(tasteRules.value, 'ARTHOUSE')))

      await seedTasteRules(db)

      const arthouse = await db
        .select()
        .from(tasteRules)
        .where(and(eq(tasteRules.kind, 'tag'), eq(tasteRules.value, 'ARTHOUSE')))
      expect(arthouse).toHaveLength(1)
      expect(arthouse[0]!.weight).toBe(25)
    } finally {
      close()
    }
  })
})
