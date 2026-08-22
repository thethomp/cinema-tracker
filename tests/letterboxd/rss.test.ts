import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseLetterboxdRss } from '../../src/letterboxd/rss.js'

const xml = readFileSync('tests/fixtures/letterboxd-rss.xml', 'utf8')

describe('parseLetterboxdRss', () => {
  const entries = parseLetterboxdRss(xml)

  it('parses every diary item in the feed', () => {
    // The feed is capped at 50 by Letterboxd; anything less means items were
    // dropped by the parser, not by the source.
    expect(entries).toHaveLength(50)
  })

  it('carries the TMDB id, so no title resolution is needed', () => {
    expect(entries.every((e) => typeof e.tmdbId === 'number')).toBe(true)
    expect(entries.filter((e) => e.tmdbId !== undefined)).toHaveLength(50)
  })

  it('parses the newest entry exactly', () => {
    expect(entries[0]).toEqual({
      filmSlug: 'insidious-out-of-the-further',
      tmdbId: 1291595,
      title: 'Insidious: Out of the Further',
      year: 2026,
      memberRating: 3,
      watchedDate: '2026-08-20',
      rewatch: false,
      liked: false,
    })
  })

  it('parses the oldest entry exactly', () => {
    expect(entries[49]).toEqual({
      // The slug is year-disambiguated ("companion-2025"), so it is not
      // derivable from the title — it has to come from the entry link.
      filmSlug: 'companion-2025',
      tmdbId: 1084199,
      title: 'Companion',
      year: 2025,
      memberRating: 3.5,
      watchedDate: '2026-05-19',
      rewatch: true,
      liked: false,
    })
  })

  it('parses ratings as numbers and leaves unrated entries undefined', () => {
    const rated = entries.filter((e) => e.memberRating !== undefined)
    expect(rated).toHaveLength(47)
    for (const entry of rated) {
      expect(entry.memberRating).toBeGreaterThanOrEqual(0.5)
      expect(entry.memberRating).toBeLessThanOrEqual(5)
    }
    expect(entries.filter((e) => e.memberRating === undefined).map((e) => e.title))
      .toEqual(['Creepy', 'Videodrome', 'Spider-Man'])
  })

  it('parses the watched date as an ISO day', () => {
    expect(entries.filter((e) => e.watchedDate !== undefined)).toHaveLength(50)
    for (const entry of entries) {
      if (entry.watchedDate) expect(entry.watchedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('derives the film slug from the entry link', () => {
    expect(entries.every((e) => /^[a-z0-9-]+$/.test(e.filmSlug))).toBe(true)
    expect(entries.map((e) => e.filmSlug).slice(0, 4)).toEqual([
      'insidious-out-of-the-further',
      'scanners',
      'teenage-sex-and-death-at-camp-miasma',
      'thesis',
    ])
  })

  it('parses rewatch and like flags', () => {
    for (const entry of entries) {
      expect(typeof entry.rewatch).toBe('boolean')
      expect(typeof entry.liked).toBe('boolean')
    }
    // The feed writes these as "Yes"/"No", not "true"/"false". Reading them as
    // booleans the JS way silently makes every entry false, which would erase
    // the like signal entirely — pin the counts, not just the types.
    expect(entries.filter((e) => e.liked)).toHaveLength(15)
    expect(entries.filter((e) => e.rewatch)).toHaveLength(12)
  })

  it('decodes XML entities in the film title', () => {
    // The feed writes apostrophes as `&#039;`. Left encoded, the title never
    // matches anything downstream.
    const entry = entries.find((e) => e.filmSlug === 'harry-potter-and-the-philosophers-stone')
    expect(entry?.title).toBe("Harry Potter and the Philosopher's Stone")
  })

  it('returns an empty list for a feed with no items', () => {
    expect(parseLetterboxdRss('<rss><channel></channel></rss>')).toEqual([])
  })

  it('throws on malformed xml rather than returning nothing', () => {
    // A zero result must be distinguishable from a broken source.
    expect(() => parseLetterboxdRss('not xml at all <<<')).toThrow()
    expect(() => parseLetterboxdRss('<html><body>Cloudflare</body></html>')).toThrow()
  })
})
