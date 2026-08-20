import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { films, screenings } from '../db/schema.js'
import type { TmdbFilm } from '../tmdb/client.js'

/** Insert or refresh a film by TMDB id. Returns the local row id. */
export async function upsertFilm(db: Db, film: TmdbFilm, now: Date): Promise<number> {
  const values = {
    tmdbId: film.tmdbId,
    title: film.title,
    year: film.year ?? null,
    runtimeMinutes: film.runtimeMinutes ?? null,
    originalLanguage: film.originalLanguage ?? null,
    genres: film.genres,
    director: film.director ?? null,
    posterUrl: film.posterUrl ?? null,
    synopsis: film.synopsis ?? null,
    usReleaseDate: film.usReleaseDate ?? null,
    fetchedAt: now,
  }

  await db.insert(films).values(values).onConflictDoUpdate({
    target: films.tmdbId,
    set: values,
  })

  const [row] = await db
    .select({ id: films.id })
    .from(films)
    .where(eq(films.tmdbId, film.tmdbId))
    .limit(1)

  if (!row) throw new Error(`film ${film.tmdbId} vanished after upsert`)
  return row.id
}

/** Point every screening with this raw title at a film. Returns rows changed. */
export async function linkScreenings(db: Db, rawTitle: string, filmId: number): Promise<number> {
  const targets = await db
    .select({ id: screenings.id })
    .from(screenings)
    .where(and(eq(screenings.rawTitle, rawTitle), isNull(screenings.filmId)))

  if (targets.length === 0) return 0

  await db
    .update(screenings)
    .set({ filmId })
    .where(and(eq(screenings.rawTitle, rawTitle), isNull(screenings.filmId)))

  return targets.length
}

export interface UnresolvedTitle {
  rawTitle: string
  screeningCount: number
}

/** Distinct raw titles with no film, busiest first. Cancelled rows excluded. */
export async function unresolvedTitles(db: Db): Promise<UnresolvedTitle[]> {
  return db
    .select({
      rawTitle: screenings.rawTitle,
      screeningCount: sql<number>`count(*)`,
    })
    .from(screenings)
    .where(and(isNull(screenings.filmId), eq(screenings.cancelled, false)))
    .groupBy(screenings.rawTitle)
    .orderBy(sql`count(*) desc`)
}
