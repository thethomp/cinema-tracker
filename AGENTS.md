# AGENTS.md

Guidance for AI agents working in this repo. Human-readable too — nothing here is
agent-specific ceremony.

This is the canonical file. `CLAUDE.md` points here.

## What this is

A personal aggregator for Seattle cinema showtimes. It sweeps venue websites and
APIs into SQLite, resolves films against TMDB, scores them against the owner's
taste, and (eventually) serves a web view that leads with what's worth attention.

Single user. Single city. Not a product.

## Setup

```bash
npm install
cp .env.example .env      # then fill in TMDB_API_KEY and AMC_API_KEY
npm test                  # should be all green before you change anything
```

## Commands

| Command | Does |
|---|---|
| `npm test` | Full Vitest suite. No network access. |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run sweep` | Fetch showtimes from all venues into SQLite. Hits live sites. |
| `npm run resolve` | Resolve unresolved raw titles against TMDB, and fetch metadata for rated Letterboxd films. Hits live API. |
| `npm run score` | Recompute taste affinities, tag and score every future screening, print the top highlights. No network. |
| `npm run serve` | Build the UI and serve it with the API on :8787, sweeping every 6 hours. Add `--no-sweep` to serve without the passes. |

`npm run sweep` takes a few minutes — the fetch layer allows one request per host
every 2 seconds by design. **Don't run two full sweeps back to back**; Cinemark
rate-limits at roughly 88 requests inside four minutes.

`npm run serve` runs the same passes on a 6-hour timer. It records each run in
`app_state.last_pipeline_run_at`, and falls back to the newest `source_runs` row
when that key is absent, so restarting the server does **not** re-sweep.

## Architecture

```
venue sites/APIs → adapters → normalize → SQLite → resolve → score → API/UI
```

| Path | Responsibility |
|---|---|
| `src/core/` | Shared types and time math. No I/O. |
| `src/fetch/` | The only place that makes HTTP requests. Rate limiting lives here. |
| `src/adapters/` | One module per venue source. |
| `src/tmdb/` | TMDB HTTP client. No matching logic. |
| `src/resolve/` | Title normalization and film resolution. |
| `src/store/` | Database reads and writes. |
| `src/sweep/` | Orchestration across adapters. |
| `src/db/` | Schema, connection, seeding. |
| `src/letterboxd/` | Letterboxd ingestion. Parsers are pure; `sync.ts` is the only part with I/O. |
| `src/taste/` | Affinity derivation from rated films, and TMDB backfill for them. |
| `src/tags/` | Rule-based tag extraction, behind an async interface an LLM can replace. |
| `src/score/` | Pure highlight scorer plus the batch pass that stores scores. |

Design docs are in `docs/superpowers/specs/`, implementation plans in
`docs/superpowers/plans/`. **Read the spec before changing behavior** — it records
verified facts about each source that are expensive to rediscover.

## The one rule that matters

**Silent wrong data is the enemy. Loud failure is fine.**

Every serious bug in this project has been a source cheerfully returning
*plausible but wrong* data instead of an error:

- SIFF ignores `?date=` and pages by day offset. Ask for day 12 and you get
  today's listings, HTTP 200. A naive sweep stored 21 copies of today.
- Cinemark's Totem Lake URL 307-redirects and **drops the query string**, so every
  requested date returned today.
- Seattle Magic Theater is client-rendered. The HTML adapter parsed a loading
  skeleton and returned `[]` forever, indistinguishable from "no events".
- Cinemark's `data-print-type-name` concatenates format, seating, and language, so
  `"Telugu Spoken with English Subtitles Standard Format Luxury Lounger"` was
  being stored as a premium-format hint.

None of these threw. All were found by looking at real output.

Consequences for how you work here:

1. **Never trust an inferred URL parameter.** Fetch two different dates and assert
   the results actually differ *and* carry the dates you asked for.
2. **Filter defensively.** Adapters filter parsed results by requested local date,
   so a today-fallback contributes nothing rather than duplicating.
3. **A zero result must be distinguishable from a broken parser.** If you can't
   tell those apart, the design is wrong.
4. **Look at the data after you change something.** Run the sweep, query SQLite,
   read the rows.

See `.claude/skills/verifying-data-sources/SKILL.md` for the full procedure.

## Conventions

- **ESM.** Relative imports use `.js` extensions on `.ts` files:
  `import { Fetcher } from '../fetch/fetcher.js'`. This is required, not a typo.
- **TypeScript 7, Vitest 4.** Both are newer majors than most documentation
  assumes. If an API surprises you, check the installed version before working
  around it.
- **`strict` and `noUncheckedIndexedAccess` are on.** Index access is
  `possibly undefined` — handle it, don't cast it away.
- **Parsers are pure.** A `parse*` function takes a string and returns data. It
  never fetches. That split is what makes fixture tests possible; preserve it.
- **All HTTP goes through `Fetcher`.** Never call `fetch` or `node:https`
  directly from an adapter — that bypasses rate limiting.
- **Node's global `fetch` is not usable for cinemark.com.** Undici's TLS
  fingerprint gets a 403 where `node:https` gets 200 with the same headers.
  `Fetcher` already handles this. Don't "simplify" it back to `fetch`.
- **Don't add dependencies** without a clear reason. The list is deliberately short.

## Testing

Adapter parsers are tested against recorded HTML/JSON fixtures in
`tests/fixtures/`. Tests never touch the network.

**Assert values, not shapes.** `expect(title).toBeTruthy()` passes for any
non-empty string and catches nothing. Pin exact counts and at least one complete
golden record per parser — exact title, exact ISO instant, exact id, exact URL.
A source redesign should produce a readable diff, not a silent empty result.

When you fix a bug, **verify the new test fails against the old code.** A test
written after the fix that passes both ways pins nothing. This has already caught
one fix that only worked against a stale fixture.

Re-record fixtures with:

```bash
npx tsx scripts/record-fixture.ts <url> <fixture-name> [extension]
```

Fixtures age. If you're returning to this repo after weeks, re-record before
trusting the selectors.

## Secrets

`.env` is gitignored and holds `TMDB_API_KEY` and `AMC_API_KEY`. Load with
`set -a; . ./.env; set +a`.

**Never print a key value, echo it into logs, or paste it into a commit,
a test fixture, or a chat message.** Report presence and length instead.

AMC's header is `X-AMC-Vendor-Key`. Third-party write-ups claiming `X-API-Key`
are wrong and will cost you an hour.

## Commits

Explain *why*, not just what. When a commit encodes a hard-won fact about a
source, put the fact in the message — that's where the next person looks.

End commits with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Don't commit or push unless asked. Branch rather than committing to `main`.
