/**
 * The whole app in one process: built assets, the JSON API, and the passes.
 *
 * `npm run serve` is the only thing the owner is expected to run day to day,
 * so the sweep has to happen here rather than in a cron entry nobody set up.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { serve as listen } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { createDatabase, type Db } from '../db/client.js'
import { appState, sourceRuns } from '../db/schema.js'
import { createScheduler } from '../schedule/scheduler.js'
import { configuredSourceIds, resolvePass, scorePass, sweepPass } from '../pipeline/passes.js'
import { createApp } from './app.js'

const DEFAULT_PORT = 8787
const DEFAULT_DB_PATH = 'data/cinema-tracker.db'
/** Vite's build output, relative to the working directory. */
const DEFAULT_WEB_DIST = 'web/dist'

/** Six hours. Sources publish daily at most; four passes a day is generous. */
export const PIPELINE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** When the scheduler last ran the passes, as an ISO instant. */
export const LAST_RUN_KEY = 'last_pipeline_run_at'

/**
 * When the passes last ran, in epoch milliseconds.
 *
 * Falls back to the newest row in `source_runs` when the key is absent, and
 * that fallback is the point. A database swept by `npm run sweep` an hour ago
 * has no `app_state` key, and without the fallback the first `npm run serve`
 * against it would sweep again immediately — two full sweeps an hour apart on
 * a first boot, and a restart loop would be worse. Cinemark rate-limits at
 * roughly 88 requests inside four minutes.
 */
export async function readLastRunAt(db: Db): Promise<number | null> {
  const [stored] = await db.select().from(appState).where(eq(appState.key, LAST_RUN_KEY)).limit(1)
  if (stored != null) {
    const parsed = Date.parse(stored.value)
    if (Number.isFinite(parsed)) return parsed
  }

  const [latest] = await db
    .select({ startedAt: sourceRuns.startedAt })
    .from(sourceRuns)
    .orderBy(desc(sourceRuns.startedAt))
    .limit(1)
  return latest != null ? latest.startedAt.getTime() : null
}

export async function writeLastRunAt(db: Db, at: Date): Promise<void> {
  await db
    .insert(appState)
    .values({ key: LAST_RUN_KEY, value: at.toISOString() })
    .onConflictDoUpdate({ target: appState.key, set: { value: at.toISOString() } })
}

export interface PipelineConfig {
  amcApiKey?: string
  tmdbApiKey?: string
}

/**
 * Sweep, then resolve, then score. Strictly in order — resolve has nothing to
 * match until the sweep has stored raw titles, and score has nothing to weigh
 * until resolve has attached films to them.
 */
export async function runPipeline(db: Db, config: PipelineConfig): Promise<void> {
  const startedAt = new Date()
  try {
    const sweep = await sweepPass(db, { amcApiKey: config.amcApiKey, now: startedAt })
    for (const result of sweep.results) {
      const detail = result.status === 'ok' ? `${result.itemCount} screenings` : result.error
      console.log(`  sweep ${result.source}: ${result.status} — ${detail}`)
    }
    for (const entry of sweep.health.filter((h) => !h.healthy)) {
      console.warn(`  unhealthy: ${entry.source} — ${entry.reason}`)
    }

    if (config.tmdbApiKey) {
      const resolved = await resolvePass(db, config.tmdbApiKey, { now: new Date() })
      console.log(
        `  resolve: ${resolved.resolution.resolved} titles, ` +
          `${resolved.resolution.screeningsLinked} screenings linked, ` +
          `${resolved.resolution.unresolved.length} still unmatched`,
      )
    } else {
      // Loud, and then carry on. Scoring stale film data still beats a server
      // that refuses to sweep because one key is missing.
      console.warn('  resolve: skipped — TMDB_API_KEY is not set')
    }

    const scored = await scorePass(db, { now: new Date() })
    console.log(`  score: ${scored.scored} screenings, ${scored.highlights} above threshold`)
  } finally {
    /*
     * Recorded even when a pass threw, and deliberately so.
     *
     * A sweep that failed halfway has already made most of its requests. If
     * the timestamp only moved on success, a crash-and-restart loop would
     * re-sweep every boot and get the app blocked — the exact failure this
     * key exists to prevent. Six hours later it tries again either way.
     */
    await writeLastRunAt(db, startedAt)
  }
}

export interface ServeOptions {
  port?: number
  dbPath?: string
  webDist?: string
  /** Set false to serve without sweeping — useful when poking at the UI. */
  schedule?: boolean
}

export async function startServer(options: ServeOptions = {}): Promise<void> {
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT)
  const dbPath = options.dbPath ?? process.env.DATABASE_PATH ?? DEFAULT_DB_PATH
  const webDist = options.webDist ?? process.env.WEB_DIST ?? DEFAULT_WEB_DIST
  const config: PipelineConfig = {
    ...(process.env.AMC_API_KEY ? { amcApiKey: process.env.AMC_API_KEY } : {}),
    ...(process.env.TMDB_API_KEY ? { tmdbApiKey: process.env.TMDB_API_KEY } : {}),
  }

  const { db, close } = createDatabase(dbPath)
  const indexPath = path.resolve(process.cwd(), webDist, 'index.html')
  const built = existsSync(indexPath)
  if (!built) {
    console.warn(`No built UI at ${indexPath}. Run 'npm run web:build'. The API still serves.`)
  }

  const api = createApp(db, { sources: configuredSourceIds(config) })
  const app = new Hono()

  // The whole /api namespace is handed to the API app rather than merged into
  // this one, so its JSON 404 and JSON error handler survive. Merged routes
  // would inherit this app's HTML fallback and turn a mistyped endpoint into
  // a page of markup the fetch layer cannot parse.
  app.all('/api/*', (c) => api.fetch(c.req.raw))

  app.use('/*', serveStatic({ root: webDist }))

  app.notFound(async (c) => {
    if (!built) {
      return c.text(
        `The web UI has not been built. Run 'npm run web:build' (looked in ${webDist}).`,
        503,
      )
    }
    // Single page, so anything not on disk is still the programme.
    return c.html(await readFile(indexPath, 'utf8'))
  })

  const lastRunAt = await readLastRunAt(db)
  const scheduler = createScheduler({
    intervalMs: PIPELINE_INTERVAL_MS,
    lastRunAt,
    run: () => runPipeline(db, config),
    onError: (error) => console.error('pipeline failed:', error),
  })

  const server = listen({ fetch: app.fetch, port }, (info) => {
    console.log(`cinema-tracker on http://localhost:${info.port}  (db: ${dbPath})`)
  })

  if (options.schedule === false) {
    console.log('Scheduler disabled.')
  } else {
    const due =
      lastRunAt == null
        ? 'never run — sweeping now'
        : `last run ${new Date(lastRunAt).toISOString()}; ` +
          `next in ${Math.max(0, Math.round((lastRunAt + PIPELINE_INTERVAL_MS - Date.now()) / 60000))}m`
    console.log(`Scheduler: every 6h. ${due}`)
    scheduler.start()
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      scheduler.stop()
      server.close(() => {
        close()
        process.exit(0)
      })
    })
  }
}
