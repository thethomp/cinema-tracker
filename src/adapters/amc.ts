import type { DateRange, RawScreening, VenueAdapter, VenueRef } from '../core/types.js'
import { localDateOf, enumerateDates } from '../core/time.js'
import type { AmcClient, AmcShowtime } from '../amc/client.js'

const TZ = 'America/Los_Angeles'

export const AMC_VENUES: VenueRef[] = [
  { id: 'amc-alderwood', name: 'AMC Alderwood Mall 16', chain: 'AMC', timezone: TZ, sourceVenueId: '2629' },
  { id: 'amc-pacific-place', name: 'AMC Pacific Place 11', chain: 'AMC', timezone: TZ, sourceVenueId: '880' },
]

/**
 * AMC's `attributes` array mixes formats with seating, accessibility, language,
 * and programming strands. Only premium formats may become `formatHints`, which
 * downstream scoring treats as special-event signal. Everything else is kept in
 * `description` for the tag extractor.
 */
const PREMIUM_FORMATS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b70\s?mm\b/i, '70MM'],
  [/\b35\s?mm\b/i, '35MM'],
  [/\bIMAX\b/i, 'IMAX'],
  [/\bDOLBY\b/i, 'DOLBY'],
  [/\bPRIME\b/i, 'PRIME'],
  [/\b(?:REALD\s+)?3D\b/i, '3D'],
  [/\bD-?BOX\b/i, 'D-BOX'],
]

function formatHintsFor(showtime: AmcShowtime): string[] {
  const labels = [
    showtime.premiumFormat ?? '',
    ...(showtime.attributes ?? []).map((a) => a.name ?? ''),
  ]
  const hints = new Set<string>()
  for (const label of labels) {
    if (!label) continue
    for (const [pattern, tag] of PREMIUM_FORMATS) {
      if (pattern.test(label)) hints.add(tag)
    }
  }
  return [...hints]
}

export function parseAmcShowtimes(showtimes: AmcShowtime[], venue: VenueRef): RawScreening[] {
  const results: RawScreening[] = []
  const seen = new Set<string>()

  for (const showtime of showtimes) {
    if (showtime.isCanceled) continue
    const id = String(showtime.id)
    if (seen.has(id)) continue

    const startsAt = new Date(showtime.showDateTimeUtc)
    if (Number.isNaN(startsAt.getTime())) continue
    seen.add(id)

    const attributeNames = (showtime.attributes ?? [])
      .map((a) => a.name)
      .filter((name): name is string => Boolean(name))

    results.push({
      rawTitle: showtime.movieName,
      startsAt,
      localDate: localDateOf(startsAt, TZ),
      venueId: venue.id,
      ticketUrl: showtime.purchaseUrl ?? `https://www.amctheatres.com/movie-theatres/${venue.sourceVenueId}`,
      sourceScreeningId: id,
      formatHints: formatHintsFor(showtime),
      runtimeMinutes: showtime.runTime,
      description: attributeNames.length > 0 ? attributeNames.join(', ') : undefined,
    })
  }

  return results
}

export function createAmcAdapter(client: Pick<AmcClient, 'getShowtimes'>): VenueAdapter {
  return {
    id: 'amc',
    venues: AMC_VENUES,
    async fetch(venue: VenueRef, range: DateRange): Promise<RawScreening[]> {
      const all: RawScreening[] = []
      for (const date of enumerateDates(range)) {
        const showtimes = await client.getShowtimes(Number(venue.sourceVenueId), date)
        // Defensive, matching the other adapters: only keep screenings actually
        // on the requested date, so an API quirk cannot duplicate a day.
        all.push(...parseAmcShowtimes(showtimes, venue).filter((s) => s.localDate === date))
      }
      return all
    },
  }
}
