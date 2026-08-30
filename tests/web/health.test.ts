import { describe, expect, it } from 'vitest'
import { sourceLabel, summarizeHealth } from '../../web/src/health'
import type { HealthReport, SourceStatus } from '../../web/src/api'

const source = (over: Partial<SourceStatus> & { source: string }): SourceStatus => ({
  healthy: true,
  lastRunAt: '2026-08-22T18:10:03.307Z',
  lastStatus: 'ok',
  itemCount: 800,
  ...over,
})

const report = (sources: SourceStatus[], over: Partial<HealthReport> = {}): HealthReport => ({
  healthy: sources.every((s) => s.healthy),
  sources,
  lastRunAt: '2026-08-22T18:10:03.307Z',
  unresolvedTitles: 0,
  unresolvedScreenings: 0,
  ...over,
})

describe('sourceLabel', () => {
  it('spells the acronyms the way the venues do', () => {
    expect(sourceLabel('siff')).toBe('SIFF')
    expect(sourceLabel('amc')).toBe('AMC')
    expect(sourceLabel('cinemark')).toBe('Cinemark')
    expect(sourceLabel('seattle-magic')).toBe('Seattle Magic')
  })

  it('title-cases an id it has never seen rather than printing the slug', () => {
    // A newly added adapter must still read as a name in the notice.
    expect(sourceLabel('grand-illusion')).toBe('Grand Illusion')
  })
})

describe('summarizeHealth', () => {
  it('says nothing when every source is reporting', () => {
    const summary = summarizeHealth(report([source({ source: 'siff' }), source({ source: 'amc' })]))
    expect(summary.ok).toBe(true)
    expect(summary.failing).toEqual([])
    // Null, not an empty string: the notice is absent, not blank.
    expect(summary.headline).toBeNull()
  })

  it('names the single failing source', () => {
    const summary = summarizeHealth(
      report([
        source({ source: 'siff', healthy: false, reason: 'never run', lastStatus: null }),
        source({ source: 'amc' }),
      ]),
    )
    expect(summary.ok).toBe(false)
    expect(summary.headline).toBe('SIFF is not reporting')
    expect(summary.failing.map((s) => s.source)).toEqual(['siff'])
  })

  it('counts them against the total when more than one has failed', () => {
    const summary = summarizeHealth(
      report([
        source({ source: 'siff', healthy: false, reason: 'never run' }),
        source({ source: 'cinemark', healthy: false, reason: 'count dropped to 3' }),
        source({ source: 'amc' }),
        source({ source: 'seattle-magic' }),
      ]),
    )
    expect(summary.headline).toBe('2 of 4 sources are not reporting')
    expect(summary.failing.map((s) => s.source)).toEqual(['siff', 'cinemark'])
  })

  it('trusts the per-source flags over the top-level one', () => {
    // The banner must follow the evidence. A report claiming health while a
    // source says "never run" is exactly the silent-wrong-data case this
    // project is built to be loud about.
    const summary = summarizeHealth(
      report([source({ source: 'siff', healthy: false, reason: 'never run' })], {
        healthy: true,
      }),
    )
    expect(summary.ok).toBe(false)
    expect(summary.headline).toBe('SIFF is not reporting')
  })

  it('states a reason for every failing source, even one that gave none', () => {
    const summary = summarizeHealth(
      report([source({ source: 'amc', healthy: false })]),
    )
    expect(summary.failing[0]!.reason).toBe('no reason given')
  })
})
