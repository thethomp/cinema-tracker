# Cinema Tracker — Design

**Date:** 2026-08-16
**Status:** Approved for planning

## Motivation

Keeping track of what's screening around Seattle currently requires visiting four
separate websites. The interesting screenings — a 70mm print, a silent film with
live score, a one-night-only restoration — are exactly the ones easiest to miss,
because they appear irregularly and disappear quickly.

Cinema Tracker aggregates showtimes from tracked venues into one view that leads
with an opinion about what deserves attention, rather than presenting an
undifferentiated list.

## Goals

- One place to see what is screening at tracked venues, and when.
- Surface noteworthy screenings: special formats and events, films matching the
  user's taste, watchlist titles, and upcoming release dates.
- Use the user's Letterboxd history — watchlist and ratings — as the taste signal,
  rather than requiring taste to be described by hand.
- Stay current without manual intervention.
- Make it obvious when a data source has broken.
- Link through to the venue's ticket page for any screening.

## Non-goals

- In-app ticket purchasing. Deep links only.
- Multi-user accounts. Single-user, single-city.
- Native mobile apps. The web UI is responsive; that is sufficient.
- Comprehensive coverage of all Seattle cinemas in v1.

## Users

One user. No authentication in v1 — the deployment is personal and unlisted.
Adding auth later is a contained change at the HTTP layer.

## v1 venues

| Venue | Source type | Notes |
|---|---|---|
| Cinemark Lincoln Square (Bellevue) | HTML | IMAX + Reserve & Dine |
| Cinemark Totem Lake (Kirkland) | HTML | |
| AMC Alderwood | Official API | Key issued, pending activation |
| AMC Pacific Place (Seattle) | Official API | Key issued, pending activation |
| SIFF Cinema Downtown | HTML | |
| SIFF Cinema Uptown | HTML | |
| SIFF Film Center | HTML | |
| Seattle Magic Theater | HTML | Irregular programming; often no events |

All venues are in `America/Los_Angeles`.

## Verified source findings

These were confirmed by direct probe on 2026-08-16. They are the basis for the
adapter designs and should be re-verified if implementation starts much later.

**AMC** — `api.amctheatres.com` is live. An unauthenticated request returns a
structured JSON error, `"The request requires vendor authentication"`, confirming
a working versioned REST API behind a vendor key. The developer portal at
`developers.amctheatres.com` is Cloudflare-protected and must be accessed from a
normal browser.

A vendor key was issued to the user on 2026-08-16 and tested the same day. Two
findings:

- **The authentication header is `X-AMC-Vendor-Key`.** Third-party documentation
  claiming `X-API-Key` is wrong; that header produces a generic
  `400 "The request requires vendor authentication"`.
- With the correct header, every catalog endpoint (`v1/theatres`, `v2/theatres`,
  `v2/movies/views/now-playing`, `v1/locations`) returns
  `403 {"code": 12005, "exceptionMessage": "Unauthorized VendorKey."}`. The key is
  recognized but not yet activated.

The developer portal states that changes deploy to production on Thursdays, which
is consistent with a key issued Sunday 2026-08-16 becoming active Thursday
2026-08-20. Retest then. If it remains unauthorized after that date, AMC degrades
to an HTML adapter like the other sources.

AMC documents a sandbox at `developers.amctheatres.com/GettingStarted/Sandbox`,
which may allow development before the production key activates. The page is
Cloudflare-protected and could not be read during design, and guessing sandbox
hostnames (`api.sandbox.`, `sandbox.api.`, `api-sandbox.`) produced only Cloudflare
error responses. **Read that page from a browser before starting the AMC adapter**
and record the real sandbox base URL and credentials here.

**Cinemark** — Theatre pages are fully server-rendered with no JavaScript
framework. Showtime data is present in the delivered HTML with structured
attributes: `data-movieid`, `data-movie-title`, `data-showdates`, `data-datevalue`,
`data-print-type` (the premium-format flag), `data-json-model`, and `showtimeId`.
The Lincoln Square page carried 195 showtimes. `data-ajax` attributes indicate
endpoints for paging to other dates. One `application/ld+json` block provides
venue identity but not showtimes.

