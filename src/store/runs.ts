import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { sourceRuns } from '../db/schema.js'

export interface RunRecord {
  source: string
  startedAt: Date
  finishedAt: Date
  status: 'ok' | 'failed'
  itemCount: number
  error?: string
}

export interface SourceHealth {
  source: string
  healthy: boolean
  reason?: string
}

/** Zero events is normal here, so the count check does not apply. */
const COUNT_CHECK_EXEMPT = new Set(['seattle-magic'])

/** Flag when the latest count falls below this fraction of the median. */
const DROP_RATIO = 0.5

/** Number of prior successful runs used to compute the baseline. */
const BASELINE_WINDOW = 7

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * How long a source may go without running before it counts as unhealthy.
 *
 * Twelve hours, against a scheduler that runs the passes every six. That is
 * exactly two missed cycles, which is deliberate: one skipped or overrunning
 * pass -- a slow sweep, a restart, a laptop asleep for an afternoon -- must not
 * raise an alarm, and two in a row must.
 *
 * This check is the whole point of the module. AMC stopped being swept for
 * seven days when its key went missing, and because its last recorded run was
 * a *success*, every other check here read it as healthy. Silence is not
 * health, and a verdict that never asks *when* cannot tell them apart.
 */
export const STALE_AFTER_MS = 12 * HOUR_MS

export async function recordRun(db: Db, record: RunRecord): Promise<void> {
  await db.insert(sourceRuns).values({
    source: record.source,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    status: record.status,
    itemCount: record.itemCount,
    error: record.error ?? null,
  })
}

export interface EvaluateHealthOptions {
  /** Injected so a verdict is not at the mercy of the wall clock. */
  now?: Date
}

export async function evaluateHealth(
  db: Db,
  sources: string[],
  options: EvaluateHealthOptions = {},
): Promise<SourceHealth[]> {
  const now = options.now ?? new Date()
  const health: SourceHealth[] = []

  for (const source of sources) {
    const runs = await db
      .select()
      .from(sourceRuns)
      .where(eq(sourceRuns.source, source))
      .orderBy(desc(sourceRuns.startedAt))
      .limit(BASELINE_WINDOW + 1)

    const latest = runs[0]
    if (!latest) {
      health.push({ source, healthy: false, reason: 'never run' })
      continue
    }

    if (latest.status === 'failed') {
      health.push({
        source,
        healthy: false,
        reason: `last run failed: ${latest.error ?? 'unknown error'}`,
      })
      continue
    }

    /*
     * Order matters: never-run, failed, stale, count-drop. Why a source
     * stopped is more actionable than how long it has been stopped, so a
     * recorded failure outranks the silence that followed it.
     */
    const age = now.getTime() - latest.startedAt.getTime()
    if (age > STALE_AFTER_MS) {
      health.push({ source, healthy: false, reason: `stale: last ran ${describeAge(age)} ago` })
      continue
    }

    // Checked after staleness on purpose: the exemption is about a source
    // being allowed to report *zero events*, not about it being allowed to
    // stop reporting.
    if (COUNT_CHECK_EXEMPT.has(source)) {
      health.push({ source, healthy: true })
      continue
    }

    const priorCounts = runs
      .slice(1)
      .filter((run) => run.status === 'ok')
      .map((run) => run.itemCount)

    const baseline = median(priorCounts)
    if (baseline > 0 && latest.itemCount < baseline * DROP_RATIO) {
      health.push({
        source,
        healthy: false,
        reason: `count dropped to ${latest.itemCount} from a median of ${baseline}`,
      })
      continue
    }

    health.push({ source, healthy: true })
  }

  return health
}

/** "7 days", "12 hours", "40 minutes" -- whole units, floored, never bare ms. */
function describeAge(ms: number): string {
  if (ms >= DAY_MS) return plural(Math.floor(ms / DAY_MS), 'day')
  if (ms >= HOUR_MS) return plural(Math.floor(ms / HOUR_MS), 'hour')
  return plural(Math.floor(ms / (60 * 1000)), 'minute')
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}
