# Taste and Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a flat list of screenings into a ranked highlight feed, using the owner's Letterboxd history as the taste signal.

**Architecture:** Letterboxd ingestion (CSV backfill, RSS incremental, watchlist crawl) populates `letterboxd_entries` and `watchlist`. A derivation step turns rated films into `taste_affinities` over genre, language, director, and decade. A rule-based tag extractor reads title, description, and format hints. A pure scoring function combines all of it into `{ score, reasons[] }`.

**Tech Stack:** TypeScript on Node 22, better-sqlite3 + Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-cinema-tracker-design.md`
**Read first:** `AGENTS.md`

---

## Prerequisites

- `main` includes PR #4 (AMC adapter). Verify `src/adapters/amc.ts` exists before starting.
- **Optional but recommended:** a Letterboxd data export at `data/letterboxd/`
  (`ratings.csv`, `watchlist.csv`, `diary.csv`). Without it the system falls back
  to RSS, which reaches only the 50 most recent diary entries. Task 4 must work
  either way and must not fail when the export is absent.

## Verified source facts (2026-08-22)

Account `TheThomp`. All confirmed by direct probe.

- **`letterboxd.com/thethomp/rss/`** — `application/rss+xml`, 50 most recent diary
  entries. Every item carries `tmdb:movieId`; 47 of 50 carry
  `letterboxd:memberRating`. Also `letterboxd:filmTitle`, `filmYear`,
  `watchedDate`, `rewatch`, `memberLike`. **TMDB ids mean rated films need no
  title resolution.**
- **`letterboxd.com/thethomp/watchlist/page/N/`** — paginated HTML, 28 per page,
  currently 9 pages (~240 films). Each entry is a `li.griditem` containing a
  `div.react-component` with:
  `data-item-name="Streetwise (1984)"`, `data-item-slug="streetwise"`,
  `data-item-link="/film/streetwise/"`.
  **`data-item-name` embeds the year in parentheses** — parse it out and use
  title+year for resolution. No TMDB ids here.
- **`letterboxd.com/thethomp/films/ratings/`** — Cloudflare challenge (403).
  **Do not scrape ratings pages.** RSS and CSV only.

## Scoring model

From the spec, with weights seeded in `taste_rules` and editable:

| Signal | Weight |
|---|---|
| Watchlist match (manual or Letterboxd) | +100 |
| Declared preference match (seeded: Horror) | +60 |
| Special-event tag (`70MM`, `35MM`, `LIVE_SCORE`, `Q_AND_A`, `ANNIVERSARY`) | +50 |
| Letterboxd strong affinity | +30 |
| Non-English original language | +20 |
| Preferred genre match | +15 |
| Venue weight (SIFF, Independent) | +15 |
| `IMAX` tag | +10 |
| Already watched, no special-event tag | −80 |

Highlight threshold: **score ≥ 40**.

Two rules that are easy to get wrong:

1. **Declared preferences are weighted above the threshold on purpose.** Horror at
   +60 must reach the feed unaided, without needing any other signal.
2. **Already-watched suppression is waived for special-event screenings.** A 70mm
   print of something already seen is exactly the rewatch worth surfacing.
   Horror scores 60 against −80, so a horror film already logged does *not*
   resurface unless the screening carries a special-event tag. That is intentional
   and is the first thing to revisit if the feed feels wrong.

## File structure

| File | Responsibility |
|---|---|
| `src/letterboxd/rss.ts` | Pure RSS parsing. |
| `src/letterboxd/watchlist.ts` | Pure watchlist HTML parsing. |
| `src/letterboxd/csv.ts` | Pure CSV parsing. |
| `src/letterboxd/sync.ts` | Fetching and storing. The only part with I/O. |
| `src/taste/affinities.ts` | Derive affinities from rated films. |
| `src/tags/extract.ts` | Rule-based tag extraction. |
| `src/score/score.ts` | Pure scoring function. |
| `src/score/run.ts` | Batch scoring over stored screenings. |

---

### Task 1: Schema for taste, tags, and descriptions

**Files:** Modify `src/db/schema.ts`, `src/db/client.ts`, `src/store/screenings.ts`, `src/core/types.ts` (no change expected — `description` already exists on `RawScreening`). Test: `tests/db/taste-schema.test.ts`

**The `description` column is the important part.** The AMC adapter already produces
`RawScreening.description` containing programming strands like `AMC Artisan Films`
and `Event` — strong noteworthy signal that is currently **discarded at the store
boundary** because `screenings` has no column for it. Every sweep throws it away.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/db/client.js'
import { venues, screenings, letterboxdEntries, watchlist, tasteAffinities, tasteRules, appState } from '../../src/db/schema.js'
import { upsertScreenings } from '../../src/store/screenings.js'

describe('taste schema', () => {
  it('persists a screening description', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(venues).values({
      id: 'v1', name: 'V', chain: 'AMC',
      timezone: 'America/Los_Angeles', sourceVenueId: '1', weight: 0,
    })

    await upsertScreenings(db, [{
      rawTitle: 'The Odyssey',
      startsAt: new Date('2026-08-20T02:00:00Z'),
      localDate: '2026-08-19',
      venueId: 'v1',
      ticketUrl: 'https://example.com',
      sourceScreeningId: 's1',
      formatHints: ['70MM'],
      description: 'AMC Artisan Films, Reserved Seating, 70mm',
    }], new Date())

    const rows = await db.select().from(screenings)
    expect(rows[0]!.description).toBe('AMC Artisan Films, Reserved Seating, 70mm')
  })

  it('leaves description null when the adapter supplies none', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(venues).values({
      id: 'v1', name: 'V', chain: 'SIFF',
      timezone: 'America/Los_Angeles', sourceVenueId: '1', weight: 15,
    })
    await upsertScreenings(db, [{
      rawTitle: 'X', startsAt: new Date(), localDate: '2026-08-19',
      venueId: 'v1', ticketUrl: 'https://e.com', sourceScreeningId: 's1', formatHints: [],
    }], new Date())

    expect((await db.select().from(screenings))[0]!.description).toBeNull()
  })

  it('stores a letterboxd diary entry', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(letterboxdEntries).values({
      kind: 'diary', filmSlug: 'videodrome', tmdbId: 837,
      title: 'Videodrome', year: 1983, memberRating: 4.5,
      watchedDate: '2026-08-12', rewatch: false, liked: true, syncedAt: new Date(),
    })
    const rows = await db.select().from(letterboxdEntries)
    expect(rows[0]!.memberRating).toBe(4.5)
    expect(rows[0]!.kind).toBe('diary')
  })

  it('stores watchlist, affinities, rules, and app state', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(watchlist).values({ filmId: null, titlePattern: 'Blue Velvet', addedAt: new Date(), source: 'letterboxd' })
    await db.insert(tasteAffinities).values({ dimension: 'genre', value: 'Horror', meanRating: 4.2, sampleCount: 12, weight: 30 })
    await db.insert(tasteRules).values({ kind: 'declared', value: 'Horror', weight: 60, enabled: true })
    await db.insert(appState).values({ key: 'last_visit_at', value: '2026-08-22T00:00:00Z' })

    expect(await db.select().from(watchlist)).toHaveLength(1)
    expect((await db.select().from(tasteAffinities))[0]!.sampleCount).toBe(12)
    expect((await db.select().from(tasteRules))[0]!.weight).toBe(60)
    expect((await db.select().from(appState))[0]!.value).toBe('2026-08-22T00:00:00Z')
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Add to `src/db/schema.ts`**

Add `description: text('description')` to the existing `screenings` table
definition, then add these tables:

```ts
export const letterboxdEntries = sqliteTable('letterboxd_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['diary', 'watchlist'] }).notNull(),
  filmSlug: text('film_slug').notNull(),
  tmdbId: integer('tmdb_id'),
  title: text('title').notNull(),
  year: integer('year'),
  memberRating: real('member_rating'),
  watchedDate: text('watched_date'),
  rewatch: integer('rewatch', { mode: 'boolean' }).notNull().default(false),
  liked: integer('liked', { mode: 'boolean' }).notNull().default(false),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
})

