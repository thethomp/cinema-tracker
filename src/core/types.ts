export interface VenueRef {
  /** Stable slug, e.g. "siff-uptown". Primary key in the venues table. */
  id: string
  name: string
  chain: string
  timezone: string
  /** Source-specific identifier, e.g. Cinemark's numeric TheaterId. */
  sourceVenueId: string
}

export interface DateRange {
  /** Inclusive, ISO date, e.g. "2026-08-16". */
  from: string
  /** Inclusive, ISO date. */
  to: string
}

export interface RawScreening {
  /** Title exactly as the venue presents it, including any "(70mm)" suffix. */
  rawTitle: string
  /** Absolute instant of the screening start. */
  startsAt: Date
  /** Local calendar date at the venue, "YYYY-MM-DD". */
  localDate: string
  venueId: string
  ticketUrl: string
  /** Stable per-source id, used for upsert identity. */
  sourceScreeningId: string
  /** Format labels straight from the source, pre-tag-extraction. */
  formatHints: string[]
  description?: string
  runtimeMinutes?: number
}

export interface VenueAdapter {
  readonly id: string
  readonly venues: VenueRef[]
  fetch(venue: VenueRef, range: DateRange): Promise<RawScreening[]>
}

/**
 * One firing signal behind a highlight score. Stored as JSON on the screening
 * so the UI can explain *why* something was surfaced, and so a rule that is
 * misfiring is visible rather than buried in an aggregate number.
 */
export interface ScoreReason {
  /** Signal family, e.g. "watchlist", "declared", "special-event". */
  signal: string
  /** What actually matched, e.g. "Horror" or "70MM, ANNIVERSARY". */
  detail: string
  weight: number
}
