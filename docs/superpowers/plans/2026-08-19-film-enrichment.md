# Film Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every swept screening to a real TMDB film, so `screenings.film_id` is populated and films carry genres, original language, runtime, director, poster, and US release date.

**Architecture:** A pure title normalizer strips venue-specific decoration ("(35mm)", "(Telugu with English Subtitles)", "(2026 Re-Release)") from raw titles. A resolver tries, in order: a manual override table, an already-resolved film cache, then TMDB search. Unresolved titles are a normal state — the screening keeps its raw title and is reported for manual override. Resolution runs as a separate CLI pass over unresolved screenings, not inside the sweep.

**Tech Stack:** TypeScript on Node 22, TMDB REST API, better-sqlite3 + Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-cinema-tracker-design.md`
**Builds on:** `docs/superpowers/plans/2026-08-16-foundation-and-adapters.md` (merged)

---

## Prerequisite

`TMDB_API_KEY` must be set in `.env`. Get one free at https://www.themoviedb.org/settings/api
(request a "Developer" key). **Task 2 cannot be verified without it.** All other tasks
can proceed; only the live-verification steps need the key.

## Scope

In scope: `films` and `title_overrides` tables, a TMDB client, the title normalizer,
the resolver, the film store, and a `resolve` CLI command.

Out of scope (Plan 3): Letterboxd, taste affinities, tag extraction, the highlight
scorer, upcoming releases. Out of scope (Plan 4): API, UI, deployment. `screenings.tags`
stays `[]` for this whole plan.

## The real corpus

These are actual distinct `raw_title` values from the live database on 2026-08-19.
The normalizer is designed against them and the tests use them verbatim.

```
Agadha (Telugu with English Subtitles)
All Wishes Come True! (Mandarin with Chinese and English Subtitles)
American Astronaut (35mm)
Cocoon One Summer of Girlhood (English Dubbed)
Cocoon One Summer of Girlhood (Japanese with English Subtitles)
Harry Potter and the Chamber of Secrets (2026 Re-Release)
Harry Potter and the Deathly Hallows: Part 1 (2026 Re-Release)
Harry Potter and the Sorcerer's Stone 25th Anniversary
Teenage Sex and Death at Camp Miasma (35mm)
The Odyssey (70mm)
KATSEYE: WILD HEARTS
```

Three rules fall out of this and drive the whole design:

1. **A trailing parenthetical is decoration, never part of the title.** Language,
   format, dub, and re-release markers all appear this way.
2. **A colon is legitimate title punctuation** (`Deathly Hallows: Part 1`,
   `KATSEYE: WILD HEARTS`). Never split or strip on it.
3. **A re-release resolves to the original film, not to the re-release year.**
   `Harry Potter and the Goblet of Fire (2026 Re-Release)` is the 2005 film.
   This is why the normalizer must *not* pass the marker year to TMDB as a year hint.

## File structure

| File | Responsibility |
|---|---|
| `src/tmdb/client.ts` | TMDB HTTP calls and response typing. No matching logic. |
| `src/resolve/normalize.ts` | Pure title normalization. No I/O, no TMDB knowledge. |
| `src/resolve/resolver.ts` | Override → cache → TMDB decision order. |
| `src/store/films.ts` | Film upsert and screening linkage. |
| `src/db/schema.ts` | Extended with `films`, `title_overrides`. |
| `src/db/client.ts` | Extended DDL. |
| `src/cli.ts` | Extended with a `resolve` command. |

---

### Task 1: Schema for films and overrides

**Files:**
- Modify: `src/db/schema.ts`, `src/db/client.ts`
- Test: `tests/db/films-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/db/client.js'
import { films, titleOverrides } from '../../src/db/schema.js'

describe('film schema', () => {
  it('stores a film with json genres', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(films).values({
      tmdbId: 671,
      title: "Harry Potter and the Sorcerer's Stone",
      year: 2001,
      runtimeMinutes: 152,
      originalLanguage: 'en',
      genres: ['Adventure', 'Fantasy'],
      director: 'Chris Columbus',
      posterUrl: 'https://image.tmdb.org/t/p/w500/x.jpg',
      synopsis: 'A boy learns he is a wizard.',
      usReleaseDate: '2001-11-16',
    })
    const rows = await db.select().from(films)
    expect(rows[0]!.genres).toEqual(['Adventure', 'Fantasy'])
    expect(rows[0]!.tmdbId).toBe(671)
  })

  it('enforces one row per tmdb id', async () => {
    const { db } = createDatabase(':memory:')
    const row = { tmdbId: 671, title: 'X', genres: [] as string[] }
    await db.insert(films).values(row)
    await expect(db.insert(films).values(row)).rejects.toThrow()
  })

  it('stores a venue-scoped title override', async () => {
    const { db } = createDatabase(':memory:')
    await db.insert(titleOverrides).values({
      rawTitle: 'The Odyssey (70mm)',
      venueId: null,
      tmdbId: 12345,
    })
    const rows = await db.select().from(titleOverrides)
    expect(rows[0]!.tmdbId).toBe(12345)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db/films-schema.test.ts`
Expected: FAIL — `films` is not exported from schema.

- [ ] **Step 3: Add the tables to `src/db/schema.ts`**

```ts
export const films = sqliteTable('films', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tmdbId: integer('tmdb_id').unique(),
  title: text('title').notNull(),
  year: integer('year'),
  runtimeMinutes: integer('runtime_minutes'),
  originalLanguage: text('original_language'),
  genres: text('genres', { mode: 'json' }).notNull().$type<string[]>(),
  director: text('director'),
  posterUrl: text('poster_url'),
  synopsis: text('synopsis'),
  usReleaseDate: text('us_release_date'),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }),
})

export const titleOverrides = sqliteTable('title_overrides', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  rawTitle: text('raw_title').notNull(),
  /** Null means the override applies at every venue. */
  venueId: text('venue_id'),
  tmdbId: integer('tmdb_id').notNull(),
})
```

- [ ] **Step 4: Add matching DDL to `CREATE_STATEMENTS` in `src/db/client.ts`**

```sql
CREATE TABLE IF NOT EXISTS films (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER UNIQUE,
  title TEXT NOT NULL,
  year INTEGER,
  runtime_minutes INTEGER,
  original_language TEXT,
  genres TEXT NOT NULL,
  director TEXT,
  poster_url TEXT,
  synopsis TEXT,
  us_release_date TEXT,
  fetched_at INTEGER
)
```
```sql
CREATE TABLE IF NOT EXISTS title_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_title TEXT NOT NULL,
  venue_id TEXT,
  tmdb_id INTEGER NOT NULL
)
```
```sql
CREATE UNIQUE INDEX IF NOT EXISTS title_overrides_key
  ON title_overrides (raw_title, IFNULL(venue_id, ''))
