import { DateTime } from 'luxon'

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
  return DateTime.fromJSDate(instant).setZone(timezone).toISODate()!
}
