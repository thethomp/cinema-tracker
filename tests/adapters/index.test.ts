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

  it('exposes every venue with a unique id', () => {
    const ids = allVenues(adapters).map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(7)
  })
})