export const watchlist = sqliteTable('watchlist', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filmId: integer('film_id'),
  titlePattern: text('title_pattern').notNull(),
  year: integer('year'),
  addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull(),
  notes: text('notes'),
  source: text('source', { enum: ['manual', 'letterboxd'] }).notNull(),
})

export const tasteAffinities = sqliteTable('taste_affinities', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dimension: text('dimension', { enum: ['genre', 'language', 'director', 'decade'] }).notNull(),
  value: text('value').notNull(),
  meanRating: real('mean_rating').notNull(),
  sampleCount: integer('sample_count').notNull(),
  weight: real('weight').notNull(),
})

export const tasteRules = sqliteTable('taste_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['declared', 'genre', 'language', 'venue', 'tag'] }).notNull(),
  value: text('value').notNull(),
  weight: real('weight').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
})

export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
```

- [ ] **Step 4: Add DDL to `src/db/client.ts`**

Append to `CREATE_STATEMENTS` — **additive only**, do not reorder or modify
existing statements:

```sql
ALTER TABLE screenings ADD COLUMN description TEXT
```

`ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` in SQLite and throws
`duplicate column name` on the second run. Guard it rather than adding it to the
array — run it inside a try/catch that swallows only that specific error, or
check `PRAGMA table_info(screenings)` first. **Check the pragma; do not blanket
catch**, because swallowing real errors here would hide schema corruption.

Then the five tables as ordinary `CREATE TABLE IF NOT EXISTS` statements matching
the Drizzle definitions above, plus:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS letterboxd_entries_key
  ON letterboxd_entries (kind, film_slug, IFNULL(watched_date, ''))
CREATE UNIQUE INDEX IF NOT EXISTS taste_affinities_key
  ON taste_affinities (dimension, value)
CREATE UNIQUE INDEX IF NOT EXISTS watchlist_key
  ON watchlist (title_pattern, IFNULL(year, 0))
```

