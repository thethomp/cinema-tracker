import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  createCinemarkAdapter,
  parseCinemarkScreenings,
  CINEMARK_VENUES,
} from '../../src/adapters/cinemark.js'
import type { Fetcher } from '../../src/fetch/fetcher.js'

const html = readFileSync('tests/fixtures/cinemark-lincoln-square.html', 'utf8')
const venue = CINEMARK_VENUES.find((v) => v.id === 'cinemark-lincoln-square')!

describe('parseCinemarkScreenings', () => {
  const screenings = parseCinemarkScreenings(html, venue)

  // Pinned exactly. A partial parsing regression that still returns "some"
  // screenings is the failure mode a lower bound cannot see.
  it('extracts every screening in the fixture', () => {
    expect(screenings).toHaveLength(63)
  })

  it('pins one screening against the fixture end to end', () => {
    const golden = screenings.find((s) => s.sourceScreeningId === '382984')!
    expect(golden).toEqual({
      rawTitle: 'The Odyssey',
      // The href reads Showtime=2026-08-16T13:15:00, wall clock at the venue.
      // Mid-August is PDT (UTC-7), so 13:15 local is 20:15Z — assert the
      // instant, not its shape, or a broken conversion goes unnoticed.
      startsAt: new Date('2026-08-16T20:15:00.000Z'),
      localDate: '2026-08-16',
      venueId: 'cinemark-lincoln-square',
      ticketUrl:
        'https://www.cinemark.com/TicketSeatMap/?TheaterId=1118&ShowtimeId=382984' +
        '&CinemarkMovieId=108919&Showtime=2026-08-16T13:15:00',
      sourceScreeningId: '382984',
      formatHints: ['IMAX'],
      runtimeMinutes: 172,
    })
  })

  it('reads the start time from the href, not the link text', () => {
    const first = screenings[0]!
    expect(first.startsAt.toISOString()).toBe('2026-08-16T18:50:00.000Z')
    expect(first.localDate).toBe('2026-08-16')
  })

  it('uses the Cinemark ShowtimeId as the source id', () => {
    expect(screenings[0]!.sourceScreeningId).toMatch(/^\d+$/)
  })

  it('builds an absolute ticket url', () => {
    expect(screenings[0]!.ticketUrl).toMatch(/^https:\/\/www\.cinemark\.com\/TicketSeatMap/)
  })

  it('skips past showtimes that have no booking link', () => {
    expect(html).toContain('off past')
    for (const screening of screenings) {
      expect(screening.ticketUrl).toContain('ShowtimeId=')
    }
  })

  it('captures the auditorium format as a hint', () => {
    const hints = new Set(screenings.flatMap((s) => s.formatHints))
    expect([...hints].sort()).toEqual(['IMAX'])
  })

  it('does not treat a subtitle or language label as a format', () => {
    // Roughly 40% of non-empty data-print-type-name values in the fixture are
    // of this shape. Emitting them would route an ordinary subtitled screening
    // into tag extraction and the special-event score.
    const subtitled = screenings.filter((s) => /with English Subtitles/i.test(s.rawTitle))
    expect(subtitled.length).toBeGreaterThan(0)
    for (const screening of subtitled) {
      expect(screening.formatHints).toEqual([])
    }
    expect(
      screenings.some((s) => s.formatHints.some((h) => /SUBTITLE|SPOKEN/i.test(h))),
    ).toBe(false)
  })

  it('keeps genuine premium formats', () => {
    const block = (id: string, printType: string) =>
      `<div class="showtimeMovieBlock">
         <div class="movieBlockHeader"><h3>Test Film</h3></div>
         <a class="showtime-link" data-print-type-name="${printType}"
            href="/TicketSeatMap/?ShowtimeId=${id}&Showtime=2026-08-16T11:50:00"></a>
       </div>`
    const synthetic = parseCinemarkScreenings(
      `<html><body>
         ${block('1', 'XD')}
         ${block('2', 'D-BOX')}
         ${block('3', 'IMAX 2D')}
         ${block('4', 'Hindi Spoken with English Subtitles Standard Format')}
       </body></html>`,
      venue,
    )

    expect(synthetic.map((s) => s.formatHints)).toEqual([['XD'], ['D-BOX'], ['IMAX'], []])
  })

  it('attaches the film title to every screening', () => {
    for (const screening of screenings) {
      expect(screening.rawTitle.length).toBeGreaterThan(0)
    }
  })

  it('produces unique source screening ids', () => {
    const ids = screenings.map((s) => s.sourceScreeningId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('createCinemarkAdapter', () => {
  function stubFetcher() {
    const urls: string[] = []
    const fetcher = {
      // Every date gets the same page — exactly what Cinemark does when a date
      // has no published schedule yet, and what its redirect used to do when
      // it dropped the query string.
      text: async (url: string) => {
        urls.push(url)
        return html
      },
    } as unknown as Fetcher
    return { fetcher, urls }
  }

  it('keeps at most one date worth of screenings when every request serves the same page', async () => {
    const { fetcher, urls } = stubFetcher()
    const adapter = createCinemarkAdapter(fetcher)

    const inRange = await adapter.fetch(venue, { from: '2026-08-16', to: '2026-08-18' })
    expect(urls).toHaveLength(3)
    expect(inRange).toHaveLength(63)
    expect([...new Set(inRange.map((s) => s.localDate))]).toEqual(['2026-08-16'])

    // The fixture is 2026-08-16's page. Asked for later dates and handed it
    // anyway, the adapter must contribute nothing rather than restate today
    // under three different dates.
    expect(await adapter.fetch(venue, { from: '2026-08-17', to: '2026-08-19' })).toEqual([])
  })
})

describe('normalizeFormat against real Cinemark labels', () => {
  // These exact strings were observed live on 2026-08-19. data-print-type-name
  // concatenates format, seating, language and room attributes in varying
  // order, so only recognized premium formats may survive.
  const cases: Array<[string, string[]]> = [
    ['IMAX 2D', ['IMAX']],
    ['REALD 3D', ['3D']],
    ['Luxury Lounger XD', ['XD']],
    ['Luxury Lounger XD D-BOX', ['XD', 'D-BOX']],
    ['XD Luxury Lounger REALD 3D D-BOX', ['XD', 'D-BOX', '3D']],
    ['Standard Format Luxury Lounger', []],
    ['Standard Format Luxury Lounger D-BOX', ['D-BOX']],
    ['Open Caption Standard Format Luxury Lounger', []],
    ['Party Space for up to 30 People', []],
    ['Telugu Spoken with English Subtitles Standard Format Luxury Lounger', []],
    ['Kannada Spoken with English Subtitles Standard Format Luxury Lounger', []],
    ['Luxury Lounger XD Telugu Spoken with English Subtitles', ['XD']],
  ]

  for (const [label, expected] of cases) {
    it(`maps "${label}" to [${expected.join(', ')}]`, () => {
      const html = `
        <div class="showtimeMovieBlock">
          <div class="movieBlockHeader"><h3>Film</h3></div>
          <div class="showtimeMovieRuntime">1 hr 30 min</div>
          <a class="showtime-link" data-print-type-name="${label}"
             href="/TicketSeatMap/?TheaterId=1&ShowtimeId=9&CinemarkMovieId=2&Showtime=2026-08-19T19:00:00">7:00pm</a>
        </div>`
      const [screening] = parseCinemarkScreenings(html, venue)
      expect(screening!.formatHints.sort()).toEqual([...expected].sort())
    })
  }

  it('never emits seating, language, or room text as a format hint', () => {
    const noise = /LOUNGER|SPOKEN|SUBTITLE|PARTY|STANDARD|CAPTION|PEOPLE/i
    for (const [label] of cases) {
      const html = `
        <div class="showtimeMovieBlock">
          <div class="movieBlockHeader"><h3>Film</h3></div>
          <a class="showtime-link" data-print-type-name="${label}"
             href="/TicketSeatMap/?TheaterId=1&ShowtimeId=9&CinemarkMovieId=2&Showtime=2026-08-19T19:00:00">7:00pm</a>
        </div>`
      const [screening] = parseCinemarkScreenings(html, venue)
      for (const hint of screening!.formatHints) expect(hint).not.toMatch(noise)
    }
  })
})

