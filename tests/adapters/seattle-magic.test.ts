import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  parseSeattleMagicScreenings,
  SEATTLE_MAGIC_VENUE,
} from '../../src/adapters/seattle-magic.js'

const html = readFileSync('tests/fixtures/seattle-magic-events.html', 'utf8')

describe('parseSeattleMagicScreenings', () => {
  it('returns an empty array when no events are listed', () => {
    expect(parseSeattleMagicScreenings(html)).toEqual([])
  })

  it('does not throw on the empty page', () => {
    expect(() => parseSeattleMagicScreenings(html)).not.toThrow()
  })

  it('parses an event card when one is present', () => {
    const withEvent = `
      <div class="event" data-event-id="abc123">
        <h3 class="event-title">Midnight Illusions</h3>
        <time datetime="2026-09-12T20:00:00">Sep 12, 8:00 PM</time>
        <a class="event-link" href="/events/midnight-illusions">Tickets</a>
      </div>`
    const [screening] = parseSeattleMagicScreenings(withEvent)

    expect(screening!.rawTitle).toBe('Midnight Illusions')
    expect(screening!.venueId).toBe(SEATTLE_MAGIC_VENUE.id)
    expect(screening!.localDate).toBe('2026-09-12')
    expect(screening!.startsAt.toISOString()).toBe('2026-09-13T03:00:00.000Z')
    expect(screening!.ticketUrl).toBe(
      'https://seattlemagictheater.com/events/midnight-illusions',
    )
  })

  it('falls back to a stable id derived from title and time', () => {
    const noId = `
      <div class="event">
        <h3 class="event-title">Close-Up Night</h3>
        <time datetime="2026-09-20T19:30:00">Sep 20</time>
      </div>`
    const [screening] = parseSeattleMagicScreenings(noId)
    expect(screening!.sourceScreeningId).toBe('close-up-night@2026-09-20T19:30:00')
  })
})
