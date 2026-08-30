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

/**
 * An integration that cannot run because its configuration is absent.
 *
 * Named rather than omitted. `createAdapters` drops the AMC adapter without a
 * vendor key and the resolve pass is skipped without a TMDB token -- both the
 * right thing to do, and both silent, which is how two of the owner's venues
 * went a week without being swept while the health view stayed green. This is
 * the shape those omissions travel in so the report can print them.
 */
export interface UnconfiguredSource {
  /** The source or pass id, as the health report lists it. */
  source: string
  /** The environment variable whose absence stops it, e.g. "AMC_API_KEY". */
  variable: string
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
