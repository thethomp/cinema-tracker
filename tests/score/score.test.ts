import { describe, it, expect } from 'vitest'
import {
  score,
  HIGHLIGHT_THRESHOLD,
  type ScoreInput,
  type ScoringModel,
} from '../../src/score/score.js'

const RULES: ScoringModel['rules'] = [
  { kind: 'watchlist', value: 'match', weight: 100, enabled: true },
  { kind: 'declared', value: 'Horror', weight: 60, enabled: true },
  { kind: 'tag', value: '70MM', weight: 50, enabled: true },
  { kind: 'tag', value: '35MM', weight: 50, enabled: true },
  { kind: 'tag', value: 'LIVE_SCORE', weight: 50, enabled: true },
  { kind: 'tag', value: 'Q_AND_A', weight: 50, enabled: true },
  { kind: 'tag', value: 'ANNIVERSARY', weight: 50, enabled: true },
  { kind: 'language', value: 'non-english', weight: 20, enabled: true },
  { kind: 'genre', value: 'Documentary', weight: 15, enabled: true },
  { kind: 'venue', value: 'SIFF', weight: 15, enabled: true },
  { kind: 'venue', value: 'Independent', weight: 15, enabled: true },
  { kind: 'tag', value: 'IMAX', weight: 10, enabled: true },
  { kind: 'watched', value: 'seen', weight: -80, enabled: true },
]

const model = (overrides: Partial<ScoringModel> = {}): ScoringModel => ({
  rules: RULES,
  affinities: [],
  ...overrides,
})

const input = (overrides: Partial<ScoreInput> = {}): ScoreInput => ({
  tags: [],
  genres: [],
  originalLanguage: 'en',
  director: null,
  year: null,
  venueChain: 'AMC',
  onWatchlist: false,
  alreadyWatched: false,
  ...overrides,
})

function weightFor(result: ReturnType<typeof score>, signal: string): number | undefined {
  return result.reasons.find((r) => r.signal === signal)?.weight
}

