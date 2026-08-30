import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { AmcClient } from '../../src/amc/client.js'
import { HttpError } from '../../src/fetch/fetcher.js'

const page = readFileSync('tests/fixtures/amc-pacific-place-showtimes.json', 'utf8')
/** Recorded live: GET /v2/theatres/880/showtimes/2026-09-18 on 2026-08-30. */
const noShowtimes404 = readFileSync('tests/fixtures/amc-no-showtimes-404.json', 'utf8')

/** A fetcher that fails every call the way `Fetcher` does. */
function throwingFetcher(status: number, body: string) {
  return {
    text: vi.fn(async (url: string, _headers?: Record<string, string>) => {
      throw new HttpError(status, url, body)
    }),
  }
}

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

describe('AmcClient 404 handling', () => {
  /*
   * Verified against the live API on 2026-08-30, because this is precisely the
   * distinction the repo keeps getting burned by. Theatre 880:
   *
   *   2026-09-17  200, 10 showtimes
   *   2026-09-18  404, {"errors":[{"code":5217,"exceptionMessage":"No showtimes found."}]}
   *   2026-09-19  404, same
   *   2026-09-25  200, 3 showtimes
   *
   * So a 404 is not the end of the publishing window -- there is real data
   * after it. It is a day with nothing scheduled. Meanwhile a bad theatre id
   * returns 404 too, with code 5108 "Theatre 999999 not found.", and a
   * malformed date returns 404 with an empty body.
   */
  it('treats a 404 carrying AMC error code 5217 as a day with no showtimes', async () => {
    const client = new AmcClient(throwingFetcher(404, noShowtimes404) as never, 'KEY')
    expect(await client.getShowtimes(880, '2026-09-18')).toEqual([])
  })

  it('still throws on a 404 that means the theatre does not exist', async () => {
    // The trap this guard exists for. A mistyped theatre id would otherwise
    // sweep as "no showtimes" every day, forever, and read as healthy.
    const body = JSON.stringify({
      errors: [{ code: 5108, exceptionMessage: 'Theatre 999999 not found.' }],
    })
    const client = new AmcClient(throwingFetcher(404, body) as never, 'KEY')
    await expect(client.getShowtimes(999999, '2026-08-30')).rejects.toThrow('404')
  })

  it('still throws on a 404 with an empty body', async () => {
    // What a malformed date returns. Nothing says "no showtimes", so nothing
    // may be assumed.
    const client = new AmcClient(throwingFetcher(404, '') as never, 'KEY')
    await expect(client.getShowtimes(880, 'not-a-date')).rejects.toThrow('404')
  })

  it('still throws on a 404 whose body is not JSON', async () => {
    const client = new AmcClient(throwingFetcher(404, '<html>Not Found</html>') as never, 'KEY')
    await expect(client.getShowtimes(880, '2026-08-30')).rejects.toThrow('404')
  })

  it('does not swallow any other status', async () => {
    const body = JSON.stringify({ errors: [{ code: 5217, exceptionMessage: 'No showtimes found.' }] })
    const client = new AmcClient(throwingFetcher(403, body) as never, 'KEY')
    await expect(client.getShowtimes(880, '2026-08-30')).rejects.toThrow('403')
  })

  it('keeps the pages it already collected when a later page 404s', async () => {
    // Paging is per day, so a 404 on page two is not "no showtimes" for the
    // day -- page one already proved otherwise. It must still throw.
    const parsed = JSON.parse(page)
    const first = JSON.stringify({
      count: 2,
      _embedded: { showtimes: [parsed._embedded.showtimes[0]] },
      _links: { next: { href: 'https://api.amctheatres.com/v2/next-page' } },
    })
    let call = 0
    const fetcher = {
      text: vi.fn(async (url: string) => {
        call += 1
        if (call === 1) return first
        throw new HttpError(404, url, noShowtimes404)
      }),
    }
    const client = new AmcClient(fetcher as never, 'KEY')
    await expect(client.getShowtimes(880, '2026-08-30')).rejects.toThrow('404')
  })
})
