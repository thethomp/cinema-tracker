import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  createSiffAdapter,
  parseSiffPage,
  parseSiffScreenings,
  SIFF_VENUES,
} from '../../src/adapters/siff.js'
import type { Fetcher } from '../../src/fetch/fetcher.js'
import { localDateOf } from '../../src/core/time.js'

const html = readFileSync('tests/fixtures/siff-cinema.html', 'utf8')

describe('parseSiffScreenings', () => {
  const screenings = parseSiffScreenings(html)

  // Pinned exactly: a partial parsing regression still returns "some"
  // screenings, which a lower bound cannot detect.
  it('extracts every screening in the fixture', () => {
    expect(screenings).toHaveLength(12)
  })

  it('pins one screening against the fixture end to end', () => {
    const golden = screenings.find((s) => s.sourceScreeningId === 'S7YThHh32o')!
    expect(golden).toEqual({
      rawTitle: 'The Odyssey (70mm)',
      // /Date(1786914000000)/ — assert the instant, not its shape.
      startsAt: new Date('2026-08-16T21:00:00.000Z'),
      localDate: '2026-08-16',
      venueId: 'siff-downtown',
      ticketUrl: 'https://www.siff.net/cinema/in-theaters/the-odyssey-(70mm)',
      sourceScreeningId: 'S7YThHh32o',
      formatHints: ['70MM'],
      runtimeMinutes: 172,
    })
  })

  it('maps the embedded JSON onto RawScreening fields', () => {
    const first = screenings[0]!
    expect(first.rawTitle).toBe('Little Shop of Horrors')
    expect(first.sourceScreeningId).toBe('XytmHWNpuq')
    expect(first.startsAt.toISOString()).toBe('2026-08-16T18:00:00.000Z')
    expect(first.localDate).toBe('2026-08-16')
  })

  it('resolves the auditorium name to a known venue id', () => {
    const ids = new Set(SIFF_VENUES.map((v) => v.id))
    for (const screening of screenings) {
      expect(ids.has(screening.venueId)).toBe(true)
    }
  })

  it('takes the ticket url from the href in the listing, not a rebuilt slug', () => {
    // The fixture's first entry links to /programs-and-events/..., which no
    // amount of slugifying the title would produce.
    expect(screenings[0]!.ticketUrl).toBe(
      'https://www.siff.net/programs-and-events/community-screenings/little-shop-of-horrors',
    )
    const odyssey = screenings.find((s) => s.rawTitle === 'The Odyssey (70mm)')!
    expect(odyssey.ticketUrl).toBe('https://www.siff.net/cinema/in-theaters/the-odyssey-(70mm)')
  })

  it('transliterates accents in the slug fallback', () => {
    // SIFF's own slugs drop diacritics rather than the letters that carry
    // them: "Romería" is /romeria, "Filipiñana" is /filipinana. Stripping the
    // character outright ("romera") is a silent 404.
    const noHref = (title: string, id: string) =>
      `<html><body><div class="item"><div class="times"><a data-screening="${JSON.stringify(
        {
          EventName: title,
          Showtime: '/Date(1786903200000)/',
          ShowtimeId: id,
          VenueName: 'SIFF Cinema Downtown',
        },
      ).replace(/"/g, '&quot;')}"></a></div></div></body></html>`

    expect(parseSiffScreenings(noHref('Romería', 'r1'))[0]!.ticketUrl).toBe(
      'https://www.siff.net/cinema/in-theaters/romeria',
    )
    expect(parseSiffScreenings(noHref('Filipiñana', 'f1'))[0]!.ticketUrl).toBe(
      'https://www.siff.net/cinema/in-theaters/filipinana',
    )
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

/** A minimal stand-in for SIFF's listing markup. */
function page(...entries: Array<Record<string, unknown>>): string {
  const items = entries
    .map((json, i) => {
      const attr = JSON.stringify(json).replace(/"/g, '&quot;')
      return `<div class="item">
        <h3><a href="/cinema/in-theaters/film-${i}">Film ${i}</a></h3>
        <div class="times"><div class="button-group">
          <a class="elevent button on" data-screening="${attr}">7:00 PM</a>
        </div></div>
      </div>`
    })
    .join('')
  return `<html><body><div class="listing thumbs">${items}</div></body></html>`
}

describe('parseSiffPage', () => {
  it('reports auditoriums it could not match instead of dropping them silently', () => {
    const html = page(
      {
        EventName: 'Known Film',
        Showtime: '/Date(1786903200000)/',
        ShowtimeId: 'known1',
        VenueName: 'SIFF Cinema Downtown',
      },
      {
        EventName: 'Orphan Film',
        Showtime: '/Date(1786903200000)/',
        ShowtimeId: 'orphan1',
        VenueName: 'SIFF Cinema Egyptian',
      },
      {
        EventName: 'Orphan Film',
        Showtime: '/Date(1786910000000)/',
        ShowtimeId: 'orphan2',
        VenueName: 'SIFF Cinema Egyptian',
      },
    )

    const { screenings, unrecognizedVenues } = parseSiffPage(html)

    expect(screenings.map((s) => s.sourceScreeningId)).toEqual(['known1'])
    expect(unrecognizedVenues).toEqual({ 'SIFF Cinema Egyptian': 2 })
  })

  it('recognizes every auditorium in the recorded fixture', () => {
    expect(parseSiffPage(html).unrecognizedVenues).toEqual({})
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

  it('keeps at most one date worth of screenings when every day serves the same page', async () => {
    // SIFF pages by offset from today, so pin today to the day the fixture was
    // recorded; the stub then answers every offset with that same page, which
    // is exactly the today-fallback SIFF serves past day=6.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-16T12:00:00Z'))
    try {
      const { fetcher, urls } = stubFetcher()
      const adapter = createSiffAdapter(fetcher)
      const downtown = SIFF_VENUES.find((v) => v.id === 'siff-downtown')!

      const inRange = await adapter.fetch(downtown, { from: '2026-08-16', to: '2026-08-18' })
      expect(urls).toHaveLength(3)
      // The fixture's three SIFF Downtown screenings, once — not once per day.
      expect(inRange).toHaveLength(3)
      expect([...new Set(inRange.map((s) => s.localDate))]).toEqual(['2026-08-16'])

      // And a window that excludes the page's own date keeps nothing at all.
      expect(await adapter.fetch(downtown, { from: '2026-08-17', to: '2026-08-19' })).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips dates outside the week SIFF actually serves', async () => {
    const { fetcher, urls } = stubFetcher()
    const adapter = createSiffAdapter(fetcher)
    // Past dates and anything past day=6 silently return today's page.
    await adapter.fetch(SIFF_VENUES[0]!, { from: plusDays(-3), to: plusDays(9) })
    expect(urls).toEqual([0, 1, 2, 3, 4, 5, 6].map((d) => `https://www.siff.net/cinema?day=${d}`))
  })
})
