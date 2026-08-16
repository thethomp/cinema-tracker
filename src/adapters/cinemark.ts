import * as cheerio from 'cheerio'
import type { DateRange, RawScreening, VenueAdapter, VenueRef } from '../core/types.js'
import { localDateOf, localWallClockToUtc } from '../core/time.js'
import type { Fetcher } from '../fetch/fetcher.js'
import { enumerateDates } from './siff.js'

const TZ = 'America/Los_Angeles'
const BASE = 'https://www.cinemark.com'

export const CINEMARK_VENUES: VenueRef[] = [
  {
    id: 'cinemark-lincoln-square',
    name: 'Cinemark Lincoln Square Cinemas and IMAX',
    chain: 'Cinemark',
    timezone: TZ,
    sourceVenueId: 'theatres/wa-bellevue/cinemark-lincoln-square-cinemas-and-imax',
  },
  {
    id: 'cinemark-totem-lake',
    name: 'Cinemark Totem Lake Kirkland and XD',
    chain: 'Cinemark',
    timezone: TZ,
    // Canonical slug. "cinemark-totem-lake-and-xd" 307s here, and Cinemark's
    // redirect drops the query string — which silently served today's page for
    // every requested date until the slug was corrected.
    sourceVenueId: 'theatres/wa-kirkland/cinemark-totem-lake-kirkland-and-xd',
  },
]

export function parseCinemarkScreenings(html: string, venue: VenueRef): RawScreening[] {
  const $ = cheerio.load(html)
  const results: RawScreening[] = []
  const seen = new Set<string>()

  $('.showtimeMovieBlock').each((_, block) => {
    const $block = $(block)
    const rawTitle = $block.find('.movieBlockHeader h3').first().text().trim()
    if (!rawTitle) return

    const runtimeMinutes = parseRuntime($block.find('.showtimeMovieRuntime').first().text())

    $block.find('a.showtime-link').each((__, link) => {
      const href = $(link).attr('href')
      if (!href) return

      const url = new URL(href, BASE)
      const showtimeId = url.searchParams.get('ShowtimeId')
      const wallClock = url.searchParams.get('Showtime')
      if (!showtimeId || !wallClock) return
      if (seen.has(showtimeId)) return
      seen.add(showtimeId)

      const startsAt = localWallClockToUtc(wallClock, TZ)
      const format = $(link).attr('data-print-type-name')?.trim()

      results.push({
        rawTitle,
        startsAt,
        localDate: localDateOf(startsAt, TZ),
        venueId: venue.id,
        ticketUrl: url.toString(),
        sourceScreeningId: showtimeId,
        formatHints: normalizeFormat(format),
        runtimeMinutes,
      })
    })
  })

  return results
}

/** "Standard Format" carries no signal; anything else does. */
function normalizeFormat(format: string | undefined): string[] {
  if (!format || /^standard format$/i.test(format)) return []
  return [format.toUpperCase()]
}

/** Cinemark renders runtime as "2 hr 25 min". */
function parseRuntime(text: string): number | undefined {
  const hours = /(\d+)\s*hr/.exec(text)
  const minutes = /(\d+)\s*min/.exec(text)
  if (!hours && !minutes) return undefined
  return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0)
}

/**
 * "?showDate=YYYY-MM-DD" is honoured server-side — verified live, each dated
 * request returned only that date's showtimes. But a date with no published
 * schedule yet silently serves today's page instead of an empty one, so every
 * response is filtered down to the date we actually asked for: a fallback then
 * contributes nothing rather than restating today for every date in the range.
 */
export function createCinemarkAdapter(fetcher: Fetcher): VenueAdapter {
  return {
    id: 'cinemark',
    venues: CINEMARK_VENUES,
    async fetch(venue: VenueRef, range: DateRange): Promise<RawScreening[]> {
      const all: RawScreening[] = []
      for (const date of enumerateDates(range)) {
        const html = await fetcher.text(`${BASE}/${venue.sourceVenueId}?showDate=${date}`)
        all.push(...parseCinemarkScreenings(html, venue).filter((s) => s.localDate === date))
      }
      return dedupeBySourceId(all)
    },
  }
}

function dedupeBySourceId(screenings: RawScreening[]): RawScreening[] {
  const byId = new Map<string, RawScreening>()
  for (const screening of screenings) byId.set(screening.sourceScreeningId, screening)
  return [...byId.values()]
}
