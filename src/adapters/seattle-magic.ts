import * as cheerio from 'cheerio'
import type { DateRange, RawScreening, VenueAdapter, VenueRef } from '../core/types.js'
import { localDateOf, localWallClockToUtc } from '../core/time.js'
import type { Fetcher } from '../fetch/fetcher.js'

const TZ = 'America/Los_Angeles'
const BASE = 'https://seattlemagictheater.com'

export const SEATTLE_MAGIC_VENUE: VenueRef = {
  id: 'seattle-magic',
  name: 'Seattle Magic Theater',
  chain: 'Independent',
  timezone: TZ,
  sourceVenueId: 'seattle-magic-theater',
}

export function parseSeattleMagicScreenings(html: string): RawScreening[] {
  const $ = cheerio.load(html)
  const results: RawScreening[] = []

  $('.event').each((_, element) => {
    const $event = $(element)
    const rawTitle = $event.find('.event-title').first().text().trim()
    const datetime = $event.find('time[datetime]').first().attr('datetime')
    if (!rawTitle || !datetime) return

    const startsAt = localWallClockToUtc(datetime, TZ)
    const href = $event.find('a[href]').first().attr('href')

    results.push({
      rawTitle,
      startsAt,
      localDate: localDateOf(startsAt, TZ),
      venueId: SEATTLE_MAGIC_VENUE.id,
      ticketUrl: href ? new URL(href, BASE).toString() : `${BASE}/events`,
      sourceScreeningId:
        $event.attr('data-event-id') ?? `${slugify(rawTitle)}@${datetime}`,
      formatHints: [],
    })
  })

  return results
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function createSeattleMagicAdapter(fetcher: Fetcher): VenueAdapter {
  return {
    id: 'seattle-magic',
    venues: [SEATTLE_MAGIC_VENUE],
    async fetch(_venue: VenueRef, _range: DateRange): Promise<RawScreening[]> {
      // The site lists all upcoming events on one page; the range is ignored.
      const html = await fetcher.text(`${BASE}/events`)
      return parseSeattleMagicScreenings(html)
    },
  }
}
