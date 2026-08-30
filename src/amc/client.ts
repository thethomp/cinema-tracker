import { HttpError, type Fetcher } from '../fetch/fetcher.js'

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

/**
 * AMC's error code for "this theatre has nothing scheduled on this date".
 *
 * It arrives as HTTP 404, which is the trap. Verified against the live API on
 * 2026-08-30 for theatre 880 (Pacific Place):
 *
 *   2026-09-17  200, 10 showtimes
 *   2026-09-18  404, code 5217 "No showtimes found."
 *   2026-09-19  404, code 5217
 *   2026-09-25  200, 3 showtimes
 *
 * So it is not the end of the publishing window -- there is real data on the
 * far side of it. It is an ordinary empty day, and treating it as a fatal
 * error meant one quiet Thursday failed the entire AMC sweep, both venues,
 * every run.
 *
 * Only this code is forgiven. A bad theatre id returns 404 as well, with code
 * 5108 "Theatre N not found.", and a malformed date returns 404 with an empty
 * body. Swallowing those would turn a typo into a source that reports no
 * showtimes forever and reads as healthy -- the exact failure this repo is
 * built to refuse. A missing vendor key is a 400 and never reaches here.
 */
const NO_SHOWTIMES_CODE = 5217

interface AmcErrorBody {
  errors?: { code?: number }[]
}

/** True only for a 404 that AMC has explicitly labelled "no showtimes found". */
function isNoShowtimes(error: unknown): boolean {
  if (!(error instanceof HttpError) || error.status !== 404) return false
  let parsed: AmcErrorBody
  try {
    parsed = JSON.parse(error.body) as AmcErrorBody
  } catch {
    // An empty or non-JSON body says nothing, so nothing may be assumed.
    return false
  }
  return parsed.errors?.some((entry) => entry.code === NO_SHOWTIMES_CODE) ?? false
}

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
      let raw: string
      try {
        raw = await this.fetcher.text(url, { 'X-AMC-Vendor-Key': this.vendorKey })
      } catch (error) {
        // Only on the first request. A 404 on page two cannot mean "no
        // showtimes today" -- page one already returned some -- so it stays
        // fatal rather than silently truncating a busy day.
        if (page === 0 && isNoShowtimes(error)) return []
        throw error
      }

      const body: ShowtimePage = JSON.parse(raw)
      all.push(...(body._embedded?.showtimes ?? []))
      url = body._links?.next?.href
    }

    return all
  }
}
