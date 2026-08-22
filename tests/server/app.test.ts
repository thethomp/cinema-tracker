import { describe, it, expect } from 'vitest'
import { createApp } from '../../src/server/app.js'
import type { Db } from '../../src/db/client.js'
import { addOdysseyFilm, addScreenings, emptyDb, NOW } from '../read/fixture.js'
import { appState } from '../../src/db/schema.js'
import { recordRun } from '../../src/store/runs.js'

const now = (): Date => NOW

async function appWithData(): Promise<{ db: Db; app: ReturnType<typeof createApp>; close: () => void }> {
  const { db, close } = await emptyDb()
  await addOdysseyFilm(db)
  await addScreenings(db, [
    {
      rawTitle: 'The Odyssey (70mm)',
      venueId: 'siff-uptown',
      filmId: 1,
      startsAt: '2026-08-23T02:00:00Z',
      localDate: '2026-08-22',
      score: 95,
      tags: ['70MM'],
      reasons: [{ signal: 'special-event', detail: '70MM', weight: 50 }],
    },
    {
      rawTitle: 'The Odyssey',
      venueId: 'amc-alderwood',
      filmId: 1,
      startsAt: '2026-08-24T02:00:00Z',
      localDate: '2026-08-23',
      score: 45,
    },
    {
      rawTitle: 'PAW Patrol: The Dino Movie',
      venueId: 'amc-alderwood',
      startsAt: '2026-08-24T03:00:00Z',
      localDate: '2026-08-23',
      score: 0,
    },
    {
      // 40 days out: inside a 90-day window, outside the default 14-day one.
      rawTitle: 'Far Future Horror',
      venueId: 'amc-alderwood',
      startsAt: '2026-10-01T02:00:00Z',
      localDate: '2026-09-30',
      score: 60,
    },
  ])
  return { db, app: createApp(db, { now }), close }
}

describe('GET /api/highlights', () => {
  it('returns grouped entries and the window it used', async () => {
    const { app, close } = await appWithData()
    try {
      const res = await app.request('/api/highlights')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')

      const body = await res.json()
      expect(body.window).toEqual({
        from: '2026-08-22T18:00:00.000Z',
        to: '2026-09-05T18:00:00.000Z',
        days: 14,
      })
      expect(body.limit).toBe(40)
      expect(body.entries).toHaveLength(1)
      expect(body.entries[0].title).toBe('The Odyssey')
      expect(body.entries[0].score).toBe(95)
      expect(body.entries[0].showtimes).toHaveLength(2)
      expect(body.entries[0].venues.map((v: { id: string }) => v.id)).toEqual([
        'siff-uptown',
        'amc-alderwood',
      ])
      expect(body.entries[0].isNew).toBe(false)
    } finally {
      close()
    }
  })

  it('honours days and limit', async () => {
    const { app, close } = await appWithData()
    try {
      const body = await (await app.request('/api/highlights?days=60&limit=1')).json()
      expect(body.window.days).toBe(60)
      expect(body.window.to).toBe('2026-10-21T18:00:00.000Z')
      expect(body.limit).toBe(1)
      expect(body.entries).toHaveLength(1)

      const wide = await (await app.request('/api/highlights?days=60')).json()
      expect(wide.entries.map((e: { title: string }) => e.title)).toEqual([
        'The Odyssey',
        'Far Future Horror',
      ])
    } finally {
      close()
    }
  })

  it('clamps a negative or absurd days and limit instead of passing them through', async () => {
    const { app, close } = await appWithData()
    try {
      const cases: [string, number, number][] = [
        ['days=-5&limit=-10', 1, 1],
        ['days=0&limit=0', 1, 1],
        ['days=99999&limit=100000', 90, 200],
        ['days=1e9&limit=1e9', 90, 200],
      ]
      for (const [query, days, limit] of cases) {
        const res = await app.request(`/api/highlights?${query}`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect([query, body.window.days, body.limit]).toEqual([query, days, limit])
      }
    } finally {
      close()
    }
  })

  it('falls back to the defaults for junk it cannot parse', async () => {
    const { app, close } = await appWithData()
    try {
      const body = await (await app.request('/api/highlights?days=soon&limit=lots')).json()
      expect(body.window.days).toBe(14)
      expect(body.limit).toBe(40)

      const empty = await (await app.request('/api/highlights?days=&limit=')).json()
      expect(empty.window.days).toBe(14)
      expect(empty.limit).toBe(40)
    } finally {
      close()
    }
  })

  it('returns an empty list, not an error, when nothing clears the threshold', async () => {
    const { db, close } = await emptyDb()
    try {
      const res = await createApp(db, { now }).request('/api/highlights')
      expect(res.status).toBe(200)
      expect((await res.json()).entries).toEqual([])
    } finally {
      close()
    }
  })
})

describe('GET /api/agenda', () => {
  it('defaults to a fortnight of days, each with grouped entries', async () => {
    const { app, close } = await appWithData()
    try {
      const res = await app.request('/api/agenda')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.days.map((d: { date: string }) => d.date)).toEqual(['2026-08-22', '2026-08-23'])
      expect(body.days[1].entries.map((e: { title: string }) => e.title)).toEqual([
        'The Odyssey',
        'PAW Patrol: The Dino Movie',
      ])
    } finally {
      close()
    }
  })

  it('accepts an explicit local date range', async () => {
    const { app, close } = await appWithData()
    try {
      const body = await (await app.request('/api/agenda?from=2026-09-29&to=2026-10-01')).json()
      // Local dates in the venue timezone, so a 7pm Seattle showtime on the
      // 30th stays on the 30th rather than sliding to the 1st in UTC.
      expect(body.window.from).toBe('2026-09-29T07:00:00.000Z')
      expect(body.window.to).toBe('2026-10-02T06:59:59.999Z')
      expect(body.days.map((d: { date: string }) => d.date)).toEqual(['2026-09-30'])
    } finally {
      close()
    }
  })

  it('never serves screenings that have already started, even for today', async () => {
    const { app, close } = await appWithData()
    try {
      // Midnight local on the 22nd is well before `now`; the window start must
      // be pulled forward to now, or this morning's showtimes come back.
      const body = await (await app.request('/api/agenda?from=2026-08-22&to=2026-08-22')).json()
      expect(body.window.from).toBe('2026-08-22T18:00:00.000Z')
    } finally {
      close()
    }
  })

  it('rejects an unparseable date with 400 and a JSON error', async () => {
    const { app, close } = await appWithData()
    try {
      const res = await app.request('/api/agenda?from=last-tuesday')
      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect((await res.json()).error).toContain('from')
    } finally {
      close()
    }
  })

  it('clamps a range longer than the maximum window', async () => {
    const { app, close } = await appWithData()
    try {
      const body = await (await app.request('/api/agenda?from=2026-08-22&to=2030-01-01')).json()
      expect(body.window.to).toBe('2026-11-20T18:00:00.000Z')
    } finally {
      close()
    }
  })

  it('rejects a range that ends before it starts', async () => {
    const { app, close } = await appWithData()
    try {
      const res = await app.request('/api/agenda?from=2026-09-10&to=2026-09-01')
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('before')
    } finally {
      close()
    }
  })
})

