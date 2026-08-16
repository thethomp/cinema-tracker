import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { screenings } from '../db/schema.js'
import type { RawScreening } from '../core/types.js'

export interface UpsertResult {
  inserted: number
  updated: number
}

/** Two consecutive absences from a successful sweep means cancelled. */
const CANCELLATION_THRESHOLD = 2

export async function upsertScreenings(
  db: Db,
  incoming: RawScreening[],
  now: Date,
): Promise<UpsertResult> {
  let inserted = 0
  let updated = 0

  for (const screening of incoming) {
    const existing = await db
      .select({ id: screenings.id })
      .from(screenings)
      .where(
        and(
          eq(screenings.venueId, screening.venueId),
          eq(screenings.sourceScreeningId, screening.sourceScreeningId),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      await db
        .update(screenings)
        .set({
          rawTitle: screening.rawTitle,
          startsAtUtc: screening.startsAt,
          localDate: screening.localDate,
          ticketUrl: screening.ticketUrl,
          formatHints: screening.formatHints,
          runtimeMinutes: screening.runtimeMinutes ?? null,
          lastSeenAt: now,
          missedSweeps: 0,
          cancelled: false,
        })
        .where(eq(screenings.id, existing[0]!.id))
      updated += 1
    } else {
      await db.insert(screenings).values({
        venueId: screening.venueId,
        filmId: null,
        rawTitle: screening.rawTitle,
        startsAtUtc: screening.startsAt,
        localDate: screening.localDate,
        ticketUrl: screening.ticketUrl,
        sourceScreeningId: screening.sourceScreeningId,
        formatHints: screening.formatHints,
        tags: [],
        runtimeMinutes: screening.runtimeMinutes ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        missedSweeps: 0,
        cancelled: false,
      })
      inserted += 1
    }
  }

  return { inserted, updated }
}

/**
 * Increment the miss counter for screenings at this venue that the sweep did
 * not report, and cancel those that have now been missed twice running.
 *
 * Call only after a SUCCESSFUL fetch — a failed adapter reports nothing, and
 * treating that as "everything was cancelled" would wipe the venue.
 */
export async function markMissing(
  db: Db,
  venueId: string,
  presentSourceIds: string[],
): Promise<void> {
  const notPresent =
    presentSourceIds.length > 0
      ? and(
          eq(screenings.venueId, venueId),
          notInArray(screenings.sourceScreeningId, presentSourceIds),
        )
      : eq(screenings.venueId, venueId)

  await db
    .update(screenings)
    .set({ missedSweeps: sql`${screenings.missedSweeps} + 1` })
    .where(and(notPresent, eq(screenings.cancelled, false)))

  await db
    .update(screenings)
    .set({ cancelled: true })
    .where(
      and(
        eq(screenings.venueId, venueId),
        sql`${screenings.missedSweeps} >= ${CANCELLATION_THRESHOLD}`,
      ),
    )
}
