import * as cheerio from 'cheerio'
import type { DateRange, RawScreening, VenueAdapter, VenueRef } from '../core/types.js'
import { localDateOf } from '../core/time.js'
import type { Fetcher } from '../fetch/fetcher.js'

const TZ = 'America/Los_Angeles'

export const SIFF_VENUES: VenueRef[] = [
  { id: 'siff-downtown', name: 'SIFF Cinema Downtown', chain: 'SIFF', timezone: TZ, sourceVenueId: 'siff-cinema-downtown' },
  { id: 'siff-uptown', name: 'SIFF Cinema Uptown', chain: 'SIFF', timezone: TZ, sourceVenueId: 'siff-cinema-uptown' },
  { id: 'siff-film-center', name: 'SIFF Film Center', chain: 'SIFF', timezone: TZ, sourceVenueId: 'siff-film-center' },
  { id: 'siff-egyptian', name: 'SIFF Cinema Egyptian', chain: 'SIFF', timezone: TZ, sourceVenueId: 'siff-cinema-egyptian' },
]

interface SiffScreeningJson {
  EventName: string
  EventUrlName: string
  Showtime: string
  ShowtimeId: string
  LengthInMinutes?: number
  VenueName: string
}

/** SIFF serializes dates as "/Date(1786908600000)/". */
function parseDotNetDate(value: string): Date {
  const match = /\/Date\((-?\d+)\)\//.exec(value)
  if (!match) throw new Error(`Unrecognized SIFF date: ${value}`)
  return new Date(Number(match[1]))
}

/**
 * Auditorium names look like "SIFF Cinema Uptown House 3". Match the longest
 * venue name that prefixes it so "Uptown" never matches "Uptown House".
 */
function resolveVenueId(auditorium: string): string | undefined {
  const sorted = [...SIFF_VENUES].sort((a, b) => b.name.length - a.name.length)
  return sorted.find((v) => auditorium.startsWith(v.name))?.id
}

export function parseSiffScreenings(html: string): RawScreening[] {
  const $ = cheerio.load(html)
  const results: RawScreening[] = []
  const seen = new Set<string>()

  $('[data-screening]').each((_, element) => {
    const attr = $(element).attr('data-screening')
    if (!attr) return

    let json: SiffScreeningJson
    try {
      json = JSON.parse(attr) as SiffScreeningJson
    } catch {
      return // Malformed entry: skip rather than fail the whole page.
    }

    const venueId = resolveVenueId(json.VenueName)
    if (!venueId) return
    if (seen.has(json.ShowtimeId)) return
    seen.add(json.ShowtimeId)

    const startsAt = parseDotNetDate(json.Showtime)
    results.push({
      rawTitle: json.EventName,
      startsAt,
      localDate: localDateOf(startsAt, TZ),
      venueId,
      ticketUrl: `https://www.siff.net/cinema/in-theaters/${slugify(json.EventName)}`,
      sourceScreeningId: json.ShowtimeId,
      formatHints: extractFormatHints(json.EventName),
      runtimeMinutes: json.LengthInMinutes,
    })
  })

  return results
}

/** SIFF encodes format in the title, e.g. "The Odyssey (70mm)". */
function extractFormatHints(title: string): string[] {
  const hints: string[] = []
  for (const [pattern, hint] of [
    [/\(70\s?mm\)/i, '70MM'],
    [/\(35\s?mm\)/i, '35MM'],
    [/\b16\s?mm\b/i, '16MM'],
  ] as const) {
    if (pattern.test(title)) hints.push(hint)
  }
  return hints
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s()-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/**
 * SIFF pages its listings by day offset from today ("/cinema?day=3"), not by
 * absolute date — a "?date=2026-08-19" parameter is accepted and ignored,
 * silently serving today. Offsets beyond 6 fall back to today the same way,
 * so the site exposes a one-week window and nothing further.
 */
const MAX_DAY_OFFSET = 6

/** Whole days from `today` to `date`, both "YYYY-MM-DD". */
function dayOffset(date: string, today: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

export function createSiffAdapter(fetcher: Fetcher): VenueAdapter {
  return {
    id: 'siff',
    venues: SIFF_VENUES,
    async fetch(venue: VenueRef, range: DateRange): Promise<RawScreening[]> {
      const today = localDateOf(new Date(), TZ)
      const all: RawScreening[] = []
      for (const date of enumerateDates(range)) {
        const offset = dayOffset(date, today)
        if (offset < 0 || offset > MAX_DAY_OFFSET) continue
        const html = await fetcher.text(`https://www.siff.net/cinema?day=${offset}`)
        // Filter on localDate as well: if SIFF ever serves the today-fallback
        // for a day we asked for, its screenings are dropped rather than
        // duplicated across every date in the range.
        all.push(
          ...parseSiffScreenings(html).filter(
            (s) => s.venueId === venue.id && s.localDate === date,
          ),
        )
      }
      return all
    },
  }
}

export function enumerateDates(range: DateRange): string[] {
  const dates: string[] = []
  const cursor = new Date(`${range.from}T00:00:00Z`)
  const end = new Date(`${range.to}T00:00:00Z`)
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}
