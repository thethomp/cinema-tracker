import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, fetchAgenda, fetchHighlights, recordVisit } from '../../web/src/api'

type FetchArgs = [input: string | URL | Request, init?: RequestInit]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchHighlights', () => {
  it('asks for the window it was given and returns the entries', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) =>
      jsonResponse({ window: {}, limit: 40, entries: [{ title: 'The Odyssey' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const entries = await fetchHighlights({ days: 21, limit: 12 })

    expect(entries).toHaveLength(1)
    expect(entries[0]!.title).toBe('The Odyssey')
    const url = String(fetchMock.mock.calls[0]![0])
    expect(url).toBe('/api/highlights?days=21&limit=12')
  })

  it('surfaces the server error message rather than a bare status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: "'to' is before 'from'" }, 400)))

    await expect(fetchHighlights({})).rejects.toThrowError(
      /GET \/api\/highlights failed \(400\): 'to' is before 'from'/,
    )
  })

  it('still reports a status when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>gateway</html>', { status: 502 })),
    )

    const error = await fetchHighlights({}).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(502)
    expect((error as ApiError).message).toContain('502')
  })

  it('reports a dead server as a connection failure, not as a hang', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    const error = await fetchHighlights({}).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(0)
    expect((error as ApiError).message).toMatch(/could not reach the API/i)
  })
})

describe('fetchAgenda', () => {
  it('omits absent bounds instead of sending empty parameters', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => jsonResponse({ window: {}, days: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchAgenda({})
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/agenda')

    await fetchAgenda({ from: '2026-08-22', to: '2026-09-05' })
    expect(String(fetchMock.mock.calls[1]![0])).toBe('/api/agenda?from=2026-08-22&to=2026-09-05')
  })

  it('returns the day groups', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ window: {}, days: [{ date: '2026-08-22', entries: [] }] })),
    )
    const days = await fetchAgenda({})
    expect(days).toEqual([{ date: '2026-08-22', entries: [] }])
  })
})

describe('recordVisit', () => {
  it('POSTs and hands back the previous timestamp', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) =>
      jsonResponse({ previous: '2026-08-20T01:00:00.000Z', current: '2026-08-22T18:00:00.000Z' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await recordVisit()
    expect(result.previous).toBe('2026-08-20T01:00:00.000Z')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' })
  })
})
