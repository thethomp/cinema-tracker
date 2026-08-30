/**
 * Development API process.
 *
 * Serves only the JSON API on :8787, against the live database, so `vite dev`
 * can proxy `/api` to it. The production entry point that serves the built
 * assets alongside the API and runs the scheduler is a later task; this exists
 * purely so the UI can be developed against real rows.
 */
import { serve } from '@hono/node-server'
import { loadEnv } from '../src/config/env.js'
import { createDatabase } from '../src/db/client.js'
import { createApp } from '../src/server/app.js'

// Before the constants below read it. See `src/config/env.ts`.
loadEnv()

const PORT = Number(process.env.PORT ?? 8787)
const DB_PATH = process.env.DB_PATH ?? 'data/cinema-tracker.db'

const { db, close } = createDatabase(DB_PATH)
const app = createApp(db)

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`dev API on http://localhost:${info.port} (db: ${DB_PATH})`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      close()
      process.exit(0)
    })
  })
}
