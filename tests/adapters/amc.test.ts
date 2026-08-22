import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  parseAmcShowtimes,
  createAmcAdapter,
  AMC_VENUES,
} from '../../src/adapters/amc.js'
import type { AmcShowtime } from '../../src/amc/client.js'

const raw = JSON.parse(
  readFileSync('tests/fixtures/amc-pacific-place-showtimes.json', 'utf8'),
)._embedded.showtimes as AmcShowtime[]

const venue = AMC_VENUES.find((v) => v.id === 'amc-pacific-place')!

describe('parseAmcShowtimes', () => {
  const screenings = parseAmcShowtimes(raw, venue)

  it('parses the fixture into screenings', () => {
    expect(screenings.length).toBeGreaterThan(0)
  })

  it('uses the absolute UTC timestamp without conversion', () => {
    const first = raw.find((s) => !s.isCanceled)!
    const parsed = screenings.find((s) => s.sourceScreeningId === String(first.id))!
    expect(parsed.startsAt.toISOString()).toBe(new Date(first.showDateTimeUtc).toISOString())
  })

  it('derives the venue-local date', () => {
    for (const s of screenings) expect(s.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('keeps only premium formats as hints', () => {
    const hints = new Set(screenings.flatMap((s) => s.formatHints))
    for (const hint of hints) {
      expect(hint).not.toMatch(/RESERVED|CAPTION|AUDIO DESCRIPTION|SPOKEN|SUBTITLE/i)
    }
  })

  it('captures 70mm as a format hint', () => {
    const seventy = screenings.filter((s) => s.formatHints.includes('70MM'))
    expect(seventy.length).toBeGreaterThan(0)
  })

  it('puts the full attribute list in description for later tag extraction', () => {
    const withArtisan = screenings.find((s) => s.description?.includes('AMC Artisan Films'))
    expect(withArtisan).toBeDefined()
  })

  it('skips cancelled showtimes', () => {
    const cancelledIds = raw.filter((s) => s.isCanceled).map((s) => String(s.id))
    for (const id of cancelledIds) {
      expect(screenings.some((s) => s.sourceScreeningId === id)).toBe(false)
    }
  })

  it('produces unique source screening ids', () => {
    const ids = screenings.map((s) => s.sourceScreeningId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // A complete golden record, per AGENTS.md: an AMC redesign should show up as a
  // readable diff here rather than as a quietly emptier database.
  it('pins one complete screening from the fixture', () => {
    const odyssey = screenings.find((s) => s.sourceScreeningId === '145711548')!
    expect(odyssey).toEqual({
      rawTitle: 'The Odyssey',
      startsAt: new Date('2026-08-22T19:30:00Z'),
      localDate: '2026-08-22',
      venueId: 'amc-pacific-place',
      ticketUrl:
        'https://www.amctheatres.com/showtimes/all/2026-08-22/pacificplace/all/145711548',
      sourceScreeningId: '145711548',
      formatHints: ['70MM'],
      runtimeMinutes: 172,
      description: '70mm, AMC Artisan Films, Reserved Seating',
    })
  })

  it('carries the ticket url and runtime', () => {
    const first = screenings[0]!
    expect(first.ticketUrl).toMatch(/^https:\/\//)
    expect(first.runtimeMinutes === undefined || first.runtimeMinutes > 0).toBe(true)
  })
})

// The recorded day happens to contain no cancellations and no non-premium
// "format-shaped" traps, so the fixture-driven tests above cannot fail if the
// filters are dropped. These pin the behaviour against constructed records.
describe('parseAmcShowtimes, constructed records', () => {
  const base: AmcShowtime = {
    id: 1,
    movieId: 99,
    movieName: 'A Film',
    showDateTimeUtc: '2026-08-23T02:30:00Z',
    premiumFormat: '',
    runTime: 120,
    purchaseUrl: 'https://www.amctheatres.com/showtimes/1',
    attributes: [],
  }

  it('drops a cancelled showtime and keeps its neighbours', () => {
    const parsed = parseAmcShowtimes(
      [
        { ...base, id: 1, isCanceled: true },
        { ...base, id: 2, isCanceled: false },
      ],
      venue,
    )
    expect(parsed.map((s) => s.sourceScreeningId)).toEqual(['2'])
  })

  it('never promotes seating, accessibility, or language attributes to hints', () => {
    const [parsed] = parseAmcShowtimes(
      [
        {
          ...base,
          attributes: [
            { name: 'Reserved Seating' },
            { name: 'Closed Caption' },
            { name: 'Audio Description' },
            { name: 'Open Caption (On-screen Subtitles)' },
            { name: 'Mandarin Spoken with Chinese and English Subtitles' },
            { name: 'AMC Artisan Films' },
            { name: 'Event' },
          ],
        },
      ],
      venue,
    )
    expect(parsed!.formatHints).toEqual([])
    expect(parsed!.description).toBe(
      'Reserved Seating, Closed Caption, Audio Description, ' +
        'Open Caption (On-screen Subtitles), ' +
        'Mandarin Spoken with Chinese and English Subtitles, AMC Artisan Films, Event',
    )
  })

  it('reads a premium format off either premiumFormat or attributes', () => {
    const [fromField] = parseAmcShowtimes([{ ...base, premiumFormat: '70mm' }], venue)
    expect(fromField!.formatHints).toEqual(['70MM'])

    const [fromAttribute] = parseAmcShowtimes(
      [{ ...base, attributes: [{ name: 'Reserved Seating' }, { name: 'IMAX' }] }],
      venue,
    )
    expect(fromAttribute!.formatHints).toEqual(['IMAX'])
  })

  it('maps an evening UTC instant back to the previous Pacific date', () => {
    // 02:30Z on the 23rd is 19:30 on the 22nd in Seattle. Storing the UTC date
    // would file this screening on the wrong day.
    const [parsed] = parseAmcShowtimes([base], venue)
    expect(parsed!.localDate).toBe('2026-08-22')
    expect(parsed!.startsAt.toISOString()).toBe('2026-08-23T02:30:00.000Z')
  })
})

describe('createAmcAdapter', () => {
  it('requests each date in the range and filters to the requested day', async () => {
    const client = {
      getShowtimes: vi.fn(async (_id: number, _date: string) => raw),
    }
    const adapter = createAmcAdapter(client as never)

    const result = await adapter.fetch(venue, { from: '2026-08-22', to: '2026-08-24' })

    expect(client.getShowtimes).toHaveBeenCalledTimes(3)
    // The stub returns the same day for every request; the local-date filter must
    // keep only one day's worth rather than tripling it.
    const dates = new Set(result.map((s) => s.localDate))
    expect(dates.size).toBe(1)
  })

  it('asks the client for the numeric theatre id of the venue it was given', async () => {
    const client = { getShowtimes: vi.fn(async (_id: number, _date: string) => []) }
    const adapter = createAmcAdapter(client as never)

    await adapter.fetch(AMC_VENUES.find((v) => v.id === 'amc-alderwood')!, {
      from: '2026-08-22',
      to: '2026-08-22',
    })

    expect(client.getShowtimes).toHaveBeenCalledWith(2629, '2026-08-22')
  })
})