describe('GET /api/health', () => {
  it('reports per-source status and unresolved counts', async () => {
    const { db, app, close } = await appWithData()
    try {
      await recordRun(db, {
        source: 'siff',
        startedAt: new Date('2026-08-22T06:00:00Z'),
        finishedAt: new Date('2026-08-22T06:01:00Z'),
        status: 'ok',
        itemCount: 63,
      })

      const res = await app.request('/api/health')
      expect(res.status).toBe(200)
      const body = await res.json()
      const siff = body.sources.find((s: { source: string }) => s.source === 'siff')
      expect(siff.healthy).toBe(true)
      expect(siff.lastRunAt).toBe('2026-08-22T06:00:00.000Z')
      // amc, cinemark and seattle-magic have never run, so the report is not
      // healthy overall — silence must not read as health.
      expect(body.healthy).toBe(false)
      expect(body.unresolvedTitles).toBe(2)
      expect(body.unresolvedScreenings).toBe(2)
    } finally {
      close()
    }
  })
})

describe('POST /api/visit', () => {
  it('returns the previous timestamp and stores the new one', async () => {
    const { db, app, close } = await appWithData()
    try {
      const first = await app.request('/api/visit', { method: 'POST' })
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({
        previous: null,
        current: '2026-08-22T18:00:00.000Z',
      })

      const stored = await db.select().from(appState)
      expect(stored).toEqual([{ key: 'last_visit_at', value: '2026-08-22T18:00:00.000Z' }])

      const later = createApp(db, { now: () => new Date('2026-08-23T09:00:00Z') })
      expect(await (await later.request('/api/visit', { method: 'POST' })).json()).toEqual({
        previous: '2026-08-22T18:00:00.000Z',
        current: '2026-08-23T09:00:00.000Z',
      })
      const after = await db.select().from(appState)
      expect(after).toHaveLength(1)
      expect(after[0]!.value).toBe('2026-08-23T09:00:00.000Z')
    } finally {
      close()
    }
  })

  it('is not reachable by GET', async () => {
    const { app, close } = await appWithData()
    try {
      expect((await app.request('/api/visit')).status).toBe(404)
    } finally {
      close()
    }
  })
})

describe('GET /api/venues', () => {
  it('lists every seeded venue', async () => {
    const { app, close } = await appWithData()
    try {
      const body = await (await app.request('/api/venues')).json()
      expect(body.venues).toHaveLength(4)
      expect(body.venues[0]).toEqual({
        id: 'amc-alderwood',
        name: 'AMC Alderwood Mall 16',
        chain: 'AMC',
        timezone: 'America/Los_Angeles',
      })
    } finally {
      close()
    }
  })
})

describe('error handling', () => {
  it('answers an unknown route with JSON, not HTML', async () => {
    const { app, close } = await appWithData()
    try {
      const res = await app.request('/api/nope')
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(await res.json()).toEqual({ error: 'Not found', path: '/api/nope' })
    } finally {
      close()
    }
  })

  it('answers a read-model failure with a JSON 500, not an empty body', async () => {
    const broken = new Proxy(
      {},
      {
        get() {
          throw new Error('database connection is not open')
        },
      },
    ) as unknown as Db

    const res = await createApp(broken, { now }).request('/api/highlights')
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error).toBe('Internal error')
    // The message has to survive: a 500 that says nothing is indistinguishable
    // from a source quietly returning nothing, which is the failure mode this
    // project exists to avoid.
    expect(body.message).toContain('database connection is not open')
  })
})
