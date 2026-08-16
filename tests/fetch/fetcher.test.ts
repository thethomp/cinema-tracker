import { describe, it, expect, vi } from 'vitest'
import { Fetcher } from '../../src/fetch/fetcher.js'

describe('Fetcher', () => {
  it('sends a descriptive user agent', async () => {
    const calls: RequestInit[] = []
    const impl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init)
      return new Response('ok', { status: 200 })
    })
    const fetcher = new Fetcher({ minIntervalMs: 0, fetchImpl: impl as never })

    await fetcher.text('https://example.com/a')

    const headers = calls[0]!.headers as Record<string, string>
    expect(headers['User-Agent']).toContain('cinema-tracker')
  })

  it('spaces requests to the same host by the minimum interval', async () => {
    const times: number[] = []
    const impl = vi.fn(async () => {
      times.push(Date.now())
      return new Response('ok', { status: 200 })
    })
    const fetcher = new Fetcher({ minIntervalMs: 50, fetchImpl: impl as never })

    await fetcher.text('https://example.com/a')
    await fetcher.text('https://example.com/b')

    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(45)
  })

  it('does not delay requests to different hosts', async () => {
    const times: number[] = []
    const impl = vi.fn(async () => {
      times.push(Date.now())
      return new Response('ok', { status: 200 })
    })
    const fetcher = new Fetcher({ minIntervalMs: 200, fetchImpl: impl as never })

    await fetcher.text('https://one.example.com/a')
    await fetcher.text('https://two.example.com/a')

    expect(times[1]! - times[0]!).toBeLessThan(150)
  })

  it('retries a 503 and succeeds', async () => {
    let n = 0
    const impl = vi.fn(async () => {
      n += 1
      return n === 1
        ? new Response('busy', { status: 503 })
        : new Response('good', { status: 200 })
    })
    const fetcher = new Fetcher({ minIntervalMs: 0, retryDelayMs: 1, fetchImpl: impl as never })

    expect(await fetcher.text('https://example.com/a')).toBe('good')
    expect(n).toBe(2)
  })

  it('throws on a persistent 404 without retrying', async () => {
    const impl = vi.fn(async () => new Response('gone', { status: 404 }))
    const fetcher = new Fetcher({ minIntervalMs: 0, retryDelayMs: 1, fetchImpl: impl as never })

    await expect(fetcher.text('https://example.com/a')).rejects.toThrow('404')
    expect(impl).toHaveBeenCalledTimes(1)
  })

  // The default transport is node:https-backed because undici is blocked by
  // some venue sites. Exercising it for real would mean a network call, so we
  // only assert the wiring: a no-option Fetcher is usable, and injection still
  // wins over the default.
  it('is usable with no options', () => {
    const fetcher = new Fetcher()
    expect(typeof fetcher.text).toBe('function')
  })

  it('prefers an injected fetch impl over the default transport', async () => {
    const impl = vi.fn(async () => new Response('injected', { status: 200 }))
    const fetcher = new Fetcher({ minIntervalMs: 0, fetchImpl: impl as never })

    expect(await fetcher.text('https://example.com/a')).toBe('injected')
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('honors a numeric Retry-After header on a 429', async () => {
    let n = 0
    const impl = vi.fn(async () => {
      n += 1
      return n === 1
        ? new Response('slow', { status: 429, headers: { 'Retry-After': '1' } })
        : new Response('ok', { status: 200 })
    })
    const fetcher = new Fetcher({ minIntervalMs: 0, retryDelayMs: 1, fetchImpl: impl as never })

    const start = Date.now()
    const result = await fetcher.text('https://example.com/a')
    const elapsed = Date.now() - start

    expect(result).toBe('ok')
    expect(elapsed).toBeGreaterThanOrEqual(950)
    expect(n).toBe(2)
  })

  it('falls back to exponential backoff when Retry-After is not numeric', async () => {
    let n = 0
    const impl = vi.fn(async () => {
      n += 1
      return n === 1
        ? new Response('slow', {
            status: 429,
            headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
          })
        : new Response('ok', { status: 200 })
    })
    const fetcher = new Fetcher({ minIntervalMs: 0, retryDelayMs: 5, fetchImpl: impl as never })

    const result = await fetcher.text('https://example.com/a')

    expect(result).toBe('ok')
    expect(n).toBe(2)
  })
})
