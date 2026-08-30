import { request as httpRequest } from 'node:http'
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

/** Ceiling on an honored `Retry-After` wait, so a hostile value can't hang a sweep. */
const MAX_RETRY_AFTER_MS = 60_000

/**
 * A non-OK HTTP response, with its body attached.
 *
 * The body is the point. AMC answers a date with no showtimes with a 404 whose
 * body says *which kind* of 404 it is -- code 5217 "No showtimes found." for a
 * day with nothing scheduled, code 5108 "Theatre N not found." for a bad
 * theatre id, and an empty body for a malformed date. A caller handed only
 * "failed: 404" cannot tell an empty Tuesday from a mistyped theatre, and
 * guessing between those two is the difference between a correct sweep and a
 * source that reports "no showtimes" forever while looking perfectly healthy.
 *
 * The message is unchanged, so anything matching on it still matches.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`GET ${url} failed: ${status}`)
    this.name = 'HttpError'
  }
}

export class Fetcher {
  private readonly minIntervalMs: number
  private readonly maxRetries: number
  private readonly retryDelayMs: number
  private readonly fetchImpl: typeof fetch
  private readonly lastRequestAt = new Map<string, number>()

  constructor(options: FetcherOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 2000
    // Four retries — 2s/4s/8s/16s of backoff — so a rate-limit block at a
    // venue (Cinemark in particular) has a realistic chance of clearing before
    // the sweep gives up on the source.
    this.maxRetries = options.maxRetries ?? 4
    this.retryDelayMs = options.retryDelayMs ?? 1000
    this.fetchImpl = options.fetchImpl ?? nodeFetch
  }

  /**
   * `headers` adds source-specific request headers (AMC's `X-AMC-Vendor-Key`,
   * for one). It cannot override the identifying defaults below: an adapter
   * that wants to send a browser User-Agent should not get one from here.
   */
  async text(url: string, headers?: Record<string, string>): Promise<string> {
    const response = await this.request(url, headers)
    return response.text()
  }

  private async request(url: string, extraHeaders?: Record<string, string>): Promise<Response> {
    const host = new URL(url).host
    await this.waitForSlot(host)

    let lastError: Error | undefined
    let nextDelayMs = 0
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(nextDelayMs)

      this.lastRequestAt.set(host, Date.now())
      const response = await this.fetchImpl(url, {
        headers: {
          ...extraHeaders,
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })

      if (response.ok) return response

      // Read before anything else touches the response: a body can only be
      // consumed once, and it is what tells one 404 from another.
      const body = await response.text().catch(() => '')

      if (!RETRYABLE.has(response.status)) {
        throw new HttpError(response.status, url, body)
      }
      lastError = new HttpError(response.status, url, body)
      nextDelayMs = retryDelayFor(response, this.retryDelayMs, attempt + 1)
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

/**
 * Delay before the next retry: honor a numeric `Retry-After` (seconds) when
 * the response carries one, capped at `MAX_RETRY_AFTER_MS`; otherwise fall
 * back to exponential backoff. The HTTP-date form of `Retry-After` is
 * ignored — if it doesn't parse as a plain number, we skip it.
 */
function retryDelayFor(response: Response, retryDelayMs: number, nextAttempt: number): number {
  const header = response.headers.get('Retry-After')
  if (header !== null) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    }
  }
  return retryDelayMs * 2 ** nextAttempt
}

const MAX_REDIRECTS = 5

/** A hung connection must not stall a whole sweep. */
const SOCKET_TIMEOUT_MS = 30_000

/**
 * Default transport, backed by `node:http`/`node:https` rather than global
 * `fetch`.
 *
 * Some sites (cinemark.com among them) answer undici with a 403 no matter what
 * headers it sends — the block keys on the TLS/connection fingerprint, below
 * HTTP. The same request from `node:https` or curl, with this same descriptive
 * User-Agent, returns 200, so we identify ourselves honestly over a different
 * client stack rather than spoofing a browser.
 */
const nodeFetch: typeof fetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : input.toString()
  const headers = (init.headers ?? {}) as Record<string, string>

  let current = url
  for (let redirect = 0; redirect < MAX_REDIRECTS; redirect++) {
    const { status, location, headers: responseHeaders, body } = await nodeGet(current, headers)

    if (status >= 300 && status < 400 && location) {
      current = new URL(location, current).toString()
      continue
    }
    // Headers have to be carried through: `Retry-After` is read off the
    // Response by the retry logic above, and would be permanently absent if
    // this constructed a bare Response.
    return new Response(new Uint8Array(body), { status, headers: responseHeaders })
  }
  throw new Error(`GET ${url} exceeded ${MAX_REDIRECTS} redirects`)
}

interface RawHttpResponse {
  status: number
  location: string | undefined
  headers: Headers
  body: Buffer
}

function nodeGet(url: string, headers: Record<string, string>): Promise<RawHttpResponse> {
  const send = new URL(url).protocol === 'http:' ? httpRequest : httpsRequest

  return new Promise((resolve, reject) => {
    const request = send(url, { method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            headers: toHeaders(response.headers),
            // We never ask for a compressed body, but decode one anyway if a
            // server sends it unprompted.
            body: decompress(Buffer.concat(chunks), response.headers['content-encoding']),
          })
        } catch (error) {
          reject(error as Error)
        }
      })
    })
    request.setTimeout(SOCKET_TIMEOUT_MS, () => {
      request.destroy(new Error(`GET ${url} timed out after ${SOCKET_TIMEOUT_MS}ms`))
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Node's header bag onto a `Headers`. Content-Encoding and Content-Length are
 * dropped: the body handed to `Response` has already been decompressed, so
 * announcing the original encoding or length would describe something else.
 */
function toHeaders(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower === 'content-encoding' || lower === 'content-length') continue
    for (const entry of Array.isArray(value) ? value : [value]) {
      headers.append(name, entry)
    }
  }
  return headers
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
