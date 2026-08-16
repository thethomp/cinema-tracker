import type { Db } from '../db/client.js'
import type { DateRange, RawScreening, VenueAdapter } from '../core/types.js'
import { upsertScreenings, markMissing } from '../store/screenings.js'
import { recordRun } from '../store/runs.js'

export interface SweepResult {
  source: string
  status: 'ok' | 'failed'
  itemCount: number
  error?: string
}

export async function runSweep(
  db: Db,
  adapters: VenueAdapter[],
  range: DateRange,
  now: Date,
): Promise<SweepResult[]> {
  const results: SweepResult[] = []

  // Sequential by design: adapters are staggered rather than concurrent so the
  // shared per-host rate limit is never the bottleneck for an unrelated source.
  for (const adapter of adapters) {
    const startedAt = new Date()
    try {
      const byVenue = new Map<string, RawScreening[]>()

      for (const venue of adapter.venues) {
        const fetched = await adapter.fetch(venue, range)
        for (const screening of fetched) {
          const bucket = byVenue.get(screening.venueId) ?? []
          bucket.push(screening)
          byVenue.set(screening.venueId, bucket)
        }
      }

      // Iterate the adapter's venues rather than the map: a venue that
      // returned nothing has no map entry, and skipping it would leave its
      // stored rows advertising shows that no longer exist.
      let itemCount = 0
      for (const venue of adapter.venues) {
        const forVenue = byVenue.get(venue.id) ?? []
        // One transaction per venue: a crash between the upsert and the miss
        // pass would otherwise leave the venue half-updated, with rows counted
        // missing that the sweep did in fact see.
        itemCount += db.transaction((tx) => {
          const result = upsertScreenings(tx, forVenue, now)
          markMissing(tx, venue.id, forVenue.map((s) => s.sourceScreeningId), range)
          return result.inserted + result.updated
        })
      }

      await recordRun(db, {
        source: adapter.id,
        startedAt,
        finishedAt: new Date(),
        status: 'ok',
        itemCount,
      })
      results.push({ source: adapter.id, status: 'ok', itemCount })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await recordRun(db, {
        source: adapter.id,
        startedAt,
        finishedAt: new Date(),
        status: 'failed',
        itemCount: 0,
        error: message,
      })
      results.push({ source: adapter.id, status: 'failed', itemCount: 0, error: message })
    }
  }

  return results
}