describe('score', () => {
  it('gives a plain screening at a weightless chain nothing', () => {
    const result = score(input(), model())
    expect(result.score).toBe(0)
    expect(result.reasons).toEqual([])
    expect(result.highlight).toBe(false)
  })

  it('pays a watchlist match 100, enough on its own', () => {
    const result = score(input({ onWatchlist: true }), model())
    expect(result.score).toBe(100)
    expect(weightFor(result, 'watchlist')).toBe(100)
    expect(result.highlight).toBe(true)
  })

  it('pays a declared preference 60, enough on its own', () => {
    // Horror must reach the feed unaided, with no other signal firing.
    const result = score(input({ genres: ['Horror'] }), model())
    expect(result.score).toBe(60)
    expect(weightFor(result, 'declared')).toBe(60)
    expect(result.highlight).toBe(true)
  })

  it('pays a special-event tag 50', () => {
    const result = score(input({ tags: ['70MM'] }), model())
    expect(result.score).toBe(50)
    expect(weightFor(result, 'special-event')).toBe(50)
  })

  it('pays the special-event bonus once, not once per tag', () => {
    // A 35mm anniversary print is one special event, not two.
    const result = score(input({ tags: ['35MM', 'ANNIVERSARY'] }), model())
    expect(result.score).toBe(50)
  })

  it('pays IMAX 10, on top of a special-event tag', () => {
    expect(score(input({ tags: ['IMAX'] }), model()).score).toBe(10)
    expect(score(input({ tags: ['70MM', 'IMAX'] }), model()).score).toBe(60)
  })

  it('pays a strong affinity 30', () => {
    const result = score(
      input({ genres: ['Drama'] }),
      model({ affinities: [{ dimension: 'genre', value: 'Drama', weight: 30 }] }),
    )
    expect(result.score).toBe(30)
    expect(weightFor(result, 'affinity')).toBe(30)
  })

  it('pays the affinity bonus once even when several dimensions match', () => {
    const result = score(
      input({ genres: ['Drama', 'Horror'], director: 'Kiyoshi Kurosawa', year: 1983 }),
      model({
        rules: RULES.filter((r) => r.kind !== 'declared'),
        affinities: [
          { dimension: 'genre', value: 'Drama', weight: 30 },
          { dimension: 'genre', value: 'Horror', weight: 30 },
          { dimension: 'director', value: 'Kiyoshi Kurosawa', weight: 30 },
          { dimension: 'decade', value: '1980s', weight: 30 },
        ],
      }),
    )
    expect(result.score).toBe(30)
  })

  it('pays a non-English original language 20', () => {
    expect(score(input({ originalLanguage: 'ja' }), model()).score).toBe(20)
    expect(score(input({ originalLanguage: 'en' }), model()).score).toBe(0)
    // Unknown language is not evidence of anything.
    expect(score(input({ originalLanguage: null }), model()).score).toBe(0)
  })

  it('pays a preferred genre 15', () => {
    const result = score(input({ genres: ['Documentary'] }), model())
    expect(result.score).toBe(15)
    expect(weightFor(result, 'genre')).toBe(15)
  })

  it('pays a weighted venue 15', () => {
    expect(score(input({ venueChain: 'SIFF' }), model()).score).toBe(15)
    expect(score(input({ venueChain: 'Independent' }), model()).score).toBe(15)
    expect(score(input({ venueChain: 'Cinemark' }), model()).score).toBe(0)
  })

  it('penalizes an already-watched film 80', () => {
    const result = score(input({ genres: ['Horror'], alreadyWatched: true }), model())
    // 60 - 80: a horror film already logged does not resurface.
    expect(result.score).toBe(-20)
    expect(weightFor(result, 'watched')).toBe(-80)
    expect(result.highlight).toBe(false)
  })

  it('waives the already-watched penalty for a special-event screening', () => {
    const result = score(
      input({ genres: ['Horror'], tags: ['70MM'], alreadyWatched: true }),
      model(),
    )
    // A 70mm print of something already seen is the rewatch worth surfacing.
    expect(result.score).toBe(110)
    expect(weightFor(result, 'watched')).toBeUndefined()
  })

  it('does not waive the penalty for a non-special tag such as IMAX', () => {
    const result = score(
      input({ genres: ['Horror'], tags: ['IMAX'], alreadyWatched: true }),
      model(),
    )
    expect(result.score).toBe(60 + 10 - 80)
  })

  it('treats exactly 40 as a highlight and 39 as not', () => {
    const boundary: ScoringModel = model({
      rules: [{ kind: 'venue', value: 'SIFF', weight: HIGHLIGHT_THRESHOLD, enabled: true }],
    })
    expect(score(input({ venueChain: 'SIFF' }), boundary).highlight).toBe(true)

    const under: ScoringModel = model({
      rules: [{ kind: 'venue', value: 'SIFF', weight: HIGHLIGHT_THRESHOLD - 1, enabled: true }],
    })
    expect(score(input({ venueChain: 'SIFF' }), under).highlight).toBe(false)
  })

  it('names every contributing signal with its weight', () => {
    const result = score(
      input({
        genres: ['Horror'],
        tags: ['70MM', 'IMAX'],
        originalLanguage: 'ja',
        venueChain: 'SIFF',
        onWatchlist: true,
      }),
      model(),
    )
    expect(result.reasons.map((r) => [r.signal, r.weight])).toEqual([
      ['watchlist', 100],
      ['declared', 60],
      ['special-event', 50],
      ['language', 20],
      ['venue', 15],
      ['tag', 10],
    ])
    expect(result.score).toBe(255)
  })

  it('takes its weights from the rules argument, not from constants', () => {
    const halved = model({ rules: RULES.map((r) => ({ ...r, weight: r.weight / 2 })) })
    expect(score(input({ onWatchlist: true }), halved).score).toBe(50)
  })

  it('ignores a disabled rule', () => {
    const off = model({
      rules: RULES.map((r) => (r.kind === 'declared' ? { ...r, enabled: false } : r)),
    })
    expect(score(input({ genres: ['Horror'] }), off).score).toBe(0)
  })

  it('scores nothing when the rule table is empty rather than falling back', () => {
    // A wiped rules table must produce a flat feed, not silently reinstate
    // hardcoded defaults that nothing in the database explains.
    const result = score(
      input({ genres: ['Horror'], tags: ['70MM'], onWatchlist: true, venueChain: 'SIFF' }),
      { rules: [], affinities: [] },
    )
    expect(result.score).toBe(0)
    expect(result.reasons).toEqual([])
  })
})
