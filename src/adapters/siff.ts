import * as cheerio from 'cheerio'
import type { DateRange, RawScreening, VenueAdapter, VenueRef } from '../core/types.js'
import { dayOffset, enumerateDates, localDateOf } from '../core/time.js'
import type { Fetcher } from '../fetch/fetcher.js'

const TZ = 'America/Los_Angeles'

export const SIFF_VENUES: VenueRef[] = [
  { id: 'siff-downtown', name: 'SIFF Cinema Downtown', chain: 'SIFF', timezone: TZ, sourceVenueId: 'siff-cinema-downtown' },
  { id: 'siff-uptown', name: 'SIFF Cinema Uptown', chain: 'SIFF', timezone: TZ, sourceVenueId: 'siff-cinema-uptown' },
  { id: 'siff-film-center', name: 'SIFF Film Center', chain: 'SIFF', timezone: TZ, sourceVenueId: 'siff-film-center' },
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

export interface SiffPage {
  screenings: RawScreening[]
  /**
   * `VenueName` values that matched no known venue, and how many screenings
   * each swallowed. Dropping these silently is how a stale venue list — or a
   * renamed auditorium — goes unnoticed, so the count is surfaced rather than
   * discarded.
   */
  unrecognizedVenues: Record<string, number>
}

export function parseSiffScreenings(html: string): RawScreening[] {
  return parseSiffPage(html).screenings
}

export function parseSiffPage(html: string): SiffPage {
  const $ = cheerio.load(html)
  const results: RawScreening[] = []
  const unrecognizedVenues: Record<string, number> = {}
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
    if (!venueId) {
      unrecognizedVenues[json.VenueName] = (unrecognizedVenues[json.VenueName] ?? 0) + 1
      return
    }
    if (seen.has(json.ShowtimeId)) return
    seen.add(json.ShowtimeId)

    const startsAt = parseDotNetDate(json.Showtime)
    results.push({
      rawTitle: json.EventName,
      startsAt,
      localDate: localDateOf(startsAt, TZ),
      venueId,
      ticketUrl: ticketUrlFor(
        $(element).closest('.item').find('h3 a[href]').first().attr('href'),
        json.EventName,
      ),
      sourceScreeningId: json.ShowtimeId,
      formatHints: extractFormatHints(json.EventName),
      runtimeMinutes: json.LengthInMinutes,
    })
  })

  return { screenings: results, unrecognizedVenues }
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

/**
 * The film page link lives in the same listing item as the screening button,
 * so read it rather than rebuilding it: reconstruction gets the path wrong for
 * anything SIFF files outside /cinema/in-theaters (community screenings, for
 * one) and mangles transliterated titles. `slugify` stays only as a fallback
 * for markup with no link at all.
 */
function ticketUrlFor(href: string | undefined, title: string): string {
  return new URL(href ?? `/cinema/in-theaters/${slugify(title)}`, SIFF_BASE).toString()
}

const SIFF_BASE = 'https://www.siff.net'

function slugify(title: string): string {
  return title
    .normalize('NFD')
    // SIFF transliterates rather than dropping: "Romería" is /romeria, not
    // /romera. Strip the combining marks and keep the base letter.
    .replace(/\p{Diacritic}/gu, '')
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
        const { screenings, unrecognizedVenues } = parseSiffPage(html)
        for (const [name, count] of Object.entries(unrecognizedVenues)) {
          console.warn(`siff: ${count} screening(s) at unrecognized auditorium "${name}"`)
        }
        // Filter on localDate as well: if SIFF ever serves the today-fallback
        // for a day we asked for, its screenings are dropped rather than
        // duplicated across every date in the range.
        all.push(
          ...screenings.filter((s) => s.venueId === venue.id && s.localDate === date),
        )
      }
      return all
    },
  }
}
