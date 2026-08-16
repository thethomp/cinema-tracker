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
| AMC Alderwood | Official API | Blocked on vendor key |
| AMC Pacific Place (Seattle) | Official API | Blocked on vendor key |
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
normal browser. The user is requesting a key.

**Cinemark** — Theatre pages are fully server-rendered with no JavaScript
framework. Showtime data is present in the delivered HTML with structured
attributes: `data-movieid`, `data-movie-title`, `data-showdates`, `data-datevalue`,
`data-print-type` (the premium-format flag), `data-json-model`, and `showtimeId`.
The Lincoln Square page carried 195 showtimes. `data-ajax` attributes indicate
endpoints for paging to other dates. One `application/ld+json` block provides
venue identity but not showtimes.

**SIFF** — Server-rendered via the Ingeniux CMS. Showtimes appear in page HTML.
Individual film pages live at `/cinema/in-theaters/<slug>`, and a `/calendar` view
exists. Slugs themselves carry special-event signal: observed examples include
`the-odyssey-(70mm)`, `teenage-sex-and-death-at-camp-miasma-(35mm)`, and
`faust-with-the-invincible-czars`. Elevent (`content.elevent.app`) provides the
checkout widget only and is not a data source; SIFF's own pages are the source.

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
external database. At four venues refreshed a few times daily, additional
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
  id, film_id (nullable), title_pattern, added_at, notes

taste_rules
  id, kind, value, weight, enabled

source_runs
  id, adapter, started_at, finished_at, status, screening_count, error
```

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
| Watchlist match | +100 |
| Special-event tag (`70MM`, `35MM`, `LIVE_SCORE`, `Q_AND_A`, `ANNIVERSARY`) | +50 |
| Non-English original language | +20 |
| Preferred genre match | +15 |
| Venue weight (SIFF, Seattle Magic Theater) | +15 |
| `IMAX` tag | +10 |

Highlight threshold: score ≥ 40. Items below the threshold appear in the agenda
but not the highlight feed.

## Upcoming releases

TMDB supplies `us_release_date`. The upcoming feed contains films within the next
60 days that either appear on the watchlist or match at least one enabled taste
rule, and that have no showtimes yet at any tracked venue.

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

Every sweep writes a `source_runs` row. An adapter is flagged failing when it
throws, or when its screening count drops by more than 50% against its trailing
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
- **Scorer tests** are straightforward given the function's purity, and cover each
  seed weight and the threshold boundary.
- **API integration tests** run against an in-memory SQLite instance.

## Risks

**AMC vendor key.** The largest unknown. If AMC declines individual developers,
AMC degrades to an HTML adapter like the others, or drops from v1. Nothing else
depends on it, so it should be applied for early and built last.

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
6. Tag extractor (rules)
7. Highlight scorer
8. API
9. UI (Layout A)
10. Health view
11. Deployment
12. AMC adapter, when the key arrives

SIFF is deliberately first among adapters. Its 70mm and live-score listings will
expose a wrong data model in week one, while changing it is still cheap.

## v2 roadmap

Recorded now, deliberately out of v1 scope:

- **LLM tag extraction**, replacing rules behind the existing interface. Expected
  to substantially outperform rules on unstructured descriptions.
- **Letterboxd integration.** Ratings and watchlist as the primary taste signal,
  likely retiring most hand-written rules. Path: CSV export (a reliable
  first-party feature) for the initial import, then per-user RSS for incremental
  sync. The official API is approval-gated and should not be planned around. The
  RSS endpoint pattern was not verified during design and must be confirmed
  against the user's real account before implementation.
- **Venue expansion.** Survey Seattle repertory houses — Grand Illusion,
  Northwest Film Forum, The Beacon, Central Cinema, Ark Lodge, The Admiral — and
  report on which merit adapters before writing any.
- **ICS calendar feed** subscribable from Google Calendar.
- **Push digest** — weekly email plus watchlist-hit alerts.
