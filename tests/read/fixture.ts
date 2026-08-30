import { createDatabase, type Db } from '../../src/db/client.js'
import { appState, films, screenings, venues } from '../../src/db/schema.js'
import type { ScoreReason } from '../../src/core/types.js'

/** 11:00 in Seattle on a Saturday. Every instant below is relative to this. */
export const NOW = new Date('2026-08-22T18:00:00Z')

export const VENUES = [
  { id: 'siff-uptown', name: 'SIFF Cinema Uptown', chain: 'SIFF' },
  { id: 'amc-alderwood', name: 'AMC Alderwood Mall 16', chain: 'AMC' },
  { id: 'amc-pacific-place', name: 'AMC Pacific Place 11', chain: 'AMC' },
  { id: 'cinemark-lincoln-square', name: 'Cinemark Lincoln Square Cinemas and IMAX', chain: 'Cinemark' },
]

export async function emptyDb(): Promise<{ db: Db; close: () => void }> {
  const { db, close } = createDatabase(':memory:')
  await db.insert(venues).values(
    VENUES.map((v) => ({
      id: v.id,
      name: v.name,
      chain: v.chain,
      timezone: 'America/Los_Angeles',
      sourceVenueId: v.id,
      weight: 0,
    })),
  )
  return { db, close }
}

let nextSourceId = 0

export interface ScreeningSpec {
  rawTitle: string
  venueId: string
  filmId?: number | null
  startsAt: string
  localDate: string
  score?: number | null
  tags?: string[]
  reasons?: ScoreReason[]
  cancelled?: boolean
  firstSeenAt?: string
  runtimeMinutes?: number | null
  ticketUrl?: string
}

export async function addScreenings(db: Db, specs: ScreeningSpec[]): Promise<void> {
  for (const spec of specs) {
    nextSourceId += 1
    await db.insert(screenings).values({
      venueId: spec.venueId,
      filmId: spec.filmId ?? null,
      rawTitle: spec.rawTitle,
      startsAtUtc: new Date(spec.startsAt),
      localDate: spec.localDate,
      ticketUrl: spec.ticketUrl ?? `https://tickets.example/${nextSourceId}`,
      sourceScreeningId: `src-${nextSourceId}`,
      formatHints: [],
      tags: spec.tags ?? [],
      runtimeMinutes: spec.runtimeMinutes ?? null,
      score: spec.score === undefined ? 0 : spec.score,
      reasons: spec.reasons ?? [],
      firstSeenAt: new Date(spec.firstSeenAt ?? '2026-07-01T00:00:00Z'),
      lastSeenAt: NOW,
      cancelled: spec.cancelled ?? false,
    })
  }
}

export async function addOdysseyFilm(db: Db): Promise<number> {
  await db.insert(films).values({
    id: 1,
    tmdbId: 555,
    title: 'The Odyssey',
    year: 2026,
    runtimeMinutes: 168,
    originalLanguage: 'en',
    genres: ['Adventure'],
    director: 'Christopher Nolan',
    posterUrl: 'https://image.tmdb.org/t/p/w500/odyssey.jpg',
  })
  return 1
}

export async function setLastVisit(db: Db, iso: string): Promise<void> {
  await db.insert(appState).values({ key: 'last_visit_at', value: iso })
}
