import { describe, it, expect } from 'vitest'
import { unconfiguredIntegrations } from '../../src/pipeline/passes.js'

describe('unconfiguredIntegrations', () => {
  it('names both missing keys when neither is set', () => {
    /*
     * The state `npm run serve` was actually in for a week. Neither key was in
     * the environment, so the AMC adapter was never built and the resolve pass
     * was skipped with a console.warn -- and neither fact reached the health
     * report, the API, or the UI. A pass that cannot run has to be visible as
     * a pass that is not running.
     */
    expect(unconfiguredIntegrations({})).toEqual([
      { source: 'amc', variable: 'AMC_API_KEY' },
      { source: 'resolve', variable: 'TMDB_API_KEY' },
    ])
  })

  it('names only the resolve pass when TMDB is the one missing', () => {
    expect(unconfiguredIntegrations({ amcApiKey: 'KEY' })).toEqual([
      { source: 'resolve', variable: 'TMDB_API_KEY' },
    ])
  })

  it('names only AMC when TMDB is configured', () => {
    expect(unconfiguredIntegrations({ tmdbApiKey: 'TOKEN' })).toEqual([
      { source: 'amc', variable: 'AMC_API_KEY' },
    ])
  })

  it('reports nothing when everything is configured', () => {
    expect(unconfiguredIntegrations({ amcApiKey: 'KEY', tmdbApiKey: 'TOKEN' })).toEqual([])
  })

  it('treats empty strings as unset', () => {
    expect(unconfiguredIntegrations({ amcApiKey: '', tmdbApiKey: '' })).toEqual([
      { source: 'amc', variable: 'AMC_API_KEY' },
      { source: 'resolve', variable: 'TMDB_API_KEY' },
    ])
  })
})
