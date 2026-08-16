import type { Db } from './client.js'
import { venues } from './schema.js'
import type { VenueRef } from '../core/types.js'

/** Independent and repertory venues outrank the chains. See spec: venue weight. */
const WEIGHTED_CHAINS: Record<string, number> = {
  SIFF: 15,
  Independent: 15,
}

export async function seedVenues(db: Db, refs: VenueRef[]): Promise<void> {
  for (const ref of refs) {
    await db
      .insert(venues)
      .values({
        id: ref.id,
        name: ref.name,
        chain: ref.chain,
        timezone: ref.timezone,
        sourceVenueId: ref.sourceVenueId,
        weight: WEIGHTED_CHAINS[ref.chain] ?? 0,
      })
      .onConflictDoUpdate({
        target: venues.id,
        // timezone and weight included: without them, changing a venue's chain
        // (and so its weight) or timezone silently did nothing on re-seed.
        set: {
          name: ref.name,
          chain: ref.chain,
          timezone: ref.timezone,
          sourceVenueId: ref.sourceVenueId,
          weight: WEIGHTED_CHAINS[ref.chain] ?? 0,
        },
      })
  }
}
