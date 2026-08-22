import { DateTime } from 'luxon'
import { createDatabase } from './db/client.js'
import { seedVenues } from './db/seed.js'
import { createAdapters, allVenues } from './adapters/index.js'
import { Fetcher } from './fetch/fetcher.js'
import { runSweep } from './sweep/sweep.js'
import { evaluateHealth } from './store/runs.js'
import { TmdbClient } from './tmdb/client.js'
import { runResolution } from './resolve/run.js'

const DB_PATH = process.env.DATABASE_PATH ?? 'data/cinema-tracker.db'
const FETCH_WINDOW_DAYS = 21
const TZ = 'America/Los_Angeles'

async function sweep(): Promise<void> {
  const { db, close } = createDatabase(DB_PATH)
  try {
    const fetcher = new Fetcher()
    const adapters = createAdapters(fetcher, { amcApiKey: process.env.AMC_API_KEY })
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
  } finally {
    close()
  }
}

const command = process.argv[2]
if (command === 'sweep') {
  await sweep()
} else if (command === 'resolve') {
  await resolve()
} else {
  console.error('Usage: cli.ts <sweep|resolve>')
  process.exit(1)
}
