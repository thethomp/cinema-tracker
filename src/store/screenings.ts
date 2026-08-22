import { and, eq, gte, lte, notInArray, sql } from 'drizzle-orm'
import type { DbLike } from '../db/client.js'
import { screenings } from '../db/schema.js'
import type { DateRange, RawScreening } from '../core/types.js'

export interface UpsertResult {
  inserted: number
  updated: number
}

/** Two consecutive absences from a successful sweep means cancelled. */
const CANCELLATION_THRESHOLD = 2

/**
 * Synchronous, like better-sqlite3 itself, so that a caller can run this and
 * `markMissing` inside one `db.transaction` — better-sqlite3 refuses a
 * transaction callback that returns a promise. Callers may still `await` the
 * result harmlessly.
 */
export function upsertScreenings(
  db: DbLike,
  incoming: RawScreening[],
  now: Date,
): UpsertResult {
  let inserted = 0
  let updated = 0

  for (const screening of incoming) {
    const existing = db
      .select({ id: screenings.id })
      .from(screenings)
      .where(
        and(
          eq(screenings.venueId, screening.venueId),
          eq(screenings.sourceScreeningId, screening.sourceScreeningId),
        ),
      )
      .limit(1)
      .all()

    if (existing.length > 0) {
      db
        .update(screenings)
        .set({
          rawTitle: screening.rawTitle,
          startsAtUtc: screening.startsAt,
          localDate: screening.localDate,
          ticketUrl: screening.ticketUrl,
          formatHints: screening.formatHints,
          description: screening.description ?? null,
          runtimeMinutes: screening.runtimeMinutes ?? null,
          lastSeenAt: now,
          missedSweeps: 0,
          cancelled: false,
        })
        .where(eq(screenings.id, existing[0]!.id))
        .run()
      updated += 1
    } else {
      db.insert(screenings).values({
        venueId: screening.venueId,
        filmId: null,
        rawTitle: screening.rawTitle,
        startsAtUtc: screening.startsAt,
        localDate: screening.localDate,
        ticketUrl: screening.ticketUrl,
        sourceScreeningId: screening.sourceScreeningId,
        formatHints: screening.formatHints,
        description: screening.description ?? null,
        tags: [],
        runtimeMinutes: screening.runtimeMinutes ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        missedSweeps: 0,
        cancelled: false,
      }).run()
      inserted += 1
    }
  }

  return { inserted, updated }
}

/**
 * Increment the miss counter for screenings at this venue that the sweep did
 * not report, and cancel those that have now been missed twice running.
 *
 * Scoped to `range`, the window the sweep actually asked the source for.
 * Without that bound, every screening that had merely *happened* fell out of
 * the listing and was counted missing — at 6-hour sweeps a show was cancelled
 * within ~12 hours of taking place and its miss count grew without limit,
 * which is the one signal separating a real cancellation from ordinary aging.
 *
 * Call only after a SUCCESSFUL fetch — a failed adapter reports nothing, and
 * treating that as "everything was cancelled" would wipe the venue.
 */
export function markMissing(
  db: DbLike,
  venueId: string,
  presentSourceIds: string[],
  range: DateRange,
): void {
  const inWindow = and(
    eq(screenings.venueId, venueId),
    gte(screenings.localDate, range.from),
    lte(screenings.localDate, range.to),
  )
  const notPresent =
    presentSourceIds.length > 0
      ? and(inWindow, notInArray(screenings.sourceScreeningId, presentSourceIds))
      : inWindow

  db
    .update(screenings)
    .set({ missedSweeps: sql`${screenings.missedSweeps} + 1` })
    .where(and(notPresent, eq(screenings.cancelled, false)))
    .run()

  // `notPresent` again, not just the venue: a row the source still lists must
  // never be cancelled, whatever its miss count. Relying on the caller having
  // reset it via `upsertScreenings` first is an invariant nothing enforces.
  db
    .update(screenings)
    .set({ cancelled: true })
    .where(and(notPresent, sql`${screenings.missedSweeps} >= ${CANCELLATION_THRESHOLD}`))
    .run()
}
