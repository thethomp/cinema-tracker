import { describe, it, expect } from 'vitest'
import { createAdapters, allVenues } from '../../src/adapters/index.js'
import { Fetcher } from '../../src/fetch/fetcher.js'

describe('createAdapters', () => {
  it('registers all four sources when an AMC key is present', () => {
    const adapters = createAdapters(new Fetcher(), { amcApiKey: 'KEY' })
    expect(adapters.map((a) => a.id).sort()).toEqual(['amc', 'cinemark', 'seattle-magic', 'siff'])
  })

  // A registered-but-keyless AMC adapter would fail every sweep and mark the
  // source unhealthy; omitting it is the honest outcome.
  it('omits AMC when no key is configured', () => {
    const adapters = createAdapters(new Fetcher())
    expect(adapters.map((a) => a.id)).not.toContain('amc')
    expect(adapters.map((a) => a.id).sort()).toEqual(['cinemark', 'seattle-magic', 'siff'])
  })

  it('omits AMC when the key is an empty string', () => {
    const adapters = createAdapters(new Fetcher(), { amcApiKey: '' })
    expect(adapters.map((a) => a.id)).not.toContain('amc')
  })

  // Pinned exactly, not as a lower bound: a venue added by mistake (as SIFF's
  // Egyptian was, after SIFF gave up that lease) should fail loudly here.
  it('exposes exactly the expected venues with an AMC key', () => {
    const ids = allVenues(createAdapters(new Fetcher(), { amcApiKey: 'KEY' })).map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([
      'amc-alderwood',
      'amc-pacific-place',
      'cinemark-lincoln-square',
      'cinemark-totem-lake',
      'seattle-magic',
      'siff-downtown',
      'siff-film-center',
      'siff-uptown',
    ])
  })

  it('exposes exactly the six non-AMC venues without a key', () => {
    const ids = allVenues(createAdapters(new Fetcher())).map((v) => v.id)
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
