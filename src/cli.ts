import { loadEnv } from './config/env.js'
import { createDatabase } from './db/client.js'
import { resolvePass, scorePass, sweepPass, syncPass } from './pipeline/passes.js'
import { startServer } from './server/serve.js'
import { HIGHLIGHT_THRESHOLD } from './score/score.js'

/*
 * First, before anything reads `process.env`.
 *
 * Every command below is configured entirely by environment variables, and
 * until this call existed none of them loaded `.env` -- so each one worked
 * only after the operator ran `set -a; . ./.env; set +a` by hand, and quietly
 * did less than it claimed when they forgot. Real environment variables still
 * win; see `loadEnv`.
 */
loadEnv()

const DB_PATH = process.env.DATABASE_PATH ?? 'data/cinema-tracker.db'

async function sweep(): Promise<void> {
  const { db, close } = createDatabase(DB_PATH)
  try {
    const { range, results, health } = await sweepPass(db, {
      ...(process.env.AMC_API_KEY ? { amcApiKey: process.env.AMC_API_KEY } : {}),
    })

    console.log(`Sweeping ${range.from} \u2192 ${range.to}`)
    for (const result of results) {
      const detail = result.status === 'ok' ? `${result.itemCount} screenings` : result.error
      console.log(`  ${result.source}: ${result.status} \u2014 ${detail}`)
    }

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
    console.error('TMDB_API_KEY is not set. Add it to .env \u2014 https://www.themoviedb.org/settings/api')
    process.exitCode = 1
    return
  }

  const { db, close } = createDatabase(DB_PATH)
  try {
    const { resolution, backfill, enrichment } = await resolvePass(db, apiKey)

    console.log(
      `Resolved ${resolution.resolved} titles, linked ${resolution.screeningsLinked} screenings`,
    )

    if (resolution.unresolved.length > 0) {
      console.log(`\n${resolution.unresolved.length} unresolved:`)
      for (const entry of resolution.unresolved) {
        console.log(`  ${entry.rawTitle} (${entry.screeningCount} screenings)`)
      }
      console.log('\nAdd a row to title_overrides to resolve one by hand.')
    }

    if (backfill.resolved > 0 || backfill.unresolved.length > 0) {
      console.log(
        `\nDiary backfill: matched ${backfill.resolved}, unmatched ${backfill.unresolved.length}`,
      )
    }

    console.log(
      `\nWatched-film metadata: fetched ${enrichment.fetched}, already held ${enrichment.skipped}`,
    )
    for (const failure of enrichment.failed) {
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
    const summary = await scorePass(db)

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

async function sync(): Promise<void> {
  const username = process.env.LETTERBOXD_USERNAME
  if (!username) {
    console.error('LETTERBOXD_USERNAME is not set. Add it to .env.')
    process.exitCode = 1
    return
  }

  const { db, close } = createDatabase(DB_PATH)
  try {
    // The same pass the scheduler runs, not a second copy of it. This command
    // and `npm run serve` used to reach Letterboxd by different routes, and
    // only one of the two routes existed in the scheduler at all.
    const result = await syncPass(db, {
      username,
      ...(process.env.LETTERBOXD_CSV_DIR ? { csvDir: process.env.LETTERBOXD_CSV_DIR } : {}),
    })

    if (result.status === 'failed') {
      console.error(`Letterboxd sync failed: ${result.error}`)
      process.exitCode = 1
      return
    }

    console.log(
      `Letterboxd: ${result.diaryEntries} diary entries, ` +
        `${result.watchlistEntries} watchlist films (${result.pagesFetched} pages)`,
    )
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
} else if (command === 'sync') {
  await sync()
} else if (command === 'serve') {
  // No `close()` here: the server owns the database for the life of the
  // process and shuts it down on SIGINT.
  // `--no-sweep` is for working on the UI: the same server, without the passes
  // running underneath and rewriting the rows being looked at.
  await startServer({ schedule: !process.argv.includes('--no-sweep') })
} else {
  console.error('Usage: cli.ts <sweep|resolve|sync|score|serve [--no-sweep]>')
  process.exit(1)
}
