import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { sourceRuns } from '../../src/db/schema.js'
import { recordRun, evaluateHealth } from '../../src/store/runs.js'

let db: Db
beforeEach(() => {
  db = createDatabase(':memory:').db
})

describe('recordRun', () => {
  it('records a successful run', async () => {
    await recordRun(db, {
      source: 'siff',
      startedAt: new Date('2026-08-16T12:00:00Z'),
      finishedAt: new Date('2026-08-16T12:00:30Z'),
      status: 'ok',
      itemCount: 42,
    })

    const rows = await db.select().from(sourceRuns)
    expect(rows[0]!.status).toBe('ok')
    expect(rows[0]!.itemCount).toBe(42)
  })

  it('records a failure with its error message', async () => {
    await recordRun(db, {
      source: 'cinemark',
      startedAt: new Date(),
      finishedAt: new Date(),
      status: 'failed',
      itemCount: 0,
      error: 'GET https://www.cinemark.com/... failed: 503',
    })

    const rows = await db.select().from(sourceRuns)
    expect(rows[0]!.error).toContain('503')
  })
})

describe('evaluateHealth', () => {
  const okRun = (source: string, itemCount: number, day: number) => ({
    source,
    startedAt: new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:00Z`),
    finishedAt: new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:30Z`),
    status: 'ok' as const,
    itemCount,
  })

  it('reports healthy when counts are steady', async () => {
    for (let day = 10; day <= 16; day++) await recordRun(db, okRun('siff', 40, day))

    const health = await evaluateHealth(db, ['siff'])
    expect(health[0]!.healthy).toBe(true)
  })

  it('flags a source whose count halved against its median', async () => {
    for (let day = 10; day <= 15; day++) await recordRun(db, okRun('siff', 40, day))
    await recordRun(db, okRun('siff', 5, 16))

    const health = await evaluateHealth(db, ['siff'])
    expect(health[0]!.healthy).toBe(false)
    expect(health[0]!.reason).toContain('dropped')
  })

  it('flags a source whose latest run failed', async () => {
    await recordRun(db, okRun('cinemark', 100, 15))
    await recordRun(db, {
      source: 'cinemark',
      startedAt: new Date('2026-08-16T12:00:00Z'),
      finishedAt: new Date('2026-08-16T12:00:05Z'),
      status: 'failed',
      itemCount: 0,
      error: 'boom',
    })

    const health = await evaluateHealth(db, ['cinemark'])
    expect(health[0]!.healthy).toBe(false)
    expect(health[0]!.reason).toContain('failed')
  })

  it('exempts seattle-magic from the count check', async () => {
    for (let day = 10; day <= 15; day++) await recordRun(db, okRun('seattle-magic', 3, day))
    await recordRun(db, okRun('seattle-magic', 0, 16))

    const health = await evaluateHealth(db, ['seattle-magic'])
    expect(health[0]!.healthy).toBe(true)
  })

  it('reports a source that has never run as unhealthy', async () => {
    const health = await evaluateHealth(db, ['siff'])
    expect(health[0]!.healthy).toBe(false)
    expect(health[0]!.reason).toContain('never run')
  })
})
