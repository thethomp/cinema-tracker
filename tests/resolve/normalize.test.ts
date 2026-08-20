import { describe, it, expect } from 'vitest'
import { normalizeTitle, matchKey } from '../../src/resolve/normalize.js'

describe('normalizeTitle', () => {
  const cases: Array<[string, { title: string; hints: string[]; reissue: boolean }]> = [
    ['American Astronaut (35mm)', { title: 'American Astronaut', hints: ['35mm'], reissue: false }],
    ['The Odyssey (70mm)', { title: 'The Odyssey', hints: ['70mm'], reissue: false }],
    ['Agadha (Telugu with English Subtitles)', { title: 'Agadha', hints: ['Telugu with English Subtitles'], reissue: false }],
    ['Cocoon One Summer of Girlhood (English Dubbed)', { title: 'Cocoon One Summer of Girlhood', hints: ['English Dubbed'], reissue: false }],
    ['All Wishes Come True! (Mandarin with Chinese and English Subtitles)', { title: 'All Wishes Come True!', hints: ['Mandarin with Chinese and English Subtitles'], reissue: false }],
    ['Harry Potter and the Chamber of Secrets (2026 Re-Release)', { title: 'Harry Potter and the Chamber of Secrets', hints: ['2026 Re-Release'], reissue: true }],
    ["Harry Potter and the Sorcerer's Stone 25th Anniversary", { title: "Harry Potter and the Sorcerer's Stone", hints: ['25th Anniversary'], reissue: true }],
    ['Teenage Sex and Death at Camp Miasma (35mm)', { title: 'Teenage Sex and Death at Camp Miasma', hints: ['35mm'], reissue: false }],
    // Live corpus, 2026-08-19: a bare year with no decoration word. These are the
    // 2012-2023 films, so 2026 must never reach TMDB as a year hint.
    ['The Hunger Games (2026)', { title: 'The Hunger Games', hints: ['2026'], reissue: true }],
    ['The Hunger Games: Catching Fire (2026)', { title: 'The Hunger Games: Catching Fire', hints: ['2026'], reissue: true }],
    ['The Hunger Games: Mockingjay Part 1 (2026)', { title: 'The Hunger Games: Mockingjay Part 1', hints: ['2026'], reissue: true }],
    ['The Hunger Games: Mockingjay Part 2 (2026)', { title: 'The Hunger Games: Mockingjay Part 2', hints: ['2026'], reissue: true }],
    ['The Hunger Games: The Ballad of Songbirds and Snakes (2026)', { title: 'The Hunger Games: The Ballad of Songbirds and Snakes', hints: ['2026'], reissue: true }],
    // Live corpus: an anniversary marker nested behind a language parenthetical.
    ['Your Name. 10th Anniversary (Japanese with English Subtitles)', { title: 'Your Name.', hints: ['Japanese with English Subtitles', '10th Anniversary'], reissue: true }],
    ['Terminator 2: Judgment Day 35th Anniversary', { title: 'Terminator 2: Judgment Day', hints: ['35th Anniversary'], reissue: true }],
  ]

  for (const [raw, expected] of cases) {
    it(`normalizes "${raw}"`, () => {
      const result = normalizeTitle(raw)
      expect(result.title).toBe(expected.title)
      expect(result.hints).toEqual(expected.hints)
      expect(result.isReissue).toBe(expected.reissue)
    })
  }

  it('preserves a colon as legitimate title punctuation', () => {
    expect(normalizeTitle('Harry Potter and the Deathly Hallows: Part 1 (2026 Re-Release)').title)
      .toBe('Harry Potter and the Deathly Hallows: Part 1')
    expect(normalizeTitle('KATSEYE: WILD HEARTS').title).toBe('KATSEYE: WILD HEARTS')
  })

  it('leaves an undecorated title untouched', () => {
    const result = normalizeTitle('Spider-Man: Brand New Day')
    expect(result.title).toBe('Spider-Man: Brand New Day')
    expect(result.hints).toEqual([])
    expect(result.isReissue).toBe(false)
  })

  it('strips multiple trailing parentheticals', () => {
    const result = normalizeTitle('Some Film (Hindi with English Subtitles) (35mm)')
    expect(result.title).toBe('Some Film')
    expect(result.hints).toEqual(['Hindi with English Subtitles', '35mm'])
  })

  it('keeps a parenthetical that is part of the actual title', () => {
    // No decoration keyword, so it is not treated as decoration.
    expect(normalizeTitle('Cléo from 5 to 7 (Cléo de 5 à 7)').title)
      .toBe('Cléo from 5 to 7 (Cléo de 5 à 7)')
  })

  it('does not mistake a number that is not a year for decoration', () => {
    // Guards the bare-year rule against eating real parenthesised title text.
    expect(normalizeTitle('Some Film (1)').title).toBe('Some Film (1)')
    expect(normalizeTitle('Blade Runner (2049 Cut)').title).toBe('Blade Runner (2049 Cut)')
  })

  it('never returns an empty title', () => {
    expect(normalizeTitle('(35mm)').title).toBe('(35mm)')
  })
})

describe('matchKey', () => {
  it('casefolds and strips punctuation and articles', () => {
    expect(matchKey('The Odyssey')).toBe(matchKey('odyssey'))
    expect(matchKey("Harry Potter and the Sorcerer's Stone"))
      .toBe(matchKey('harry potter and the sorcerers stone'))
  })

  it('folds diacritics', () => {
    expect(matchKey('Romería')).toBe(matchKey('Romeria'))
  })

  it('does not collapse genuinely different titles', () => {
    expect(matchKey('The Odyssey')).not.toBe(matchKey('Odyssey 2'))
  })
})
