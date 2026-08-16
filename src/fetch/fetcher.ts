import { request as httpsRequest } from 'node:https'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'

const USER_AGENT =
  'cinema-tracker/0.1 (personal showtimes aggregator; +https://github.com/thomp/cinema-tracker)'

export interface FetcherOptions {
  /** Minimum gap between requests to the same host. */
  minIntervalMs?: number
  maxRetries?: number
  retryDelayMs?: number
  fetchImpl?: typeof fetch
}

/** Status codes worth retrying — transient server and rate-limit responses. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

export class Fetcher {
  private readonly minIntervalMs: number
  private readonly maxRetries: number
  private readonly retryDelayMs: number
  private readonly fetchImpl: typeof fetch
  private readonly lastRequestAt = new Map<string, number>()

  constructor(options: FetcherOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 2000
    this.maxRetries = options.maxRetries ?? 2
    this.retryDelayMs = options.retryDelayMs ?? 1000
    this.fetchImpl = options.fetchImpl ?? httpsFetch
  }

  async text(url: string): Promise<string> {
    const response = await this.request(url)
    return response.text()
  }

  private async request(url: string): Promise<Response> {
    const host = new URL(url).host
    await this.waitForSlot(host)

    let lastError: Error | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs * attempt)

      this.lastRequestAt.set(host, Date.now())
      const response = await this.fetchImpl(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })

      if (response.ok) return response

      if (!RETRYABLE.has(response.status)) {
        throw new Error(`GET ${url} failed: ${response.status}`)
      }
      lastError = new Error(`GET ${url} failed: ${response.status}`)
    }
    throw lastError ?? new Error(`GET ${url} failed`)
  }

  private async waitForSlot(host: string): Promise<void> {
    const last = this.lastRequestAt.get(host)
    if (last === undefined) return
    const elapsed = Date.now() - last
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const MAX_REDIRECTS = 5

/**
 * Default transport, backed by `node:https` rather than global `fetch`.
 *
 * Some sites (cinemark.com among them) answer undici with a 403 no matter what
 * headers it sends — the block keys on the TLS/connection fingerprint, below
 * HTTP. The same request from `node:https` or curl, with this same descriptive
 * User-Agent, returns 200, so we identify ourselves honestly over a different
 * client stack rather than spoofing a browser.
 */
const httpsFetch: typeof fetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : input.toString()
  const headers = (init.headers ?? {}) as Record<string, string>

  let current = url
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const { status, location, body } = await httpsGet(current, headers)

    if (status >= 300 && status < 400 && location) {
      current = new URL(location, current).toString()
      continue
    }
    return new Response(new Uint8Array(body), { status })
  }
  throw new Error(`GET ${url} exceeded ${MAX_REDIRECTS} redirects`)
}

interface RawHttpsResponse {
  status: number
  location: string | undefined
  body: Buffer
}

function httpsGet(url: string, headers: Record<string, string>): Promise<RawHttpsResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            // We never ask for a compressed body, but decode one anyway if a
            // server sends it unprompted.
            body: decompress(Buffer.concat(chunks), response.headers['content-encoding']),
          })
        } catch (error) {
          reject(error as Error)
        }
      })
    })
    request.on('error', reject)
    request.end()
  })
}

function decompress(body: Buffer, encoding: string | undefined): Buffer {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip':
      return gunzipSync(body)
    case 'deflate':
      return inflateSync(body)
    case 'br':
      return brotliDecompressSync(body)
    default:
      return body
  }
}
