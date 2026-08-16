import { describe, it, expect } from 'vitest'
import { localWallClockToUtc, localDateOf } from '../../src/core/time.js'

const LA = 'America/Los_Angeles'

describe('localWallClockToUtc', () => {
  it('interprets a zoneless timestamp in the venue timezone', () => {
    // 9:50am PDT on 2026-08-16 is 16:50 UTC.
    const result = localWallClockToUtc('2026-08-16T09:50:00', LA)
    expect(result.toISOString()).toBe('2026-08-16T16:50:00.000Z')
  })

  it('handles a winter date at the other UTC offset', () => {
    // 9:50am PST on 2026-01-15 is 17:50 UTC.
    const result = localWallClockToUtc('2026-01-15T09:50:00', LA)
    expect(result.toISOString()).toBe('2026-01-15T17:50:00.000Z')
  })
})

describe('localDateOf', () => {
  it('returns the venue-local calendar date', () => {
    const instant = new Date('2026-08-16T16:50:00.000Z')
    expect(localDateOf(instant, LA)).toBe('2026-08-16')
  })

  it('keeps a late-evening screening on its own local date', () => {
    // 11:45pm PDT on 2026-08-16 is already 2026-08-17 in UTC.
    const instant = new Date('2026-08-17T06:45:00.000Z')
    expect(localDateOf(instant, LA)).toBe('2026-08-16')
  })
})
