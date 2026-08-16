# Foundation and Venue Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scheduled sweep that fetches screenings from SIFF, Cinemark, and Seattle Magic Theater into SQLite, with fixture-based parser tests and health tracking.

**Architecture:** Each venue source is a `VenueAdapter` behind one contract, sharing a rate-limited fetch layer. Adapters return `RawScreening[]`; a store upserts them with `first_seen_at`/`last_seen_at` tracking so newly-appeared screenings can be detected later. A sweep orchestrator runs all adapters and records a `source_runs` row per source. The sweep is invoked manually via the CLI in this plan; the 6-hour in-process scheduler ships with the server in Plan 3.

**Tech Stack:** TypeScript (ESM) on Node 22, better-sqlite3 + Drizzle ORM, cheerio for HTML parsing, Luxon for timezone handling, Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-08-16-cinema-tracker-design.md`

---

## Scope

In scope: project scaffold, database schema, fetch layer, three venue adapters, screening store, sweep orchestrator, CLI.

Out of scope (later plans): TMDB, title resolution, Letterboxd, tag extraction, scoring, HTTP API, UI, deployment, AMC.

Films are **not** resolved in this plan. `screenings.film_id` stays null and `raw_title` carries the venue's title. That is the designed intermediate state.

## File structure

| File | Responsibility |
|---|---|
| `src/core/types.ts` | Shared domain types. No logic. |
| `src/core/time.ts` | Timezone conversion and local-date derivation. |
| `src/fetch/fetcher.ts` | Rate-limited, retrying HTTP with a descriptive UA. |
| `src/db/schema.ts` | Drizzle table definitions. |
| `src/db/client.ts` | Database construction and migration. |
| `src/adapters/siff.ts` | SIFF parser + fetch. |
| `src/adapters/cinemark.ts` | Cinemark parser + fetch. |
| `src/adapters/seattle-magic.ts` | Seattle Magic Theater parser + fetch. |
| `src/adapters/index.ts` | Adapter registry. |
| `src/store/screenings.ts` | Upsert, first/last seen, cancellation. |
| `src/store/runs.ts` | `source_runs` recording and health evaluation. |
| `src/sweep/sweep.ts` | Orchestration across adapters. |
| `src/cli.ts` | Entry point: `sweep` and `serve` commands. |
| `scripts/record-fixture.ts` | Saves a live page to `tests/fixtures/`. |

Each adapter file exports one adapter and a pure `parse*` function. **Parsers take a string and return data — they never fetch.** That split is what makes fixture tests possible.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (modify)

- [ ] **Step 1: Initialize the package**

```bash
cd /Users/thomp/git/cinema-tracker
npm init -y
npm pkg set name="cinema-tracker" type="module" private=true
npm pkg set scripts.test="vitest run" scripts.typecheck="tsc --noEmit"
npm pkg set scripts.sweep="tsx src/cli.ts sweep"
npm install better-sqlite3 drizzle-orm cheerio luxon
npm install -D typescript tsx vitest drizzle-kit @types/node @types/better-sqlite3 @types/luxon
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src", "tests", "scripts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 4: Add build artifacts to `.gitignore`**

Append these lines to the existing `.gitignore` (which already contains `.superpowers/` and `.env`):

```
node_modules/
dist/
data/
```

- [ ] **Step 5: Verify the toolchain runs**

Run: `npx vitest run --passWithNoTests`
Expected: Vitest reports "No test files found" and exits 0.

Do **not** run `tsc --noEmit` yet. `include` points at `src`, `tests`, and `scripts`,
none of which exist until Task 2, and `tsc` exits 2 with `TS18003: No inputs were
found in config file` when its includes match nothing. That is a missing-input
error, not a type error. Do not add a placeholder file to silence it — Task 2
resolves it by adding the first real source file. Typechecking begins in Task 2.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: scaffold TypeScript project with vitest"
```

---

### Task 2: Core types

**Files:**
- Create: `src/core/types.ts`

- [ ] **Step 1: Write the types**

There is no test for this task — it is types only, verified by `tsc`.

```ts
export interface VenueRef {
  /** Stable slug, e.g. "siff-uptown". Primary key in the venues table. */
  id: string
  name: string
  chain: string
  timezone: string
  /** Source-specific identifier, e.g. Cinemark's numeric TheaterId. */
  sourceVenueId: string
}

export interface DateRange {
  /** Inclusive, ISO date, e.g. "2026-08-16". */
  from: string
  /** Inclusive, ISO date. */
  to: string
}

export interface RawScreening {
  /** Title exactly as the venue presents it, including any "(70mm)" suffix. */
  rawTitle: string
  /** Absolute instant of the screening start. */
  startsAt: Date
  /** Local calendar date at the venue, "YYYY-MM-DD". */
  localDate: string
  venueId: string
  ticketUrl: string
  /** Stable per-source id, used for upsert identity. */
  sourceScreeningId: string
  /** Format labels straight from the source, pre-tag-extraction. */
  formatHints: string[]
  description?: string
  runtimeMinutes?: number
}

