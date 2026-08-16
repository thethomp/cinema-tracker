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

export async function evaluateHealth(db: Db, sources: string[]): Promise<SourceHealth[]> {
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

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}
