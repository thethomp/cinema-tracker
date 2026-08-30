/**
 * Reading the health report as a headline.
 *
 * Pure, because the judgement is the part worth pinning: "is anything wrong,
 * and what do I say about it" is exactly the logic that would otherwise rot
 * quietly inside a component nobody renders in a test.
 */
import type { HealthReport, SourceStatus } from './api'

/** Ids whose casing a title-caser would get wrong. */
const NAMES: Record<string, string> = {
  amc: 'AMC',
  siff: 'SIFF',
  cinemark: 'Cinemark',
  'seattle-magic': 'Seattle Magic',
  letterboxd: 'Letterboxd',
  // Not a venue. It shows up only when TMDB_API_KEY is missing, and "Resolve"
  // in a list of cinema chains reads like somewhere you could buy a ticket.
  resolve: 'Film resolution',
}

/**
 * A source id as a person would write it.
 *
 * An unknown id is title-cased rather than printed raw: a new adapter should
 * read as a name in the failure notice on the day it is added, without anyone
 * having to remember to extend this map first.
 */
export function sourceLabel(id: string): string {
  const known = NAMES[id]
  if (known != null) return known
  return id
    .split(/[-_]/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export interface HealthSummary {
  ok: boolean
  /** Every unhealthy source, each guaranteed a printable `reason`. */
  failing: (SourceStatus & { reason: string })[]
  /** One line naming what is wrong, or null when nothing is. */
  headline: string | null
}

/**
 * Decide what the page says about its own sources.
 *
 * Derived from the per-source flags rather than the report's top-level
 * `healthy`. The two should agree, and if they ever do not, the specific
 * evidence wins — this project's whole failure mode is a component cheerfully
 * reporting health while a source underneath it has stopped returning data.
 */
export function summarizeHealth(report: HealthReport): HealthSummary {
  const failing = report.sources
    .filter((source) => !source.healthy)
    .map((source) => ({
      ...source,
      // A source can be unhealthy without an explanation. Saying so is better
      // than an empty dash the reader has to interpret.
      reason: source.reason != null && source.reason !== '' ? source.reason : 'no reason given',
    }))

  if (failing.length === 0) return { ok: true, failing: [], headline: null }

  const headline =
    failing.length === 1
      ? `${sourceLabel(failing[0]!.source)} is not reporting`
      : `${failing.length} of ${report.sources.length} sources are not reporting`

  return { ok: false, failing, headline }
}