```

Add all three to the existing `CREATE_STATEMENTS` array. Do not reorder or modify
existing statements — the DDL is applied to live databases and must stay additive.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/db/films-schema.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Verify it applies cleanly to the existing live database**

```bash
cp data/cinema-tracker.db /tmp/migrate-check.db
cat > /tmp/migrate.ts <<'EOF'
import { createDatabase } from '/Users/thomp/git/cinema-tracker/src/db/client.js'
import { screenings, films } from '/Users/thomp/git/cinema-tracker/src/db/schema.js'
async function main() {
  const { db } = createDatabase('/tmp/migrate-check.db')
  console.log('screenings preserved:', (await db.select().from(screenings)).length)
  console.log('films table present:', (await db.select().from(films)).length === 0)
}
main()
EOF
npx tsx /tmp/migrate.ts
```

Expected: the existing screening count is unchanged and the films table exists empty.
If screenings are lost, the DDL is not additive — stop and fix.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/db/films-schema.test.ts
git commit -m "feat: add films and title_overrides tables"
```

---

### Task 2: TMDB client

**Files:**
- Create: `src/tmdb/client.ts`
- Test: `tests/tmdb/client.test.ts`

The client does HTTP and typing only. It contains no matching or ranking logic —
that belongs to the resolver, so it can be tested without a network.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { TmdbClient } from '../../src/tmdb/client.js'

const SEARCH_RESPONSE = {
  results: [
    {
      id: 671,
      title: "Harry Potter and the Sorcerer's Stone",
      release_date: '2001-11-16',
      original_language: 'en',
      popularity: 88.5,
      poster_path: '/wu.jpg',
      overview: 'A boy learns he is a wizard.',
    },
    {
      id: 999,
      title: 'Harry Potter Retrospective',
      release_date: '2019-01-01',
      original_language: 'en',
      popularity: 1.2,
      poster_path: null,
      overview: 'A documentary.',
    },
  ],
}

const DETAIL_RESPONSE = {
  id: 671,
  title: "Harry Potter and the Sorcerer's Stone",
  release_date: '2001-11-16',
  runtime: 152,
  original_language: 'en',
  genres: [{ id: 12, name: 'Adventure' }, { id: 14, name: 'Fantasy' }],
  poster_path: '/wu.jpg',
  overview: 'A boy learns he is a wizard.',
  credits: { crew: [{ job: 'Director', name: 'Chris Columbus' }] },
  release_dates: {
    results: [
      { iso_3166_1: 'GB', release_dates: [{ release_date: '2001-11-04T00:00:00.000Z' }] },
      { iso_3166_1: 'US', release_dates: [{ release_date: '2001-11-16T00:00:00.000Z' }] },
    ],
  },
}

function stubFetcher(payloads: Record<string, unknown>) {
  return {
    text: vi.fn(async (url: string) => {
      for (const [fragment, payload] of Object.entries(payloads)) {
        if (url.includes(fragment)) return JSON.stringify(payload)
      }
      throw new Error(`unexpected url ${url}`)
    }),
  }
}