- [ ] **Step 5: Thread `description` through `upsertScreenings`**

In `src/store/screenings.ts`, add `description: screening.description ?? null` to
both the insert values and the update `set` clause.

- [ ] **Step 6: Verify it migrates the live database without loss**

```bash
cp data/cinema-tracker.db /tmp/taste-migrate.db
cat > /tmp/m.ts <<'EOF'
import { createDatabase } from '/Users/thomp/git/cinema-tracker/src/db/client.js'
import { screenings, films } from '/Users/thomp/git/cinema-tracker/src/db/schema.js'
async function main() {
  for (let i = 0; i < 2; i++) {   // twice, to prove the ALTER guard is idempotent
    const { db, close } = createDatabase('/tmp/taste-migrate.db')
    console.log(`open ${i + 1}: screenings ${(await db.select().from(screenings)).length}, films ${(await db.select().from(films)).length}`)
    close()
  }
}
main()
EOF
npx tsx /tmp/m.ts
```

Expected: identical counts on both opens, no `duplicate column name` error.
**Opening twice is the point** — a naive ALTER passes the first run and throws on
every run after.

- [ ] **Step 7:** `npx vitest run` — full suite green.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/client.ts src/store/screenings.ts tests/db/taste-schema.test.ts
git commit -m "feat: add taste tables and persist screening descriptions"
```

---

### Task 2: Letterboxd RSS parser

**Files:** Create `src/letterboxd/rss.ts`, test `tests/letterboxd/rss.test.ts`, fixture `tests/fixtures/letterboxd-rss.xml`

- [ ] **Step 1: Record the fixture**

```bash
npx tsx scripts/record-fixture.ts "https://letterboxd.com/thethomp/rss/" letterboxd-rss xml
```

Confirm it contains `tmdb:movieId` and `letterboxd:memberRating`:

```bash
grep -c 'tmdb:movieId' tests/fixtures/letterboxd-rss.xml
grep -c 'letterboxd:memberRating' tests/fixtures/letterboxd-rss.xml
```

Expected: roughly 50 and 47. **If either is 0, the feed shape changed** — stop and
report rather than writing a parser against a guess.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseLetterboxdRss } from '../../src/letterboxd/rss.js'

const xml = readFileSync('tests/fixtures/letterboxd-rss.xml', 'utf8')

describe('parseLetterboxdRss', () => {
  const entries = parseLetterboxdRss(xml)

  it('parses every diary item in the feed', () => {
    expect(entries.length).toBeGreaterThan(30)
  })

  it('carries the TMDB id, so no title resolution is needed', () => {
    expect(entries.every((e) => typeof e.tmdbId === 'number')).toBe(true)
  })

  it('parses ratings as numbers and leaves unrated entries undefined', () => {
    const rated = entries.filter((e) => e.memberRating !== undefined)
    expect(rated.length).toBeGreaterThan(20)
    for (const entry of rated) {
      expect(entry.memberRating).toBeGreaterThanOrEqual(0.5)
      expect(entry.memberRating).toBeLessThanOrEqual(5)
    }
  })

  it('parses the watched date as an ISO day', () => {
    for (const entry of entries) {
      if (entry.watchedDate) expect(entry.watchedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('derives the film slug from the entry link', () => {
    expect(entries.every((e) => /^[a-z0-9-]+$/.test(e.filmSlug))).toBe(true)
  })

  it('parses rewatch and like flags', () => {
    for (const entry of entries) {
      expect(typeof entry.rewatch).toBe('boolean')
      expect(typeof entry.liked).toBe('boolean')
    }
  })

  it('returns an empty list for a feed with no items', () => {
    expect(parseLetterboxdRss('<rss><channel></channel></rss>')).toEqual([])
  })

  it('throws on malformed xml rather than returning nothing', () => {
    expect(() => parseLetterboxdRss('not xml at all <<<')).toThrow()
  })
})
```

