import { describe, it, expect } from 'vitest'
import { createAdapters, allVenues, unconfiguredAdapters } from '../../src/adapters/index.js'
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

describe('unconfiguredAdapters', () => {
  // Omitting the AMC adapter is the right thing to *do* and the wrong thing to
  // do *silently*. For a week the owner's two AMC venues stopped being swept
  // and nothing said so: no adapter, no run, no row, no health entry. This is
  // how the omission gets a name it can be reported under.
  it('names AMC and the variable it wants when no key is configured', () => {
    expect(unconfiguredAdapters()).toEqual([{ source: 'amc', variable: 'AMC_API_KEY' }])
  })

  it('treats an empty key as no key, exactly as createAdapters does', () => {
    expect(unconfiguredAdapters({ amcApiKey: '' })).toEqual([
      { source: 'amc', variable: 'AMC_API_KEY' },
    ])
  })

  it('reports nothing missing when the key is present', () => {
    expect(unconfiguredAdapters({ amcApiKey: 'KEY' })).toEqual([])
  })

  it('agrees with createAdapters about which sources are absent', () => {
    // The two must never drift: an adapter that is built but reported missing,
    // or missing but reported built, is worse than either fact alone.
    for (const options of [{}, { amcApiKey: '' }, { amcApiKey: 'KEY' }]) {
      const built = new Set(createAdapters(new Fetcher(), options).map((a) => a.id))
      for (const entry of unconfiguredAdapters(options)) {
        expect(built.has(entry.source)).toBe(false)
      }
    }
  })
})
