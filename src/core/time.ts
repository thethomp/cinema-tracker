import { DateTime } from 'luxon'
import type { DateRange } from './types.js'

/**
 * Interpret a zoneless local timestamp ("2026-08-16T09:50:00") as wall-clock
 * time in `timezone` and return the absolute instant.
 */
export function localWallClockToUtc(wallClock: string, timezone: string): Date {
  const dt = DateTime.fromISO(wallClock, { zone: timezone })
  if (!dt.isValid) {
    throw new Error(`Invalid wall-clock timestamp: ${wallClock}`)
  }
  return dt.toJSDate()
}

/** The calendar date on which this instant falls, in the venue's timezone. */
export function localDateOf(instant: Date, timezone: string): string {
  const date = DateTime.fromJSDate(instant).setZone(timezone).toISODate()
  // Null means the Date (or the zone) was invalid. Asserting it away with `!`
  // would put the string "null" into a localDate column.
  if (date === null) {
    throw new Error(`Invalid instant or timezone: ${instant.toString()} / ${timezone}`)
  }
  return date
}

/** Every date in an inclusive range, as "YYYY-MM-DD". */
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

/**
 * Whole days from `today` to `date`, both "YYYY-MM-DD". Compared at UTC
 * midnight so a DST boundary between the two cannot shift the count.
 */
export function dayOffset(date: string, today: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}
