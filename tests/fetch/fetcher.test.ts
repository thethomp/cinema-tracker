import { describe, it, expect, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Fetcher } from '../../src/fetch/fetcher.js'

/** Stand up a throwaway loopback server so the default transport is exercised. */
async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}/` }
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

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

  // The default transport is node:http/https-backed because undici is blocked
  // by some venue sites. Here we assert only the wiring — a no-option Fetcher
  // is usable, and injection still wins over the default. The transport's own
  // behaviour is exercised against a local server further down.
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

  it('retries up to four times before giving up', async () => {
    const impl = vi.fn(async () => new Response('busy', { status: 503 }))
    const fetcher = new Fetcher({ minIntervalMs: 0, retryDelayMs: 1, fetchImpl: impl as never })

    await expect(fetcher.text('https://example.com/a')).rejects.toThrow('503')
    // One initial attempt plus the default four retries.
    expect(impl).toHaveBeenCalledTimes(5)
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

// The tests above inject a `fetchImpl`, so they say nothing about the transport
// the app actually runs. These drive the *default* transport against a local
// server: if response headers are dropped on the way out of node:http, the
// honored Retry-After delay disappears and the elapsed-time assertion fails.
describe('Fetcher default transport', () => {
  it('propagates response headers, so Retry-After is honored', async () => {
    let hits = 0
    const { server, url } = await listen((_req, res) => {
      hits += 1
      if (hits === 1) {
        res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'text/plain' })
        res.end('slow down')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })

    try {
      const fetcher = new Fetcher({ minIntervalMs: 0, retryDelayMs: 1 })
      const start = Date.now()
      const body = await fetcher.text(url)
      const elapsed = Date.now() - start

      expect(body).toBe('ok')
      expect(hits).toBe(2)
      // retryDelayMs is 1ms, so anything near a second can only have come from
      // the Retry-After header surviving the transport.
      expect(elapsed).toBeGreaterThanOrEqual(950)
    } finally {
      await close(server)
    }
  })

  it('follows no more redirects than MAX_REDIRECTS', async () => {
    let hits = 0
    const { server, url } = await listen((_req, res) => {
      hits += 1
      res.writeHead(302, { Location: `/hop-${hits}` })
      res.end()
    })

    try {
      const fetcher = new Fetcher({ minIntervalMs: 0, retryDelayMs: 1 })
      await expect(fetcher.text(url)).rejects.toThrow('exceeded 5 redirects')
      expect(hits).toBe(5)
    } finally {
      await close(server)
    }
  })
})