Add one golden-record assertion pinning the newest entry's exact title, tmdbId,
rating, and watchedDate, read from the fixture you just recorded. Per `AGENTS.md`,
shape assertions alone do not detect partial rot.

- [ ] **Step 3: Run to verify it fails.**

- [ ] **Step 4: Implement `src/letterboxd/rss.ts`**

Use a small XML approach rather than adding a dependency — the feed is simple and
regex-per-item over `<item>...</item>` blocks is adequate and dependency-free.
Namespaced tags appear literally as `<letterboxd:memberRating>` and
`<tmdb:movieId>` in the raw XML.

```ts
export interface LetterboxdDiaryEntry {
  filmSlug: string
  tmdbId?: number
  title: string
  year?: number
  memberRating?: number
  watchedDate?: string
  rewatch: boolean
  liked: boolean
}

const ITEM = /<item>([\s\S]*?)<\/item>/g

function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)
  if (!match) return undefined
  return match[1]!
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .trim() || undefined
}

export function parseLetterboxdRss(xml: string): LetterboxdDiaryEntry[] {
  if (!/<rss[\s>]/.test(xml)) throw new Error('not a Letterboxd RSS feed')

  const entries: LetterboxdDiaryEntry[] = []
  for (const match of xml.matchAll(ITEM)) {
    const block = match[1]!
    const title = tag(block, 'letterboxd:filmTitle')
    const link = tag(block, 'link')
    if (!title || !link) continue

    const slug = /\/film\/([a-z0-9-]+)/.exec(link)?.[1]
    if (!slug) continue

    const rating = tag(block, 'letterboxd:memberRating')
    const year = tag(block, 'letterboxd:filmYear')
    const tmdbId = tag(block, 'tmdb:movieId')

    entries.push({
      filmSlug: slug,
      tmdbId: tmdbId ? Number(tmdbId) : undefined,
      title,
      year: year ? Number(year) : undefined,
      memberRating: rating ? Number(rating) : undefined,
      watchedDate: tag(block, 'letterboxd:watchedDate'),
      rewatch: tag(block, 'letterboxd:rewatch')?.toLowerCase() === 'yes',
      liked: tag(block, 'letterboxd:memberLike')?.toLowerCase() === 'true',
    })
  }
  return entries
}
```

- [ ] **Step 5:** `npx vitest run tests/letterboxd/rss.test.ts` — expect 9 passing.

- [ ] **Step 6: Commit** — `feat: add Letterboxd diary RSS parser`

---

### Task 3: Letterboxd watchlist parser

**Files:** Create `src/letterboxd/watchlist.ts`, test `tests/letterboxd/watchlist.test.ts`, fixture `tests/fixtures/letterboxd-watchlist.html`

Verified markup: each entry is a `li.griditem` containing a `div.react-component`
with `data-item-name="Streetwise (1984)"`, `data-item-slug="streetwise"`,
`data-item-link="/film/streetwise/"`. 28 per page, currently 9 pages.

- [ ] **Step 1: Record the fixture**

```bash
npx tsx scripts/record-fixture.ts "https://letterboxd.com/thethomp/watchlist/" letterboxd-watchlist
grep -c 'data-item-slug=' tests/fixtures/letterboxd-watchlist.html
```

Expected: 28. If 0, the markup changed — stop and report.

- [ ] **Step 2: Write the failing test**