export interface VenueAdapter {
  readonly id: string
  readonly venues: VenueRef[]
  fetch(venue: VenueRef, range: DateRange): Promise<RawScreening[]>
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add core domain types"
```

---

### Task 3: Time utilities

Cinemark publishes local wall-clock times with no zone (`2026-08-16T09:50:00`); SIFF publishes epoch milliseconds. Both must land on the same absolute instant plus a venue-local calendar date.

**Files:**
- Create: `src/core/time.ts`
- Test: `tests/core/time.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { localWallClockToUtc, localDateOf } from '../../src/core/time.js'

const LA = 'America/Los_Angeles'

describe('localWallClockToUtc', () => {
  it('interprets a zoneless timestamp in the venue timezone', () => {
    // 9:50am PDT on 2026-08-16 is 16:50 UTC.
    const result = localWallClockToUtc('2026-08-16T09:50:00', LA)
    expect(result.toISOString()).toBe('2026-08-16T16:50:00.000Z')
  })

  it('handles a winter date at the other UTC offset', () => {
    // 9:50am PST on 2026-01-15 is 17:50 UTC.
    const result = localWallClockToUtc('2026-01-15T09:50:00', LA)
    expect(result.toISOString()).toBe('2026-01-15T17:50:00.000Z')
  })
})

describe('localDateOf', () => {
  it('returns the venue-local calendar date', () => {
    const instant = new Date('2026-08-16T16:50:00.000Z')
    expect(localDateOf(instant, LA)).toBe('2026-08-16')
  })

  it('keeps a late-evening screening on its own local date', () => {
    // 11:45pm PDT on 2026-08-16 is already 2026-08-17 in UTC.
    const instant = new Date('2026-08-17T06:45:00.000Z')
    expect(localDateOf(instant, LA)).toBe('2026-08-16')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/time.test.ts`
Expected: FAIL — cannot resolve `../../src/core/time.js`.

- [ ] **Step 3: Write the implementation**

```ts
import { DateTime } from 'luxon'

/**
 * Interpret a zoneless local timestamp ("2026-08-16T09:50:00") as wall-clock
 * time in `timezone` and return the absolute instant.
 */
export function localWallClockToUtc(wallClock: string, timezone: string): Date {
  const dt = DateTime.fromISO(wallClock, { zone: timezone })
  if (!dt.isValid) {
    throw new Error(`Invalid wall-clock timestamp: ${wallClock}`)
  }
  return dt.toJSDate()
}

/** The calendar date on which this instant falls, in the venue's timezone. */
export function localDateOf(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant).setZone(timezone).toISODate()!
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/time.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/time.ts tests/core/time.test.ts
git commit -m "feat: add timezone-aware time utilities"
```

---

### Task 4: Fetch layer

Politeness is enforced here so no adapter can bypass it: at most one request per host every 2 seconds, with retries on transient failures.

**Files:**
- Create: `src/fetch/fetcher.ts`
- Test: `tests/fetch/fetcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/fetch/fetcher.test.ts`
Expected: FAIL — cannot resolve `../../src/fetch/fetcher.js`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/fetch/fetcher.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fetch/fetcher.ts tests/fetch/fetcher.test.ts
git commit -m "feat: add rate-limited fetch layer with retries"
```

---

### Task 5: Database schema and client

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`
- Test: `tests/db/client.test.ts`

Only the tables this plan needs are created. Later plans add `films`, `letterboxd_entries`, `taste_affinities`, `taste_rules`, `title_overrides`, `watchlist`, and `app_state`.

- [ ] **Step 1: Write the schema**

```ts
import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const venues = sqliteTable('venues', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  chain: text('chain').notNull(),
  timezone: text('timezone').notNull(),
  sourceVenueId: text('source_venue_id').notNull(),
  weight: real('weight').notNull().default(0),
})

export const screenings = sqliteTable(
  'screenings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    venueId: text('venue_id').notNull().references(() => venues.id),
    filmId: integer('film_id'),
    rawTitle: text('raw_title').notNull(),
    startsAtUtc: integer('starts_at_utc', { mode: 'timestamp_ms' }).notNull(),
    localDate: text('local_date').notNull(),
    ticketUrl: text('ticket_url').notNull(),
    sourceScreeningId: text('source_screening_id').notNull(),
    formatHints: text('format_hints', { mode: 'json' }).notNull().$type<string[]>(),
    tags: text('tags', { mode: 'json' }).notNull().$type<string[]>(),
    runtimeMinutes: integer('runtime_minutes'),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    missedSweeps: integer('missed_sweeps').notNull().default(0),
    cancelled: integer('cancelled', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => ({
    /** Upsert identity: one row per source screening per venue. */
    sourceIdx: uniqueIndex('screenings_source_idx').on(
      table.venueId,
      table.sourceScreeningId,
    ),
  }),
)

export const sourceRuns = sqliteTable('source_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  status: text('status', { enum: ['ok', 'failed'] }).notNull(),
  itemCount: integer('item_count').notNull().default(0),
  error: text('error'),
})
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/db/client.js'
import { venues } from '../../src/db/schema.js'

describe('createDatabase', () => {
  it('creates an in-memory database with the schema applied', async () => {
    const { db } = createDatabase(':memory:')

    await db.insert(venues).values({
      id: 'siff-uptown',
      name: 'SIFF Cinema Uptown',
      chain: 'SIFF',
      timezone: 'America/Los_Angeles',
      sourceVenueId: 'siff-cinema-uptown',
      weight: 15,
    })

    const rows = await db.select().from(venues)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('SIFF Cinema Uptown')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/db/client.test.ts`
Expected: FAIL — cannot resolve `../../src/db/client.js`.

- [ ] **Step 4: Write the client**

Drizzle migrations are overkill for a single-user app whose schema we control. The client creates tables directly and is idempotent.

```ts
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS venues (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     chain TEXT NOT NULL,
     timezone TEXT NOT NULL,
     source_venue_id TEXT NOT NULL,
     weight REAL NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS screenings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     venue_id TEXT NOT NULL REFERENCES venues(id),
     film_id INTEGER,
     raw_title TEXT NOT NULL,
     starts_at_utc INTEGER NOT NULL,
     local_date TEXT NOT NULL,
     ticket_url TEXT NOT NULL,
     source_screening_id TEXT NOT NULL,
     format_hints TEXT NOT NULL,
     tags TEXT NOT NULL,
     runtime_minutes INTEGER,
     first_seen_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     missed_sweeps INTEGER NOT NULL DEFAULT 0,
     cancelled INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS screenings_source_idx
     ON screenings (venue_id, source_screening_id)`,
  `CREATE TABLE IF NOT EXISTS source_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     status TEXT NOT NULL,
     item_count INTEGER NOT NULL DEFAULT 0,
     error TEXT
   )`,
]

export type Db = BetterSQLite3Database<typeof schema>

export function createDatabase(path: string): { db: Db; close: () => void } {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  for (const statement of CREATE_STATEMENTS) sqlite.exec(statement)

  return {
    db: drizzle(sqlite, { schema }),
    close: () => sqlite.close(),
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/db/client.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/db/client.test.ts
git commit -m "feat: add SQLite schema and client"
```

---

### Task 6: Fixture recorder

Parsers are tested against saved copies of real pages. This script produces them.

**Files:**
- Create: `scripts/record-fixture.ts`
- Create: `tests/fixtures/` (three recorded HTML files)

- [ ] **Step 1: Write the recorder**

```ts
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Fetcher } from '../src/fetch/fetcher.js'

/** Usage: npx tsx scripts/record-fixture.ts <url> <fixture-name> */
const [url, name] = process.argv.slice(2)
if (!url || !name) {
  console.error('Usage: record-fixture.ts <url> <fixture-name>')
  process.exit(1)
}

const fetcher = new Fetcher()
const html = await fetcher.text(url)
const path = join('tests/fixtures', `${name}.html`)
await mkdir(dirname(path), { recursive: true })
await writeFile(path, html, 'utf8')
console.log(`Wrote ${path} (${html.length} bytes)`)
```

- [ ] **Step 2: Record all three fixtures**

```bash
npx tsx scripts/record-fixture.ts \
  "https://www.siff.net/cinema" siff-cinema
npx tsx scripts/record-fixture.ts \
  "https://www.cinemark.com/theatres/wa-bellevue/cinemark-lincoln-square-cinemas-and-imax" cinemark-lincoln-square
npx tsx scripts/record-fixture.ts \
  "https://seattlemagictheater.com/events" seattle-magic-events
```

Expected: three files written, roughly 80KB, 340KB, and 19KB respectively.

- [ ] **Step 3: Confirm the fixtures contain the markup the parsers rely on**

```bash
grep -c 'data-screening=' tests/fixtures/siff-cinema.html
grep -c 'class="showtime-link"' tests/fixtures/cinemark-lincoln-square.html
grep -c 'Upcoming Events' tests/fixtures/seattle-magic-events.html
```

Expected: a non-zero count for each. If the SIFF or Cinemark count is 0, the site changed since 2026-08-16 — stop and re-inspect the markup before writing the parser, because the selectors in Tasks 7 and 8 will not apply.

- [ ] **Step 4: Commit**

```bash
git add scripts/record-fixture.ts tests/fixtures/
git commit -m "test: add fixture recorder and record venue fixtures"
```

---

### Task 7: SIFF adapter

SIFF embeds a JSON object per showtime in a `data-screening` attribute. Parse that rather than traversing the DOM — it is the most stable surface the page offers.

Observed shape (HTML-escaped in the attribute):

```json
{"EventName":"The Samurai and the Prisoner","EventUrlName":"SamuraiandthePrisoner",
 "Showtime":"/Date(1786908600000)/","ShowtimeEnd":"/Date(1786917420000)/",
 "ShowtimeId":"ewMMr6SjSA","LengthInMinutes":147,
 "VenueName":"SIFF Cinema Uptown House 3","HasTicketsOnSale":true}
```

**Files:**
- Create: `src/adapters/siff.ts`
- Test: `tests/adapters/siff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseSiffScreenings, SIFF_VENUES } from '../../src/adapters/siff.js'

const html = readFileSync('tests/fixtures/siff-cinema.html', 'utf8')

describe('parseSiffScreenings', () => {
  const screenings = parseSiffScreenings(html)

  it('extracts screenings from the fixture', () => {
    expect(screenings.length).toBeGreaterThan(0)
  })

  it('maps the embedded JSON onto RawScreening fields', () => {
    const first = screenings[0]!
    expect(first.rawTitle).toBeTruthy()
    expect(first.sourceScreeningId).toMatch(/^\w+$/)
    expect(first.startsAt).toBeInstanceOf(Date)
    expect(Number.isNaN(first.startsAt.getTime())).toBe(false)
    expect(first.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('resolves the auditorium name to a known venue id', () => {
    const ids = new Set(SIFF_VENUES.map((v) => v.id))
    for (const screening of screenings) {
      expect(ids.has(screening.venueId)).toBe(true)
    }
  })

  it('builds a ticket url pointing at the film page', () => {
    expect(screenings[0]!.ticketUrl).toContain('siff.net')
  })

  it('carries the runtime through when present', () => {
    const withRuntime = screenings.find((s) => s.runtimeMinutes !== undefined)
    expect(withRuntime!.runtimeMinutes).toBeGreaterThan(0)
  })

  it('produces unique source screening ids', () => {
    const ids = screenings.map((s) => s.sourceScreeningId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/siff.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/siff.js`.

- [ ] **Step 3: Write the parser and adapter**

```ts
import * as cheerio from 'cheerio'
import type { DateRange, RawScreening, VenueAdapter, VenueRef } from '../core/types.js'
import { localDateOf } from '../core/time.js'
import type { Fetcher } from '../fetch/fetcher.js'

const TZ = 'America/Los_Angeles'

export const SIFF_VENUES: VenueRef[] = [
  { id: 'siff-downtown', name: 'SIFF Cinema Downtown', chain: 'SIFF', timezone: TZ, sourceVenueId: 'siff-cinema-downtown' },
  { id: 'siff-uptown', name: 'SIFF Cinema Uptown', chain: 'SIFF', timezone: TZ, sourceVenueId: 'siff-cinema-uptown' },
  { id: 'siff-film-center', name: 'SIFF Film Center', chain: 'SIFF', timezone: TZ, sourceVenueId: 'siff-film-center' },
  { id: 'siff-egyptian', name: 'SIFF Cinema Egyptian', chain: 'SIFF', timezone: TZ, sourceVenueId: 'siff-cinema-egyptian' },
]

interface SiffScreeningJson {
  EventName: string
  EventUrlName: string
  Showtime: string
  ShowtimeId: string
  LengthInMinutes?: number
  VenueName: string
}

/** SIFF serializes dates as "/Date(1786908600000)/". */
function parseDotNetDate(value: string): Date {
  const match = /\/Date\((-?\d+)\)\//.exec(value)
  if (!match) throw new Error(`Unrecognized SIFF date: ${value}`)
  return new Date(Number(match[1]))
}

/**
 * Auditorium names look like "SIFF Cinema Uptown House 3". Match the longest
 * venue name that prefixes it so "Uptown" never matches "Uptown House".
 */
function resolveVenueId(auditorium: string): string | undefined {
  const sorted = [...SIFF_VENUES].sort((a, b) => b.name.length - a.name.length)
  return sorted.find((v) => auditorium.startsWith(v.name))?.id
}

export function parseSiffScreenings(html: string): RawScreening[] {
  const $ = cheerio.load(html)
  const results: RawScreening[] = []
  const seen = new Set<string>()

  $('[data-screening]').each((_, element) => {
    const attr = $(element).attr('data-screening')
    if (!attr) return

    let json: SiffScreeningJson
    try {
      json = JSON.parse(attr) as SiffScreeningJson
    } catch {
      return // Malformed entry: skip rather than fail the whole page.
    }

    const venueId = resolveVenueId(json.VenueName)
    if (!venueId) return
    if (seen.has(json.ShowtimeId)) return
    seen.add(json.ShowtimeId)

    const startsAt = parseDotNetDate(json.Showtime)
    results.push({
      rawTitle: json.EventName,
      startsAt,
      localDate: localDateOf(startsAt, TZ),
      venueId,
      ticketUrl: `https://www.siff.net/cinema/in-theaters/${slugify(json.EventName)}`,
      sourceScreeningId: json.ShowtimeId,
      formatHints: extractFormatHints(json.EventName),
      runtimeMinutes: json.LengthInMinutes,
    })
  })

  return results
}

/** SIFF encodes format in the title, e.g. "The Odyssey (70mm)". */
function extractFormatHints(title: string): string[] {
  const hints: string[] = []
  for (const [pattern, hint] of [
    [/\(70\s?mm\)/i, '70MM'],
    [/\(35\s?mm\)/i, '35MM'],
    [/\b16\s?mm\b/i, '16MM'],
  ] as const) {
    if (pattern.test(title)) hints.push(hint)
  }
  return hints
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s()-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

export function createSiffAdapter(fetcher: Fetcher): VenueAdapter {
  return {
    id: 'siff',
    venues: SIFF_VENUES,
    async fetch(venue: VenueRef, range: DateRange): Promise<RawScreening[]> {
      const dates = enumerateDates(range)
      const all: RawScreening[] = []
      for (const date of dates) {
        const html = await fetcher.text(`https://www.siff.net/cinema?date=${date}`)
        all.push(...parseSiffScreenings(html).filter((s) => s.venueId === venue.id))
      }
      return all
    },
  }
}

export function enumerateDates(range: DateRange): string[] {
  const dates: string[] = []
  const cursor = new Date(`${range.from}T00:00:00Z`)
  const end = new Date(`${range.to}T00:00:00Z`)
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/siff.test.ts`
Expected: PASS, 6 tests.

If `resolveVenueId` rejects everything and the venue-id test fails, print the distinct auditorium names and add any missing venue to `SIFF_VENUES`:

```bash
npx tsx -e "import {readFileSync} from 'node:fs'; \
const h=readFileSync('tests/fixtures/siff-cinema.html','utf8'); \
console.log([...new Set([...h.matchAll(/&quot;VenueName&quot;:&quot;([^&]+)&quot;/g)].map(m=>m[1]))])"
```

- [ ] **Step 5: Verify the live date parameter**

The `?date=` parameter used by `createSiffAdapter` was inferred, not observed. Confirm it before relying on it:

```bash
npx tsx -e "import {Fetcher} from './src/fetch/fetcher.js'; \
const f=new Fetcher(); \
const a=await f.text('https://www.siff.net/cinema'); \
const b=await f.text('https://www.siff.net/cinema?date=2026-08-19'); \
const ids=(s)=>new Set([...s.matchAll(/ShowtimeId&quot;:&quot;(\w+)/g)].map(m=>m[1])); \
console.log('today',ids(a).size,'dated',ids(b).size, \
 'differs', [...ids(b)].some(x=>!ids(a).has(x)));"
```

Expected: `differs true`. If it prints `differs false`, the parameter is ignored — inspect the date links in the fixture (`grep -oE 'href="[^"]*cinema[^"]*"' tests/fixtures/siff-cinema.html | sort -u`) and correct the URL in `createSiffAdapter` before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/siff.ts tests/adapters/siff.test.ts
git commit -m "feat: add SIFF adapter parsing embedded screening JSON"
```

---

### Task 8: Cinemark adapter

Cinemark's page is server-rendered. Each film is a `.showtimeMovieBlock`; each bookable showtime is an `a.showtime-link` whose `href` carries the identifiers and an unambiguous local start time.

Observed anchor:

```html
<a class="showtime-link" data-print-type-name="Standard Format"
   href="/TicketSeatMap/?TheaterId=1118&ShowtimeId=383003&CinemarkMovieId=107537&Showtime=2026-08-16T09:50:00">9:50am</a>
```

Past showtimes render as `<p class="off past">` with no anchor and must be skipped.

**Files:**
- Create: `src/adapters/cinemark.ts`
- Test: `tests/adapters/cinemark.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseCinemarkScreenings, CINEMARK_VENUES } from '../../src/adapters/cinemark.js'

const html = readFileSync('tests/fixtures/cinemark-lincoln-square.html', 'utf8')
const venue = CINEMARK_VENUES.find((v) => v.id === 'cinemark-lincoln-square')!

describe('parseCinemarkScreenings', () => {
  const screenings = parseCinemarkScreenings(html, venue)

  it('extracts screenings from the fixture', () => {
    expect(screenings.length).toBeGreaterThan(10)
  })

  it('reads the start time from the href, not the link text', () => {
    const first = screenings[0]!
    // 9:50am PDT on 2026-08-16 is 16:50 UTC.
    expect(first.startsAt.toISOString()).toMatch(/^2026-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/)
    expect(first.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('uses the Cinemark ShowtimeId as the source id', () => {
    expect(screenings[0]!.sourceScreeningId).toMatch(/^\d+$/)
  })

  it('builds an absolute ticket url', () => {
    expect(screenings[0]!.ticketUrl).toMatch(/^https:\/\/www\.cinemark\.com\/TicketSeatMap/)
  })

  it('skips past showtimes that have no booking link', () => {
    // The fixture contains at least one <p class="off past"> entry.
    expect(html).toContain('off past')
    for (const screening of screenings) {
      expect(screening.ticketUrl).toContain('ShowtimeId=')
    }
  })

  it('captures the auditorium format as a hint', () => {
    const hints = new Set(screenings.flatMap((s) => s.formatHints))
    expect(hints.size).toBeGreaterThan(0)
  })

  it('attaches the film title to every screening', () => {
    for (const screening of screenings) {
      expect(screening.rawTitle.length).toBeGreaterThan(0)
    }
  })

  it('produces unique source screening ids', () => {
    const ids = screenings.map((s) => s.sourceScreeningId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/cinemark.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/cinemark.js`.

- [ ] **Step 3: Write the parser and adapter**

```ts
import * as cheerio from 'cheerio'
import type { DateRange, RawScreening, VenueAdapter, VenueRef } from '../core/types.js'
import { localDateOf, localWallClockToUtc } from '../core/time.js'
import type { Fetcher } from '../fetch/fetcher.js'
import { enumerateDates } from './siff.js'

const TZ = 'America/Los_Angeles'
const BASE = 'https://www.cinemark.com'

export const CINEMARK_VENUES: VenueRef[] = [
  {
    id: 'cinemark-lincoln-square',
    name: 'Cinemark Lincoln Square Cinemas and IMAX',
    chain: 'Cinemark',
    timezone: TZ,
    sourceVenueId: 'theatres/wa-bellevue/cinemark-lincoln-square-cinemas-and-imax',
  },
  {
    id: 'cinemark-totem-lake',
    name: 'Cinemark Totem Lake and XD',
    chain: 'Cinemark',
    timezone: TZ,
    sourceVenueId: 'theatres/wa-kirkland/cinemark-totem-lake-and-xd',
  },
]

export function parseCinemarkScreenings(html: string, venue: VenueRef): RawScreening[] {
  const $ = cheerio.load(html)
  const results: RawScreening[] = []
  const seen = new Set<string>()

  $('.showtimeMovieBlock').each((_, block) => {
    const $block = $(block)
    const rawTitle = $block.find('.movieBlockHeader h3').first().text().trim()
    if (!rawTitle) return

    const runtimeMinutes = parseRuntime($block.find('.showtimeMovieRuntime').first().text())

    $block.find('a.showtime-link').each((__, link) => {
      const href = $(link).attr('href')
      if (!href) return

      const url = new URL(href, BASE)
      const showtimeId = url.searchParams.get('ShowtimeId')
      const wallClock = url.searchParams.get('Showtime')
      if (!showtimeId || !wallClock) return
      if (seen.has(showtimeId)) return
      seen.add(showtimeId)

      const startsAt = localWallClockToUtc(wallClock, TZ)
      const format = $(link).attr('data-print-type-name')?.trim()

      results.push({
        rawTitle,
        startsAt,
        localDate: localDateOf(startsAt, TZ),
        venueId: venue.id,
        ticketUrl: url.toString(),
        sourceScreeningId: showtimeId,
        formatHints: normalizeFormat(format),
        runtimeMinutes,
      })
    })
  })

  return results
}

/** "Standard Format" carries no signal; anything else does. */
function normalizeFormat(format: string | undefined): string[] {
  if (!format || /^standard format$/i.test(format)) return []
  return [format.toUpperCase()]
}

/** Cinemark renders runtime as "2 hr 25 min". */
function parseRuntime(text: string): number | undefined {
  const hours = /(\d+)\s*hr/.exec(text)
  const minutes = /(\d+)\s*min/.exec(text)
  if (!hours && !minutes) return undefined
  return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0)
}

export function createCinemarkAdapter(fetcher: Fetcher): VenueAdapter {
  return {
    id: 'cinemark',
    venues: CINEMARK_VENUES,
    async fetch(venue: VenueRef, range: DateRange): Promise<RawScreening[]> {
      const all: RawScreening[] = []
      for (const date of enumerateDates(range)) {
        const html = await fetcher.text(`${BASE}/${venue.sourceVenueId}?showDate=${date}`)
        all.push(...parseCinemarkScreenings(html, venue))
      }
      return dedupeBySourceId(all)
    },
  }
}

function dedupeBySourceId(screenings: RawScreening[]): RawScreening[] {
  const byId = new Map<string, RawScreening>()
  for (const screening of screenings) byId.set(screening.sourceScreeningId, screening)
  return [...byId.values()]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/cinemark.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify the live date parameter and the Totem Lake slug**

Both were inferred. Confirm before relying on them:

```bash
npx tsx -e "import {Fetcher} from './src/fetch/fetcher.js'; \
const f=new Fetcher(); \
const ids=(s)=>new Set([...s.matchAll(/ShowtimeId=(\d+)/g)].map(m=>m[1])); \
const base='https://www.cinemark.com/theatres/wa-bellevue/cinemark-lincoln-square-cinemas-and-imax'; \
const a=ids(await f.text(base)); \
const b=ids(await f.text(base+'?showDate=2026-08-19')); \
console.log('today',a.size,'dated',b.size,'differs',[...b].some(x=>!a.has(x))); \
const t=await f.text('https://www.cinemark.com/theatres/wa-kirkland/cinemark-totem-lake-and-xd'); \
console.log('totem lake showtimes', ids(t).size);"
```

Expected: `differs true` and a non-zero Totem Lake count.

If `differs` is false, find the real parameter from the date carousel — the fixture contains `a.showdate-link` elements with `data-datevalue` and `data-ajax` attributes:

```bash
grep -oE '<a[^>]*showdate-link[^>]*>' tests/fixtures/cinemark-lincoln-square.html | head -3
grep -oE 'data-ajax[a-z-]*="[^"]*"' tests/fixtures/cinemark-lincoln-square.html | sort -u
```

Correct the URL in `createCinemarkAdapter`, then re-run this step. If Totem Lake returns zero, find its real slug via `https://www.cinemark.com/theatres` and update `CINEMARK_VENUES`.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/cinemark.ts tests/adapters/cinemark.test.ts
git commit -m "feat: add Cinemark adapter"
```

---

### Task 9: Seattle Magic Theater adapter

The `/events` page listed no events when recorded. An empty result is the normal state, so the parser must return `[]` cleanly rather than throwing, and the test must assert that.

**Files:**
- Create: `src/adapters/seattle-magic.ts`
- Test: `tests/adapters/seattle-magic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  parseSeattleMagicScreenings,
  SEATTLE_MAGIC_VENUE,
} from '../../src/adapters/seattle-magic.js'

const html = readFileSync('tests/fixtures/seattle-magic-events.html', 'utf8')

describe('parseSeattleMagicScreenings', () => {
  it('returns an empty array when no events are listed', () => {
    expect(parseSeattleMagicScreenings(html)).toEqual([])
  })

  it('does not throw on the empty page', () => {
    expect(() => parseSeattleMagicScreenings(html)).not.toThrow()
  })

  it('parses an event card when one is present', () => {
    const withEvent = `
      <div class="event" data-event-id="abc123">
        <h3 class="event-title">Midnight Illusions</h3>
        <time datetime="2026-09-12T20:00:00">Sep 12, 8:00 PM</time>
        <a class="event-link" href="/events/midnight-illusions">Tickets</a>
      </div>`
    const [screening] = parseSeattleMagicScreenings(withEvent)

    expect(screening!.rawTitle).toBe('Midnight Illusions')
    expect(screening!.venueId).toBe(SEATTLE_MAGIC_VENUE.id)
    expect(screening!.localDate).toBe('2026-09-12')
    expect(screening!.startsAt.toISOString()).toBe('2026-09-13T03:00:00.000Z')
    expect(screening!.ticketUrl).toBe(
      'https://seattlemagictheater.com/events/midnight-illusions',
    )
  })

  it('falls back to a stable id derived from title and time', () => {
    const noId = `
      <div class="event">
        <h3 class="event-title">Close-Up Night</h3>
        <time datetime="2026-09-20T19:30:00">Sep 20</time>
      </div>`
    const [screening] = parseSeattleMagicScreenings(noId)
    expect(screening!.sourceScreeningId).toBe('close-up-night@2026-09-20T19:30:00')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/seattle-magic.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/seattle-magic.js`.

- [ ] **Step 3: Write the parser and adapter**

The site is hand-rolled with no CMS, so the markup carries no stable contract. The parser targets a conventional `.event` / `.event-title` / `<time datetime>` shape and returns nothing when that shape is absent — which is also what happens when there are genuinely no events.

```ts
import * as cheerio from 'cheerio'
import type { DateRange, RawScreening, VenueAdapter, VenueRef } from '../core/types.js'
import { localDateOf, localWallClockToUtc } from '../core/time.js'
import type { Fetcher } from '../fetch/fetcher.js'

const TZ = 'America/Los_Angeles'
const BASE = 'https://seattlemagictheater.com'

export const SEATTLE_MAGIC_VENUE: VenueRef = {
  id: 'seattle-magic',
  name: 'Seattle Magic Theater',
  chain: 'Independent',
  timezone: TZ,
  sourceVenueId: 'seattle-magic-theater',
}

export function parseSeattleMagicScreenings(html: string): RawScreening[] {
  const $ = cheerio.load(html)
  const results: RawScreening[] = []

  $('.event').each((_, element) => {
    const $event = $(element)
    const rawTitle = $event.find('.event-title').first().text().trim()
    const datetime = $event.find('time[datetime]').first().attr('datetime')
    if (!rawTitle || !datetime) return

    const startsAt = localWallClockToUtc(datetime, TZ)
    const href = $event.find('a[href]').first().attr('href')

    results.push({
      rawTitle,
      startsAt,
      localDate: localDateOf(startsAt, TZ),
      venueId: SEATTLE_MAGIC_VENUE.id,
      ticketUrl: href ? new URL(href, BASE).toString() : `${BASE}/events`,
      sourceScreeningId:
        $event.attr('data-event-id') ?? `${slugify(rawTitle)}@${datetime}`,
      formatHints: [],
    })
  })

  return results
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function createSeattleMagicAdapter(fetcher: Fetcher): VenueAdapter {
  return {
    id: 'seattle-magic',
    venues: [SEATTLE_MAGIC_VENUE],
    async fetch(_venue: VenueRef, _range: DateRange): Promise<RawScreening[]> {
      // The site lists all upcoming events on one page; the range is ignored.
      const html = await fetcher.text(`${BASE}/events`)
      return parseSeattleMagicScreenings(html)
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/seattle-magic.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/seattle-magic.ts tests/adapters/seattle-magic.test.ts
git commit -m "feat: add Seattle Magic Theater adapter"
```

---

### Task 10: Adapter registry

**Files:**
- Create: `src/adapters/index.ts`
- Test: `tests/adapters/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { createAdapters, allVenues } from '../../src/adapters/index.js'
import { Fetcher } from '../../src/fetch/fetcher.js'

describe('createAdapters', () => {
  const adapters = createAdapters(new Fetcher())

  it('registers all three v1 sources', () => {
    expect(adapters.map((a) => a.id).sort()).toEqual([
      'cinemark',
      'seattle-magic',
      'siff',
    ])
  })

  it('exposes every venue with a unique id', () => {
    const ids = allVenues(adapters).map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(7)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters/index.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/index.js`.

- [ ] **Step 3: Write the registry**

```ts
import type { VenueAdapter, VenueRef } from '../core/types.js'
import type { Fetcher } from '../fetch/fetcher.js'
import { createSiffAdapter } from './siff.js'
import { createCinemarkAdapter } from './cinemark.js'
import { createSeattleMagicAdapter } from './seattle-magic.js'

export function createAdapters(fetcher: Fetcher): VenueAdapter[] {
  return [
    createSiffAdapter(fetcher),
    createCinemarkAdapter(fetcher),
    createSeattleMagicAdapter(fetcher),
  ]
}

export function allVenues(adapters: VenueAdapter[]): VenueRef[] {
  return adapters.flatMap((adapter) => adapter.venues)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/index.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/index.ts tests/adapters/index.test.ts
git commit -m "feat: add adapter registry"
```

---

### Task 11: Screening store

`first_seen_at` is set once and never updated — it is what later powers "new since you last looked". A screening missing from two consecutive successful sweeps is marked cancelled, not deleted.

**Files:**
- Create: `src/store/screenings.ts`
- Test: `tests/store/screenings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { venues, screenings } from '../../src/db/schema.js'
import { upsertScreenings, markMissing } from '../../src/store/screenings.js'
import type { RawScreening } from '../../src/core/types.js'

function raw(overrides: Partial<RawScreening> = {}): RawScreening {
  return {
    rawTitle: 'The Odyssey (70mm)',
    startsAt: new Date('2026-08-21T02:15:00.000Z'),
    localDate: '2026-08-20',
    venueId: 'siff-downtown',
    ticketUrl: 'https://www.siff.net/cinema/in-theaters/the-odyssey-70mm',
    sourceScreeningId: 'abc123',
    formatHints: ['70MM'],
    ...overrides,
  }
}

let db: Db

beforeEach(async () => {
  db = createDatabase(':memory:').db
  await db.insert(venues).values({
    id: 'siff-downtown',
    name: 'SIFF Cinema Downtown',
    chain: 'SIFF',
    timezone: 'America/Los_Angeles',
    sourceVenueId: 'siff-cinema-downtown',
    weight: 15,
  })
})

describe('upsertScreenings', () => {
  it('inserts new screenings', async () => {
    const result = await upsertScreenings(db, [raw()], new Date('2026-08-16T12:00:00Z'))

    expect(result.inserted).toBe(1)
    expect(result.updated).toBe(0)
    const rows = await db.select().from(screenings)
    expect(rows[0]!.rawTitle).toBe('The Odyssey (70mm)')
    expect(rows[0]!.formatHints).toEqual(['70MM'])
  })

  it('preserves first_seen_at across re-sweeps', async () => {
    const first = new Date('2026-08-16T12:00:00Z')
    const second = new Date('2026-08-17T12:00:00Z')

    await upsertScreenings(db, [raw()], first)
    const result = await upsertScreenings(db, [raw()], second)

    expect(result.inserted).toBe(0)
    expect(result.updated).toBe(1)
    const rows = await db.select().from(screenings)
    expect(rows[0]!.firstSeenAt.getTime()).toBe(first.getTime())
    expect(rows[0]!.lastSeenAt.getTime()).toBe(second.getTime())
  })

  it('treats the same source id at a different venue as a distinct screening', async () => {
    await db.insert(venues).values({
      id: 'siff-uptown',
      name: 'SIFF Cinema Uptown',
      chain: 'SIFF',
      timezone: 'America/Los_Angeles',
      sourceVenueId: 'siff-cinema-uptown',
      weight: 15,
    })

    await upsertScreenings(db, [raw()], new Date())
    await upsertScreenings(db, [raw({ venueId: 'siff-uptown' })], new Date())

    expect(await db.select().from(screenings)).toHaveLength(2)
  })

  it('updates a changed start time on an existing screening', async () => {
    await upsertScreenings(db, [raw()], new Date('2026-08-16T12:00:00Z'))
    await upsertScreenings(
      db,
      [raw({ startsAt: new Date('2026-08-21T03:00:00.000Z') })],
      new Date('2026-08-17T12:00:00Z'),
    )

    const rows = await db.select().from(screenings)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.startsAtUtc.toISOString()).toBe('2026-08-21T03:00:00.000Z')
  })

  it('resets missed_sweeps when a screening reappears', async () => {
    await upsertScreenings(db, [raw()], new Date('2026-08-16T12:00:00Z'))
    await markMissing(db, 'siff-downtown', ['other-id'])
    await upsertScreenings(db, [raw()], new Date('2026-08-17T12:00:00Z'))

    const rows = await db.select().from(screenings)
    expect(rows[0]!.missedSweeps).toBe(0)
    expect(rows[0]!.cancelled).toBe(false)
  })
})

describe('markMissing', () => {
  it('does not cancel after a single miss', async () => {
    await upsertScreenings(db, [raw()], new Date())
    await markMissing(db, 'siff-downtown', [])

    const rows = await db.select().from(screenings)
    expect(rows[0]!.missedSweeps).toBe(1)
    expect(rows[0]!.cancelled).toBe(false)
  })

  it('cancels after two consecutive misses', async () => {
    await upsertScreenings(db, [raw()], new Date())
    await markMissing(db, 'siff-downtown', [])
    await markMissing(db, 'siff-downtown', [])

    const rows = await db.select().from(screenings)
    expect(rows[0]!.missedSweeps).toBe(2)
    expect(rows[0]!.cancelled).toBe(true)
  })

  it('leaves screenings at other venues untouched', async () => {
    await upsertScreenings(db, [raw()], new Date())
    await markMissing(db, 'cinemark-lincoln-square', [])

    const rows = await db.select().from(screenings)
    expect(rows[0]!.missedSweeps).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store/screenings.test.ts`
Expected: FAIL — cannot resolve `../../src/store/screenings.js`.

- [ ] **Step 3: Write the store**

```ts
import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { screenings } from '../db/schema.js'
import type { RawScreening } from '../core/types.js'

export interface UpsertResult {
  inserted: number
  updated: number
}

/** Two consecutive absences from a successful sweep means cancelled. */
const CANCELLATION_THRESHOLD = 2

export async function upsertScreenings(
  db: Db,
  incoming: RawScreening[],
  now: Date,
): Promise<UpsertResult> {
  let inserted = 0
  let updated = 0

  for (const screening of incoming) {
    const existing = await db
      .select({ id: screenings.id })
      .from(screenings)
      .where(
        and(
          eq(screenings.venueId, screening.venueId),
          eq(screenings.sourceScreeningId, screening.sourceScreeningId),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      await db
        .update(screenings)
        .set({
          rawTitle: screening.rawTitle,
          startsAtUtc: screening.startsAt,
          localDate: screening.localDate,
          ticketUrl: screening.ticketUrl,
          formatHints: screening.formatHints,
          runtimeMinutes: screening.runtimeMinutes ?? null,
          lastSeenAt: now,
          missedSweeps: 0,
          cancelled: false,
        })
        .where(eq(screenings.id, existing[0]!.id))
      updated += 1
    } else {
      await db.insert(screenings).values({
        venueId: screening.venueId,
        filmId: null,
        rawTitle: screening.rawTitle,
        startsAtUtc: screening.startsAt,
        localDate: screening.localDate,
        ticketUrl: screening.ticketUrl,
        sourceScreeningId: screening.sourceScreeningId,
        formatHints: screening.formatHints,
        tags: [],
        runtimeMinutes: screening.runtimeMinutes ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        missedSweeps: 0,
        cancelled: false,
      })
      inserted += 1
    }
  }

  return { inserted, updated }
}

/**
 * Increment the miss counter for screenings at this venue that the sweep did
 * not report, and cancel those that have now been missed twice running.
 *
 * Call only after a SUCCESSFUL fetch — a failed adapter reports nothing, and
 * treating that as "everything was cancelled" would wipe the venue.
 */
export async function markMissing(
  db: Db,
  venueId: string,
  presentSourceIds: string[],
): Promise<void> {
  const notPresent =
    presentSourceIds.length > 0
      ? and(
          eq(screenings.venueId, venueId),
          notInArray(screenings.sourceScreeningId, presentSourceIds),
        )
      : eq(screenings.venueId, venueId)

  await db
    .update(screenings)
    .set({ missedSweeps: sql`${screenings.missedSweeps} + 1` })
    .where(and(notPresent, eq(screenings.cancelled, false)))

  await db
    .update(screenings)
    .set({ cancelled: true })
    .where(
      and(
        eq(screenings.venueId, venueId),
        sql`${screenings.missedSweeps} >= ${CANCELLATION_THRESHOLD}`,
      ),
    )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/store/screenings.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/store/screenings.ts tests/store/screenings.test.ts
git commit -m "feat: add screening store with first-seen and cancellation tracking"
```

---

### Task 12: Source run recording and health

**Files:**
- Create: `src/store/runs.ts`
- Test: `tests/store/runs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { sourceRuns } from '../../src/db/schema.js'
import { recordRun, evaluateHealth } from '../../src/store/runs.js'

let db: Db
beforeEach(() => {
  db = createDatabase(':memory:').db
})

describe('recordRun', () => {
  it('records a successful run', async () => {
    await recordRun(db, {
      source: 'siff',
      startedAt: new Date('2026-08-16T12:00:00Z'),
      finishedAt: new Date('2026-08-16T12:00:30Z'),
      status: 'ok',
      itemCount: 42,
    })

    const rows = await db.select().from(sourceRuns)
    expect(rows[0]!.status).toBe('ok')
    expect(rows[0]!.itemCount).toBe(42)
  })

  it('records a failure with its error message', async () => {
    await recordRun(db, {
      source: 'cinemark',
      startedAt: new Date(),
      finishedAt: new Date(),
      status: 'failed',
      itemCount: 0,
      error: 'GET https://www.cinemark.com/... failed: 503',
    })

    const rows = await db.select().from(sourceRuns)
    expect(rows[0]!.error).toContain('503')
  })
})

describe('evaluateHealth', () => {
  const okRun = (source: string, itemCount: number, day: number) => ({
    source,
    startedAt: new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:00Z`),
    finishedAt: new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:30Z`),
    status: 'ok' as const,
    itemCount,
  })

  it('reports healthy when counts are steady', async () => {
    for (let day = 10; day <= 16; day++) await recordRun(db, okRun('siff', 40, day))

    const health = await evaluateHealth(db, ['siff'])
    expect(health[0]!.healthy).toBe(true)
  })

  it('flags a source whose count halved against its median', async () => {
    for (let day = 10; day <= 15; day++) await recordRun(db, okRun('siff', 40, day))
    await recordRun(db, okRun('siff', 5, 16))

    const health = await evaluateHealth(db, ['siff'])
    expect(health[0]!.healthy).toBe(false)
    expect(health[0]!.reason).toContain('dropped')
  })

  it('flags a source whose latest run failed', async () => {
    await recordRun(db, okRun('cinemark', 100, 15))
    await recordRun(db, {
      source: 'cinemark',
      startedAt: new Date('2026-08-16T12:00:00Z'),
      finishedAt: new Date('2026-08-16T12:00:05Z'),
      status: 'failed',
      itemCount: 0,
      error: 'boom',
    })

    const health = await evaluateHealth(db, ['cinemark'])
    expect(health[0]!.healthy).toBe(false)
    expect(health[0]!.reason).toContain('failed')
  })

  it('exempts seattle-magic from the count check', async () => {
    for (let day = 10; day <= 15; day++) await recordRun(db, okRun('seattle-magic', 3, day))
    await recordRun(db, okRun('seattle-magic', 0, 16))

    const health = await evaluateHealth(db, ['seattle-magic'])
    expect(health[0]!.healthy).toBe(true)
  })

  it('reports a source that has never run as unhealthy', async () => {
    const health = await evaluateHealth(db, ['siff'])
    expect(health[0]!.healthy).toBe(false)
    expect(health[0]!.reason).toContain('never run')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store/runs.test.ts`
Expected: FAIL — cannot resolve `../../src/store/runs.js`.

- [ ] **Step 3: Write the implementation**

```ts
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { sourceRuns } from '../db/schema.js'

export interface RunRecord {
  source: string
  startedAt: Date
  finishedAt: Date
  status: 'ok' | 'failed'
  itemCount: number
  error?: string
}

export interface SourceHealth {
  source: string
  healthy: boolean
  reason?: string
}

/** Zero events is normal here, so the count check does not apply. */
const COUNT_CHECK_EXEMPT = new Set(['seattle-magic'])

/** Flag when the latest count falls below this fraction of the median. */
const DROP_RATIO = 0.5

/** Number of prior successful runs used to compute the baseline. */
const BASELINE_WINDOW = 7

export async function recordRun(db: Db, record: RunRecord): Promise<void> {
  await db.insert(sourceRuns).values({
    source: record.source,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    status: record.status,
    itemCount: record.itemCount,
    error: record.error ?? null,
  })
}

export async function evaluateHealth(db: Db, sources: string[]): Promise<SourceHealth[]> {
  const health: SourceHealth[] = []

  for (const source of sources) {
    const runs = await db
      .select()
      .from(sourceRuns)
      .where(eq(sourceRuns.source, source))
      .orderBy(desc(sourceRuns.startedAt))
      .limit(BASELINE_WINDOW + 1)

    const latest = runs[0]
    if (!latest) {
      health.push({ source, healthy: false, reason: 'never run' })
      continue
    }

    if (latest.status === 'failed') {
      health.push({
        source,
        healthy: false,
        reason: `last run failed: ${latest.error ?? 'unknown error'}`,
      })
      continue
    }

    if (COUNT_CHECK_EXEMPT.has(source)) {
      health.push({ source, healthy: true })
      continue
    }

    const priorCounts = runs
      .slice(1)
      .filter((run) => run.status === 'ok')
      .map((run) => run.itemCount)

    const baseline = median(priorCounts)
    if (baseline > 0 && latest.itemCount < baseline * DROP_RATIO) {
      health.push({
        source,
        healthy: false,
        reason: `count dropped to ${latest.itemCount} from a median of ${baseline}`,
      })
      continue
    }

    health.push({ source, healthy: true })
  }

  return health
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/store/runs.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/store/runs.ts tests/store/runs.test.ts
git commit -m "feat: add source run recording and health evaluation"
```

---

### Task 13: Sweep orchestrator

One adapter failing must not abort the sweep or destroy that venue's existing data.

**Files:**
- Create: `src/sweep/sweep.ts`
- Test: `tests/sweep/sweep.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { venues, screenings, sourceRuns } from '../../src/db/schema.js'
import { runSweep } from '../../src/sweep/sweep.js'
import type { VenueAdapter, VenueRef, RawScreening } from '../../src/core/types.js'

const TZ = 'America/Los_Angeles'
const venueA: VenueRef = {
  id: 'venue-a', name: 'Venue A', chain: 'Test', timezone: TZ, sourceVenueId: 'a',
}

function screening(id: string): RawScreening {
  return {
    rawTitle: 'Test Film',
    startsAt: new Date('2026-08-21T02:15:00.000Z'),
    localDate: '2026-08-20',
    venueId: 'venue-a',
    ticketUrl: 'https://example.com/t',
    sourceScreeningId: id,
    formatHints: [],
  }
}

function stubAdapter(id: string, result: RawScreening[] | Error): VenueAdapter {
  return {
    id,
    venues: [venueA],
    async fetch() {
      if (result instanceof Error) throw result
      return result
    },
  }
}

let db: Db
beforeEach(async () => {
  db = createDatabase(':memory:').db
  await db.insert(venues).values({ ...venueA, weight: 0 })
})

describe('runSweep', () => {
  const range = { from: '2026-08-16', to: '2026-08-20' }

  it('stores screenings and records a successful run', async () => {
    await runSweep(db, [stubAdapter('good', [screening('s1')])], range, new Date())

    expect(await db.select().from(screenings)).toHaveLength(1)
    const runs = await db.select().from(sourceRuns)
    expect(runs[0]!.status).toBe('ok')
    expect(runs[0]!.itemCount).toBe(1)
  })

  it('records a failed run without throwing', async () => {
    await expect(
      runSweep(db, [stubAdapter('bad', new Error('network down'))], range, new Date()),
    ).resolves.toBeDefined()

    const runs = await db.select().from(sourceRuns)
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toContain('network down')
  })

  it('does not mark screenings missing when the adapter failed', async () => {
    await runSweep(db, [stubAdapter('good', [screening('s1')])], range, new Date())
    await runSweep(db, [stubAdapter('good', new Error('network down'))], range, new Date())

    const rows = await db.select().from(screenings)
    expect(rows[0]!.missedSweeps).toBe(0)
    expect(rows[0]!.cancelled).toBe(false)
  })

  it('marks screenings missing after a successful sweep that omits them', async () => {
    await runSweep(db, [stubAdapter('good', [screening('s1')])], range, new Date())
    await runSweep(db, [stubAdapter('good', [screening('s2')])], range, new Date())

    const rows = await db.select().from(screenings)
    const gone = rows.find((r) => r.sourceScreeningId === 's1')!
    expect(gone.missedSweeps).toBe(1)
  })

  it('continues to later adapters when an earlier one fails', async () => {
    const result = await runSweep(
      db,
      [
        stubAdapter('bad', new Error('boom')),
        stubAdapter('good', [screening('s1')]),
      ],
      range,
      new Date(),
    )

    expect(result.map((r) => r.status).sort()).toEqual(['failed', 'ok'])
    expect(await db.select().from(screenings)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/sweep/sweep.test.ts`
Expected: FAIL — cannot resolve `../../src/sweep/sweep.js`.

- [ ] **Step 3: Write the orchestrator**

```ts
import type { Db } from '../db/client.js'
import type { DateRange, RawScreening, VenueAdapter } from '../core/types.js'
import { upsertScreenings, markMissing } from '../store/screenings.js'
import { recordRun } from '../store/runs.js'

export interface SweepResult {
  source: string
  status: 'ok' | 'failed'
  itemCount: number
  error?: string
}

export async function runSweep(
  db: Db,
  adapters: VenueAdapter[],
  range: DateRange,
  now: Date,
): Promise<SweepResult[]> {
  const results: SweepResult[] = []

  // Sequential by design: adapters are staggered rather than concurrent so the
  // shared per-host rate limit is never the bottleneck for an unrelated source.
  for (const adapter of adapters) {
    const startedAt = new Date()
    try {
      const byVenue = new Map<string, RawScreening[]>()

      for (const venue of adapter.venues) {
        const fetched = await adapter.fetch(venue, range)
        for (const screening of fetched) {
          const bucket = byVenue.get(screening.venueId) ?? []
          bucket.push(screening)
          byVenue.set(screening.venueId, bucket)
        }
      }

      let itemCount = 0
      for (const [venueId, screenings] of byVenue) {
        const result = await upsertScreenings(db, screenings, now)
        itemCount += result.inserted + result.updated
        await markMissing(db, venueId, screenings.map((s) => s.sourceScreeningId))
      }

      await recordRun(db, {
        source: adapter.id,
        startedAt,
        finishedAt: new Date(),
        status: 'ok',
        itemCount,
      })
      results.push({ source: adapter.id, status: 'ok', itemCount })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await recordRun(db, {
        source: adapter.id,
        startedAt,
        finishedAt: new Date(),
        status: 'failed',
        itemCount: 0,
        error: message,
      })
      results.push({ source: adapter.id, status: 'failed', itemCount: 0, error: message })
    }
  }

  return results
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/sweep/sweep.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sweep/sweep.ts tests/sweep/sweep.test.ts
git commit -m "feat: add sweep orchestrator with per-source isolation"
```

---

### Task 14: CLI and venue seeding

**Files:**
- Create: `src/cli.ts`, `src/db/seed.ts`
- Test: `tests/db/seed.test.ts`

- [ ] **Step 1: Write the failing test for seeding**

```ts
import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/db/client.js'
import { venues } from '../../src/db/schema.js'
import { seedVenues } from '../../src/db/seed.js'
import { createAdapters, allVenues } from '../../src/adapters/index.js'
import { Fetcher } from '../../src/fetch/fetcher.js'

describe('seedVenues', () => {
  it('inserts every adapter venue', async () => {
    const { db } = createDatabase(':memory:')
    const expected = allVenues(createAdapters(new Fetcher()))

    await seedVenues(db, expected)

    expect(await db.select().from(venues)).toHaveLength(expected.length)
  })

  it('is idempotent', async () => {
    const { db } = createDatabase(':memory:')
    const expected = allVenues(createAdapters(new Fetcher()))

    await seedVenues(db, expected)
    await seedVenues(db, expected)

    expect(await db.select().from(venues)).toHaveLength(expected.length)
  })

  it('weights SIFF and Seattle Magic above the chains', async () => {
    const { db } = createDatabase(':memory:')
    await seedVenues(db, allVenues(createAdapters(new Fetcher())))

    const rows = await db.select().from(venues)
    const siff = rows.find((v) => v.id === 'siff-uptown')!
    const cinemark = rows.find((v) => v.id === 'cinemark-lincoln-square')!
    expect(siff.weight).toBeGreaterThan(cinemark.weight)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/seed.test.ts`
Expected: FAIL — cannot resolve `../../src/db/seed.js`.

- [ ] **Step 3: Write the seeder**

```ts
import type { Db } from './client.js'
import { venues } from './schema.js'
import type { VenueRef } from '../core/types.js'

/** Independent and repertory venues outrank the chains. See spec: venue weight. */
const WEIGHTED_CHAINS: Record<string, number> = {
  SIFF: 15,
  Independent: 15,
}

export async function seedVenues(db: Db, refs: VenueRef[]): Promise<void> {
  for (const ref of refs) {
    await db
      .insert(venues)
      .values({
        id: ref.id,
        name: ref.name,
        chain: ref.chain,
        timezone: ref.timezone,
        sourceVenueId: ref.sourceVenueId,
        weight: WEIGHTED_CHAINS[ref.chain] ?? 0,
      })
      .onConflictDoUpdate({
        target: venues.id,
        set: { name: ref.name, chain: ref.chain, sourceVenueId: ref.sourceVenueId },
      })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/db/seed.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the CLI**

```ts
import { DateTime } from 'luxon'
import { createDatabase } from './db/client.js'
import { seedVenues } from './db/seed.js'
import { createAdapters, allVenues } from './adapters/index.js'
import { Fetcher } from './fetch/fetcher.js'
import { runSweep } from './sweep/sweep.js'
import { evaluateHealth } from './store/runs.js'

const DB_PATH = process.env.DATABASE_PATH ?? 'data/cinema-tracker.db'
const FETCH_WINDOW_DAYS = 21
const TZ = 'America/Los_Angeles'

async function sweep(): Promise<void> {
  const { db, close } = createDatabase(DB_PATH)
  try {
    const fetcher = new Fetcher()
    const adapters = createAdapters(fetcher)
    await seedVenues(db, allVenues(adapters))

    const today = DateTime.now().setZone(TZ)
    const range = {
      from: today.toISODate()!,
      to: today.plus({ days: FETCH_WINDOW_DAYS }).toISODate()!,
    }

    console.log(`Sweeping ${range.from} → ${range.to}`)
    const results = await runSweep(db, adapters, range, new Date())

    for (const result of results) {
      const detail = result.status === 'ok' ? `${result.itemCount} screenings` : result.error
      console.log(`  ${result.source}: ${result.status} — ${detail}`)
    }

    const health = await evaluateHealth(db, adapters.map((a) => a.id))
    const unhealthy = health.filter((h) => !h.healthy)
    if (unhealthy.length > 0) {
      console.log('\nUnhealthy sources:')
      for (const entry of unhealthy) console.log(`  ${entry.source}: ${entry.reason}`)
      process.exitCode = 1
    }
  } finally {
    close()
  }
}

const command = process.argv[2]
if (command === 'sweep') {
  await sweep()
} else {
  console.error('Usage: cli.ts sweep')
  process.exit(1)
}
```

- [ ] **Step 6: Run a real sweep**

```bash
mkdir -p data
npx tsx src/cli.ts sweep
```

Expected: each source reports `ok` with a non-zero screening count, except `seattle-magic`, which legitimately reports `0`. `seattle-magic` will also be listed as unhealthy on the very first run, because it has no prior successful run to compare against — that resolves on the second sweep.

- [ ] **Step 7: Confirm real data landed**

```bash
npx tsx -e "import {createDatabase} from './src/db/client.js'; \
import {screenings} from './src/db/schema.js'; \
const {db}=createDatabase('data/cinema-tracker.db'); \
const rows=await db.select().from(screenings); \
console.log('total',rows.length); \
console.log('by venue',Object.entries(rows.reduce((a,r)=>{a[r.venueId]=(a[r.venueId]||0)+1;return a},{}))); \
console.log('sample',rows.slice(0,3).map(r=>({t:r.rawTitle,d:r.localDate,f:r.formatHints})));"
```

Expected: several hundred screenings spread across the SIFF and Cinemark venues, with plausible titles and dates. If a venue has zero rows, that adapter's live fetch is broken even though its parser tests pass — revisit the URL-construction step in that adapter's task.

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass; no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/cli.ts src/db/seed.ts tests/db/seed.test.ts
git commit -m "feat: add venue seeding and sweep CLI"
```

---

## Done when

- `npx vitest run` passes and `npx tsc --noEmit` is clean.
- `npx tsx src/cli.ts sweep` populates `data/cinema-tracker.db` with real screenings from SIFF and both Cinemark venues.
- Re-running the sweep leaves `first_seen_at` unchanged on existing rows.
- A deliberately broken adapter URL produces a `failed` row in `source_runs` and leaves that venue's stored screenings intact.

## Notes for the next plan

- `screenings.film_id` is null everywhere and `tags` is empty. Plan 2 fills both.
- `enumerateDates` lives in `src/adapters/siff.ts` and is imported by the Cinemark adapter. If a third caller appears, move it to `src/core/time.ts`.
- The sweep is CLI-invoked only. The 6-hour scheduler the spec calls for is
  deferred to Plan 3, where it runs in the same process as the HTTP server.
- The SIFF ticket URL is a film-page link, not a direct checkout link — SIFF's booking flow is a JavaScript modal backed by Elevent. Revisit if click-through proves annoying in the UI.
