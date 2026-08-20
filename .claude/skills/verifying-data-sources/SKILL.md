---
name: verifying-data-sources
description: Use before writing or trusting any adapter against an external showtimes source, and whenever a source returns data that looks plausible. Establishes that a source silently serving wrong data is the default failure mode here, and gives the procedure for proving otherwise.
---

# Verifying Data Sources

## When to use

- Before writing an adapter for a new venue.
- Before trusting an inferred URL parameter, path, or slug.
- After any change to parsing or fetching.
- When a source returns results that look fine.

That last one is the important one. Every bug this project has hit looked fine.

## The premise

**Cinema websites return HTTP 200 with wrong data.** They do not error when you
ask for something they don't have — they quietly serve today's listings, or a
loading skeleton, or a generic shell. An adapter built on assumption will pass its
tests, populate a database, and be wrong.

Real examples from this repo:

| Source | What it does | What you'd have stored |
|---|---|---|
| SIFF | Ignores `?date=`, pages by `?day=N` offset; `day>6` returns today | 21 copies of today |
| Cinemark | Wrong slug 307-redirects and drops the query string | Today, for every requested date |
| Cinemark | Dates with no published schedule serve today's page | Today, duplicated |
| Seattle Magic | Client-rendered; HTML is a loading skeleton | `[]` forever, looking like "no events" |
| Seattle Magic | `/events/{slug}` soft-404s — 200 for any slug | Dead ticket links |

## The procedure

### 1. Prove the date parameter actually varies the response

Not "the responses differ" — ids can differ for unrelated reasons. Prove the
returned records **carry the date you asked for**.

```bash
# Fetch two dates. Compare the parsed local dates, not just the raw bytes.
# Expect: dated response contains ONLY the requested date.
```

If they don't differ, find the real mechanism before writing anything: read the
date navigation in a recorded fixture, look for `data-*` attributes, check for a
JSON endpoint the page calls.

### 2. Check for a soft 404

Request a deliberately invalid identifier — a nonsense slug, an absurd date, a
made-up id.

```bash
curl -s -o /tmp/real -w '%{http_code}\n' "$URL_REAL"
curl -s -o /tmp/fake -w '%{http_code}\n' "$URL_NONSENSE"
md5 /tmp/real /tmp/fake    # identical hashes = soft 404, the id means nothing
```

A 200 for a nonsense identifier means the identifier is not being honored.

### 3. Check whether the content is even in the HTML

```bash
curl -s "$URL" | grep -c 'known-title-from-the-page'
```

Zero, while a browser shows content, means client-side rendering. Find the JSON
the page fetches — `grep -oE "fetch\([^)]*\)"` on the HTML — and use that instead.
It is almost always cleaner than the DOM.

### 4. Prefer structured data already on the page

Before writing DOM traversal, look for embedded JSON. It is far more stable than
selectors:

- SIFF puts a full JSON object per showtime in a `data-screening` attribute.
- Cinemark puts identifiers and an unambiguous local start time in each
  `showtime-link` href.
- Seattle Magic serves `events.json` directly.
- AMC has an official REST API with a structured `attributes` array.

None of these required parsing rendered text.

### 5. Verify the identifier survives redirects

```bash
curl -sI "$URL?param=value" | grep -i '^location'
```

If a redirect drops your query string, the parameter is silently discarded.
Fix the URL to the canonical one — do not re-append parameters across redirects,
which is incorrect HTTP behavior.

### 6. Filter defensively regardless

Even after verifying, filter parsed results by what you asked for:

```ts
parseX(html).filter((s) => s.localDate === requestedDate)
```

This costs nothing and converts a future silent regression into missing data
rather than wrong data. Both existing HTML adapters do this, and tests fail if
the filter is removed.

### 7. Look at the stored rows

Run the sweep. Query SQLite. Read actual titles, dates, and hints. Every defect
listed above was found by reading real output — not by reading code, and not by
running tests.

## Anti-patterns

| Thought | Why it's wrong |
|---|---|
| "The tests pass, so the adapter works" | Fixture tests prove parsing, not fetching. Both Cinemark date bugs passed every test. |
| "The response was 200" | 200 is the failure mode here, not the success signal. |
| "I'll infer the parameter from the pattern" | Inferred `?date=` and `?showDate=` were both wrong. |
| "It returned zero, so there's nothing on" | Or the parser is blind. Prove you can tell those apart. |
| "The fixture has it, so it's fine" | Fixtures age. The subtitle-label bug passed against a 3-day-old fixture and failed live. |

## Recording what you learn

When you establish a fact about a source, write it into the design spec at
`docs/superpowers/specs/` with the date you verified it. These facts are expensive
to rediscover and invisible in code.
