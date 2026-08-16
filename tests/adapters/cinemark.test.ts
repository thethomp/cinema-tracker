import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseCinemarkScreenings, CINEMARK_VENUES } from '../../src/adapters/cinemark.js'

const html = readFileSync('tests/fixtures/cinemark-lincoln-square.html', 'utf8')
const venue = CINEMARK_VENUES.find((v) => v.id === 'cinemark-lincoln-square')!

describe('parseCinemarkScreenings', () => {
  const screenings = parseCinemarkScreenings(html, venue)

  it('extracts screenings from the fixture', () => {
    expect(screenings.length).toBeGreaterThan(10)
  })

  it('reads the start time from the href, not the link text', () => {
    const first = screenings[0]!
    expect(first.startsAt.toISOString()).toMatch(/^2026-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/)
    expect(first.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('uses the Cinemark ShowtimeId as the source id', () => {
    expect(screenings[0]!.sourceScreeningId).toMatch(/^\d+$/)
  })

  it('builds an absolute ticket url', () => {
    expect(screenings[0]!.ticketUrl).toMatch(/^https:\/\/www\.cinemark\.com\/TicketSeatMap/)
  })

  it('skips past showtimes that have no booking link', () => {
    expect(html).toContain('off past')
    for (const screening of screenings) {
      expect(screening.ticketUrl).toContain('ShowtimeId=')
    }
  })

  it('captures the auditorium format as a hint', () => {
    const hints = new Set(screenings.flatMap((s) => s.formatHints))
    expect(hints.size).toBeGreaterThan(0)
  })

  it('attaches the film title to every screening', () => {
    for (const screening of screenings) {
      expect(screening.rawTitle.length).toBeGreaterThan(0)
    }
  })

  it('produces unique source screening ids', () => {
    const ids = screenings.map((s) => s.sourceScreeningId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
