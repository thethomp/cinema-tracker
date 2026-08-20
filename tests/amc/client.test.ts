import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { AmcClient } from '../../src/amc/client.js'

const page = readFileSync('tests/fixtures/amc-pacific-place-showtimes.json', 'utf8')

// The parameters are named so `mock.calls` is typed as (url, headers) rather
// than an empty tuple; the stub ignores them and replays pages in order.
function stubFetcher(pages: string[]) {
  let n = 0
  return {
    text: vi.fn(async (_url: string, _headers?: Record<string, string>) =>
      pages[Math.min(n++, pages.length - 1)]!),
  }
}

describe('AmcClient', () => {
  it('sends the vendor key header via the url-less fetcher contract', async () => {
    const fetcher = stubFetcher([page])
    const client = new AmcClient(fetcher as never, 'KEY')

    await client.getShowtimes(880, '2026-08-22')

    expect(fetcher.text).toHaveBeenCalled()
    // The key travels as a header, never as a query parameter: AMC rejects the
    // latter, and a key in a URL would end up in logs.
    expect(fetcher.text.mock.calls[0]![1]).toEqual({ 'X-AMC-Vendor-Key': 'KEY' })
    expect(fetcher.text.mock.calls[0]![0]).not.toContain('KEY')
  })

  it('requests a large page size so a day is not truncated', async () => {
    const fetcher = stubFetcher([page])
    const client = new AmcClient(fetcher as never, 'KEY')

    await client.getShowtimes(880, '2026-08-22')

    expect(fetcher.text.mock.calls[0]![0]).toContain('pageSize=100')
  })

  it('returns every showtime in the fixture', async () => {
    const parsed = JSON.parse(page)
    const fetcher = stubFetcher([page])
    const client = new AmcClient(fetcher as never, 'KEY')

    const showtimes = await client.getShowtimes(880, '2026-08-22')

    expect(showtimes).toHaveLength(parsed._embedded.showtimes.length)
    expect(showtimes.length).toBe(parsed.count)
  })

  it('follows _links.next across pages and concatenates', async () => {
    const parsed = JSON.parse(page)
    const first = JSON.stringify({
      count: 2,
      _embedded: { showtimes: [parsed._embedded.showtimes[0]] },
      _links: { next: { href: 'https://api.amctheatres.com/v2/next-page' } },
    })
    const second = JSON.stringify({
      count: 2,
      _embedded: { showtimes: [parsed._embedded.showtimes[1]] },
      _links: {},
    })
    const fetcher = stubFetcher([first, second])
    const client = new AmcClient(fetcher as never, 'KEY')

    expect(await client.getShowtimes(880, '2026-08-22')).toHaveLength(2)
    expect(fetcher.text).toHaveBeenCalledTimes(2)
    expect(fetcher.text.mock.calls[1]![0]).toBe('https://api.amctheatres.com/v2/next-page')
  })

  it('stops paging at a sane limit rather than looping forever', async () => {
    // A self-referential next link must not hang the sweep.
    const looping = JSON.stringify({
      count: 999,
      _embedded: { showtimes: [JSON.parse(page)._embedded.showtimes[0]] },
      _links: { next: { href: 'https://api.amctheatres.com/v2/loop' } },
    })
    const fetcher = stubFetcher([looping])
    const client = new AmcClient(fetcher as never, 'KEY')

    await client.getShowtimes(880, '2026-08-22')

    expect(fetcher.text.mock.calls.length).toBeLessThanOrEqual(20)
  })

  it('returns an empty list when a day has no showtimes', async () => {
    const empty = JSON.stringify({ count: 0, _embedded: {}, _links: {} })
    const client = new AmcClient(stubFetcher([empty]) as never, 'KEY')

    expect(await client.getShowtimes(880, '2026-08-22')).toEqual([])
  })
})
