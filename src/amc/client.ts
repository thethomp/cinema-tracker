import type { Fetcher } from '../fetch/fetcher.js'

const BASE = 'https://api.amctheatres.com/v2'

/**
 * AMC's showtimes endpoint defaults to `pageSize=10`. A busy day at Pacific
 * Place has 41 showtimes, so an unparameterised request quietly returns a
 * quarter of the day with HTTP 200 — exactly the silent-wrong-data failure this
 * repo keeps hitting. Always ask for 100 and follow `_links.next`.
 */
const PAGE_SIZE = 100

/** A self-referential `next` link must not hang the sweep. */
const MAX_PAGES = 20

export interface AmcAttribute {
  name?: string
}

export interface AmcShowtime {
  id: number
  movieId: number
  movieName: string
  showDateTimeUtc: string
  premiumFormat?: string
  runTime?: number
  purchaseUrl?: string
  isCanceled?: boolean
  attributes?: AmcAttribute[]
}

interface ShowtimePage {
  count?: number
  _embedded?: { showtimes?: AmcShowtime[] }
  _links?: { next?: { href?: string } }
}

export class AmcClient {
  constructor(
    private readonly fetcher: Pick<Fetcher, 'text'>,
    private readonly vendorKey: string,
  ) {}

  async getShowtimes(theatreId: number, date: string): Promise<AmcShowtime[]> {
    let url: string | undefined = `${BASE}/theatres/${theatreId}/showtimes/${date}?pageSize=${PAGE_SIZE}`
    const all: AmcShowtime[] = []

    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body: ShowtimePage = JSON.parse(
        await this.fetcher.text(url, { 'X-AMC-Vendor-Key': this.vendorKey }),
      )
      all.push(...(body._embedded?.showtimes ?? []))
      url = body._links?.next?.href
    }

    return all
  }
}
