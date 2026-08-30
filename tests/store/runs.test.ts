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
  // These fixtures are dated, and the staleness check reads the clock. Pinning
  // `now` an hour after the newest run keeps them about what they test.
  const JUST_AFTER = new Date('2026-08-16T13:00:00Z')

  const okRun = (source: string, itemCount: number, day: number) => ({
    source,
    startedAt: new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:00Z`),
    finishedAt: new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:30Z`),
    status: 'ok' as const,
    itemCount,
  })

  it('reports healthy when counts are steady', async () => {
    for (let day = 10; day <= 16; day++) await recordRun(db, okRun('siff', 40, day))

    const health = await evaluateHealth(db, ['siff'], { now: JUST_AFTER })
    expect(health[0]!.healthy).toBe(true)
  })

  it('flags a source whose count halved against its median', async () => {
    for (let day = 10; day <= 15; day++) await recordRun(db, okRun('siff', 40, day))
    await recordRun(db, okRun('siff', 5, 16))

    const health = await evaluateHealth(db, ['siff'], { now: JUST_AFTER })
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

    const health = await evaluateHealth(db, ['cinemark'], { now: JUST_AFTER })
    expect(health[0]!.healthy).toBe(false)
    expect(health[0]!.reason).toContain('failed')
  })

  it('exempts seattle-magic from the count check', async () => {
    for (let day = 10; day <= 15; day++) await recordRun(db, okRun('seattle-magic', 3, day))
    await recordRun(db, okRun('seattle-magic', 0, 16))

    const health = await evaluateHealth(db, ['seattle-magic'], { now: JUST_AFTER })
    expect(health[0]!.healthy).toBe(true)
  })

  it('reports a source that has never run as unhealthy', async () => {
    const health = await evaluateHealth(db, ['siff'], { now: JUST_AFTER })
    expect(health[0]!.healthy).toBe(false)
    expect(health[0]!.reason).toContain('never run')
  })
})

describe('evaluateHealth staleness', () => {
  const NOW = new Date('2026-08-30T03:30:00Z')

  const runAt = (source: string, iso: string, over: Partial<Parameters<typeof recordRun>[1]> = {}) =>
    recordRun(db, {
      source,
      startedAt: new Date(iso),
      finishedAt: new Date(iso),
      status: 'ok',
      itemCount: 40,
      ...over,
    })

  it('flags a source that has not run in a week, even though its last run succeeded', async () => {
    // The live failure: AMC_API_KEY went missing, the adapter stopped being
    // built, and no sweep ran for seven days. The last run on record was a
    // success, so the health view stayed green while two venues went dark.
    await runAt('amc', '2026-08-22T09:30:00Z', { itemCount: 1262 })

    const health = await evaluateHealth(db, ['amc'], { now: NOW })
    expect(health[0]!.healthy).toBe(false)
    expect(health[0]!.reason).toBe('stale: last ran 7 days ago')
  })

  it('stays healthy inside the threshold', async () => {
    for (const day of [27, 28, 29]) await runAt('siff', `2026-08-${day}T03:00:00Z`)
    await runAt('siff', '2026-08-30T03:23:53Z')

    const health = await evaluateHealth(db, ['siff'], { now: NOW })
    expect(health[0]!.healthy).toBe(true)
    expect(health[0]!.reason).toBeUndefined()
  })

  it('holds at exactly twelve hours and flags just past it', async () => {
    await runAt('siff', '2026-08-29T15:30:00Z')
    expect((await evaluateHealth(db, ['siff'], { now: NOW }))[0]!.healthy).toBe(true)

    await runAt('cinemark', '2026-08-29T15:29:00Z')
    const stale = (await evaluateHealth(db, ['cinemark'], { now: NOW }))[0]!
    expect(stale.healthy).toBe(false)
    expect(stale.reason).toBe('stale: last ran 12 hours ago')
  })

  it('counts a source exempt from the count check as stale all the same', async () => {
    // seattle-magic is allowed to report zero events. It is not allowed to
    // stop reporting: the exemption is about the count, not about silence.
    await runAt('seattle-magic', '2026-08-28T03:26:00Z', { itemCount: 1 })

    const health = await evaluateHealth(db, ['seattle-magic'], { now: NOW })
    expect(health[0]!.healthy).toBe(false)
    expect(health[0]!.reason).toBe('stale: last ran 2 days ago')
  })

  it('reports the failure rather than the staleness when an old run also failed', async () => {
    // Reason order is never-run, failed, stale, count-drop. Why it stopped is
    // more actionable than how long it has been stopped.
    await runAt('cinemark', '2026-08-22T09:00:00Z', {
      status: 'failed',
      itemCount: 0,
      error: 'GET https://www.cinemark.com/... failed: 503',
    })

    const health = await evaluateHealth(db, ['cinemark'], { now: NOW })
    expect(health[0]!.reason).toBe(
      'last run failed: GET https://www.cinemark.com/... failed: 503',
    )
  })

  it('reports staleness rather than a count drop when both are true', async () => {
    for (const day of [18, 19, 20, 21]) await runAt('siff', `2026-08-${day}T03:00:00Z`)
    await runAt('siff', '2026-08-22T03:00:00Z', { itemCount: 2 })

    const health = await evaluateHealth(db, ['siff'], { now: NOW })
    expect(health[0]!.reason).toBe('stale: last ran 8 days ago')
  })

  it('says one day in the singular', async () => {
    await runAt('siff', '2026-08-29T02:30:00Z')
    expect((await evaluateHealth(db, ['siff'], { now: NOW }))[0]!.reason).toBe(
      'stale: last ran 1 day ago',
    )
  })

  it('defaults to the wall clock when no now is given', async () => {
    await runAt('amc', '2026-08-22T09:30:00Z')
    const health = await evaluateHealth(db, ['amc'])
    expect(health[0]!.healthy).toBe(false)
    expect(health[0]!.reason).toMatch(/^stale: last ran /)
  })
})
