import { and, eq, gt, isNull, desc } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { screenings, sourceRuns } from '../db/schema.js'
import { evaluateHealth } from '../store/runs.js'

/**
 * The sources that are expected to run, whether or not they ever have.
 *
 * Hard-coded rather than derived from `source_runs` alone: a source that has
 * never run leaves no rows, and deriving the list from the table would make a
 * never-configured adapter invisible instead of unhealthy. Read models cannot
 * build adapters — those need a Fetcher and an API key — so the names live here.
 */
export const KNOWN_SOURCES = ['amc', 'cinemark', 'seattle-magic', 'siff'] as const

export interface SourceStatus {
  source: string
  healthy: boolean
  reason?: string
  /** Start of the most recent run, or null when the source has never run. */
  lastRunAt: string | null
  lastStatus: 'ok' | 'failed' | null
  itemCount: number | null
}

export interface HealthReport {
  /** False if any source is unhealthy. The UI leads with this. */
  healthy: boolean
  sources: SourceStatus[]
  /** Most recent run of any source, or null. */
  lastRunAt: string | null
  /** Distinct raw titles with no film, among live future screenings. */
  unresolvedTitles: number
  /** Screenings behind those titles. */
  unresolvedScreenings: number
}

export interface HealthOptions {
  now?: Date
  /**
   * Sources the caller knows are configured, *added* to the known set rather
   * than replacing it.
   *
   * `serve.ts` builds the adapters and so knows what this process actually
   * runs, including any added since `KNOWN_SOURCES` was last edited. Union
   * rather than override, because both directions hide a real fault: drop the
   * known set and a missing AMC_API_KEY makes AMC vanish from the report
   * instead of showing as not running; ignore the caller's list and a new
   * adapter is invisible until its first successful sweep.
   */
  sources?: readonly string[]
}

/** A pure read: per-source status, when each last ran, and what is unresolved. */
export async function getHealth(db: Db, options: HealthOptions = {}): Promise<HealthReport> {
  const now = options.now ?? new Date()

  const runRows = await db
    .select({ source: sourceRuns.source })
    .from(sourceRuns)
    .groupBy(sourceRuns.source)
  const names = [
    ...new Set([
      ...KNOWN_SOURCES,
      ...(options.sources ?? []),
      ...runRows.map((row) => row.source),
    ]),
  ].sort()

  const evaluated = new Map(
    (await evaluateHealth(db, names)).map((entry) => [entry.source, entry]),
  )

  const sources: SourceStatus[] = []
  let lastRunAt: string | null = null

  for (const source of names) {
    const [latest] = await db
      .select()
      .from(sourceRuns)
      .where(eq(sourceRuns.source, source))
      .orderBy(desc(sourceRuns.startedAt))
      .limit(1)

    const verdict = evaluated.get(source)
    const startedAt = latest ? latest.startedAt.toISOString() : null
    if (startedAt != null && (lastRunAt == null || startedAt > lastRunAt)) lastRunAt = startedAt

    sources.push({
      source,
      healthy: verdict?.healthy ?? false,
      ...(verdict?.reason != null ? { reason: verdict.reason } : {}),
      lastRunAt: startedAt,
      lastStatus: latest?.status ?? null,
      itemCount: latest?.itemCount ?? null,
    })
  }

  // Scoped to live future screenings: a title nobody can buy a ticket for is
  // not work outstanding, and counting the whole table would make the number
  // grow forever.
  const unresolved = await db
    .select({ rawTitle: screenings.rawTitle })
    .from(screenings)
    .where(
      and(
        isNull(screenings.filmId),
        eq(screenings.cancelled, false),
        gt(screenings.startsAtUtc, now),
      ),
    )

  return {
    healthy: sources.every((source) => source.healthy),
    sources,
    lastRunAt,
    unresolvedTitles: new Set(unresolved.map((row) => row.rawTitle)).size,
    unresolvedScreenings: unresolved.length,
  }
}
