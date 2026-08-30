import { describe, it, expect } from 'vitest'
import { getHealth } from '../../src/read/health.js'
import { recordRun } from '../../src/store/runs.js'
import { NOW, addScreenings, emptyDb } from './fixture.js'

const AT = (iso: string): Date => new Date(iso)

describe('getHealth', () => {
  it('reports every known source as never run on a fresh database', async () => {
    const { db, close } = await emptyDb()
    try {
      const health = await getHealth(db, { now: NOW })
      expect(health.sources.map((s) => s.source)).toEqual([
        'amc',
        'cinemark',
        'seattle-magic',
        'siff',
      ])
      // Silence must not read as health: a source that has never run is not OK.
      expect(health.sources.every((s) => s.healthy === false)).toBe(true)
      expect(health.sources[0]!.reason).toBe('never run')
      expect(health.sources[0]!.lastRunAt).toBeNull()
      expect(health.sources[0]!.lastStatus).toBeNull()
      expect(health.healthy).toBe(false)
      expect(health.unresolvedTitles).toBe(0)
      expect(health.unresolvedScreenings).toBe(0)
    } finally {
      close()
    }
  })

  it('carries per-source status and the last run time', async () => {
    const { db, close } = await emptyDb()
    try {
      for (const source of ['siff', 'cinemark', 'seattle-magic', 'amc']) {
        await recordRun(db, {
          source,
          startedAt: AT('2026-08-22T14:00:00Z'),
          finishedAt: AT('2026-08-22T14:02:00Z'),
          status: 'ok',
          itemCount: 400,
        })
      }
      await recordRun(db, {
        source: 'cinemark',
        startedAt: AT('2026-08-22T16:00:00Z'),
        finishedAt: AT('2026-08-22T16:00:05Z'),
        status: 'failed',
        itemCount: 0,
        error: 'GET https://www.cinemark.com/... failed: 503',
      })

      const health = await getHealth(db, { now: NOW })
      const byName = new Map(health.sources.map((s) => [s.source, s]))

      expect(byName.get('siff')!.healthy).toBe(true)
      expect(byName.get('siff')!.lastRunAt).toBe('2026-08-22T14:00:00.000Z')
      expect(byName.get('siff')!.lastStatus).toBe('ok')
      expect(byName.get('siff')!.itemCount).toBe(400)

      expect(byName.get('cinemark')!.healthy).toBe(false)
      expect(byName.get('cinemark')!.reason).toBe(
        'last run failed: GET https://www.cinemark.com/... failed: 503',
      )
      expect(byName.get('cinemark')!.lastRunAt).toBe('2026-08-22T16:00:00.000Z')
      expect(byName.get('cinemark')!.lastStatus).toBe('failed')

      expect(health.healthy).toBe(false)
      expect(health.lastRunAt).toBe('2026-08-22T16:00:00.000Z')
    } finally {
      close()
    }
  })

  it('includes a source that only appears in source_runs', async () => {
    const { db, close } = await emptyDb()
    try {
      await recordRun(db, {
        source: 'letterboxd',
        startedAt: AT('2026-08-22T14:00:00Z'),
        finishedAt: AT('2026-08-22T14:00:10Z'),
        status: 'ok',
        itemCount: 285,
      })
      const health = await getHealth(db, { now: NOW })
      expect(health.sources.map((s) => s.source)).toContain('letterboxd')
      expect(health.sources.find((s) => s.source === 'letterboxd')!.healthy).toBe(true)
    } finally {
      close()
    }
  })

  it('reports a source that has stopped running as unhealthy, not as its last success', async () => {
    /*
     * The live failure this check exists for. AMC last swept successfully on
     * the 22nd and then its key went missing, so nothing ran for a week. Every
     * other check here reads a successful run and says "fine"; only asking
     * *when* it ran tells the truth, and the reason has to carry the interval
     * or the reader cannot tell a blip from an outage.
     */
    const { db, close } = await emptyDb()
    try {
      await recordRun(db, {
        source: 'amc',
        startedAt: AT('2026-08-15T18:00:00Z'),
        finishedAt: AT('2026-08-15T18:04:00Z'),
        status: 'ok',
        itemCount: 1262,
      })

      const health = await getHealth(db, { now: NOW })
      const amc = health.sources.find((s) => s.source === 'amc')!
      expect(amc.healthy).toBe(false)
      expect(amc.reason).toBe('stale: last ran 7 days ago')
      // The successful run is still reported -- the reader needs to see both.
      expect(amc.lastStatus).toBe('ok')
      expect(amc.itemCount).toBe(1262)
      expect(health.healthy).toBe(false)
    } finally {
      close()
    }
  })

  it('counts unresolved future titles, not every row ever swept', async () => {
    const { db, close } = await emptyDb()
    try {
      await addScreenings(db, [
        // Two showtimes of one unresolved title: one title, two screenings.
        {
          rawTitle: 'Amok Time + Star Trek III',
          venueId: 'amc-alderwood',
          startsAt: '2026-09-06T23:00:00Z',
          localDate: '2026-09-06',
        },
        {
          rawTitle: 'Amok Time + Star Trek III',
          venueId: 'amc-alderwood',
          startsAt: '2026-09-07T23:00:00Z',
          localDate: '2026-09-07',
        },
        {
          rawTitle: 'The Changeling + Star Trek: The Motion Picture',
          venueId: 'cinemark-lincoln-square',
          startsAt: '2026-09-04T23:00:00Z',
          localDate: '2026-09-04',
        },
        // Past, cancelled, and resolved rows must not inflate the count.
        {
          rawTitle: 'Long Gone',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-01T02:00:00Z',
          localDate: '2026-07-31',
        },
        {
          rawTitle: 'Dropped From The Listing',
          venueId: 'amc-alderwood',
          startsAt: '2026-09-04T23:00:00Z',
          localDate: '2026-09-04',
          cancelled: true,
        },
      ])

      const health = await getHealth(db, { now: NOW })
      expect(health.unresolvedTitles).toBe(2)
      expect(health.unresolvedScreenings).toBe(3)
    } finally {
      close()
    }
  })
  it('expects the sources the caller names, on top of the ones it already knows', async () => {
    // `serve.ts` builds the adapters and knows which ones this process is
    // actually configured to run. An adapter added to the codebase but never
    // swept leaves no rows in `source_runs`, so without being told about it
    // the report would omit it entirely -- invisible rather than unhealthy.
    const { db, close } = await emptyDb()
    try {
      const health = await getHealth(db, { now: NOW, sources: ['grand-illusion'] })
      expect(health.sources.map((s) => s.source)).toEqual([
        'amc',
        'cinemark',
        'grand-illusion',
        'seattle-magic',
        'siff',
      ])
      expect(health.sources.find((s) => s.source === 'grand-illusion')).toMatchObject({
        healthy: false,
        reason: 'never run',
      })
    } finally {
      close()
    }
  })

  it('keeps a known source listed even when the caller does not name it', async () => {
    // The reverse hazard. If AMC_API_KEY goes missing the adapter is not
    // built, and a report that only listed the live adapters would quietly
    // drop AMC instead of reporting it as not running -- a misconfiguration
    // hidden by the very view meant to surface it.
    const { db, close } = await emptyDb()
    try {
      const health = await getHealth(db, { now: NOW, sources: ['siff'] })
      expect(health.sources.map((s) => s.source)).toContain('amc')
    } finally {
      close()
    }
  })
})
