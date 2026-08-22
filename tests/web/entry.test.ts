import { describe, expect, it } from 'vitest'
import type { EntryShowtime } from '../../web/src/api'
import { splitTags, summarizeShowtimes, venueSummary } from '../../web/src/entry'

function showtime(id: number, localDate: string, hour: number, venueId = 'siff-uptown'): EntryShowtime {
  return {
    id,
    localDate,
    startsAtUtc: `${localDate}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    ticketUrl: `https://example.test/${id}`,
    venueId,
  }
}

describe('splitTags', () => {
  it('stamps only the four formats worth crossing town for', () => {
    const { stamps, chips } = splitTags(['ARTHOUSE', '70MM', 'RE_RELEASE', 'Q_AND_A'])
    expect(stamps).toEqual(['70MM', 'Q & A'])
    expect(chips).toEqual(['ARTHOUSE', 'RE-RELEASE'])
  })

  it('does not stamp ANNIVERSARY, which is a marketing line and not a print', () => {
    const { stamps, chips } = splitTags(['ANNIVERSARY', 'EVENT'])
    expect(stamps).toEqual([])
    expect(chips).toEqual(['ANNIVERSARY', 'EVENT'])
  })

  it('orders stamps by rarity rather than by the order the tags arrived', () => {
    expect(splitTags(['LIVE_SCORE', '35MM']).stamps).toEqual(['35MM', 'LIVE SCORE'])
  })

  it('passes an unknown tag through as a chip rather than dropping it', () => {
    expect(splitTags(['SOMETHING_NEW']).chips).toEqual(['SOMETHING NEW'])
  })
})

describe('summarizeShowtimes', () => {
  it('keeps a single screening whole', () => {
    const summary = summarizeShowtimes([showtime(1, '2026-08-29', 3)], { maxDays: 2, maxPerDay: 6 })
    expect(summary.days).toHaveLength(1)
    expect(summary.days[0]!.times).toHaveLength(1)
    expect(summary.hiddenCount).toBe(0)
    expect(summary.lastLocalDate).toBe('2026-08-29')
  })

  it('bounds a wide release so it cannot outgrow a one-off print', () => {
    const many: EntryShowtime[] = []
    for (let day = 22; day <= 28; day += 1) {
      for (let hour = 1; hour <= 8; hour += 1) {
        many.push(showtime(day * 100 + hour, `2026-08-${day}`, hour))
      }
    }
    const summary = summarizeShowtimes(many, { maxDays: 2, maxPerDay: 6 })

    expect(summary.days).toHaveLength(2)
    expect(summary.days.every((day) => day.times.length <= 6)).toBe(true)
    expect(summary.total).toBe(56)
    // 56 total, 12 printed.
    expect(summary.hiddenCount).toBe(44)
    expect(summary.lastLocalDate).toBe('2026-08-28')
  })

  it('orders days and times chronologically whatever order the rows arrive in', () => {
    const summary = summarizeShowtimes(
      [showtime(3, '2026-08-30', 5), showtime(1, '2026-08-29', 9), showtime(2, '2026-08-29', 2)],
      { maxDays: 3, maxPerDay: 6 },
    )
    expect(summary.days.map((day) => day.localDate)).toEqual(['2026-08-29', '2026-08-30'])
    expect(summary.days[0]!.times.map((time) => time.id)).toEqual([2, 1])
  })

  it('is empty-safe', () => {
    const summary = summarizeShowtimes([], { maxDays: 2, maxPerDay: 6 })
    expect(summary.days).toEqual([])
    expect(summary.total).toBe(0)
    expect(summary.lastLocalDate).toBeNull()
  })
})

describe('venueSummary', () => {
  it('names venues up to the cap and counts the rest', () => {
    const venues = [
      { id: 'a', name: 'SIFF Cinema Uptown', chain: 'SIFF' },
      { id: 'b', name: 'AMC Pacific Place 11', chain: 'AMC' },
      { id: 'c', name: 'Cinemark Totem Lake', chain: 'Cinemark' },
      { id: 'd', name: 'SIFF Cinema Egyptian', chain: 'SIFF' },
    ]
    expect(venueSummary(venues, 2)).toEqual({
      named: ['SIFF Cinema Uptown', 'AMC Pacific Place 11'],
      extra: 2,
    })
    expect(venueSummary(venues.slice(0, 2), 2)).toEqual({
      named: ['SIFF Cinema Uptown', 'AMC Pacific Place 11'],
      extra: 0,
    })
  })
})
