import { describe, it, expect } from 'vitest'
import { createAdapters, allVenues } from '../../src/adapters/index.js'
import { Fetcher } from '../../src/fetch/fetcher.js'

describe('createAdapters', () => {
  const adapters = createAdapters(new Fetcher())

  it('registers all three v1 sources', () => {
    expect(adapters.map((a) => a.id).sort()).toEqual([
      'cinemark',
      'seattle-magic',
      'siff',
    ])
  })

  // Pinned exactly, not as a lower bound: a venue added by mistake (as SIFF's
  // Egyptian was, after SIFF gave up that lease) should fail loudly here.
  it('exposes exactly the v1 venues, each with a unique id', () => {
    const ids = allVenues(adapters).map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(6)
    expect([...ids].sort()).toEqual([
      'cinemark-lincoln-square',
      'cinemark-totem-lake',
      'seattle-magic',
      'siff-downtown',
      'siff-film-center',
      'siff-uptown',
    ])
  })
})
