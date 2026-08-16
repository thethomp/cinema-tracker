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
    this.fetchImpl = options.fetchImpl ?? fetch
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
