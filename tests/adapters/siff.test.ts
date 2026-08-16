import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSiffAdapter, parseSiffScreenings, SIFF_VENUES } from '../../src/adapters/siff.js'
import type { Fetcher } from '../../src/fetch/fetcher.js'
import { localDateOf } from '../../src/core/time.js'

const html = readFileSync('tests/fixtures/siff-cinema.html', 'utf8')

describe('parseSiffScreenings', () => {
  const screenings = parseSiffScreenings(html)

  it('extracts screenings from the fixture', () => {
    expect(screenings.length).toBeGreaterThan(0)
  })

  it('maps the embedded JSON onto RawScreening fields', () => {
    const first = screenings[0]!
    expect(first.rawTitle).toBeTruthy()
    expect(first.sourceScreeningId).toMatch(/^\w+$/)
    expect(first.startsAt).toBeInstanceOf(Date)
    expect(Number.isNaN(first.startsAt.getTime())).toBe(false)
    expect(first.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('resolves the auditorium name to a known venue id', () => {
    const ids = new Set(SIFF_VENUES.map((v) => v.id))
    for (const screening of screenings) {
      expect(ids.has(screening.venueId)).toBe(true)
    }
  })

  it('builds a ticket url pointing at the film page', () => {
    expect(screenings[0]!.ticketUrl).toContain('siff.net')
  })

  it('carries the runtime through when present', () => {
    const withRuntime = screenings.find((s) => s.runtimeMinutes !== undefined)
    expect(withRuntime!.runtimeMinutes).toBeGreaterThan(0)
  })

  it('produces unique source screening ids', () => {
    const ids = screenings.map((s) => s.sourceScreeningId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('createSiffAdapter', () => {
  const TZ = 'America/Los_Angeles'
  const today = localDateOf(new Date(), TZ)
  const plusDays = (n: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

  function stubFetcher() {
    const urls: string[] = []
    const fetcher = {
      text: async (url: string) => {
        urls.push(url)
        return html
      },
    } as unknown as Fetcher
    return { fetcher, urls }
  }

  it('requests each date as a day offset from today', async () => {
    const { fetcher, urls } = stubFetcher()
    const adapter = createSiffAdapter(fetcher)
    await adapter.fetch(SIFF_VENUES[0]!, { from: today, to: plusDays(2) })
    expect(urls).toEqual([
      'https://www.siff.net/cinema?day=0',
      'https://www.siff.net/cinema?day=1',
      'https://www.siff.net/cinema?day=2',
    ])
  })

  it('skips dates outside the week SIFF actually serves', async () => {
    const { fetcher, urls } = stubFetcher()
    const adapter = createSiffAdapter(fetcher)
    // Past dates and anything past day=6 silently return today's page.
    await adapter.fetch(SIFF_VENUES[0]!, { from: plusDays(-3), to: plusDays(9) })
    expect(urls).toEqual([0, 1, 2, 3, 4, 5, 6].map((d) => `https://www.siff.net/cinema?day=${d}`))
  })
})
