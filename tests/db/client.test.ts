import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../../src/db/client.js'
import { venues } from '../../src/db/schema.js'

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('createDatabase', () => {
  it('creates the containing directory', () => {
    // `data/` is gitignored, and better-sqlite3 will not create a missing
    // directory — so `npm run sweep` on a fresh clone died before it started.
    const root = mkdtempSync(join(tmpdir(), 'cinema-tracker-'))
    created.push(root)
    const path = join(root, 'nested', 'data', 'cinema-tracker.db')

    const { close } = createDatabase(path)
    close()

    expect(existsSync(path)).toBe(true)
  })

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
