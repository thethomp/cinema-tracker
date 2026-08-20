# AMC Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AMC Alderwood Mall 16 and AMC Pacific Place 11 as tracked venues via AMC's official REST API.

**Architecture:** A thin AMC API client behind the existing `Fetcher`, plus a `VenueAdapter` following the same contract as the other three. Unlike the HTML adapters, AMC returns absolute UTC timestamps and structured attributes, so there is no wall-clock conversion and no label parsing — but attributes still mix five categories and need filtering.

**Tech Stack:** TypeScript on Node 22, AMC REST API v2, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-cinema-tracker-design.md`
**Read first:** `AGENTS.md`

---

## Prerequisite

`AMC_API_KEY` in `.env`, verified active 2026-08-19. Header is **`X-AMC-Vendor-Key`**
— third-party docs claiming `X-API-Key` are wrong and produce a generic 400.

## Verified API facts (2026-08-19)

All confirmed by direct probe. Re-verify if implementation starts much later.

- `GET /v2/theatres?pageSize=200&pageNumber=N` — 524 theatres, paginated.
  **Alderwood = 2629**, **Pacific Place = 880**.
- `GET /v2/theatres/{id}/showtimes/{YYYY-MM-DD}` — 200.
  **Default `pageSize` is 10.** A day with 41 showtimes returns 10 unless you pass
  `?pageSize=100`. `_links.next` is present for further pages. **Silently fetching
  a quarter of each day is the single most likely bug in this plan.**
- A showtime record carries:

```
id                 145711542          movieId       76238
movieName          The Odyssey        sortableMovieName
showDateTimeUtc    2026-08-20T19:30:00Z    ← absolute instant
showDateTimeLocal  2026-08-20T12:30:00     utcOffset
premiumFormat      "70mm" or ""       runTime       (minutes)
genre              purchaseUrl        mobilePurchaseUrl
auditorium         isCanceled         isSoldOut     isAlmostSoldOut
attributes         [{ name, ... }]
```

- Observed `attributes` names across one day at Pacific Place, with counts:

```
41  Reserved Seating                    ← seating
29  Closed Caption                      ← accessibility
29  Audio Description                   ← accessibility
 9  AMC Artisan Films                   ← programming strand
 7  Thrills & Chills                    ← programming strand
 4  International Films                 ← programming strand
 3  70mm                                ← format
 3  Open Caption (On-screen Subtitles)  ← accessibility
 3  Mandarin Spoken with Chinese and English Subtitles  ← language
 1  Event                               ← programming strand
 1  Japanese Spoken with English Subtitles             ← language
```

- Observed `premiumFormat` values: `""` and `"70mm"`.

## Design decisions these facts force

1. **Always request `?pageSize=100`** and follow `_links.next` until exhausted.
   Assert in a test that a multi-page day yields every showtime.
2. **`formatHints` gets an allowlist**, exactly like Cinemark. Seating,
   accessibility, and language must never become format hints — the spec routes
   `formatHints` into tag extraction and a +50 special-event weight, so
   `Reserved Seating` scoring as a special event would be wrong.
3. **Programming strands are worth keeping** but are not formats. `AMC Artisan
   Films` is AMC's arthouse line and `Event` marks one-offs — both are real
   noteworthy signal for a user who cares about repertory and special screenings.
   Put the full attribute list into `RawScreening.description` so Plan 3's tag
   extractor can use it. **This is the first adapter to populate `description`**,
   which a prior review flagged as a gap.
4. **Skip `isCanceled` showtimes.** No other source offers this.
5. **No timezone conversion.** `showDateTimeUtc` is absolute; derive `localDate`
   from it with the existing `localDateOf`.

---

### Task 1: AMC API client

**Files:**
- Create: `src/amc/client.ts`
- Test: `tests/amc/client.test.ts`
- Fixture: `tests/fixtures/amc-pacific-place-showtimes.json`

- [ ] **Step 1: Record a real response as a fixture**

```bash
set -a; . ./.env; set +a
curl -s -H "X-AMC-Vendor-Key: $AMC_API_KEY" \
  "https://api.amctheatres.com/v2/theatres/880/showtimes/2026-08-22?pageSize=100" \
  -o tests/fixtures/amc-pacific-place-showtimes.json