**SIFF publishes only a 7-day window.** Confirmed 2026-08-16 during implementation.
The cinema page pages by day *offset*, not absolute date: `/cinema?day=0` through
`/cinema?day=6`. An absolute `?date=YYYY-MM-DD` parameter is ignored, and offsets
of 7 or greater silently return **today's** listings rather than erroring. A naive
21-day sweep therefore yields 21 copies of today. The SIFF adapter requests
offsets 0–6 only and additionally filters parsed results by local date, so any
future today-fallback contributes nothing instead of duplicating.

The 21-day fetch window in "Scheduler and politeness" applies to Cinemark and AMC.
SIFF's effective horizon is 7 days.

**Cinemark rejects Node's `fetch`, not our user agent.** Confirmed 2026-08-16.
`api`-style probes established that `undici` (Node's built-in `fetch`) receives a
403 from cinemark.com regardless of headers — including with a full browser header
set and with no headers at all — while `curl` and Node's built-in `node:https`
module both receive 200 using the project's own self-identifying user agent. The
block is a TLS/connection fingerprint below the HTTP layer, not a judgment about
how we identify ourselves. The fetch layer therefore uses `node:https` as its
default transport and keeps the descriptive user agent unchanged. No user-agent
spoofing is required or used.

**SIFF** — Server-rendered via the Ingeniux CMS. Showtimes appear in page HTML.
Individual film pages live at `/cinema/in-theaters/<slug>`, and a `/calendar` view
exists. Slugs themselves carry special-event signal: observed examples include
`the-odyssey-(70mm)`, `teenage-sex-and-death-at-camp-miasma-(35mm)`, and
`faust-with-the-invincible-czars`. Elevent (`content.elevent.app`) provides the
checkout widget only and is not a data source; SIFF's own pages are the source.

**Letterboxd** — Account `TheThomp`. Verified by direct probe on 2026-08-16.

- `letterboxd.com/thethomp/rss/` returns `application/rss+xml` with the 50 most
  recent diary entries. Each item carries `tmdb:movieId`,
  `letterboxd:memberRating`, `letterboxd:watchedDate`, `letterboxd:rewatch`,
  `letterboxd:memberLike`, `filmTitle`, and `filmYear`. **The presence of TMDB IDs
  means rated films need no title resolution at all** — they arrive keyed to the
  same identifier the rest of the system uses.
- `letterboxd.com/thethomp/watchlist/` returns paginated HTML at
  `/watchlist/page/N/`, 28 films per page. Films are exposed via `data-item-slug`,
  `data-item-name`, and `/film/<slug>/` links. A full crawl on 2026-08-16 returned
  **219 unique films across 8 pages**. No TMDB IDs are present, so watchlist
  entries require slug or title+year resolution.
- `letterboxd.com/thethomp/films/ratings/` returns a Cloudflare challenge (403).
  Do not scrape ratings pages; use RSS and CSV export instead.

The official Letterboxd API is approval-gated and is not planned around.

**Seattle Magic Theater** — Hand-rolled static site, no CMS, no structured data,
no feed. The `/events` page rendered an "Upcoming Events" heading with no events
listed. Trivial to parse; expect long empty stretches, and do not treat an empty
result from this adapter as a failure.

## Architecture

A single deployable TypeScript service:

```
external sources → adapters → normalization → SQLite → scoring → API + UI
```

The scheduler runs in-process. There is no queue, no separate worker, and no
external database. At five sources refreshed a few times daily, additional
infrastructure would add maintenance cost without benefit.

### Stack

- TypeScript on Node 22
- Hono (HTTP API)
- React + Vite (UI), served as static assets by the same process
- SQLite via Drizzle ORM
- Vitest (tests)
- Docker, deployed to Fly.io with a persistent volume

TypeScript was chosen over Python to keep the whole system in one language. The
user is more familiar with Python but explicitly preferred single-language
consistency.

## Data model

```
venues
  id, name, chain, address, city, url, timezone, weight

films
  id, tmdb_id (nullable), title, year, runtime_minutes, original_language,
  genres (json), director, poster_url, synopsis, us_release_date

screenings
  id, venue_id, film_id (nullable until resolved), starts_at_utc,
  local_date, ticket_url, source_screening_id, raw_title,
  tags (json), first_seen_at, last_seen_at

title_overrides
  raw_title, venue_id (nullable), tmdb_id

watchlist
  id, film_id (nullable), title_pattern, added_at, notes, source

letterboxd_entries
  id, kind, film_slug, tmdb_id (nullable), title, year,
  member_rating, watched_date, rewatch, liked, synced_at

taste_affinities
  id, dimension, value, mean_rating, sample_count, weight

taste_rules
  id, kind, value, weight, enabled

source_runs
  id, source, started_at, finished_at, status, item_count, error

app_state
  key, value
```

`source_runs.source` names an adapter or the Letterboxd sync; `item_count` is
screenings for adapters and synced entries for Letterboxd.

`app_state` holds singleton values, notably `last_visit_at`, which backs the
"new since you last looked" marker in the UI.

`local_date` is stored explicitly alongside `starts_at_utc` so that day-grouping
in the UI never depends on the server's timezone. A 11:45pm screening belongs to
that evening, not the next UTC day.

`first_seen_at` is what makes "new since you last looked" possible, and drives
watchlist alerts and newly-announced special events. It is set once on insert and
never updated; `last_seen_at` updates on every sweep that still reports the
screening. A screening absent from two consecutive successful sweeps is treated as
cancelled and hidden, not deleted.

## Adapter contract

```ts
interface VenueAdapter {
  readonly id: string
  readonly venues: VenueRef[]
  fetch(venue: VenueRef, range: DateRange): Promise<RawScreening[]>
}

interface RawScreening {
  rawTitle: string
  startsAt: Date
  ticketUrl: string
  sourceScreeningId: string
  formatHints: string[]   // e.g. ["IMAX"], ["70MM"] — pre-tag-extraction
  description?: string
}
```

Each adapter knows one source and nothing else. Adding a venue means writing one
module and registering it; no other code changes.

All adapters share a common fetch layer providing rate limiting, response caching,
retry with backoff, and a consistent descriptive user agent.

## Title resolver

Maps `rawTitle` from a venue to a TMDB film. This is the hardest normalization
problem in the system and is isolated accordingly.

Resolution order:

1. Exact match in `title_overrides` for this raw title (optionally venue-scoped).
2. Normalized-title exact match against already-resolved films. Normalization
   strips format suffixes (`(70mm)`, `(35mm)`, `- IMAX`), leading articles, and
   punctuation, and casefolds.
3. TMDB search on the normalized title, accepting the top result only when the
   match score clears a confidence threshold.
4. Unresolved. The screening is stored with `film_id = null` and still displays
   using its raw title. It appears in the health view for manual override.

Unresolved screenings are a normal state, not an error. The override table is the
manual escape hatch, and is expected to be used.

## Tag extractor

v1 is rule-based over raw title, format hints, and description. Tags:
`70MM`, `35MM`, `IMAX`, `DOLBY`, `Q_AND_A`, `LIVE_SCORE`, `ANNIVERSARY`,
`FESTIVAL`, `SING_ALONG`, `MEMBER_ONLY`.

This is planned for replacement by LLM-based extraction in v2. The v1 rule
implementation defines the interface and provides the test corpus the LLM version
will be measured against. The interface is therefore fixed now:

```ts
interface TagExtractor {
  extract(input: TagInput): Promise<Tag[]>
}
```

Async from the start, so the LLM implementation is a drop-in swap.

## Highlight scorer

A pure function:

```ts
score(film, screening, rules): { score: number, reasons: Reason[] }
```

Purity keeps it trivially testable. `reasons` is what allows the UI to explain
*why* something is highlighted, and to show which taste rules are actually firing.

Seed weights (all stored in `taste_rules` and editable):

| Signal | Weight |
|---|---|
| Watchlist match (manual or Letterboxd) | +100 |
| Declared preference match (seeded: Horror) | +60 |
| Special-event tag (`70MM`, `35MM`, `LIVE_SCORE`, `Q_AND_A`, `ANNIVERSARY`) | +50 |
| Letterboxd affinity, strong (see below) | +30 |
| Non-English original language | +20 |
| Preferred genre match | +15 |
| Venue weight (SIFF, Seattle Magic Theater) | +15 |
| `IMAX` tag | +10 |
| Already watched, no special-event tag | −80 |

Highlight threshold: score ≥ 40. Items below the threshold appear in the agenda
but not the highlight feed.

**Declared preferences.** Standing preferences the user states outright, stored in
`taste_rules` with `kind = 'declared'`. They are deliberately weighted above the
highlight threshold so that a match always reaches the feed on its own, without
needing any other signal, and they are never overridden by weak derived affinity.

Seeded with **Horror**, at +60. That places horror above special-event tags and
below watchlist hits in the feed ordering — any horror film screening at a tracked
venue surfaces, and an explicitly watchlisted film still outranks it.

Declared preferences are still subject to already-watched suppression: a horror
film scores 60 against a −80 penalty and therefore does not resurface once seen,
unless the screening carries a special-event tag. This is intentional, and it is
the main case to revisit if the feed feels wrong in practice.

**Already-watched suppression.** A film present in `letterboxd_entries` with
`kind = 'diary'` is heavily penalized, so last month's viewing does not crowd the
feed. The penalty does not apply when the screening carries a special-event tag —
a 70mm print of something already seen is precisely the kind of rewatch worth
surfacing.

## Upcoming releases

TMDB supplies `us_release_date`. The upcoming feed contains films within the next
60 days that have no showtimes yet at any tracked venue, and that either appear on
the watchlist, match at least one enabled taste rule, or carry a strong Letterboxd
affinity.

## Letterboxd integration

Letterboxd is the primary taste signal, replacing most hand-written rules.

Letterboxd is **not** a `VenueAdapter` — it produces no screenings. It is a
separate sync module writing to `letterboxd_entries`, `watchlist`, and
`taste_affinities`. It shares the common fetch layer and records `source_runs`
rows, so its failures surface in the health view alongside adapter failures.

**Initial import — CSV.** The user exports their data from Letterboxd (Settings →
Import & Export) and drops the archive in place. This yields complete watchlist
and full rating history, and is not subject to scraping fragility. This is the
authoritative backfill and is run once.

**Incremental sync — RSS.** The diary feed at `letterboxd.com/<user>/rss/` is
polled on the normal sweep schedule. It returns the 50 most recent entries with
`tmdb:movieId` already attached, so new ratings need no title resolution. Entries
are upserted on `(film_slug, watched_date)`.

**Watchlist sync — HTML.** The paginated watchlist is crawled on the same
schedule, one request per page with the shared rate limit. Slugs resolve to TMDB
via the existing title resolver using title and year; unresolved entries are
retained by slug and surfaced in the health view.

Because RSS only reaches back 50 entries, a gap longer than that between syncs is
covered by re-running the CSV import. The system does not attempt to paginate
history from HTML.

**Deriving affinities.** `taste_affinities` is recomputed after each sync. For
each dimension — genre, original language, director, decade — the system computes
the mean member rating and sample count across rated films carrying that value.
A dimension value counts as a **strong affinity** when its mean rating is at least
0.5 stars above the user's overall mean and it has at least 5 rated samples. The
minimum sample count exists to stop a single 5-star rating from turning a whole
genre into a highlight generator.

A film scores the strong-affinity bonus once, not once per matching dimension.

**Watchlist unification.** Letterboxd watchlist entries populate the same
`watchlist` table as manually added titles, distinguished by `source`. Manual
entries are never overwritten by a sync.

## Scheduler and politeness

- Sweep every 6 hours, adapters staggered rather than concurrent.
- Fetch window: today through today + 21 days.
- Rate limit: at most 1 request per 2 seconds per host.
- Responses cached; conditional requests where the source supports them.
- Descriptive user agent identifying the tool as a personal aggregator.

This is a personal-scale read of publicly published showtimes. The limits are
built into the shared fetch layer rather than left to individual adapters.

## API surface

```
GET  /api/highlights?days=14
GET  /api/schedule?from=&to=&venue=&tag=
GET  /api/upcoming
GET  /api/watchlist
POST /api/watchlist
DELETE /api/watchlist/:id
GET  /api/health
POST /api/overrides
```

## UI

Layout A, confirmed against mockups.

**Highlight feed** at the top of the page: special events, watchlist hits, and
high-scoring taste matches, each showing its tags and the reason it surfaced.
Below it, a **day-by-day agenda** of all screenings grouped by local date, with
venue, format, and times. Every showtime links to the venue's ticket page.

Items whose `first_seen_at` is more recent than the user's last visit are marked
as new. Filters for venue, tag, and watchlist-only.

A separate **health view** lists recent `source_runs`, adapter status, and
unresolved titles awaiting override.

Responsive; usable on a phone.

## Health monitoring

Every sweep writes a `source_runs` row. A source is flagged failing when it
throws, or when its `item_count` drops by more than 50% against its trailing
7-day median. Seattle Magic Theater is exempt from the count check, since zero
events is its normal state.

Failures surface in the health view and are visible from the main UI.

## Testing

- **Adapter parse tests** run against recorded HTML fixtures in `fixtures/`, with
  no network access. This is the primary defense against silent scraper rot: a
  source redesign produces a failing test with a readable diff rather than an
  empty dashboard.
- **Resolver tests** cover suffix stripping, override precedence, and
  below-threshold non-matches.
- **Letterboxd tests** run against recorded RSS and watchlist HTML fixtures,
  covering rating parsing, TMDB id extraction, pagination, and the affinity
  computation including its minimum-sample-count floor.
- **Scorer tests** are straightforward given the function's purity, and cover each
  seed weight and the threshold boundary.
- **API integration tests** run against an in-memory SQLite instance.

## Risks

**AMC vendor key.** A key was issued on 2026-08-16 and tested the same day: the
API accepts the `X-AMC-Vendor-Key` header but returns `Unauthorized VendorKey`
(code 12005) on all catalog endpoints, indicating the key is not yet activated.
This matches AMC's stated Thursday production deploy cadence, so the expected
resolution is 2026-08-20. If it is still unauthorized after that date, AMC
degrades to an HTML adapter like the others. Nothing else depends on it, and it is
sequenced last.

**Scraper breakage.** Certain over time, not hypothetical. Mitigated by fixture
tests plus the health view — the goal is fast, loud detection rather than
prevention.

**Title resolution errors.** Mitigated by the manual override table and by
degrading to the raw title rather than dropping the screening.

## Implementation sequence

Riskiest work first:

1. Adapter contract and fixture test harness
2. SIFF adapter — the richest special-event signal, and the best early test of
   whether the data model holds
3. Cinemark adapter
4. Seattle Magic Theater adapter
5. TMDB client and title resolver
6. Letterboxd import (CSV) and sync (RSS + watchlist HTML)
7. Tag extractor (rules)
8. Highlight scorer, including affinity derivation
9. API
10. UI (Layout A)
11. Health view
12. Deployment
13. AMC adapter, once the vendor key activates

SIFF is deliberately first among adapters. Its 70mm and live-score listings will
expose a wrong data model in week one, while changing it is still cheap.

Letterboxd follows the title resolver because it depends on it for watchlist
slugs, and precedes the scorer because the scorer consumes its affinities.

## v2 roadmap

Recorded now, deliberately out of v1 scope:

- **LLM tag extraction**, replacing rules behind the existing interface. Expected
  to substantially outperform rules on unstructured descriptions.
- **LLM taste scoring**, layered on top of the Letterboxd affinity model once
  there is enough real usage to judge where the affinity model falls short.
- **Venue expansion.** Survey Seattle repertory houses — Grand Illusion,
  Northwest Film Forum, The Beacon, Central Cinema, Ark Lodge, The Admiral — and
  report on which merit adapters before writing any.
- **ICS calendar feed** subscribable from Google Calendar.
- **Push digest** — weekly email plus watchlist-hit alerts.