Cover: parses 28 entries from the fixture; splits `"Streetwise (1984)"` into title
`Streetwise` and year `1984`; handles a name with no year (year undefined, title
intact); handles a title that itself contains parentheses; reports the highest
pagination number found; returns `[]` for markup with no entries. Include one
golden record with exact title, year, and slug.

- [ ] **Step 3: Implement `src/letterboxd/watchlist.ts`**

Export a pure `parseWatchlistPage(html)` returning `{ entries, maxPage }`, where
each entry is `{ filmSlug, title, year? }`. Parse the year with a **trailing**
`\s+\((\d{4})\)$` match on `data-item-name`, so a title containing parentheses
keeps them. Derive `maxPage` from `/watchlist/page/(\d+)/` links, defaulting to 1.

Use cheerio, consistent with the other HTML parsers.

- [ ] **Step 4:** run tests — expect 7 passing.

- [ ] **Step 5: Commit** — `feat: add Letterboxd watchlist parser`

---

### Task 4: Letterboxd CSV import

**Files:** Create `src/letterboxd/csv.ts`, test `tests/letterboxd/csv.test.ts`

Letterboxd's export contains `ratings.csv`, `watchlist.csv`, and `diary.csv`.
**Do not assume exact column names.** Match headers case-insensitively and
tolerate missing optional columns. Known/expected headers:

- `ratings.csv` — `Date`, `Name`, `Year`, `Letterboxd URI`, `Rating`
- `watchlist.csv` — `Date`, `Name`, `Year`, `Letterboxd URI`
- `diary.csv` — `Date`, `Name`, `Year`, `Letterboxd URI`, `Rating`, `Rewatch`, `Watched Date`

Required in all cases: `Name`. Everything else is optional; a row missing `Name`
is skipped, not fatal.

- [ ] **Step 1: Write the failing test**

Write CSV fixtures inline in the test (no network, no user data committed). Cover:
parses a ratings export into entries with numeric ratings; parses a watchlist
export; derives `filmSlug` from the `Letterboxd URI` when present and from the
title when not; skips a row with no `Name`; handles quoted fields containing
commas; handles a `Rating` column that is empty; is case-insensitive on headers;
returns `[]` for an empty file or a header-only file.

**Do not add a CSV dependency.** Write a small parser handling quoted fields and
escaped quotes — this is a known-shape file, not arbitrary CSV.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/letterboxd/csv.ts`**

Export `parseLetterboxdCsv(text, kind: 'diary' | 'watchlist')` returning the same
entry shape as the RSS parser, minus `tmdbId` (the export carries none).

- [ ] **Step 4:** run tests — expect 9 passing.

- [ ] **Step 5: Commit** — `feat: add Letterboxd CSV export parser`

---

### Task 5: Letterboxd sync

**Files:** Create `src/letterboxd/sync.ts`, test `tests/letterboxd/sync.test.ts`

The only part of Letterboxd handling that does I/O. It records `source_runs` rows
like an adapter, so failures surface in the health view.

- [ ] **Step 1: Write the failing test**

Cover, with a stubbed fetcher and in-memory database:

- RSS entries are upserted into `letterboxd_entries` with `kind = 'diary'`.
- Re-running is idempotent — no duplicate rows, ratings refreshed.
- Watchlist crawl follows pagination up to `maxPage` and stores `kind = 'watchlist'`.
- Watchlist entries also populate the `watchlist` table with `source = 'letterboxd'`.
- **A manual watchlist row is never overwritten or deleted by a sync.**
- A CSV import at a supplied directory backfills entries; **a missing directory is
  not an error** and the sync proceeds with RSS only.
- A failing fetch records a `failed` `source_runs` row and does not throw.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/letterboxd/sync.ts`**

`syncLetterboxd(db, fetcher, { username, csvDir? }, now)` →
`{ diaryEntries, watchlistEntries, source: 'letterboxd' }`.

Order: CSV backfill if present, then RSS, then watchlist crawl. Upsert on
`(kind, film_slug, watched_date)`. Rate limiting comes from the shared `Fetcher`;
the watchlist crawl is one request per page.

- [ ] **Step 4:** run tests — expect 7 passing.

- [ ] **Step 5: Verify live**