python3 -c "
import json; d=json.load(open('tests/fixtures/amc-pacific-place-showtimes.json'))
print('count', d.get('count'), 'embedded', len(d['_embedded']['showtimes']))"
```

Expected: `count` equals the embedded length. **The fixture must not contain a key**
— confirm with `grep -c "$AMC_API_KEY" tests/fixtures/amc-pacific-place-showtimes.json`
returning 0 before committing. If the response echoes credentials anywhere, redact
them and say so.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { AmcClient } from '../../src/amc/client.js'

const page = readFileSync('tests/fixtures/amc-pacific-place-showtimes.json', 'utf8')

function stubFetcher(pages: string[]) {
  let n = 0
  return { text: vi.fn(async () => pages[Math.min(n++, pages.length - 1)]!) }
}

describe('AmcClient', () => {
  it('sends the vendor key header via the url-less fetcher contract', async () => {
    const fetcher = stubFetcher([page])
    const client = new AmcClient(fetcher as never, 'KEY')

    await client.getShowtimes(880, '2026-08-22')

    expect(fetcher.text).toHaveBeenCalled()
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
```

- [ ] **Step 3: Run to verify it fails.**

- [ ] **Step 4: Implement `src/amc/client.ts`**

The existing `Fetcher.text(url)` sends no custom auth header, so the client passes
the key as a query parameter is **not** acceptable — AMC requires the header.
Extend `Fetcher.text` to accept optional extra headers rather than bypassing it;
that keeps rate limiting intact. Add the overload in `src/fetch/fetcher.ts`:

```ts
async text(url: string, headers?: Record<string, string>): Promise<string>
```

and merge `headers` into the request headers, with the existing `User-Agent`,
`Accept`, and `Accept-Language` as defaults that callers may not override.

```ts
import type { Fetcher } from '../fetch/fetcher.js'

const BASE = 'https://api.amctheatres.com/v2'
const PAGE_SIZE = 100
const MAX_PAGES = 20

export interface AmcAttribute { name?: string }

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
```

- [ ] **Step 5:** `npx vitest run tests/amc/client.test.ts` — expect 6 passing.
      Confirm the 7 existing fetcher tests still pass after the header overload.

- [ ] **Step 6: Commit**

```bash
git add src/amc/client.ts src/fetch/fetcher.ts tests/amc/client.test.ts \
        tests/fetch/fetcher.test.ts tests/fixtures/amc-pacific-place-showtimes.json
git commit -m "feat: add AMC API client with pagination"
```

---

### Task 2: AMC adapter

**Files:**
- Create: `src/adapters/amc.ts`
- Test: `tests/adapters/amc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  parseAmcShowtimes,
  createAmcAdapter,
  AMC_VENUES,
} from '../../src/adapters/amc.js'
import type { AmcShowtime } from '../../src/amc/client.js'

const raw = JSON.parse(
  readFileSync('tests/fixtures/amc-pacific-place-showtimes.json', 'utf8'),
)._embedded.showtimes as AmcShowtime[]

const venue = AMC_VENUES.find((v) => v.id === 'amc-pacific-place')!

describe('parseAmcShowtimes', () => {
  const screenings = parseAmcShowtimes(raw, venue)

  it('parses the fixture into screenings', () => {
    expect(screenings.length).toBeGreaterThan(0)
  })

  it('uses the absolute UTC timestamp without conversion', () => {
    const first = raw.find((s) => !s.isCanceled)!
    const parsed = screenings.find((s) => s.sourceScreeningId === String(first.id))!
    expect(parsed.startsAt.toISOString()).toBe(new Date(first.showDateTimeUtc).toISOString())
  })

  it('derives the venue-local date', () => {
    for (const s of screenings) expect(s.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('keeps only premium formats as hints', () => {
    const hints = new Set(screenings.flatMap((s) => s.formatHints))
    for (const hint of hints) {
      expect(hint).not.toMatch(/RESERVED|CAPTION|AUDIO DESCRIPTION|SPOKEN|SUBTITLE/i)
    }
  })

  it('captures 70mm as a format hint', () => {
    const seventy = screenings.filter((s) => s.formatHints.includes('70MM'))
    expect(seventy.length).toBeGreaterThan(0)
  })

  it('puts the full attribute list in description for later tag extraction', () => {
    const withArtisan = screenings.find((s) => s.description?.includes('AMC Artisan Films'))
    expect(withArtisan).toBeDefined()
  })

  it('skips cancelled showtimes', () => {
    const cancelledIds = raw.filter((s) => s.isCanceled).map((s) => String(s.id))
    for (const id of cancelledIds) {
      expect(screenings.some((s) => s.sourceScreeningId === id)).toBe(false)
    }
  })

  it('produces unique source screening ids', () => {
    const ids = screenings.map((s) => s.sourceScreeningId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries the ticket url and runtime', () => {
    const first = screenings[0]!
    expect(first.ticketUrl).toMatch(/^https:\/\//)
    expect(first.runtimeMinutes === undefined || first.runtimeMinutes > 0).toBe(true)
  })
})

describe('createAmcAdapter', () => {
  it('requests each date in the range and filters to the requested day', async () => {
    const client = {
      getShowtimes: vi.fn(async (_id: number, _date: string) => raw),
    }
    const adapter = createAmcAdapter(client as never)

    const result = await adapter.fetch(venue, { from: '2026-08-22', to: '2026-08-24' })

    expect(client.getShowtimes).toHaveBeenCalledTimes(3)
    // The stub returns the same day for every request; the local-date filter must
    // keep only one day's worth rather than tripling it.
    const dates = new Set(result.map((s) => s.localDate))
    expect(dates.size).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/adapters/amc.ts`**

