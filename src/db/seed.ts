import type { Db } from './client.js'
import { tasteRules, venues } from './schema.js'
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

/**
 * The seed weights from the scoring model.
 *
 * `taste_rules` is documented as editable, so seeding inserts missing rows and
 * leaves existing ones exactly as they are. A re-seed that reset weights would
 * silently undo every adjustment the owner had made, which is the kind of
 * quiet data loss this project treats as a bug.
 */
const TASTE_RULE_SEEDS: {
  kind: 'declared' | 'genre' | 'language' | 'venue' | 'tag' | 'watchlist' | 'watched'
  value: string
  weight: number
}[] = [
  { kind: 'watchlist', value: 'match', weight: 100 },
  // Deliberately above the 40 highlight threshold: a horror film reaches the
  // feed on this signal alone, with nothing else firing.
  { kind: 'declared', value: 'Horror', weight: 60 },
  { kind: 'tag', value: '70MM', weight: 50 },
  { kind: 'tag', value: '35MM', weight: 50 },
  { kind: 'tag', value: 'LIVE_SCORE', weight: 50 },
  { kind: 'tag', value: 'Q_AND_A', weight: 50 },
  { kind: 'tag', value: 'ANNIVERSARY', weight: 50 },
  { kind: 'language', value: 'non-english', weight: 20 },
  // "Preferred genre match" from the scoring model is worth 15, but the owner
  // has declared exactly one standing preference and it is Horror, above as a
  // `declared` rule at 60. Adding a `genre` row here — or by hand — gives that
  // genre the +15; seeding invented favourites would put taste in the feed
  // that the owner never expressed.
  { kind: 'venue', value: 'SIFF', weight: 15 },
  { kind: 'venue', value: 'Independent', weight: 15 },
  { kind: 'tag', value: 'IMAX', weight: 10 },
  // A one-off programme slot: "Studio Ghibli Fest", a Q&A premiere, an
  // anniversary event series. Deliberately under the 40 threshold — it needs a
  // second signal to reach the feed.
  { kind: 'tag', value: 'EVENT', weight: 30 },
  // Milder still, and on purpose. ARTHOUSE comes from AMC Artisan Films, which
  // is a standing programming line covering 176 live screenings rather than a
  // one-off. Weighted to nudge, not to promote on its own.
  { kind: 'tag', value: 'ARTHOUSE', weight: 15 },
  { kind: 'watched', value: 'seen', weight: -80 },
]

/** Weight applied to a `genre` rule when one is added. */
export const PREFERRED_GENRE_WEIGHT = 15

export async function seedTasteRules(db: Db): Promise<void> {
  const existing = new Set(
    (await db.select({ kind: tasteRules.kind, value: tasteRules.value }).from(tasteRules)).map(
      (row) => `${row.kind}:${row.value}`,
    ),
  )

  const missing = TASTE_RULE_SEEDS.filter((rule) => !existing.has(`${rule.kind}:${rule.value}`))
  if (missing.length === 0) return

  await db.insert(tasteRules).values(missing.map((rule) => ({ ...rule, enabled: true })))
}
