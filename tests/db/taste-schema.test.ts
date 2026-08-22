import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../../src/db/client.js'
import {
  venues,
  screenings,
  letterboxdEntries,
  watchlist,
  tasteAffinities,
  tasteRules,
  appState,
} from '../../src/db/schema.js'
import { upsertScreenings } from '../../src/store/screenings.js'

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('taste schema', () => {
  it('persists a screening description', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(venues).values({
      id: 'v1', name: 'V', chain: 'AMC',
      timezone: 'America/Los_Angeles', sourceVenueId: '1', weight: 0,
    })

    await upsertScreenings(db, [{
      rawTitle: 'The Odyssey',
      startsAt: new Date('2026-08-20T02:00:00Z'),
      localDate: '2026-08-19',
      venueId: 'v1',
      ticketUrl: 'https://example.com',
      sourceScreeningId: 's1',
      formatHints: ['70MM'],
      description: 'AMC Artisan Films, Reserved Seating, 70mm',
    }], new Date())

    const rows = await db.select().from(screenings)
    expect(rows[0]!.description).toBe('AMC Artisan Films, Reserved Seating, 70mm')
  })

  it('leaves description null when the adapter supplies none', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(venues).values({
      id: 'v1', name: 'V', chain: 'SIFF',
      timezone: 'America/Los_Angeles', sourceVenueId: '1', weight: 15,
    })
    await upsertScreenings(db, [{
      rawTitle: 'X', startsAt: new Date(), localDate: '2026-08-19',
      venueId: 'v1', ticketUrl: 'https://e.com', sourceScreeningId: 's1', formatHints: [],
    }], new Date())

    expect((await db.select().from(screenings))[0]!.description).toBeNull()
  })

  it('refreshes the description when a later sweep changes it', async () => {
    // The update path is a separate code path from the insert; a description
    // that only lands on first sight would go stale the moment AMC re-labels
    // a screening, and nothing else in the pipeline would notice.
    const { db } = createDatabase(':memory:')
    await db.insert(venues).values({
      id: 'v1', name: 'V', chain: 'AMC',
      timezone: 'America/Los_Angeles', sourceVenueId: '1', weight: 0,
    })
    const base = {
      rawTitle: 'The Odyssey',
      startsAt: new Date('2026-08-20T02:00:00Z'),
      localDate: '2026-08-19',
      venueId: 'v1',
      ticketUrl: 'https://example.com',
      sourceScreeningId: 's1',
      formatHints: ['70MM'],
    }
    await upsertScreenings(db, [{ ...base, description: 'Event' }], new Date())
    const result = await upsertScreenings(
      db,
      [{ ...base, description: 'AMC Artisan Films' }],
      new Date(),
    )

    expect(result).toEqual({ inserted: 0, updated: 1 })
    const rows = await db.select().from(screenings)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.description).toBe('AMC Artisan Films')
  })

  it('stores a letterboxd diary entry', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(letterboxdEntries).values({
      kind: 'diary', filmSlug: 'videodrome', tmdbId: 837,
      title: 'Videodrome', year: 1983, memberRating: 4.5,
      watchedDate: '2026-08-12', rewatch: false, liked: true, syncedAt: new Date(),
    })
    const rows = await db.select().from(letterboxdEntries)
    expect(rows[0]!.memberRating).toBe(4.5)
    expect(rows[0]!.kind).toBe('diary')
  })

  it('enforces one letterboxd entry per kind, slug, and watched date', async () => {
    const { db } = createDatabase(':memory:')
    const row = {
      kind: 'diary' as const, filmSlug: 'videodrome', tmdbId: 837,
      title: 'Videodrome', year: 1983, memberRating: 4.5,
      watchedDate: '2026-08-12', rewatch: false, liked: true, syncedAt: new Date(),
    }
    await db.insert(letterboxdEntries).values(row)
    await expect(db.insert(letterboxdEntries).values(row)).rejects.toThrow()

    // A rewatch on a different date is a distinct entry, not a duplicate.
    await db.insert(letterboxdEntries).values({ ...row, watchedDate: '2026-08-20', rewatch: true })
    expect(await db.select().from(letterboxdEntries)).toHaveLength(2)
  })

  it('stores watchlist, affinities, rules, and app state', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(watchlist).values({ filmId: null, titlePattern: 'Blue Velvet', addedAt: new Date(), source: 'letterboxd' })
    await db.insert(tasteAffinities).values({ dimension: 'genre', value: 'Horror', meanRating: 4.2, sampleCount: 12, weight: 30 })
    await db.insert(tasteRules).values({ kind: 'declared', value: 'Horror', weight: 60, enabled: true })
    await db.insert(appState).values({ key: 'last_visit_at', value: '2026-08-22T00:00:00Z' })

    expect(await db.select().from(watchlist)).toHaveLength(1)
    expect((await db.select().from(tasteAffinities))[0]!.sampleCount).toBe(12)
    expect((await db.select().from(tasteRules))[0]!.weight).toBe(60)
    expect((await db.select().from(appState))[0]!.value).toBe('2026-08-22T00:00:00Z')
  })

  it('enforces one affinity per dimension and value', async () => {
    const { db } = createDatabase(':memory:')
    const row = { dimension: 'genre' as const, value: 'Horror', meanRating: 4.2, sampleCount: 12, weight: 30 }
    await db.insert(tasteAffinities).values(row)
    await expect(db.insert(tasteAffinities).values(row)).rejects.toThrow()
  })

  it('migrates an existing database idempotently across repeated opens', async () => {
    // `ALTER TABLE ... ADD COLUMN` has no IF NOT EXISTS in SQLite. A naive
    // ALTER in the DDL passes the first open of a pre-existing database and
    // throws `duplicate column name` on every open after — including against
    // the live database, which is opened by every sweep.
    const root = mkdtempSync(join(tmpdir(), 'cinema-tracker-taste-'))
    created.push(root)
    const path = join(root, 'migrate.db')

    const first = createDatabase(path)
    await first.db.insert(venues).values({
      id: 'v1', name: 'V', chain: 'AMC',
      timezone: 'America/Los_Angeles', sourceVenueId: '1', weight: 0,
    })
    await upsertScreenings(first.db, [{
      rawTitle: 'The Odyssey',
      startsAt: new Date('2026-08-20T02:00:00Z'),
      localDate: '2026-08-19',
      venueId: 'v1',
      ticketUrl: 'https://example.com',
      sourceScreeningId: 's1',
      formatHints: ['70MM'],
      description: 'AMC Artisan Films',
    }], new Date())
    first.close()

    for (let i = 0; i < 3; i++) {
      const reopened = createDatabase(path)
      const rows = await reopened.db.select().from(screenings)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.description).toBe('AMC Artisan Films')
      reopened.close()
    }
  })
})