```bash
cat > /tmp/verify-lb.ts <<'EOF'
import { Fetcher } from '/Users/thomp/git/cinema-tracker/src/fetch/fetcher.js'
import { createDatabase } from '/Users/thomp/git/cinema-tracker/src/db/client.js'
import { syncLetterboxd } from '/Users/thomp/git/cinema-tracker/src/letterboxd/sync.js'
import { letterboxdEntries, watchlist } from '/Users/thomp/git/cinema-tracker/src/db/schema.js'
async function main() {
  const { db } = createDatabase('/tmp/lb-verify.db')
  const result = await syncLetterboxd(db, new Fetcher(), { username: 'thethomp' }, new Date())
  console.log(result)
  const rows = await db.select().from(letterboxdEntries)
  console.log('diary:', rows.filter((r) => r.kind === 'diary').length)
  console.log('watchlist:', rows.filter((r) => r.kind === 'watchlist').length)
  console.log('with tmdb id:', rows.filter((r) => r.tmdbId != null).length)
  console.log('watchlist table:', (await db.select().from(watchlist)).length)
  console.log('sample:', rows.slice(0, 3).map((r) => [r.title, r.year, r.memberRating, r.watchedDate]))
}
main()
EOF
rm -f /tmp/lb-verify.db && npx tsx /tmp/verify-lb.ts
```

Expected: ~50 diary entries all carrying TMDB ids, and ~240 watchlist entries
across 9 pages. **If watchlist comes back as 28, pagination is broken** — that is
the same class of bug as AMC's `pageSize`.

- [ ] **Step 6: Commit** — `feat: add Letterboxd sync`

---

### Task 6: Taste affinities

**Files:** Create `src/taste/affinities.ts`, test `tests/taste/affinities.test.ts`

A dimension value is a **strong affinity** when its mean member rating is at least
**0.5 stars above the overall mean** and it has at least **5 rated samples**. The
sample floor exists so one 5-star rating cannot turn a whole genre into a
highlight generator.

Dimensions: `genre`, `language`, `director`, `decade`. Source data is
`letterboxd_entries` joined to `films` by `tmdb_id` — a rated film contributes
only if we have TMDB metadata for it.

- [ ] **Step 1: Write the failing test**