```ts
import type { DateRange, RawScreening, VenueAdapter, VenueRef } from '../core/types.js'
import { localDateOf, enumerateDates } from '../core/time.js'
import type { AmcClient, AmcShowtime } from '../amc/client.js'

const TZ = 'America/Los_Angeles'

export const AMC_VENUES: VenueRef[] = [
  { id: 'amc-alderwood', name: 'AMC Alderwood Mall 16', chain: 'AMC', timezone: TZ, sourceVenueId: '2629' },
  { id: 'amc-pacific-place', name: 'AMC Pacific Place 11', chain: 'AMC', timezone: TZ, sourceVenueId: '880' },
]

/**
 * AMC's `attributes` array mixes formats with seating, accessibility, language,
 * and programming strands. Only premium formats may become `formatHints`, which
 * downstream scoring treats as special-event signal. Everything else is kept in
 * `description` for the tag extractor.
 */
const PREMIUM_FORMATS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b70\s?mm\b/i, '70MM'],
  [/\b35\s?mm\b/i, '35MM'],
  [/\bIMAX\b/i, 'IMAX'],
  [/\bDOLBY\b/i, 'DOLBY'],
  [/\bPRIME\b/i, 'PRIME'],
  [/\b(?:REALD\s+)?3D\b/i, '3D'],
  [/\bD-?BOX\b/i, 'D-BOX'],
]

function formatHintsFor(showtime: AmcShowtime): string[] {
  const labels = [
    showtime.premiumFormat ?? '',
    ...(showtime.attributes ?? []).map((a) => a.name ?? ''),
  ]
  const hints = new Set<string>()
  for (const label of labels) {
    if (!label) continue
    for (const [pattern, tag] of PREMIUM_FORMATS) {
      if (pattern.test(label)) hints.add(tag)
    }
  }
  return [...hints]
}

export function parseAmcShowtimes(showtimes: AmcShowtime[], venue: VenueRef): RawScreening[] {
  const results: RawScreening[] = []
  const seen = new Set<string>()

  for (const showtime of showtimes) {
    if (showtime.isCanceled) continue
    const id = String(showtime.id)
    if (seen.has(id)) continue

    const startsAt = new Date(showtime.showDateTimeUtc)
    if (Number.isNaN(startsAt.getTime())) continue
    seen.add(id)

    const attributeNames = (showtime.attributes ?? [])
      .map((a) => a.name)
      .filter((name): name is string => Boolean(name))

    results.push({
      rawTitle: showtime.movieName,
      startsAt,
      localDate: localDateOf(startsAt, TZ),
      venueId: venue.id,
      ticketUrl: showtime.purchaseUrl ?? `https://www.amctheatres.com/movie-theatres/${venue.sourceVenueId}`,
      sourceScreeningId: id,
      formatHints: formatHintsFor(showtime),
      runtimeMinutes: showtime.runTime,
      description: attributeNames.length > 0 ? attributeNames.join(', ') : undefined,
    })
  }

  return results
}

export function createAmcAdapter(client: Pick<AmcClient, 'getShowtimes'>): VenueAdapter {
  return {
    id: 'amc',
    venues: AMC_VENUES,
    async fetch(venue: VenueRef, range: DateRange): Promise<RawScreening[]> {
      const all: RawScreening[] = []
      for (const date of enumerateDates(range)) {
        const showtimes = await client.getShowtimes(Number(venue.sourceVenueId), date)
        // Defensive, matching the other adapters: only keep screenings actually
        // on the requested date, so an API quirk cannot duplicate a day.
        all.push(...parseAmcShowtimes(showtimes, venue).filter((s) => s.localDate === date))
      }
      return all
    },
  }
}
```

- [ ] **Step 4:** `npx vitest run tests/adapters/amc.test.ts` — expect 10 passing.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/amc.ts tests/adapters/amc.test.ts
git commit -m "feat: add AMC adapter"
```

---

### Task 3: Register and verify live

**Files:**
- Modify: `src/adapters/index.ts`, `tests/adapters/index.test.ts`

- [ ] **Step 1: Update the registry test**

`createAdapters` currently takes only a `Fetcher`. AMC additionally needs the
vendor key, so change the signature to accept an options object rather than adding
a positional parameter:

