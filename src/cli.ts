import { DateTime } from 'luxon'
import { createDatabase } from './db/client.js'
import { seedTasteRules, seedVenues } from './db/seed.js'
import { createAdapters, allVenues } from './adapters/index.js'
import { Fetcher } from './fetch/fetcher.js'
import { runSweep } from './sweep/sweep.js'
import { evaluateHealth } from './store/runs.js'
import { TmdbClient } from './tmdb/client.js'
import { runResolution } from './resolve/run.js'
import { enrichWatchedFilms } from './taste/enrich.js'
import { RuleTagExtractor } from './tags/extract.js'
import { runScoring } from './score/run.js'
import { HIGHLIGHT_THRESHOLD } from './score/score.js'

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

    // The taste model reads `films`, which the pass above fills only with
    // titles currently on sale. Without this the owner's diary joins to a
    // dozen rows and every affinity falls under the sample floor.
    const enriched = await enrichWatchedFilms(db, client, new Date())
    console.log(
      `\nWatched-film metadata: fetched ${enriched.fetched}, already held ${enriched.skipped}`,
    )
    for (const failure of enriched.failed) {
      console.log(`  tmdb ${failure.tmdbId}: ${failure.error}`)
    }
  } finally {
    close()
  }
}

const TOP_HIGHLIGHTS = 20

async function scoreCommand(): Promise<void> {
  const { db, close } = createDatabase(DB_PATH)
  try {
    await seedTasteRules(db)

    const summary = await runScoring(db, new RuleTagExtractor(), new Date())

    console.log(
      `Scored ${summary.scored} future screenings; ${summary.highlights} at or above ${HIGHLIGHT_THRESHOLD}.`,
    )
    console.log(
      `Taste model: ${summary.affinities} strong affinities, overall mean ${summary.overallMean.toFixed(2)}.`,
    )

    if (summary.groups.length === 0) {
      console.log('\nNothing cleared the highlight threshold.')
      return
    }

    console.log(`\nTop ${Math.min(TOP_HIGHLIGHTS, summary.groups.length)} highlights:\n`)
    let rank = 0
    for (const group of summary.groups.slice(0, TOP_HIGHLIGHTS)) {
      rank += 1
      const title = group.filmTitle && group.filmTitle !== group.rawTitle
        ? `${group.rawTitle}  [${group.filmTitle}]`
        : group.rawTitle
      const showtimes = group.showtimes === 1 ? '1 showtime' : `${group.showtimes} showtimes`
      console.log(`${String(rank).padStart(2)}. ${String(group.score).padStart(4)}  ${title}`)
      console.log(
        `      ${group.firstDate}  ${group.venueNames.join(', ')}  (${showtimes})`,
      )
      console.log(`      tags: ${group.tags.length > 0 ? group.tags.join(', ') : '—'}`)
      console.log(
        `      why: ${group.reasons.map((r) => `${r.signal} ${r.weight > 0 ? '+' : ''}${r.weight} (${r.detail})`).join('; ')}`,
      )
    }
  } finally {
    close()
  }
}

const command = process.argv[2]
if (command === 'sweep') {
  await sweep()
} else if (command === 'resolve') {
  await resolve()
} else if (command === 'score') {
  await scoreCommand()
} else {
  console.error('Usage: cli.ts <sweep|resolve|score>')
  process.exit(1)
}
