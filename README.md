# cinema-tracker

A personal aggregator for Seattle cinema showtimes.

Checking what's on around Seattle means visiting four different websites, and the
screenings most worth catching — a 70mm print, a silent film with live score, a
one-night-only restoration — are the easiest to miss, because they appear
irregularly and vanish quickly.

cinema-tracker pulls everything into one place and leads with what deserves
attention, rather than handing you an undifferentiated list.

## Status

Under construction. **There is no web UI yet** — the pipeline currently sweeps
showtimes into a local SQLite database, and you query it with `sqlite3`.

| | Stage | Status |
|---|---|---|
| ✅ | Foundation & venue adapters | Merged |
| 🔨 | Film enrichment (TMDB) | In progress |
| | Taste & scoring (Letterboxd) | Planned |
| | API, web UI, deployment | Planned |
| | AMC adapter | Planned — API key active |

## Venues tracked

| Venue | Source |
|---|---|
| SIFF Cinema Downtown / Uptown / Film Center | siff.net |
| Cinemark Lincoln Square (Bellevue) | cinemark.com |
| Cinemark Totem Lake (Kirkland) | cinemark.com |
| Seattle Magic Theater | `events.json` |
| AMC Alderwood / Pacific Place | Official AMC API *(not yet wired up)* |

SIFF publishes only a 7-day window; the others publish roughly three weeks.

## Requirements

- **Node 22+**
- A **TMDB API key** — free and self-serve at
  [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)
  (request a "Developer" key). Needed for film enrichment.
- An **AMC vendor API key** — request at
  [developers.amctheatres.com](https://developers.amctheatres.com/). Only needed
  once the AMC adapter lands. Keys activate on AMC's weekly Thursday deploy, so
  expect a delay between issue and activation.

Nothing else. The database is SQLite, created automatically.

## Setup

```bash
npm install
cp .env.example .env
```

Then edit `.env`:

```
TMDB_API_KEY=your_key_here
AMC_API_KEY=your_key_here
```

`.env` is gitignored. Don't commit it.

## Usage

```bash
npm run sweep      # fetch showtimes from all venues into SQLite
npm run resolve    # match raw titles to TMDB films
npm test           # run the test suite (no network)
```

The database is written to `data/cinema-tracker.db`, overridable with
`DATABASE_PATH`.

**A sweep takes a few minutes.** The fetch layer deliberately allows one request
per host every two seconds, out of politeness to venues that are mostly small
businesses. Avoid running two full sweeps back to back — Cinemark rate-limits at
around 88 requests inside four minutes. Re-running is otherwise safe: existing
rows are updated in place, and `first_seen_at` is preserved so newly-appeared
screenings stay detectable.

## Looking at the data

Until the UI exists:

```bash
# What's on, by venue
sqlite3 -box data/cinema-tracker.db "
  SELECT v.name, COUNT(*) AS screenings, MIN(s.local_date), MAX(s.local_date)
  FROM screenings s JOIN venues v ON v.id = s.venue_id
  WHERE s.cancelled = 0 GROUP BY v.id ORDER BY screenings DESC;"

# Special formats — the stuff worth planning around
sqlite3 -box data/cinema-tracker.db "
  SELECT DISTINCT s.local_date, s.raw_title, s.format_hints, v.name
  FROM screenings s JOIN venues v ON v.id = s.venue_id
  WHERE s.cancelled = 0 AND s.format_hints != '[]'
  ORDER BY s.local_date;"
```

## How it works

```
venue sites/APIs → adapters → normalize → SQLite → resolve → score → API/UI
```

Each venue gets one adapter behind a shared contract. Parsers are pure functions
from string to data and never fetch, which lets them be tested against recorded
fixtures with no network. All HTTP goes through a single rate-limited layer.

Screenings are upserted on `(venue, source_screening_id)`. A screening missing
from two consecutive successful sweeps is marked cancelled rather than deleted, so
a single failed fetch can't wipe a venue.

Every sweep records a row per source, and a source is flagged when it throws or
its screening count falls below half its recent median — because the realistic
failure mode is a site redesign producing *plausible but wrong* data, not an
error.

## Documentation

- `docs/superpowers/specs/` — design decisions, and verified facts about each
  source with the dates they were checked
- `docs/superpowers/plans/` — implementation plans
- `AGENTS.md` — conventions and gotchas for anyone (human or agent) working here

## Note on data collection

This reads publicly published showtimes for one person's personal use, at roughly
one request per host every two seconds, with an honest user agent that identifies
the tool and links back to this repository.
