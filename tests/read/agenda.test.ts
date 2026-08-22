import { describe, it, expect } from 'vitest'
import { getAgenda } from '../../src/read/agenda.js'
import { NOW, addOdysseyFilm, addScreenings, emptyDb, setLastVisit } from './fixture.js'

const WINDOW = { from: NOW, to: new Date('2026-09-30T00:00:00Z') }

describe('getAgenda', () => {
  it('returns an empty list on an empty database', async () => {
    const { db, close } = await emptyDb()
    try {
      expect(await getAgenda(db, WINDOW)).toEqual([])
    } finally {
      close()
    }
  })

  it('groups by local date and then by film within the day', async () => {
    const { db, close } = await emptyDb()
    try {
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
        },
        {
          rawTitle: 'The Odyssey',
          venueId: 'amc-alderwood',
          filmId: 1,
          startsAt: '2026-08-23T04:00:00Z',
          localDate: '2026-08-22',
          score: 45,
        },
        {
          // Earliest showtime of the day, so it leads the day.
          rawTitle: 'PAW Patrol: The Dino Movie',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-23T01:00:00Z',
          localDate: '2026-08-22',
          score: 0,
        },
        {
          rawTitle: 'The Odyssey',
          venueId: 'amc-alderwood',
          filmId: 1,
          startsAt: '2026-08-25T02:00:00Z',
          localDate: '2026-08-24',
          score: 45,
        },
      ])

      const days = await getAgenda(db, WINDOW)

      // 2026-08-23 has nothing, so it is absent rather than an empty panel.
      expect(days.map((d) => d.date)).toEqual(['2026-08-22', '2026-08-24'])

      const first = days[0]!
      expect(first.entries.map((e) => e.title)).toEqual([
        'PAW Patrol: The Dino Movie',
        'The Odyssey',
      ])
      const odyssey = first.entries[1]!
      expect(odyssey.showtimes).toHaveLength(2)
      expect(odyssey.venues.map((v) => v.id)).toEqual(['siff-uptown', 'amc-alderwood'])
      expect(odyssey.score).toBe(95)

      // The 24th carries only its own showtime, not the 22nd's.
      expect(days[1]!.entries).toHaveLength(1)
      expect(days[1]!.entries[0]!.showtimes).toHaveLength(1)
    } finally {
      close()
    }
  })

  it('keeps low-scoring films: the agenda is the full listing, not the feed', async () => {
    const { db, close } = await emptyDb()
    try {
      await addScreenings(db, [
        {
          rawTitle: 'Spider-Man: Brand New Day',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-23T02:00:00Z',
          localDate: '2026-08-22',
          score: -80,
        },
      ])
      const days = await getAgenda(db, WINDOW)
      expect(days).toHaveLength(1)
      expect(days[0]!.entries[0]!.title).toBe('Spider-Man: Brand New Day')
      expect(days[0]!.entries[0]!.score).toBe(-80)
    } finally {
      close()
    }
  })

  it('excludes past and cancelled screenings', async () => {
    const { db, close } = await emptyDb()
    try {
      await addScreenings(db, [
        {
          rawTitle: 'Already Over',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-22T02:00:00Z',
          localDate: '2026-08-21',
          score: 100,
        },
        {
          rawTitle: 'Cancelled',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-25T02:00:00Z',
          localDate: '2026-08-24',
          score: 100,
          cancelled: true,
        },
        {
          rawTitle: 'Still To Come',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-25T03:00:00Z',
          localDate: '2026-08-24',
          score: 100,
        },
      ])
      const days = await getAgenda(db, WINDOW)
      expect(days.map((d) => d.date)).toEqual(['2026-08-24'])
      expect(days[0]!.entries.map((e) => e.title)).toEqual(['Still To Come'])
    } finally {
      close()
    }
  })

  it('carries isNew, false-by-default when no visit is recorded', async () => {
    const { db, close } = await emptyDb()
    try {
      await addScreenings(db, [
        {
          rawTitle: 'Fresh',
          venueId: 'amc-alderwood',
          startsAt: '2026-08-25T02:00:00Z',
          localDate: '2026-08-24',
          firstSeenAt: '2026-08-21T00:00:00Z',
        },
      ])
      expect((await getAgenda(db, WINDOW))[0]!.entries[0]!.isNew).toBe(false)

      await setLastVisit(db, '2026-08-20T00:00:00Z')
      expect((await getAgenda(db, WINDOW))[0]!.entries[0]!.isNew).toBe(true)
    } finally {
      close()
    }
  })
})
