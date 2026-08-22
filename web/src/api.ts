/**
 * The typed edge between the UI and the JSON API.
 *
 * No client library. Every response goes through `request`, which turns any
 * non-2xx or transport failure into an `ApiError` carrying something a person
 * can act on. A UI that spins forever because a fetch rejected silently is the
 * failure mode this exists to prevent.
 */

export interface EntryReason {
  label: string
  weight: number
}

export interface EntryVenue {
  id: string
  name: string
  chain: string
}

export interface EntryShowtime {
  id: number
  startsAtUtc: string
  localDate: string
  ticketUrl: string
  venueId: string
}

/** Mirrors `FilmEntry` in `src/read/query.ts`. */
export interface FilmEntry {
  filmId: number | null
  title: string
  rawTitle: string
  year?: number
  director?: string
  runtimeMinutes?: number
  posterUrl?: string
  score: number
  reasons: EntryReason[]
  tags: string[]
  venues: EntryVenue[]
  showtimes: EntryShowtime[]
  firstSeenAt: string
  isNew: boolean
}

export interface AgendaDay {
  /** Venue-local calendar date, "YYYY-MM-DD". */
  date: string
  entries: FilmEntry[]
}

export interface SourceStatus {
  source: string
  healthy: boolean
  reason?: string
  lastRunAt: string | null
  lastStatus: 'ok' | 'failed' | null
  itemCount: number | null
}

export interface HealthReport {
  healthy: boolean
  sources: SourceStatus[]
  lastRunAt: string | null
  unresolvedTitles: number
  unresolvedScreenings: number
}

export interface ApiWindow {
  from: string
  to: string
  days?: number
}

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached a server. */
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (cause) {
    // A rejected fetch is almost always the API process not running. Say that,
    // rather than reprinting the browser's "Failed to fetch".
    throw new ApiError(
      `Could not reach the API at ${path}. Is the server running on :8787?`,
      0,
    )
  }

  if (!response.ok) {
    const detail = await errorDetail(response)
    const method = init?.method ?? 'GET'
    throw new ApiError(
      `${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ''}`,
      response.status,
    )
  }

  return (await response.json()) as T
}

/** The server's own error message when it sent one; nothing when it did not. */
async function errorDetail(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    if (body != null && typeof body === 'object' && 'error' in body) {
      const message = (body as { error?: unknown }).error
      if (typeof message === 'string' && message !== '') return message
    }
  } catch {
    // Not JSON -- a proxy error page, most likely. The status carries it.
  }
  return null
}

export interface HighlightQuery {
  days?: number
  limit?: number
}

export async function fetchHighlights(query: HighlightQuery): Promise<FilmEntry[]> {
  const params = new URLSearchParams()
  if (query.days != null) params.set('days', String(query.days))
  if (query.limit != null) params.set('limit', String(query.limit))
  const suffix = params.size > 0 ? `?${params}` : ''

  const body = await request<{ window: ApiWindow; limit: number; entries: FilmEntry[] }>(
    `/api/highlights${suffix}`,
  )
  return body.entries
}

export interface AgendaQuery {
  /** Venue-local date, "YYYY-MM-DD". */
  from?: string
  to?: string
}

export async function fetchAgenda(query: AgendaQuery): Promise<AgendaDay[]> {
  const params = new URLSearchParams()
  if (query.from) params.set('from', query.from)
  if (query.to) params.set('to', query.to)
  const suffix = params.size > 0 ? `?${params}` : ''

  const body = await request<{ window: ApiWindow; days: AgendaDay[] }>(`/api/agenda${suffix}`)
  return body.days
}

export interface Venue {
  id: string
  name: string
  chain: string
  timezone: string
}

export async function fetchVenues(): Promise<Venue[]> {
  const body = await request<{ venues: Venue[] }>('/api/venues')
  return body.venues
}

export function fetchHealth(): Promise<HealthReport> {
  return request<HealthReport>('/api/health')
}

/**
 * Stamps this visit and returns the previous stamp.
 *
 * The previous value is the whole point: it is what "new since you last
 * looked" is measured against, and the POST destroys it.
 */
export function recordVisit(): Promise<{ previous: string | null; current: string }> {
  return request<{ previous: string | null; current: string }>('/api/visit', { method: 'POST' })
}
