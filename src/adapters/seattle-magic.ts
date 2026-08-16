import type { DateRange, RawScreening, VenueAdapter, VenueRef } from '../core/types.js'
import { localDateOf, localWallClockToUtc } from '../core/time.js'
import type { Fetcher } from '../fetch/fetcher.js'

const TZ = 'America/Los_Angeles'
const BASE = 'https://seattlemagictheater.com'

/**
 * The listing pages are entirely client-rendered: `/events` serves a loading
 * skeleton and the browser then fetches this feed. Parsing the HTML yielded an
 * empty list on every real request, which is indistinguishable from "nothing
 * is scheduled" — so we read the feed the page itself reads.
 */
const EVENTS_URL = `${BASE}/events.json`

/**
 * Seattle Magic screens at several rented rooms (the per-event `venue` field
 * names the room), but it is one programmer with one schedule, so we model it
 * as a single logical venue.
 */
export const SEATTLE_MAGIC_VENUE: VenueRef = {
  id: 'seattle-magic',
  name: 'Seattle Magic Theater',
  chain: 'Independent',
  timezone: TZ,
  sourceVenueId: 'seattle-magic-theater',
}

interface SeattleMagicEvent {
  slug?: unknown
  title?: unknown
  /** Zoneless local ISO timestamp, e.g. "2025-04-30T20:00:00". */
  gcalStart?: unknown
  gcalEnd?: unknown
}

/**
 * Parse the raw text of `/events.json`.
 *
 * Malformed JSON throws — the caller records a failed run rather than a
 * successful empty one. A single unusable element is skipped instead.
 */
export function parseSeattleMagicScreenings(json: string): RawScreening[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) {
    throw new Error('Seattle Magic events.json was not a JSON array')
  }

  const results: RawScreening[] = []
  const usedIds = new Set<string>()

  for (const element of parsed) {
    if (typeof element !== 'object' || element === null) continue
    const event = element as SeattleMagicEvent

    const rawTitle = typeof event.title === 'string' ? event.title.trim() : ''
    const gcalStart = typeof event.gcalStart === 'string' ? event.gcalStart : ''
    const startsAt = parseWallClock(gcalStart)
    if (!rawTitle || !startsAt) continue

    const slug = typeof event.slug === 'string' ? event.slug.trim() : ''
    const sourceScreeningId = uniqueId(
      slug || `${slugify(rawTitle)}@${gcalStart}`,
      gcalStart,
      usedIds,
    )
    usedIds.add(sourceScreeningId)

    results.push({
      rawTitle,
      startsAt,
      localDate: localDateOf(startsAt, TZ),
      venueId: SEATTLE_MAGIC_VENUE.id,
      ticketUrl: slug ? `${BASE}/movie-event.html?slug=${encodeURIComponent(slug)}` : `${BASE}/events`,
      sourceScreeningId,
      formatHints: [],
      runtimeMinutes: runtimeBetween(startsAt, parseWallClock(event.gcalEnd)),
    })
  }

  return results
}

/**
 * A repeated slug means a repertory title playing twice; the start timestamp
 * separates them. The trailing counter only matters if a feed ever repeats both.
 */
function uniqueId(preferred: string, gcalStart: string, used: Set<string>): string {
  if (!used.has(preferred)) return preferred

  const disambiguated = `${preferred}@${gcalStart}`
  if (!used.has(disambiguated)) return disambiguated

  let n = 2
  while (used.has(`${disambiguated}#${n}`)) n += 1
  return `${disambiguated}#${n}`
}

/** `localWallClockToUtc` throws on garbage; a bad element should just be skipped. */
function parseWallClock(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    return localWallClockToUtc(value, TZ)
  } catch {
    return undefined
  }
}

/**
 * Approximate: `gcalStart`/`gcalEnd` bound the whole event, which includes
 * doors time and any intro or Q&A, so this runs longer than the print.
 */
function runtimeBetween(startsAt: Date, endsAt: Date | undefined): number | undefined {
  if (!endsAt) return undefined
  const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000)
  return minutes > 0 ? minutes : undefined
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function createSeattleMagicAdapter(fetcher: Fetcher): VenueAdapter {
  return {
    id: 'seattle-magic',
    venues: [SEATTLE_MAGIC_VENUE],
    async fetch(_venue: VenueRef, range: DateRange): Promise<RawScreening[]> {
      const json = await fetcher.text(EVENTS_URL)
      // The feed is the full archive, past events included, so a sweep that
      // took it wholesale would re-insert history every time.
      return parseSeattleMagicScreenings(json).filter(
        (screening) => screening.localDate >= range.from && screening.localDate <= range.to,
      )
    },
  }
}
