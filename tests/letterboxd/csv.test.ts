import { describe, it, expect } from 'vitest'
import { parseLetterboxdCsv } from '../../src/letterboxd/csv.js'

// Fixtures are inline: a real export is the owner's personal data and is not
// committed. Column sets follow Letterboxd's documented exports.
const RATINGS = `Date,Name,Year,Letterboxd URI,Rating
2026-05-19,Companion,2025,https://letterboxd.com/film/companion-2025/,3.5
2026-05-02,Videodrome,1983,https://letterboxd.com/film/videodrome/,4.5
`

const WATCHLIST = `Date,Name,Year,Letterboxd URI
2026-08-01,Streetwise,1984,https://letterboxd.com/film/streetwise/
2026-07-30,Needful Things,1993,https://letterboxd.com/film/needful-things/
`

const DIARY = `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date
2026-08-21,Scanners,1981,https://boxd.it/abcde,4.0,Yes,,2026-08-19
2026-08-18,Thesis,1996,https://boxd.it/fghij,3.5,,,2026-08-17
`

describe('parseLetterboxdCsv', () => {
  it('parses a ratings export into entries with numeric ratings', () => {
    const entries = parseLetterboxdCsv(RATINGS, 'diary')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      filmSlug: 'companion-2025',
      title: 'Companion',
      year: 2025,
      memberRating: 3.5,
      watchedDate: '2026-05-19',
      rewatch: false,
      liked: false,
    })
    expect(entries[1]!.memberRating).toBe(4.5)
  })

  it('parses a watchlist export', () => {
    const entries = parseLetterboxdCsv(WATCHLIST, 'watchlist')
    expect(entries).toEqual([
      {
        filmSlug: 'streetwise',
        title: 'Streetwise',
        year: 1984,
        memberRating: undefined,
        // "Date" on a watchlist export is when the film was *added*, not
        // watched. Storing it as a watched date would be silently wrong.
        watchedDate: undefined,
        rewatch: false,
        liked: false,
      },
      {
        filmSlug: 'needful-things',
        title: 'Needful Things',
        year: 1993,
        memberRating: undefined,
        watchedDate: undefined,
        rewatch: false,
        liked: false,
      },
    ])
  })

  it('reads the diary Watched Date and Rewatch columns', () => {
    const entries = parseLetterboxdCsv(DIARY, 'diary')
    expect(entries.map((e) => [e.watchedDate, e.rewatch])).toEqual([
      ['2026-08-19', true],
      ['2026-08-17', false],
    ])
  })

  it('derives the slug from the Letterboxd URI when it names a film', () => {
    const entries = parseLetterboxdCsv(RATINGS, 'diary')
    // The URI slug is year-disambiguated; slugifying "Companion" would give
    // "companion", which is a different film.
    expect(entries[0]!.filmSlug).toBe('companion-2025')
  })

  it('falls back to slugifying the title when the URI is not a film link', () => {
    // diary.csv URIs are boxd.it short links to the *entry*, not the film.
    const entries = parseLetterboxdCsv(DIARY, 'diary')
    expect(entries.map((e) => e.filmSlug)).toEqual(['scanners', 'thesis'])

    const punctuated = parseLetterboxdCsv(
      `Name,Year\nHarry Potter and the Philosopher's Stone,2001\nWALL·E,2008\nAmélie,2001\n`,
      'diary',
    )
    // Letterboxd drops apostrophes rather than hyphenating them, and folds
    // accents: "philosophers", not "philosopher-s"; "amelie", not "am-lie".
    expect(punctuated.map((e) => e.filmSlug)).toEqual([
      'harry-potter-and-the-philosophers-stone',
      'wall-e',
      'amelie',
    ])
  })

  it('skips a row with no Name rather than failing the file', () => {
    const entries = parseLetterboxdCsv(
      `Date,Name,Year\n2026-01-01,,1984\n2026-01-02,Streetwise,1984\n`,
      'watchlist',
    )
    expect(entries.map((e) => e.title)).toEqual(['Streetwise'])
  })

  it('handles quoted fields containing commas and escaped quotes', () => {
    const entries = parseLetterboxdCsv(
      `Date,Name,Year,Letterboxd URI,Rating\n` +
        `2026-01-01,"Dr. Strangelove, or: How I Learned to Stop Worrying",1964,https://letterboxd.com/film/dr-strangelove/,5\n` +
        `2026-01-02,"The ""Burbs",1989,https://letterboxd.com/film/the-burbs/,3\n`,
      'diary',
    )
    expect(entries.map((e) => e.title)).toEqual([
      'Dr. Strangelove, or: How I Learned to Stop Worrying',
      'The "Burbs',
    ])
    expect(entries.map((e) => e.memberRating)).toEqual([5, 3])
  })

  it('leaves an empty Rating undefined rather than scoring it zero', () => {
    const entries = parseLetterboxdCsv(
      `Date,Name,Year,Rating\n2026-01-01,Creepy,2016,\n`,
      'diary',
    )
    expect(entries[0]!.memberRating).toBeUndefined()
  })

  it('matches headers case-insensitively and tolerates missing columns', () => {
    const entries = parseLetterboxdCsv(
      `name,YEAR,rating,watched date\nVideodrome,1983,4.5,2026-05-02\n`,
      'diary',
    )
    expect(entries[0]).toEqual({
      filmSlug: 'videodrome',
      title: 'Videodrome',
      year: 1983,
      memberRating: 4.5,
      watchedDate: '2026-05-02',
      rewatch: false,
      liked: false,
    })
  })

  it('tolerates a UTF-8 BOM and CRLF line endings', () => {
    const entries = parseLetterboxdCsv(
      `﻿Date,Name,Year\r\n2026-01-01,Streetwise,1984\r\n`,
      'watchlist',
    )
    expect(entries[0]!.title).toBe('Streetwise')
    expect(entries[0]!.year).toBe(1984)
  })

  it('returns an empty list for an empty or header-only file', () => {
    expect(parseLetterboxdCsv('', 'diary')).toEqual([])
    expect(parseLetterboxdCsv('   \n', 'diary')).toEqual([])
    expect(parseLetterboxdCsv('Date,Name,Year,Rating\n', 'diary')).toEqual([])
  })

  it('skips a row whose Name column is absent entirely', () => {
    // No Name header at all: nothing usable, but not a crash.
    expect(parseLetterboxdCsv(`Date,Year\n2026-01-01,1984\n`, 'diary')).toEqual([])
  })
})
