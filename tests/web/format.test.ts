import { describe, expect, it } from 'vitest'
import {
  formatAgo,
  formatDateRange,
  formatDayNumeral,
  formatLongDate,
  formatMonthLabel,
  formatRuntime,
  formatTime,
  formatWeekday,
  localDateIn,
  relativeDayLabel,
} from '../../web/src/format'

describe('formatTime', () => {
  it('sets a Seattle evening showtime in newspaper-listing style', () => {
    // 2026-08-22 19:15 PDT
    expect(formatTime('2026-08-23T02:15:00.000Z')).toBe('7:15p')
  })

  it('uses 12 for noon and midnight rather than 0', () => {
    expect(formatTime('2026-08-22T19:00:00.000Z')).toBe('12:00p')
    expect(formatTime('2026-08-22T07:30:00.000Z')).toBe('12:30a')
  })

  it('marks morning matinees with a', () => {
    expect(formatTime('2026-08-22T18:05:00.000Z')).toBe('11:05a')
  })
})

describe('localDateIn', () => {
  it('reads the Seattle calendar date, not the UTC one', () => {
    // 23:30 PDT on the 22nd is already the 23rd in UTC.
    expect(localDateIn(new Date('2026-08-23T06:30:00.000Z'))).toBe('2026-08-22')
  })
})

describe('relativeDayLabel', () => {
  it('names today and tomorrow, and dates everything else', () => {
    expect(relativeDayLabel('2026-08-22', '2026-08-22')).toBe('Tonight')
    expect(relativeDayLabel('2026-08-23', '2026-08-22')).toBe('Tomorrow')
    expect(relativeDayLabel('2026-08-29', '2026-08-22')).toBe('Sat 29')
  })
})

describe('formatRuntime', () => {
  it('sets hours and minutes', () => {
    expect(formatRuntime(185)).toBe('3h 05m')
    expect(formatRuntime(97)).toBe('1h 37m')
  })

  it('drops the hour for a short', () => {
    expect(formatRuntime(42)).toBe('42m')
  })

  it('returns null when unknown, so the caller omits the field', () => {
    expect(formatRuntime(undefined)).toBeNull()
    expect(formatRuntime(0)).toBeNull()
  })
})

describe('formatDateRange', () => {
  it('states the year once when both ends share it', () => {
    expect(formatDateRange('2026-08-22', '2026-09-05')).toBe('22 AUG – 05 SEP 2026')
  })

  it('states both years when the range crosses new year', () => {
    expect(formatDateRange('2026-12-28', '2027-01-03')).toBe('28 DEC 2026 – 03 JAN 2027')
  })
})

describe('weekday and month helpers', () => {
  it('reads a plain YYYY-MM-DD without a timezone shift', () => {
    expect(formatWeekday('2026-08-22')).toBe('Sat')
    expect(formatDayNumeral('2026-08-22')).toBe('22')
    expect(formatMonthLabel('2026-08-22')).toBe('AUG')
    expect(formatLongDate('2026-08-22')).toBe('Saturday 22 August')
  })
})

describe('formatAgo', () => {
  const now = new Date('2026-08-22T18:00:00.000Z')

  it('describes freshness in the coarsest useful unit', () => {
    expect(formatAgo('2026-08-22T17:59:30.000Z', now)).toBe('just now')
    expect(formatAgo('2026-08-22T17:48:00.000Z', now)).toBe('12m ago')
    expect(formatAgo('2026-08-22T13:00:00.000Z', now)).toBe('5h ago')
    expect(formatAgo('2026-08-19T18:00:00.000Z', now)).toBe('3d ago')
  })

  it('says so rather than printing NaN when there has never been a run', () => {
    expect(formatAgo(null, now)).toBe('never')
    expect(formatAgo('not a date', now)).toBe('unknown')
  })
})
