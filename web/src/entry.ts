import type { EntryShowtime, EntryVenue } from './api'

/**
 * The four tags that earn vermilion.
 *
 * Not the same set as `SPECIAL_EVENT_TAGS` in the scorer, which also contains
 * ANNIVERSARY. Anniversary screenings are a distribution line -- there are 118
 * of them live right now -- and stamping them would put the accent colour on a
 * fifth of the page. What gets stamped is the *print*: a physical format or a
 * one-off performance you cannot get any other night.
 *
 * Ordered by rarity, so a 35mm print is named before a live score when a
 * screening is both.
 */
const STAMPED: readonly string[] = ['70MM', '35MM', 'LIVE_SCORE', 'Q_AND_A']

const TAG_LABELS: Record<string, string> = {
  LIVE_SCORE: 'LIVE SCORE',
  Q_AND_A: 'Q & A',
  RE_RELEASE: 'RE-RELEASE',
  SING_ALONG: 'SING-ALONG',
  MEMBER_ONLY: 'MEMBERS ONLY',
}

export function tagLabel(tag: string): string {
  return TAG_LABELS[tag] ?? tag.replaceAll('_', ' ')
}

export interface SplitTags {
  /** Display labels for the vermilion stamps. */
  stamps: string[]
  /** Everything else, as muted small-caps chips. */
  chips: string[]
}

export function splitTags(tags: readonly string[]): SplitTags {
  const present = new Set(tags)
  return {
    stamps: STAMPED.filter((tag) => present.has(tag)).map(tagLabel),
    chips: tags.filter((tag) => !STAMPED.includes(tag)).map(tagLabel),
  }
}

export interface ShowtimeDay {
  localDate: string
  times: EntryShowtime[]
  /** Times on this day that did not fit. */
  hiddenOnDay: number
}

export interface ShowtimeSummary {
  days: ShowtimeDay[]
  /** Every showtime in the entry, printed or not. */
  total: number
  /** Total not printed, across every day. */
  hiddenCount: number
  /** Last date the film plays in the window, or null. */
  lastLocalDate: string | null
}

export interface SummaryOptions {
  maxDays: number
  maxPerDay: number
}

/**
 * Bound an entry's showtimes to a printable block.
 *
 * This is the fix for the hierarchy problem, not a cosmetic truncation. The
 * live database has 151 showtimes of The Odyssey and 99 of The End of Oak
 * Street against a *single* 35mm GoldenEye at SIFF Uptown. Printed in full,
 * the page would rank by distribution deal: the wide release would be twenty
 * times the height of the one thing in the feed worth crossing town for. Two
 * days of times, then the run stated as a sentence.
 */
export function summarizeShowtimes(
  showtimes: readonly EntryShowtime[],
  options: SummaryOptions,
): ShowtimeSummary {
  const byDate = new Map<string, EntryShowtime[]>()
  for (const showtime of showtimes) {
    const bucket = byDate.get(showtime.localDate)
    if (bucket) bucket.push(showtime)
    else byDate.set(showtime.localDate, [showtime])
  }

  const dates = [...byDate.keys()].sort()
  const days: ShowtimeDay[] = dates.slice(0, options.maxDays).map((localDate) => {
    const all = [...byDate.get(localDate)!].sort((a, b) =>
      a.startsAtUtc.localeCompare(b.startsAtUtc),
    )
    return {
      localDate,
      times: all.slice(0, options.maxPerDay),
      hiddenOnDay: Math.max(0, all.length - options.maxPerDay),
    }
  })

  const printed = days.reduce((sum, day) => sum + day.times.length, 0)
  return {
    days,
    total: showtimes.length,
    hiddenCount: showtimes.length - printed,
    lastLocalDate: dates.length > 0 ? dates[dates.length - 1]! : null,
  }
}

export interface VenueSummary {
  named: string[]
  extra: number
}

/** Name the first few venues; count the rest. */
export function venueSummary(venues: readonly EntryVenue[], max: number): VenueSummary {
  return {
    named: venues.slice(0, max).map((venue) => venue.name),
    extra: Math.max(0, venues.length - max),
  }
}
