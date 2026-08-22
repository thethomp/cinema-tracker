import type { Fetcher } from '../fetch/fetcher.js'

const BASE = 'https://api.themoviedb.org/3'
const POSTER_BASE = 'https://image.tmdb.org/t/p/w500'

export interface TmdbCandidate {
  tmdbId: number
  title: string
  year?: number
  originalLanguage?: string
  popularity: number
}

export interface TmdbFilm {
  tmdbId: number
  title: string
  year?: number
  runtimeMinutes?: number
  originalLanguage?: string
  genres: string[]
  director?: string
  posterUrl?: string
  synopsis?: string
  usReleaseDate?: string
}

interface SearchPayload {
  results?: Array<{
    id: number
    title?: string
    release_date?: string
    original_language?: string
    popularity?: number
  }>
}

interface DetailPayload {
  id: number
  title?: string
  release_date?: string
  runtime?: number | null
  original_language?: string
  genres?: Array<{ name: string }>
  poster_path?: string | null
  overview?: string
  credits?: { crew?: Array<{ job?: string; name?: string }> }
  release_dates?: {
    results?: Array<{
      iso_3166_1?: string
      release_dates?: Array<{ release_date?: string }>
    }>
  }
}

/** "2001-11-16" -> 2001. Undefined for empty or malformed values. */
function yearOf(releaseDate: string | undefined): number | undefined {
  if (!releaseDate) return undefined
  const year = Number(releaseDate.slice(0, 4))
  return Number.isFinite(year) && year > 1800 ? year : undefined
}

export class TmdbClient {
  constructor(
    private readonly fetcher: Pick<Fetcher, 'text'>,
    private readonly apiKey: string,
  ) {}

  async searchMovies(query: string, year?: number): Promise<TmdbCandidate[]> {
    const params = new URLSearchParams({
      api_key: this.apiKey,
      query,
      include_adult: 'false',
    })
    if (year !== undefined) params.set('year', String(year))

    // URLSearchParams encodes spaces as "+", which TMDB accepts but which makes
    // the request harder to read in logs and tests. Normalize to %20.
    const qs = params.toString().replace(/\+/g, '%20')
    const payload = JSON.parse(await this.fetcher.text(`${BASE}/search/movie?${qs}`)) as SearchPayload

    return (payload.results ?? []).map((result) => ({
      tmdbId: result.id,
      title: result.title ?? '',
      year: yearOf(result.release_date),
      originalLanguage: result.original_language,
      popularity: result.popularity ?? 0,
    }))
  }

  async getMovie(tmdbId: number): Promise<TmdbFilm> {
    const params = new URLSearchParams({
      api_key: this.apiKey,
      append_to_response: 'credits,release_dates',
    })
    const payload = JSON.parse(
      await this.fetcher.text(`${BASE}/movie/${tmdbId}?${params.toString()}`),
    ) as DetailPayload

    const director = payload.credits?.crew?.find((member) => member.job === 'Director')?.name
    const us = payload.release_dates?.results?.find((entry) => entry.iso_3166_1 === 'US')
    const usReleaseDate = us?.release_dates?.[0]?.release_date?.slice(0, 10)

    return {
      tmdbId: payload.id,
      title: payload.title ?? '',
      year: yearOf(payload.release_date),
      runtimeMinutes: payload.runtime ?? undefined,
      originalLanguage: payload.original_language,
      genres: (payload.genres ?? []).map((genre) => genre.name),
      director,
      posterUrl: payload.poster_path ? `${POSTER_BASE}${payload.poster_path}` : undefined,
      synopsis: payload.overview,
      usReleaseDate,
    }
  }
}
