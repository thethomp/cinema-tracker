import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  createSeattleMagicAdapter,
  parseSeattleMagicScreenings,
  SEATTLE_MAGIC_VENUE,
} from '../../src/adapters/seattle-magic.js'
import type { Fetcher } from '../../src/fetch/fetcher.js'

const fixture = readFileSync('tests/fixtures/seattle-magic-events.json', 'utf8')

describe('parseSeattleMagicScreenings', () => {
  it('parses the recorded fixture into a non-empty list', () => {
    const screenings = parseSeattleMagicScreenings(fixture)

    expect(screenings.length).toBeGreaterThan(0)
    for (const screening of screenings) {
      expect(screening.venueId).toBe(SEATTLE_MAGIC_VENUE.id)
      expect(screening.formatHints).toEqual([])
    }
  })

  it('maps title, start instant and local date for a known entry', () => {
    const screening = parseSeattleMagicScreenings(fixture).find(
      (s) => s.sourceScreeningId === 'fisher-king',
    )

    expect(screening).toBeDefined()
    expect(screening!.rawTitle).toBe('The Fisher King')
    // 2025-04-30T20:00:00 local Seattle (PDT, UTC-7).
    expect(screening!.startsAt.toISOString()).toBe('2025-05-01T03:00:00.000Z')
    expect(screening!.localDate).toBe('2025-04-30')
    expect(screening!.ticketUrl).toContain('fisher-king')
    // 20:00 -> 22:30 event window.
    expect(screening!.runtimeMinutes).toBe(150)
  })

  it('produces unique source ids', () => {
    const ids = parseSeattleMagicScreenings(fixture).map((s) => s.sourceScreeningId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('disambiguates a repeated slug with the start timestamp', () => {
    const json = JSON.stringify([
      { slug: 'encore', title: 'Encore', gcalStart: '2026-09-12T20:00:00' },
      { slug: 'encore', title: 'Encore', gcalStart: '2026-09-13T20:00:00' },
    ])
    const ids = parseSeattleMagicScreenings(json).map((s) => s.sourceScreeningId)

    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe('encore')
  })

  it('derives an id from title and start when the slug is missing', () => {
    const json = JSON.stringify([
      { title: 'Close-Up Night', gcalStart: '2026-09-20T19:30:00' },
    ])
    const [screening] = parseSeattleMagicScreenings(json)

    expect(screening!.sourceScreeningId).toBe('close-up-night@2026-09-20T19:30:00')
  })

  it('skips a malformed element without throwing', () => {
    const json = JSON.stringify([
      { slug: 'good', title: 'Good One', gcalStart: '2026-09-12T20:00:00' },
      null,
      'not an object',
      { slug: 'no-start', title: 'No Start' },
      { slug: 'bad-start', title: 'Bad Start', gcalStart: 'not-a-timestamp' },
      { slug: 'no-title', gcalStart: '2026-09-14T20:00:00' },
    ])

    let screenings: ReturnType<typeof parseSeattleMagicScreenings> = []
    expect(() => {
      screenings = parseSeattleMagicScreenings(json)
    }).not.toThrow()
    expect(screenings.map((s) => s.sourceScreeningId)).toEqual(['good'])
  })

  it('omits runtimeMinutes when the end time is unusable', () => {
    const json = JSON.stringify([
      { slug: 'open-ended', title: 'Open Ended', gcalStart: '2026-09-12T20:00:00' },
    ])
    const [screening] = parseSeattleMagicScreenings(json)

    expect(screening!.runtimeMinutes).toBeUndefined()
  })

  it('returns an empty array for an empty JSON array', () => {
    expect(parseSeattleMagicScreenings('[]')).toEqual([])
  })

  it('throws on malformed JSON', () => {
    expect(() => parseSeattleMagicScreenings('{not json')).toThrow()
  })

  it('throws when the payload is not an array', () => {
    expect(() => parseSeattleMagicScreenings('{"events":[]}')).toThrow()
  })
})

describe('createSeattleMagicAdapter', () => {
  function stubFetcher() {
    const urls: string[] = []
    const fetcher = {
      text: async (url: string) => {
        urls.push(url)
        return fixture
      },
    } as unknown as Fetcher
    return { fetcher, urls }
  }

  it('fetches the JSON endpoint', async () => {
    const { fetcher, urls } = stubFetcher()
    const adapter = createSeattleMagicAdapter(fetcher)
    await adapter.fetch(SEATTLE_MAGIC_VENUE, { from: '2026-01-01', to: '2026-12-31' })

    expect(urls).toEqual(['https://seattlemagictheater.com/events.json'])
  })

  it('filters out events outside the requested range', async () => {
    const { fetcher } = stubFetcher()
    const adapter = createSeattleMagicAdapter(fetcher)

    const all = await adapter.fetch(SEATTLE_MAGIC_VENUE, {
      from: '2025-01-01',
      to: '2027-12-31',
    })
    const narrow = await adapter.fetch(SEATTLE_MAGIC_VENUE, {
      from: '2026-01-01',
      to: '2026-12-31',
    })

    // The feed carries past events; the narrow window must drop the 2025 ones.
    expect(all.length).toBeGreaterThan(narrow.length)
    expect(narrow.every((s) => s.localDate >= '2026-01-01' && s.localDate <= '2026-12-31')).toBe(
      true,
    )
    expect(all.some((s) => s.localDate.startsWith('2025'))).toBe(true)
  })

  it('includes events on the range boundaries', async () => {
    const { fetcher } = stubFetcher()
    const adapter = createSeattleMagicAdapter(fetcher)
    const boundary = '2025-04-30' // The Fisher King, first entry in the fixture.

    const screenings = await adapter.fetch(SEATTLE_MAGIC_VENUE, {
      from: boundary,
      to: boundary,
    })

    expect(screenings.map((s) => s.sourceScreeningId)).toContain('fisher-king')
  })
})