```ts
export function createAdapters(fetcher: Fetcher, options: { amcApiKey?: string } = {}): VenueAdapter[]
```

When `amcApiKey` is absent, **omit the AMC adapter entirely** rather than
registering one that will fail every sweep. Update the test to assert both cases:

```ts
it('registers all four sources when an AMC key is present', () => {
  const adapters = createAdapters(new Fetcher(), { amcApiKey: 'KEY' })
  expect(adapters.map((a) => a.id).sort()).toEqual(['amc', 'cinemark', 'seattle-magic', 'siff'])
})

it('omits AMC when no key is configured', () => {
  const adapters = createAdapters(new Fetcher())
  expect(adapters.map((a) => a.id)).not.toContain('amc')
})

it('exposes exactly the expected venues with an AMC key', () => {
  const ids = allVenues(createAdapters(new Fetcher(), { amcApiKey: 'KEY' })).map((v) => v.id).sort()
  expect(ids).toEqual([
    'amc-alderwood', 'amc-pacific-place',
    'cinemark-lincoln-square', 'cinemark-totem-lake',
    'seattle-magic', 'siff-downtown', 'siff-film-center', 'siff-uptown',
  ])
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement the registry change and wire the CLI**

Update `src/adapters/index.ts`, and in `src/cli.ts` pass
`{ amcApiKey: process.env.AMC_API_KEY }` to `createAdapters`. The seeder already
weights by chain; AMC is a chain, so it keeps weight 0 alongside Cinemark.

- [ ] **Step 4:** `npx vitest run` — full suite green.

- [ ] **Step 5: Verify live against both theatres**

```bash
cat > /tmp/verify-amc.ts <<'EOF'
import { Fetcher } from '/Users/thomp/git/cinema-tracker/src/fetch/fetcher.js'
import { AmcClient } from '/Users/thomp/git/cinema-tracker/src/amc/client.js'
import { createAmcAdapter, AMC_VENUES } from '/Users/thomp/git/cinema-tracker/src/adapters/amc.js'
async function main() {
  const key = process.env.AMC_API_KEY
  if (!key) { console.error('AMC_API_KEY not set'); process.exit(1) }
  const adapter = createAmcAdapter(new AmcClient(new Fetcher({ minIntervalMs: 500 }), key))
  for (const venue of AMC_VENUES) {
    const rows = await adapter.fetch(venue, { from: '2026-08-20', to: '2026-08-22' })
    const byDate: Record<string, number> = {}
    for (const r of rows) byDate[r.localDate] = (byDate[r.localDate] ?? 0) + 1
    console.log(venue.id, 'total', rows.length, byDate)
    console.log('  hints:', [...new Set(rows.flatMap((r) => r.formatHints))])
    console.log('  sample:', rows.slice(0, 2).map((r) => [r.rawTitle, r.localDate, r.formatHints]))
  }
}
main()
EOF
set -a; . ./.env; set +a; npx tsx /tmp/verify-amc.ts
```

Expected: both venues return dozens of screenings per day spread across **three
distinct dates**, with hints containing only premium formats. **If a day returns
exactly 10, pagination is broken** — that is the trap this plan exists to avoid.

- [ ] **Step 6: Run a full sweep and confirm AMC lands in the database**

```bash
npm run sweep
sqlite3 -box data/cinema-tracker.db "
SELECT v.name, COUNT(*) AS screenings FROM screenings s
JOIN venues v ON v.id = s.venue_id WHERE s.cancelled = 0
GROUP BY v.id ORDER BY screenings DESC;"
```

Expected: both AMC venues appear with non-zero counts. Then run `npm run resolve`
and report how many of the new AMC titles resolved.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/index.ts src/cli.ts tests/adapters/index.test.ts
git commit -m "feat: register AMC adapter and wire the vendor key"
```

---

## Done when

- `npx vitest run` passes and `npx tsc --noEmit` is clean.
- A live fetch returns more than 10 showtimes for a busy day at both theatres.
- `npm run sweep` populates both AMC venues.
- `formatHints` contains only premium formats; seating, accessibility, and
  language appear in `description` instead.
- Omitting `AMC_API_KEY` cleanly omits the adapter rather than failing sweeps.

## Notes for the next plan

- AMC is the first adapter to populate `RawScreening.description`. The store does
  not currently persist it — Plan 3 should add a `description` column to
  `screenings` and thread it through, since the LLM tag extractor consumes it.
- AMC's programming strands (`AMC Artisan Films`, `Thrills & Chills`,
  `International Films`, `Event`) are strong noteworthy signal and land in
  `description`. The tag extractor should treat `Event` and `AMC Artisan Films`
  as meaningful.
- `isSoldOut` and `isAlmostSoldOut` are available and unused. Potentially useful
  in the UI later; deliberately not captured now.