Cover: computes the overall mean across rated entries; a genre with 6 ratings
averaging 1.0 above the mean becomes a strong affinity; a genre with 3 ratings
well above the mean does **not** (sample floor); a genre only 0.2 above does not
(margin floor); unrated entries are excluded from all means; recomputation is
idempotent and replaces prior rows rather than accumulating; a film with several
genres contributes to each; `decade` is derived from `films.year`
(1983 → `1980s`); returns empty when there are no rated entries.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/taste/affinities.ts`**

`deriveAffinities(db)` → `{ overallMean, affinities: TasteAffinity[] }`, writing to
`taste_affinities` and deleting rows that no longer qualify. Keep the computation
a pure function over rows where practical, so it can be tested without a database.

- [ ] **Step 4:** run tests — expect 9 passing.

- [ ] **Step 5: Verify against real data**

Run the sync from Task 5, then derive, and print the top affinities per dimension
with their sample counts. **Read the output and sanity-check it against what you
know of the user's taste** — the owner has said they love horror, so horror
appearing as a strong genre affinity is a good sign; if it doesn't appear, check
whether the sample floor or the join to `films` is dropping data.

- [ ] **Step 6: Commit** — `feat: derive taste affinities from Letterboxd ratings`

---

### Task 7: Tag extractor

**Files:** Create `src/tags/extract.ts`, test `tests/tags/extract.test.ts`

Rule-based over `rawTitle`, `description`, and `formatHints`. The interface is
**async from the start** so an LLM implementation is a drop-in swap later:

```ts
export interface TagInput {
  rawTitle: string
  description?: string
  formatHints: string[]
}
export interface TagExtractor {
  extract(input: TagInput): Promise<string[]>
}
```

Tags: `70MM`, `35MM`, `IMAX`, `DOLBY`, `Q_AND_A`, `LIVE_SCORE`, `ANNIVERSARY`,
`FESTIVAL`, `SING_ALONG`, `MEMBER_ONLY`, `EVENT`, `ARTHOUSE`, `RE_RELEASE`.

- [ ] **Step 1: Write the failing test**

Use **real strings from the database**, not invented ones:

```
'The Odyssey (70mm)'                                    → 70MM
'Teenage Sex and Death at Camp Miasma (35mm)'           → 35MM
'Faust with the Invincible Czars'                       → LIVE_SCORE
"Harry Potter and the Sorcerer's Stone 25th Anniversary" → ANNIVERSARY, RE_RELEASE
'Harry Potter and the Chamber of Secrets (2026 Re-Release)' → RE_RELEASE
'The Hunger Games (2026)'                               → RE_RELEASE
description 'AMC Artisan Films, Reserved Seating, 70mm' → ARTHOUSE, 70MM
description 'Event, Closed Caption'                     → EVENT
formatHints ['IMAX']                                    → IMAX
```

Also assert that ordinary screenings produce **no** tags — `'Spider-Man: Brand New
Day'` with `formatHints: []` must return `[]`. A tag extractor that tags
everything is worse than none.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/tags/extract.ts`** as a `RuleTagExtractor` class implementing `TagExtractor`.

- [ ] **Step 4:** run tests — expect 12 passing.

- [ ] **Step 5: Run it over every screening in the live database and report the tag distribution.** Read it. If more than roughly a quarter of screenings carry a special-event tag, the rules are too loose — special events are rare by definition.

- [ ] **Step 6: Commit** — `feat: add rule-based tag extractor`

---

### Task 8: Highlight scorer and CLI

**Files:** Create `src/score/score.ts`, `src/score/run.ts`; modify `src/cli.ts`, `src/db/seed.ts`. Tests for each.

- [ ] **Step 1: Seed `taste_rules`**

Extend `src/db/seed.ts` with `seedTasteRules(db)`, idempotent, inserting the weights
from the Scoring model table above — including the declared Horror preference at
+60 and the already-watched penalty at −80.

- [ ] **Step 2: Write the failing scorer test**

`score(input, rules)` is a **pure function**. Cover every weight in the table plus:

- The threshold boundary: exactly 40 is a highlight, 39 is not.
- `reasons[]` names each contributing signal with its weight.
- A watchlist match alone clears the threshold.
- **A horror film alone clears the threshold** (declared preference, +60).
- **An already-watched horror film does not resurface** (60 − 80 = −20)…
- **…unless the screening carries a special-event tag**, which waives the penalty.
- Affinity contributes once, not once per matching dimension.
- Weights come from the rules argument, not hardcoded — passing a modified rule
  set changes the score.

- [ ] **Step 3: Implement `src/score/score.ts`.** Keep it pure — no database access, no I/O.

- [ ] **Step 4: Implement `src/score/run.ts`** — load rules, affinities, watchlist, and watched films once, then score every non-cancelled future screening, writing `tags` and a computed score. Store the score and reasons on the screening row (add `score REAL` and `reasons TEXT` columns via the same guarded-ALTER approach as Task 1).

- [ ] **Step 5: Add a `score` command to `src/cli.ts`** and an `npm run score` script. It should run tag extraction and scoring together and print the top 20 highlights.

- [ ] **Step 6:** run the full suite — green.

- [ ] **Step 7: Run the whole pipeline for real and read the output**

```bash
npm run sweep && npm run resolve && npm run score
```

Print the top 20 highlights with score, reasons, title, date, venue, and tags.

**This is the real test of the plan.** Read the list as the user would. Ask:
- Is the 70mm *Odyssey* near the top? It should be.
- Are horror films surfacing?
- Are the two watchlist films currently screening at the top?
- Is anything obviously boring ranked highly? If a routine Tuesday showing of a
  wide release outranks a 35mm repertory screening, the weights are wrong —
  report it rather than declaring success.

- [ ] **Step 8: Commit** — `feat: add highlight scorer and score CLI`

---

## Done when

- `npx vitest run` passes and `npx tsc --noEmit` is clean.
- `npm run score` produces a ranked list whose top entries are recognizably the
  interesting screenings, not the busiest ones.
- Letterboxd sync brings in ~50 diary entries and ~240 watchlist films.
- Horror appears as a strong affinity or as a declared preference driving films
  into the feed.
- `description` is persisted and AMC's programming strands reach tag extraction.

## Notes for the next plan

- Plan 4 is the API and UI (Layout A: highlight feed on top, day-by-day agenda
  below) plus the 6-hour scheduler and deployment.
- `app_state.last_visit_at` is created here but unused — the UI needs it for the
  "new since you last looked" marker.
- The LLM tag extractor swaps in behind `TagExtractor` with no other changes.
- `isSoldOut` / `isAlmostSoldOut` from AMC remain uncaptured.
