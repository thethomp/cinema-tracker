import { describe, it, expect, vi } from 'vitest'
import { TmdbClient } from '../../src/tmdb/client.js'

const SEARCH_RESPONSE = {
  results: [
    {
      id: 671,
      title: "Harry Potter and the Sorcerer's Stone",
      release_date: '2001-11-16',
      original_language: 'en',
      popularity: 88.5,
      poster_path: '/wu.jpg',
      overview: 'A boy learns he is a wizard.',
    },
    {
      id: 999,
      title: 'Harry Potter Retrospective',
      release_date: '2019-01-01',
      original_language: 'en',
      popularity: 1.2,
      poster_path: null,
      overview: 'A documentary.',
    },
  ],
}

const DETAIL_RESPONSE = {
  id: 671,
  title: "Harry Potter and the Sorcerer's Stone",
  release_date: '2001-11-16',
  runtime: 152,
  original_language: 'en',
  genres: [{ id: 12, name: 'Adventure' }, { id: 14, name: 'Fantasy' }],
  poster_path: '/wu.jpg',
  overview: 'A boy learns he is a wizard.',
  credits: { crew: [{ job: 'Director', name: 'Chris Columbus' }] },
  release_dates: {
    results: [
      { iso_3166_1: 'GB', release_dates: [{ release_date: '2001-11-04T00:00:00.000Z' }] },
      { iso_3166_1: 'US', release_dates: [{ release_date: '2001-11-16T00:00:00.000Z' }] },
    ],
  },
}

function stubFetcher(payloads: Record<string, unknown>) {
  return {
    text: vi.fn(async (url: string) => {
      for (const [fragment, payload] of Object.entries(payloads)) {
        if (url.includes(fragment)) return JSON.stringify(payload)
      }
      throw new Error(`unexpected url ${url}`)
    }),
  }
}

describe('TmdbClient', () => {
  it('returns search candidates in response order', async () => {
    const fetcher = stubFetcher({ '/search/movie': SEARCH_RESPONSE })
    const client = new TmdbClient(fetcher as never, 'KEY')

    const results = await client.searchMovies('Harry Potter')

    expect(results.map((r) => r.tmdbId)).toEqual([671, 999])
    expect(results[0]!.year).toBe(2001)
    expect(results[0]!.title).toBe("Harry Potter and the Sorcerer's Stone")
  })

  it('sends the api key and url-encodes the query', async () => {
    const fetcher = stubFetcher({ '/search/movie': SEARCH_RESPONSE })
    const client = new TmdbClient(fetcher as never, 'KEY')

    await client.searchMovies('Deathly Hallows: Part 1')

    const url = fetcher.text.mock.calls[0]![0]
    expect(url).toContain('api_key=KEY')
    expect(url).toContain('Deathly%20Hallows%3A%20Part%201')
  })

  it('passes a year hint when given', async () => {
    const fetcher = stubFetcher({ '/search/movie': SEARCH_RESPONSE })
    const client = new TmdbClient(fetcher as never, 'KEY')

    await client.searchMovies('Harry Potter', 2001)

    expect(fetcher.text.mock.calls[0]![0]).toContain('year=2001')
  })

  it('maps film details including director and US release date', async () => {
    const fetcher = stubFetcher({ '/movie/671': DETAIL_RESPONSE })
    const client = new TmdbClient(fetcher as never, 'KEY')

    const film = await client.getMovie(671)

    expect(film.director).toBe('Chris Columbus')
    expect(film.genres).toEqual(['Adventure', 'Fantasy'])
    expect(film.runtimeMinutes).toBe(152)
    expect(film.usReleaseDate).toBe('2001-11-16')
    expect(film.posterUrl).toBe('https://image.tmdb.org/t/p/w500/wu.jpg')
  })

  it('omits the poster url when TMDB has no poster', async () => {
    const fetcher = stubFetcher({
      '/movie/999': { ...DETAIL_RESPONSE, id: 999, poster_path: null },
    })
    const client = new TmdbClient(fetcher as never, 'KEY')

    expect((await client.getMovie(999)).posterUrl).toBeUndefined()
  })

  it('returns no US release date when none is published', async () => {
    const fetcher = stubFetcher({
      '/movie/671': { ...DETAIL_RESPONSE, release_dates: { results: [] } },
    })
    const client = new TmdbClient(fetcher as never, 'KEY')

    expect((await client.getMovie(671)).usReleaseDate).toBeUndefined()
  })
})