describe('TmdbClient', () => {
  it('returns search candidates in response order', async () => {
    const fetcher = stubFetcher({ '/search/movie': SEARCH_RESPONSE })
    const client = new TmdbClient(fetcher as never, 'KEY')

    const results = await client.searchMovies('Harry Potter')

    expect(results.map((r) => r.tmdbId)).toEqual([671, 999])
    expect(results[0]!.year).toBe(2001)
    expect(results[0]!.title).toBe("Harry Potter and the Sorcerer's Stone")
  })

  it('sends the api key and url-encodes the query', async () => {
    const fetcher = stubFetcher({ '/search/movie': SEARCH_RESPONSE })
    const client = new TmdbClient(fetcher as never, 'KEY')

    await client.searchMovies('Deathly Hallows: Part 1')

    const url = fetcher.text.mock.calls[0]![0]
    expect(url).toContain('api_key=KEY')
    expect(url).toContain('Deathly%20Hallows%3A%20Part%201')
  })

  it('passes a year hint when given', async () => {
    const fetcher = stubFetcher({ '/search/movie': SEARCH_RESPONSE })
    const client = new TmdbClient(fetcher as never, 'KEY')

    await client.searchMovies('Harry Potter', 2001)

    expect(fetcher.text.mock.calls[0]![0]).toContain('year=2001')
  })

  it('maps film details including director and US release date', async () => {
    const fetcher = stubFetcher({ '/movie/671': DETAIL_RESPONSE })
    const client = new TmdbClient(fetcher as never, 'KEY')

    const film = await client.getMovie(671)

    expect(film.director).toBe('Chris Columbus')
    expect(film.genres).toEqual(['Adventure', 'Fantasy'])
    expect(film.runtimeMinutes).toBe(152)
    expect(film.usReleaseDate).toBe('2001-11-16')
    expect(film.posterUrl).toBe('https://image.tmdb.org/t/p/w500/wu.jpg')
  })

  it('omits the poster url when TMDB has no poster', async () => {
    const fetcher = stubFetcher({
      '/movie/999': { ...DETAIL_RESPONSE, id: 999, poster_path: null },
    })
    const client = new TmdbClient(fetcher as never, 'KEY')

    expect((await client.getMovie(999)).posterUrl).toBeUndefined()
  })

  it('returns no US release date when none is published', async () => {
    const fetcher = stubFetcher({
      '/movie/671': { ...DETAIL_RESPONSE, release_dates: { results: [] } },
    })
    const client = new TmdbClient(fetcher as never, 'KEY')

    expect((await client.getMovie(671)).usReleaseDate).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tmdb/client.test.ts`
Expected: FAIL — cannot resolve `../../src/tmdb/client.js`.

- [ ] **Step 3: Implement `src/tmdb/client.ts`**

```ts
import type { Fetcher } from '../fetch/fetcher.js'

const BASE = 'https://api.themoviedb.org/3'
const POSTER_BASE = 'https://image.tmdb.org/t/p/w500'

export interface TmdbCandidate {
  tmdbId: number
  title: string
  year?: number
  originalLanguage?: string
  popularity: number
}

export interface TmdbFilm {
  tmdbId: number
  title: string
  year?: number
  runtimeMinutes?: number
  originalLanguage?: string
  genres: string[]
  director?: string
  posterUrl?: string
  synopsis?: string
  usReleaseDate?: string
}

interface SearchPayload {
  results?: Array<{
    id: number
    title?: string
    release_date?: string
    original_language?: string
    popularity?: number
  }>
}

interface DetailPayload {
  id: number
  title?: string
  release_date?: string
  runtime?: number | null
  original_language?: string
  genres?: Array<{ name: string }>
  poster_path?: string | null
  overview?: string
  credits?: { crew?: Array<{ job?: string; name?: string }> }
  release_dates?: {
    results?: Array<{
      iso_3166_1?: string
      release_dates?: Array<{ release_date?: string }>
    }>
  }
}

/** "2001-11-16" -> 2001. Undefined for empty or malformed values. */
function yearOf(releaseDate: string | undefined): number | undefined {
  if (!releaseDate) return undefined
  const year = Number(releaseDate.slice(0, 4))
  return Number.isFinite(year) && year > 1800 ? year : undefined
}

export class TmdbClient {
  constructor(
    private readonly fetcher: Pick<Fetcher, 'text'>,
    private readonly apiKey: string,
  ) {}

  async searchMovies(query: string, year?: number): Promise<TmdbCandidate[]> {
    const params = new URLSearchParams({
      api_key: this.apiKey,
      query,
      include_adult: 'false',
    })
    if (year !== undefined) params.set('year', String(year))

    // URLSearchParams encodes spaces as "+", which TMDB accepts but which makes
    // the request harder to read in logs and tests. Normalize to %20.
    const qs = params.toString().replace(/\+/g, '%20')
    const payload = JSON.parse(await this.fetcher.text(`${BASE}/search/movie?${qs}`)) as SearchPayload

    return (payload.results ?? []).map((result) => ({
      tmdbId: result.id,
      title: result.title ?? '',
      year: yearOf(result.release_date),
      originalLanguage: result.original_language,
      popularity: result.popularity ?? 0,
    }))
  }

  async getMovie(tmdbId: number): Promise<TmdbFilm> {
    const params = new URLSearchParams({
      api_key: this.apiKey,
      append_to_response: 'credits,release_dates',
    })
    const payload = JSON.parse(
      await this.fetcher.text(`${BASE}/movie/${tmdbId}?${params.toString()}`),
    ) as DetailPayload

    const director = payload.credits?.crew?.find((member) => member.job === 'Director')?.name
    const us = payload.release_dates?.results?.find((entry) => entry.iso_3166_1 === 'US')
    const usReleaseDate = us?.release_dates?.[0]?.release_date?.slice(0, 10)

    return {
      tmdbId: payload.id,
      title: payload.title ?? '',
      year: yearOf(payload.release_date),
      runtimeMinutes: payload.runtime ?? undefined,
      originalLanguage: payload.original_language,
      genres: (payload.genres ?? []).map((genre) => genre.name),
      director,
      posterUrl: payload.poster_path ? `${POSTER_BASE}${payload.poster_path}` : undefined,
      synopsis: payload.overview,
      usReleaseDate,
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tmdb/client.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify against the live API**

Requires `TMDB_API_KEY` in `.env`.

```bash
cat > /tmp/verify-tmdb.ts <<'EOF'
import { Fetcher } from '/Users/thomp/git/cinema-tracker/src/fetch/fetcher.js'
import { TmdbClient } from '/Users/thomp/git/cinema-tracker/src/tmdb/client.js'
async function main() {
  const key = process.env.TMDB_API_KEY
  if (!key) { console.error('TMDB_API_KEY not set'); process.exit(1) }
  const client = new TmdbClient(new Fetcher({ minIntervalMs: 300 }), key)
  const hits = await client.searchMovies("Harry Potter and the Sorcerer's Stone")
  console.log('candidates:', hits.slice(0, 3).map((h) => [h.tmdbId, h.title, h.year]))
  const film = await client.getMovie(hits[0]!.tmdbId)
  console.log('detail:', film.title, film.year, film.runtimeMinutes, film.genres, film.director, film.usReleaseDate)
}
main()
EOF
set -a; . ./.env; set +a; npx tsx /tmp/verify-tmdb.ts
```

Expected: the top candidate is the 2001 film (TMDB id 671), and the detail call
returns a runtime, genres, a director, and a US release date.

**If this 401s**, the key is wrong or not yet active. **If the shape differs from
the stubbed payloads above, the stubs are wrong** — update both the stubs and the
client, and say so, rather than adjusting only the client.

- [ ] **Step 6: Commit**

```bash
git add src/tmdb/client.ts tests/tmdb/client.test.ts
git commit -m "feat: add TMDB client for search and film details"
```

---

### Task 3: Title normalizer

Pure string work, no I/O and no TMDB knowledge. Tested against the real corpus.

**Files:**
- Create: `src/resolve/normalize.ts`
- Test: `tests/resolve/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { normalizeTitle, matchKey } from '../../src/resolve/normalize.js'

describe('normalizeTitle', () => {
  const cases: Array<[string, { title: string; hints: string[]; reissue: boolean }]> = [
    ['American Astronaut (35mm)', { title: 'American Astronaut', hints: ['35mm'], reissue: false }],
    ['The Odyssey (70mm)', { title: 'The Odyssey', hints: ['70mm'], reissue: false }],
    ['Agadha (Telugu with English Subtitles)', { title: 'Agadha', hints: ['Telugu with English Subtitles'], reissue: false }],
    ['Cocoon One Summer of Girlhood (English Dubbed)', { title: 'Cocoon One Summer of Girlhood', hints: ['English Dubbed'], reissue: false }],
    ['All Wishes Come True! (Mandarin with Chinese and English Subtitles)', { title: 'All Wishes Come True!', hints: ['Mandarin with Chinese and English Subtitles'], reissue: false }],
    ['Harry Potter and the Chamber of Secrets (2026 Re-Release)', { title: 'Harry Potter and the Chamber of Secrets', hints: ['2026 Re-Release'], reissue: true }],
    ["Harry Potter and the Sorcerer's Stone 25th Anniversary", { title: "Harry Potter and the Sorcerer's Stone", hints: ['25th Anniversary'], reissue: true }],
    ['Teenage Sex and Death at Camp Miasma (35mm)', { title: 'Teenage Sex and Death at Camp Miasma', hints: ['35mm'], reissue: false }],
  ]

  for (const [raw, expected] of cases) {
    it(`normalizes "${raw}"`, () => {
      const result = normalizeTitle(raw)
      expect(result.title).toBe(expected.title)
      expect(result.hints).toEqual(expected.hints)
      expect(result.isReissue).toBe(expected.reissue)
    })
  }

  it('preserves a colon as legitimate title punctuation', () => {
    expect(normalizeTitle('Harry Potter and the Deathly Hallows: Part 1 (2026 Re-Release)').title)
      .toBe('Harry Potter and the Deathly Hallows: Part 1')
    expect(normalizeTitle('KATSEYE: WILD HEARTS').title).toBe('KATSEYE: WILD HEARTS')
  })

  it('leaves an undecorated title untouched', () => {
    const result = normalizeTitle('Spider-Man: Brand New Day')
    expect(result.title).toBe('Spider-Man: Brand New Day')
    expect(result.hints).toEqual([])
    expect(result.isReissue).toBe(false)
  })

  it('strips multiple trailing parentheticals', () => {
    const result = normalizeTitle('Some Film (Hindi with English Subtitles) (35mm)')
    expect(result.title).toBe('Some Film')
    expect(result.hints).toEqual(['Hindi with English Subtitles', '35mm'])
  })

  it('keeps a parenthetical that is part of the actual title', () => {
    // No decoration keyword, so it is not treated as decoration.
    expect(normalizeTitle('Cléo from 5 to 7 (Cléo de 5 à 7)').title)
      .toBe('Cléo from 5 to 7 (Cléo de 5 à 7)')
  })

  it('never returns an empty title', () => {
    expect(normalizeTitle('(35mm)').title).toBe('(35mm)')
  })
})

describe('matchKey', () => {
  it('casefolds and strips punctuation and articles', () => {
    expect(matchKey('The Odyssey')).toBe(matchKey('odyssey'))
    expect(matchKey("Harry Potter and the Sorcerer's Stone"))
      .toBe(matchKey('harry potter and the sorcerers stone'))
  })

  it('folds diacritics', () => {
    expect(matchKey('Romería')).toBe(matchKey('Romeria'))
  })

  it('does not collapse genuinely different titles', () => {
    expect(matchKey('The Odyssey')).not.toBe(matchKey('Odyssey 2'))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/resolve/normalize.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement `src/resolve/normalize.ts`**

```ts
export interface NormalizedTitle {
  /** Title with venue decoration removed. Never empty. */
  title: string
  /** The decoration that was removed, outermost last, in source order. */
  hints: string[]
  /**
   * True when the decoration marks a re-release or anniversary showing. The
   * caller must NOT use any year in that marker as a TMDB year hint — a 2026
   * re-release of Goblet of Fire is still the 2005 film.
   */
  isReissue: boolean
}

/**
 * Words that identify a trailing parenthetical as venue decoration rather than
 * part of the title. Without this check, "Cléo from 5 to 7 (Cléo de 5 à 7)"
 * would lose its original-language title.
 */
const DECORATION = /\b(?:\d{2,3}\s?mm|subtitle|subtitles|spoken|dubbed|dub|re-?release|reissue|anniversary|restored|restoration|remaster(?:ed)?|imax|3d|open caption|sing-?along)\b/i

const REISSUE = /\b(?:re-?release|reissue|anniversary|restored|restoration|remaster(?:ed)?)\b/i

/** e.g. "25th Anniversary", "50th Anniversary" appended without parentheses. */
const TRAILING_ANNIVERSARY = /\s+(\d{1,3}(?:st|nd|rd|th)\s+anniversary)\s*$/i

export function normalizeTitle(rawTitle: string): NormalizedTitle {
  let title = rawTitle.trim()
  const hints: string[] = []

  // Repeatedly peel trailing parentheticals that look like decoration.
  for (;;) {
    const match = /\s*\(([^()]*)\)\s*$/.exec(title)
    if (!match || !DECORATION.test(match[1]!)) break
    const stripped = title.slice(0, match.index).trim()
    if (!stripped) break // Never reduce a title to nothing.
    hints.unshift(match[1]!.trim())
    title = stripped
  }

  const anniversary = TRAILING_ANNIVERSARY.exec(title)
  if (anniversary) {
    const stripped = title.slice(0, anniversary.index).trim()
    if (stripped) {
      hints.push(anniversary[1]!.trim())
      title = stripped
    }
  }

  return {
    title,
    hints,
    isReissue: hints.some((hint) => REISSUE.test(hint)),
  }
}

const LEADING_ARTICLE = /^(?:the|a|an)\s+/i

/**
 * A comparison key for deciding whether two titles refer to the same film.
 * Lossy by design — only ever compare keys, never display them.
 */
export function matchKey(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(LEADING_ARTICLE, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/resolve/normalize.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Check the normalizer against every real title in the database**

```bash
cat > /tmp/normalize-all.ts <<'EOF'
import { createDatabase } from '/Users/thomp/git/cinema-tracker/src/db/client.js'
import { screenings } from '/Users/thomp/git/cinema-tracker/src/db/schema.js'
import { normalizeTitle } from '/Users/thomp/git/cinema-tracker/src/resolve/normalize.js'
async function main() {
  const { db } = createDatabase('data/cinema-tracker.db')
  const titles = [...new Set((await db.select().from(screenings)).map((r) => r.rawTitle))].sort()
  for (const raw of titles) {
    const n = normalizeTitle(raw)
    if (n.title !== raw) console.log(`${raw}\n  -> "${n.title}"  hints=${JSON.stringify(n.hints)} reissue=${n.isReissue}`)
  }
  console.log(`\n${titles.length} distinct titles, ${titles.filter((t) => normalizeTitle(t).title !== t).length} normalized`)
}
main()
EOF
npx tsx /tmp/normalize-all.ts
```

Read every line of output. **Any title where decoration survived, or where real
title text was removed, is a bug** — fix the pattern and add that title to the test
corpus. Report the full output.

- [ ] **Step 6: Commit**

```bash
git add src/resolve/normalize.ts tests/resolve/normalize.test.ts
git commit -m "feat: add title normalizer for venue decoration"
```

---

### Task 4: Film store

**Files:**
- Create: `src/store/films.ts`
- Test: `tests/store/films.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { venues, screenings, films } from '../../src/db/schema.js'
import { upsertFilm, linkScreenings, unresolvedTitles } from '../../src/store/films.js'
import type { TmdbFilm } from '../../src/tmdb/client.js'

const FILM: TmdbFilm = {
  tmdbId: 671,
  title: "Harry Potter and the Sorcerer's Stone",
  year: 2001,
  runtimeMinutes: 152,
  originalLanguage: 'en',
  genres: ['Adventure', 'Fantasy'],
  director: 'Chris Columbus',
  posterUrl: 'https://image.tmdb.org/t/p/w500/x.jpg',
  synopsis: 'A boy learns he is a wizard.',
  usReleaseDate: '2001-11-16',
}

let db: Db
beforeEach(async () => {
  db = createDatabase(':memory:').db
  await db.insert(venues).values({
    id: 'v1', name: 'V', chain: 'Test',
    timezone: 'America/Los_Angeles', sourceVenueId: 'v1', weight: 0,
  })
})

async function addScreening(rawTitle: string, sourceId: string) {
  await db.insert(screenings).values({
    venueId: 'v1', filmId: null, rawTitle,
    startsAtUtc: new Date('2026-08-20T02:00:00Z'), localDate: '2026-08-19',
    ticketUrl: 'https://example.com', sourceScreeningId: sourceId,
    formatHints: [], tags: [], firstSeenAt: new Date(), lastSeenAt: new Date(),
  })
}

describe('upsertFilm', () => {
  it('inserts a film and returns its row id', async () => {
    const id = await upsertFilm(db, FILM, new Date())
    const rows = await db.select().from(films)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(id)
    expect(rows[0]!.genres).toEqual(['Adventure', 'Fantasy'])
  })

  it('is idempotent on tmdb id and refreshes metadata', async () => {
    const first = await upsertFilm(db, FILM, new Date('2026-08-19T00:00:00Z'))
    const second = await upsertFilm(db, { ...FILM, runtimeMinutes: 160 }, new Date('2026-08-20T00:00:00Z'))

    expect(second).toBe(first)
    const rows = await db.select().from(films)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.runtimeMinutes).toBe(160)
  })
})

describe('linkScreenings', () => {
  it('links every screening sharing a raw title', async () => {
    await addScreening('Harry Potter', 's1')
    await addScreening('Harry Potter', 's2')
    await addScreening('Other Film', 's3')
    const filmId = await upsertFilm(db, FILM, new Date())

    const count = await linkScreenings(db, 'Harry Potter', filmId)

    expect(count).toBe(2)
    const rows = await db.select().from(screenings)
    expect(rows.filter((r) => r.filmId === filmId)).toHaveLength(2)
    expect(rows.find((r) => r.rawTitle === 'Other Film')!.filmId).toBeNull()
  })
})

describe('unresolvedTitles', () => {
  it('returns distinct unresolved titles with their counts', async () => {
    await addScreening('Alpha', 's1')
    await addScreening('Alpha', 's2')
    await addScreening('Beta', 's3')
    const filmId = await upsertFilm(db, FILM, new Date())
    await linkScreenings(db, 'Beta', filmId)

    const rows = await unresolvedTitles(db)

    expect(rows).toEqual([{ rawTitle: 'Alpha', screeningCount: 2 }])
  })

  it('ignores cancelled screenings', async () => {
    await addScreening('Alpha', 's1')
    await db.update(screenings).set({ cancelled: true })

    expect(await unresolvedTitles(db)).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/store/films.ts`**

```ts
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { films, screenings } from '../db/schema.js'
import type { TmdbFilm } from '../tmdb/client.js'

/** Insert or refresh a film by TMDB id. Returns the local row id. */
export async function upsertFilm(db: Db, film: TmdbFilm, now: Date): Promise<number> {
  const values = {
    tmdbId: film.tmdbId,
    title: film.title,
    year: film.year ?? null,
    runtimeMinutes: film.runtimeMinutes ?? null,
    originalLanguage: film.originalLanguage ?? null,
    genres: film.genres,
    director: film.director ?? null,
    posterUrl: film.posterUrl ?? null,
    synopsis: film.synopsis ?? null,
    usReleaseDate: film.usReleaseDate ?? null,
    fetchedAt: now,
  }

  await db.insert(films).values(values).onConflictDoUpdate({
    target: films.tmdbId,
    set: values,
  })

  const [row] = await db
    .select({ id: films.id })
    .from(films)
    .where(eq(films.tmdbId, film.tmdbId))
    .limit(1)

  if (!row) throw new Error(`film ${film.tmdbId} vanished after upsert`)
  return row.id
}

/** Point every screening with this raw title at a film. Returns rows changed. */
export async function linkScreenings(db: Db, rawTitle: string, filmId: number): Promise<number> {
  const targets = await db
    .select({ id: screenings.id })
    .from(screenings)
    .where(and(eq(screenings.rawTitle, rawTitle), isNull(screenings.filmId)))

  if (targets.length === 0) return 0

  await db
    .update(screenings)
    .set({ filmId })
    .where(and(eq(screenings.rawTitle, rawTitle), isNull(screenings.filmId)))

  return targets.length
}

export interface UnresolvedTitle {
  rawTitle: string
  screeningCount: number
}

/** Distinct raw titles with no film, busiest first. Cancelled rows excluded. */
export async function unresolvedTitles(db: Db): Promise<UnresolvedTitle[]> {
  return db
    .select({
      rawTitle: screenings.rawTitle,
      screeningCount: sql<number>`count(*)`,
    })
    .from(screenings)
    .where(and(isNull(screenings.filmId), eq(screenings.cancelled, false)))
    .groupBy(screenings.rawTitle)
    .orderBy(sql`count(*) desc`)
}
```

- [ ] **Step 4:** `npx vitest run tests/store/films.test.ts` — expect 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/store/films.ts tests/store/films.test.ts
git commit -m "feat: add film store with screening linkage"
```

---

### Task 5: Resolver

Decision order: override table, then already-resolved cache, then TMDB search.
Unresolved is a normal outcome, not an error.

**Files:**
- Create: `src/resolve/resolver.ts`
- Test: `tests/resolve/resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { films, titleOverrides } from '../../src/db/schema.js'
import { resolveTitle } from '../../src/resolve/resolver.js'
import type { TmdbCandidate, TmdbFilm } from '../../src/tmdb/client.js'

function stubClient(candidates: TmdbCandidate[], detail?: Partial<TmdbFilm>) {
  return {
    searchMovies: vi.fn(async () => candidates),
    getMovie: vi.fn(async (id: number): Promise<TmdbFilm> => ({
      tmdbId: id, title: 'Detail', genres: [], ...detail,
    })),
  }
}

const candidate = (over: Partial<TmdbCandidate> = {}): TmdbCandidate => ({
  tmdbId: 1, title: 'The Odyssey', year: 2026, popularity: 50, ...over,
})

let db: Db
beforeEach(() => { db = createDatabase(':memory:').db })

describe('resolveTitle', () => {
  it('prefers a manual override and never calls TMDB search', async () => {
    await db.insert(titleOverrides).values({ rawTitle: 'Weird Title', venueId: null, tmdbId: 42 })
    const client = stubClient([])

    const result = await resolveTitle(db, client as never, 'Weird Title')

    expect(result.status).toBe('resolved')
    expect(result.tmdbId).toBe(42)
    expect(result.via).toBe('override')
    expect(client.searchMovies).not.toHaveBeenCalled()
  })

  it('reuses an already-resolved film by match key without hitting TMDB', async () => {
    await db.insert(films).values({ tmdbId: 99, title: 'The Odyssey', year: 2026, genres: [] })
    const client = stubClient([])

    const result = await resolveTitle(db, client as never, 'Odyssey (70mm)')

    expect(result.status).toBe('resolved')
    expect(result.tmdbId).toBe(99)
    expect(result.via).toBe('cache')
    expect(client.searchMovies).not.toHaveBeenCalled()
  })

  it('accepts a confident TMDB match on exact normalized title', async () => {
    const client = stubClient([candidate({ tmdbId: 7, title: 'The Odyssey' })])

    const result = await resolveTitle(db, client as never, 'The Odyssey (70mm)')

    expect(result.status).toBe('resolved')
    expect(result.tmdbId).toBe(7)
    expect(result.via).toBe('search')
  })

  it('rejects a low-confidence match rather than guessing', async () => {
    const client = stubClient([candidate({ tmdbId: 8, title: 'Something Else Entirely' })])

    const result = await resolveTitle(db, client as never, 'The Odyssey (70mm)')

    expect(result.status).toBe('unresolved')
    expect(result.reason).toContain('no confident match')
  })

  // Verified live on 2026-08-19: TMDB serves the UK primary title for this film,
  // so an exact-match-only rule would reject a title that is plainly the same.
  it('accepts a regional title variant on high token overlap', async () => {
    const client = stubClient([
      candidate({ tmdbId: 671, title: "Harry Potter and the Philosopher's Stone", year: 2001 }),
    ])

    const result = await resolveTitle(db, client as never, "Harry Potter and the Sorcerer's Stone")

    expect(result.status).toBe('resolved')
    expect(result.tmdbId).toBe(671)
    expect(result.via).toBe('search')
  })

  it('does not accept a short title on partial overlap', async () => {
    // Two shared tokens out of three is above the ratio but below the absolute
    // floor — "DC Returns" is not "DC League of Super-Pets".
    const client = stubClient([candidate({ tmdbId: 9, title: 'DC Returns' })])

    expect((await resolveTitle(db, client as never, 'DC')).status).toBe('unresolved')
  })

  it('prefers an exact match over a merely similar one', async () => {
    const client = stubClient([
      candidate({ tmdbId: 1, title: "Harry Potter and the Philosopher's Stone", popularity: 99 }),
      candidate({ tmdbId: 2, title: "Harry Potter and the Sorcerer's Stone", popularity: 1 }),
    ])

    expect((await resolveTitle(db, client as never, "Harry Potter and the Sorcerer's Stone")).tmdbId).toBe(2)
  })

  it('does not pass a re-release year as a TMDB year hint', async () => {
    const client = stubClient([candidate({ tmdbId: 671, title: 'Harry Potter and the Goblet of Fire', year: 2005 })])

    await resolveTitle(db, client as never, 'Harry Potter and the Goblet of Fire (2026 Re-Release)')

    expect(client.searchMovies).toHaveBeenCalledWith('Harry Potter and the Goblet of Fire', undefined)
  })

  it('breaks ties on popularity when several titles match exactly', async () => {
    const client = stubClient([
      candidate({ tmdbId: 1, title: 'The Odyssey', popularity: 3 }),
      candidate({ tmdbId: 2, title: 'The Odyssey', popularity: 90 }),
    ])

    expect((await resolveTitle(db, client as never, 'The Odyssey')).tmdbId).toBe(2)
  })

  it('reports unresolved when TMDB returns nothing', async () => {
    const client = stubClient([])

    const result = await resolveTitle(db, client as never, 'Nonexistent Film')

    expect(result.status).toBe('unresolved')
    expect(result.reason).toContain('no results')
  })

  it('scopes an override to a venue when one is given', async () => {
    await db.insert(titleOverrides).values({ rawTitle: 'DC', venueId: 'cinemark-totem-lake', tmdbId: 5 })
    const client = stubClient([])

    expect((await resolveTitle(db, client as never, 'DC', 'cinemark-totem-lake')).tmdbId).toBe(5)
    expect((await resolveTitle(db, client as never, 'DC', 'siff-uptown')).status).toBe('unresolved')
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/resolve/resolver.ts`**

```ts
import { and, eq, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { films, titleOverrides } from '../db/schema.js'
import type { TmdbClient } from '../tmdb/client.js'
import { normalizeTitle, matchKey } from './normalize.js'

/**
 * Token-overlap floor for accepting a non-exact title. 0.75 accepts
 * "Sorcerer's Stone" vs "Philosopher's Stone" (5 of 6 tokens, dice 0.83) and
 * rejects genuinely different films.
 */
const SIMILARITY_THRESHOLD = 0.75

/**
 * Absolute floor on shared tokens, so short titles cannot pass on ratio alone.
 * Without it, "DC" vs "DC Returns" scores 0.67 on one shared token.
 */
const MIN_SHARED_TOKENS = 3

export type ResolveResult =
  | { status: 'resolved'; tmdbId: number; via: 'override' | 'cache' | 'search' }
  | { status: 'unresolved'; reason: string }

export async function resolveTitle(
  db: Db,
  client: Pick<TmdbClient, 'searchMovies'>,
  rawTitle: string,
  venueId?: string,
): Promise<ResolveResult> {
  const override = await findOverride(db, rawTitle, venueId)
  if (override !== undefined) return { status: 'resolved', tmdbId: override, via: 'override' }

  const normalized = normalizeTitle(rawTitle)
  const key = matchKey(normalized.title)

  const cached = (await db.select().from(films)).find((film) => matchKey(film.title) === key)
  if (cached?.tmdbId != null) return { status: 'resolved', tmdbId: cached.tmdbId, via: 'cache' }

  // A re-release marker carries the reissue year, not the film's year, so it is
  // never a usable hint. Goblet of Fire "(2026 Re-Release)" is the 2005 film.
  const candidates = await client.searchMovies(normalized.title, undefined)
  if (candidates.length === 0) return { status: 'unresolved', reason: 'no results from TMDB' }

  // Exact normalized match wins outright. Several candidates can tie here —
  // "The Odyssey" really does return two distinct 2026 films — so break on
  // popularity.
  const exact = candidates.filter((c) => matchKey(c.title) === key)
  if (exact.length > 0) {
    const best = exact.reduce((a, b) => (b.popularity > a.popularity ? b : a))
    return { status: 'resolved', tmdbId: best.tmdbId, via: 'search' }
  }

  // Fall back to token overlap, for regional title variants. TMDB serves UK
  // primary titles, so "Sorcerer's Stone" comes back as "Philosopher's Stone" —
  // plainly the same film, but not an exact match.
  const similar = candidates
    .map((c) => ({ candidate: c, ...titleSimilarity(key, matchKey(c.title)) }))
    .filter((s) => s.dice >= SIMILARITY_THRESHOLD && s.shared >= MIN_SHARED_TOKENS)
    .sort((a, b) => b.dice - a.dice || b.candidate.popularity - a.candidate.popularity)

  const winner = similar[0]
  if (winner) {
    return { status: 'resolved', tmdbId: winner.candidate.tmdbId, via: 'search' }
  }

  return { status: 'unresolved', reason: `no confident match among ${candidates.length} candidates` }
}

/** Dice coefficient over word tokens, plus the raw count of shared tokens. */
function titleSimilarity(a: string, b: string): { dice: number; shared: number } {
  const left = new Set(a.split(' ').filter(Boolean))
  const right = new Set(b.split(' ').filter(Boolean))
  if (left.size === 0 || right.size === 0) return { dice: 0, shared: 0 }

  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return { dice: (2 * shared) / (left.size + right.size), shared }
}

async function findOverride(db: Db, rawTitle: string, venueId?: string): Promise<number | undefined> {
  const rows = await db
    .select()
    .from(titleOverrides)
    .where(
      and(
        eq(titleOverrides.rawTitle, rawTitle),
        venueId === undefined
          ? isNull(titleOverrides.venueId)
          : or(isNull(titleOverrides.venueId), eq(titleOverrides.venueId, venueId)),
      ),
    )

  // A venue-specific override beats a global one.
  return rows.sort((a, b) => (b.venueId ? 1 : 0) - (a.venueId ? 1 : 0))[0]?.tmdbId
}
```

- [ ] **Step 4:** `npx vitest run tests/resolve/resolver.test.ts` — expect 8 passing.

- [ ] **Step 5: Commit**

```bash
git add src/resolve/resolver.ts tests/resolve/resolver.test.ts
git commit -m "feat: add title resolver with override, cache, and search tiers"
```

---

### Task 6: `resolve` CLI command

**Files:**
- Modify: `src/cli.ts`
- Create: `src/resolve/run.ts`
- Test: `tests/resolve/run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createDatabase, type Db } from '../../src/db/client.js'
import { venues, screenings, films } from '../../src/db/schema.js'
import { runResolution } from '../../src/resolve/run.js'

let db: Db
beforeEach(async () => {
  db = createDatabase(':memory:').db
  await db.insert(venues).values({
    id: 'v1', name: 'V', chain: 'Test',
    timezone: 'America/Los_Angeles', sourceVenueId: 'v1', weight: 0,
  })
})

async function addScreening(rawTitle: string, sourceId: string) {
  await db.insert(screenings).values({
    venueId: 'v1', filmId: null, rawTitle,
    startsAtUtc: new Date('2026-08-20T02:00:00Z'), localDate: '2026-08-19',
    ticketUrl: 'https://example.com', sourceScreeningId: sourceId,
    formatHints: [], tags: [], firstSeenAt: new Date(), lastSeenAt: new Date(),
  })
}

function stubClient(byTitle: Record<string, number>) {
  return {
    searchMovies: vi.fn(async (q: string) =>
      byTitle[q] !== undefined ? [{ tmdbId: byTitle[q]!, title: q, year: 2026, popularity: 10 }] : [],
    ),
    getMovie: vi.fn(async (id: number) => ({ tmdbId: id, title: `Film ${id}`, genres: ['Drama'] })),
  }
}

describe('runResolution', () => {
  it('resolves and links every screening for a title', async () => {
    await addScreening('Alpha', 's1')
    await addScreening('Alpha', 's2')
    const client = stubClient({ Alpha: 100 })

    const summary = await runResolution(db, client as never, new Date())

    expect(summary.resolved).toBe(1)
    expect(summary.unresolved).toHaveLength(0)
    expect(summary.screeningsLinked).toBe(2)
    const rows = await db.select().from(screenings)
    expect(rows.every((r) => r.filmId !== null)).toBe(true)
    expect(await db.select().from(films)).toHaveLength(1)
  })

  it('reports unresolved titles without failing the run', async () => {
    await addScreening('Alpha', 's1')
    await addScreening('Mystery', 's2')
    const client = stubClient({ Alpha: 100 })

    const summary = await runResolution(db, client as never, new Date())

    expect(summary.resolved).toBe(1)
    expect(summary.unresolved).toEqual([{ rawTitle: 'Mystery', screeningCount: 1 }])
  })

  it('fetches each film detail exactly once per title', async () => {
    await addScreening('Alpha', 's1')
    await addScreening('Alpha', 's2')
    const client = stubClient({ Alpha: 100 })

    await runResolution(db, client as never, new Date())

    expect(client.getMovie).toHaveBeenCalledTimes(1)
  })

  it('is a no-op on a second run', async () => {
    await addScreening('Alpha', 's1')
    const client = stubClient({ Alpha: 100 })

    await runResolution(db, client as never, new Date())
    const second = await runResolution(db, client as never, new Date())

    expect(second.resolved).toBe(0)
    expect(second.screeningsLinked).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/resolve/run.ts`**

```ts
import type { Db } from '../db/client.js'
import type { TmdbClient } from '../tmdb/client.js'
import { resolveTitle } from './resolver.js'
import { upsertFilm, linkScreenings, unresolvedTitles, type UnresolvedTitle } from '../store/films.js'

export interface ResolutionSummary {
  resolved: number
  screeningsLinked: number
  unresolved: UnresolvedTitle[]
}

/**
 * Resolve every unresolved raw title to a TMDB film and link its screenings.
 * Runs as its own pass rather than inside the sweep, so a TMDB outage cannot
 * fail a sweep and so it can be re-run cheaply after adding overrides.
 */
export async function runResolution(
  db: Db,
  client: TmdbClient,
  now: Date,
): Promise<ResolutionSummary> {
  const pending = await unresolvedTitles(db)
  let resolved = 0
  let screeningsLinked = 0
  const unresolved: UnresolvedTitle[] = []

  for (const entry of pending) {
    const result = await resolveTitle(db, client, entry.rawTitle)
    if (result.status === 'unresolved') {
      unresolved.push(entry)
      continue
    }

    const film = await client.getMovie(result.tmdbId)
    const filmId = await upsertFilm(db, film, now)
    screeningsLinked += await linkScreenings(db, entry.rawTitle, filmId)
    resolved += 1
  }

  return { resolved, screeningsLinked, unresolved }
}
```

- [ ] **Step 4: Add the `resolve` command to `src/cli.ts`**

Add this function alongside the existing `sweep`, and extend the command dispatch
at the bottom of the file to accept `resolve`. Do not change the existing `sweep`
behavior.

```ts
async function resolve(): Promise<void> {
  const apiKey = process.env.TMDB_API_KEY
  if (!apiKey) {
    console.error('TMDB_API_KEY is not set. Add it to .env — https://www.themoviedb.org/settings/api')
    process.exitCode = 1
    return
  }

  const { db, close } = createDatabase(DB_PATH)
  try {
    const client = new TmdbClient(new Fetcher({ minIntervalMs: 300 }), apiKey)
    const summary = await runResolution(db, client, new Date())

    console.log(`Resolved ${summary.resolved} titles, linked ${summary.screeningsLinked} screenings`)

    if (summary.unresolved.length > 0) {
      console.log(`\n${summary.unresolved.length} unresolved:`)
      for (const entry of summary.unresolved) {
        console.log(`  ${entry.rawTitle} (${entry.screeningCount} screenings)`)
      }
      console.log('\nAdd a row to title_overrides to resolve one by hand.')
    }
  } finally {
    close()
  }
}
```

Update the dispatch:

```ts
const command = process.argv[2]
if (command === 'sweep') {
  await sweep()
} else if (command === 'resolve') {
  await resolve()
} else {
  console.error('Usage: cli.ts <sweep|resolve>')
  process.exit(1)
}
```

Add the required imports at the top of `src/cli.ts`:

```ts
import { TmdbClient } from './tmdb/client.js'
import { runResolution } from './resolve/run.js'
```

Add an npm script:

```bash
npm pkg set scripts.resolve="tsx src/cli.ts resolve"
```

- [ ] **Step 5:** `npx vitest run tests/resolve/run.test.ts` — expect 4 passing.

- [ ] **Step 6: Run it for real**

TMDB's rate limit is generous, but there are 65 distinct titles, so this takes
roughly a minute at the 300ms interval.

```bash
set -a; . ./.env; set +a
npm run resolve
```

Expected: most titles resolve; a handful of very local or non-US titles may not.

- [ ] **Step 7: Inspect the result and judge quality**

```bash
sqlite3 -box data/cinema-tracker.db "
SELECT f.title, f.year, f.original_language AS lang, f.runtime_minutes AS mins,
       f.director, COUNT(s.id) AS screenings
FROM films f JOIN screenings s ON s.film_id = f.id
GROUP BY f.id ORDER BY screenings DESC LIMIT 20;"

sqlite3 -box data/cinema-tracker.db "
SELECT s.raw_title, f.title AS resolved_to, f.year
FROM screenings s JOIN films f ON f.id = s.film_id
WHERE s.raw_title LIKE '%Re-Release%' OR s.raw_title LIKE '%Anniversary%'
GROUP BY s.raw_title;"
```

**Read the second query carefully.** Every Harry Potter re-release must resolve to
its original year (2001–2011), *not* to 2026. If any resolved to a 2026 entry, the
year-hint suppression is not working — that is a bug, not a data quirk.

Report both tables in full, plus the unresolved list.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/resolve/run.ts tests/resolve/run.test.ts package.json
git commit -m "feat: add resolve CLI pass linking screenings to TMDB films"
```

---

## Done when

- `npx vitest run` passes and `npx tsc --noEmit` is clean.
- `npm run resolve` links the large majority of screenings to real films.
- Every Harry Potter re-release resolves to its original release year, not 2026.
- Re-running `resolve` is a no-op.
- Unresolved titles are listed by name and screening count rather than silently skipped.

## Known limitation

`resolveTitle` supports venue-scoped overrides, but `runResolution` groups work by
distinct `raw_title` across all venues and calls it without a `venueId`. Only
global overrides (`venue_id IS NULL`) therefore take effect in the batch pass. The
venue-scoped path exists for the case where two venues use the same raw title for
different films; wire it up only if that actually occurs. Do not delete the
capability or its test — just know it is not reachable from the CLI yet.

## Notes for the next plan

- Plan 3 (taste and scoring) consumes `films.genres`, `films.originalLanguage`,
  and `films.director` for affinity derivation, and `films.usReleaseDate` for the
  upcoming feed.
- `screenings.tags` is still `[]`; the tag extractor is Plan 3.
- `RawScreening.description` is still never populated by any adapter. Seattle
  Magic's `events.json` carries a rich `description`, and SIFF's film pages carry
  country/year/director. Capturing it is cheap and the LLM tag extractor will want
  it — worth folding into Plan 3's first task.
