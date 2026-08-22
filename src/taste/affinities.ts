import { sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { films, letterboxdEntries, tasteAffinities } from '../db/schema.js'

export type AffinityDimension = 'genre' | 'language' | 'director' | 'decade'

/** One rated film, flattened to the dimensions affinities are computed over. */
export interface RatedFilm {
  rating: number
  genres: string[]
  originalLanguage?: string | null
  director?: string | null
  year?: number | null
}

export interface DerivedAffinity {
  dimension: AffinityDimension
  value: string
  meanRating: number
  sampleCount: number
  weight: number
}

export interface AffinityModel {
  overallMean: number
  /** Distinct rated films that contributed. Zero means the model is empty. */
  ratedCount: number
  affinities: DerivedAffinity[]
}

/**
 * A dimension value must clear the overall mean by this much to count as a
 * strong affinity.
 */
export const MIN_MARGIN = 0.5

/**
 * ...and it must have at least this many rated samples. Without the floor a
 * single 5-star rating turns a whole genre into a highlight generator.
 */
export const MIN_SAMPLE_COUNT = 5

/** The scoring model pays a flat +30 for a strong affinity, whatever the dimension. */
export const STRONG_AFFINITY_WEIGHT = 30

/** 1983 -> "1980s". Undefined for a missing or implausible year. */
export function decadeOf(year: number | null | undefined): string | undefined {
  if (year == null || !Number.isFinite(year) || year < 1800) return undefined
  return `${Math.floor(year / 10) * 10}s`
}

function dimensionValues(film: RatedFilm): { dimension: AffinityDimension; value: string }[] {
  const out: { dimension: AffinityDimension; value: string }[] = []
  for (const genre of film.genres) {
    const value = genre.trim()
    if (value) out.push({ dimension: 'genre', value })
  }
  const language = film.originalLanguage?.trim()
  if (language) out.push({ dimension: 'language', value: language })
  const director = film.director?.trim()
  if (director) out.push({ dimension: 'director', value: director })
  const decade = decadeOf(film.year)
  if (decade) out.push({ dimension: 'decade', value: decade })
  return out
}

function isRated(film: RatedFilm): boolean {
  return typeof film.rating === 'number' && Number.isFinite(film.rating)
}

interface Bucket {
  dimension: AffinityDimension
  value: string
  sum: number
  count: number
}

/**
 * Pure core: rated films in, strong affinities out.
 *
 * Kept free of the database so the floors -- the part that is easy to get
 * subtly wrong -- can be tested on constructed input.
 */
export function computeAffinities(
  ratedFilms: RatedFilm[],
  weight: number = STRONG_AFFINITY_WEIGHT,
): AffinityModel {
  const rated = ratedFilms.filter(isRated)
  if (rated.length === 0) return { overallMean: 0, ratedCount: 0, affinities: [] }

  const overallMean = rated.reduce((sum, f) => sum + f.rating, 0) / rated.length

  const buckets = new Map<string, Bucket>()
  for (const film of rated) {
    for (const { dimension, value } of dimensionValues(film)) {
      const key = `${dimension} ${value}`
      const bucket = buckets.get(key) ?? { dimension, value, sum: 0, count: 0 }
      bucket.sum += film.rating
      bucket.count += 1
      buckets.set(key, bucket)
    }
  }

  const affinities: DerivedAffinity[] = []
  for (const bucket of buckets.values()) {
    if (bucket.count < MIN_SAMPLE_COUNT) continue
    const meanRating = bucket.sum / bucket.count
    if (meanRating < overallMean + MIN_MARGIN) continue
    affinities.push({
      dimension: bucket.dimension,
      value: bucket.value,
      meanRating,
      sampleCount: bucket.count,
      weight,
    })
  }

  affinities.sort(
    (a, b) =>
      b.meanRating - a.meanRating ||
      b.sampleCount - a.sampleCount ||
      a.dimension.localeCompare(b.dimension) ||
      a.value.localeCompare(b.value),
  )

  return { overallMean, ratedCount: rated.length, affinities }
}

interface RatedRow {
  filmId: number
  rating: number
  watchedDate: string | null
  genres: string[]
  originalLanguage: string | null
  director: string | null
  year: number | null
}

/**
 * Rated diary entries joined to the films we hold TMDB metadata for.
 *
 * The join is deliberately **not** `tmdb_id` alone. Only the RSS feed carries
 * TMDB ids; CSV-export entries carry none, so a strict id join drops every one
 * of them silently and leaves a model built on a handful of films. Title+year
 * is the fallback, casefolded because Letterboxd and TMDB disagree on
 * capitalization more often than on wording.
 */
async function loadRatedRows(db: Db): Promise<RatedRow[]> {
  const rows = await db
    .select({
      filmId: films.id,
      rating: letterboxdEntries.memberRating,
      watchedDate: letterboxdEntries.watchedDate,
      genres: films.genres,
      originalLanguage: films.originalLanguage,
      director: films.director,
      year: films.year,
    })
    .from(letterboxdEntries)
    .innerJoin(
      films,
      sql`((${letterboxdEntries.tmdbId} IS NOT NULL AND ${films.tmdbId} = ${letterboxdEntries.tmdbId})
          OR (lower(${films.title}) = lower(${letterboxdEntries.title})
              AND ${letterboxdEntries.year} IS NOT NULL
              AND ${films.year} = ${letterboxdEntries.year}))`,
    )
    .where(
      sql`${letterboxdEntries.kind} = 'diary' AND ${letterboxdEntries.memberRating} IS NOT NULL`,
    )

  return rows.map((row) => ({
    filmId: row.filmId,
    rating: row.rating as number,
    watchedDate: row.watchedDate,
    genres: row.genres ?? [],
    originalLanguage: row.originalLanguage,
    director: row.director,
    year: row.year,
  }))
}

/**
 * Recompute `taste_affinities` from the Letterboxd diary.
 *
 * Rows that no longer qualify are deleted rather than left to rot: a stale
 * affinity keeps paying out +30 forever and nothing in the feed would show you
 * why.
 */
export async function deriveAffinities(db: Db): Promise<AffinityModel> {
  const rows = await loadRatedRows(db)

  // One sample per film. A rewatch is a second diary row for the same film and
  // would otherwise let a single title vote twice; the latest viewing wins,
  // since that is the rating the owner currently stands behind.
  const latest = new Map<number, RatedRow>()
  for (const row of rows) {
    const current = latest.get(row.filmId)
    if (!current || (row.watchedDate ?? '') > (current.watchedDate ?? '')) {
      latest.set(row.filmId, row)
    }
  }

  const model = computeAffinities(
    [...latest.values()].map((row) => ({
      rating: row.rating,
      genres: row.genres,
      originalLanguage: row.originalLanguage,
      director: row.director,
      year: row.year,
    })),
  )

  // better-sqlite3 transactions are synchronous: the callback must not return
  // a promise, so these use .run() rather than being awaited.
  db.transaction((tx) => {
    tx.delete(tasteAffinities).run()
    if (model.affinities.length > 0) {
      tx.insert(tasteAffinities)
        .values(
          model.affinities.map((a) => ({
            dimension: a.dimension,
            value: a.value,
            meanRating: a.meanRating,
            sampleCount: a.sampleCount,
            weight: a.weight,
          })),
        )
        .run()
    }
  })

  return model
}
