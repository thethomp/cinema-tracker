import { Hono } from 'hono'
import { asc } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { Db } from '../db/client.js'
import { appState, venues } from '../db/schema.js'
import { getAgenda } from '../read/agenda.js'
import { getHealth } from '../read/health.js'
import { getHighlights } from '../read/highlights.js'

/**
 * Every venue in this project is in Seattle, so agenda dates are local dates
 * here. When that stops being true the timezone has to come from `venues`, not
 * from the server's own clock.
 */
const TZ = 'America/Los_Angeles'

const DEFAULT_DAYS = 14
const MIN_DAYS = 1
/** Sweeps fetch 21 days ahead; 90 is generous headroom and a hard stop. */
const MAX_DAYS = 90

const DEFAULT_LIMIT = 40
const MIN_LIMIT = 1
const MAX_LIMIT = 200

const DAY_MS = 24 * 60 * 60 * 1000

export interface AppOptions {
  /** Injected so tests are not at the mercy of the wall clock. */
  now?: () => Date
  /**
   * Sources this process is configured to run, added to the health report's
   * known set. `serve.ts` passes its live adapter ids; see `HealthOptions`.
   */
  sources?: readonly string[]
}

/**
 * Read a bounded integer query parameter.
 *
 * Absent or unparseable falls back to the default; anything else is clamped.
 * Neither a negative nor a nine-digit value may reach the query layer — the
 * first silently inverts a window and the second asks SQLite for every row
 * ever swept.
 */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

class BadRequest extends Error {}

/**
 * Parse a `YYYY-MM-DD` query parameter as an instant in the venue timezone.
 *
 * A bad date is a 400 rather than a silent fallback to today: a UI asking for
 * a range it mistyped should be told, not handed a plausible different answer.
 */
function localDay(raw: string | undefined, name: string, edge: 'start' | 'end'): Date | null {
  if (raw == null || raw.trim() === '') return null
  const parsed = DateTime.fromISO(raw.trim(), { zone: TZ })
  if (!parsed.isValid) {
    throw new BadRequest(`Invalid '${name}' date: expected YYYY-MM-DD, got '${raw}'`)
  }
  return (edge === 'start' ? parsed.startOf('day') : parsed.endOf('day')).toJSDate()
}

/**
 * `createApp` takes the database rather than opening one.
 *
 * That is what lets the tests drive the whole app over `:memory:` through
 * `app.request()` without binding a socket or touching the live file.
 */
export function createApp(db: Db, options: AppOptions = {}) {
  const clock = options.now ?? (() => new Date())
  const app = new Hono()

  app.get('/api/highlights', async (c) => {
    const days = boundedInt(c.req.query('days'), DEFAULT_DAYS, MIN_DAYS, MAX_DAYS)
    const limit = boundedInt(c.req.query('limit'), DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT)

    const from = clock()
    const to = new Date(from.getTime() + days * DAY_MS)
    const entries = await getHighlights(db, { from, to, limit })

    return c.json({
      window: { from: from.toISOString(), to: to.toISOString(), days },
      limit,
      entries,
    })
  })

  app.get('/api/agenda', async (c) => {
    const now = clock()
    const requestedFrom = localDay(c.req.query('from'), 'from', 'start')
    const requestedTo = localDay(c.req.query('to'), 'to', 'end')

    // Never earlier than now. Start-of-day for today is hours in the past, and
    // an agenda that offers this morning's showtimes is worse than useless.
    const from = new Date(Math.max(requestedFrom?.getTime() ?? 0, now.getTime()))
    const defaultTo = new Date(from.getTime() + DEFAULT_DAYS * DAY_MS)
    const ceiling = from.getTime() + MAX_DAYS * DAY_MS

    if (requestedTo != null && requestedTo.getTime() < from.getTime()) {
      throw new BadRequest(`'to' is before 'from'`)
    }
    const to = new Date(Math.min(requestedTo?.getTime() ?? defaultTo.getTime(), ceiling))

    const days = await getAgenda(db, { from, to })
    return c.json({ window: { from: from.toISOString(), to: to.toISOString() }, days })
  })

  app.get('/api/health', async (c) =>
    c.json(
      await getHealth(db, {
        now: clock(),
        ...(options.sources != null ? { sources: options.sources } : {}),
      }),
    ),
  )

  app.post('/api/visit', async (c) => {
    const current = clock().toISOString()
    const existing = await db.select().from(appState)
    const previous = existing.find((row) => row.key === 'last_visit_at')?.value ?? null

    await db
      .insert(appState)
      .values({ key: 'last_visit_at', value: current })
      .onConflictDoUpdate({ target: appState.key, set: { value: current } })

    // The previous value goes back in the response because it is about to be
    // gone: the UI needs it to decide what was new *this* visit.
    return c.json({ previous, current })
  })

  app.get('/api/venues', async (c) => {
    const rows = await db
      .select({
        id: venues.id,
        name: venues.name,
        chain: venues.chain,
        timezone: venues.timezone,
      })
      .from(venues)
      .orderBy(asc(venues.id))
    return c.json({ venues: rows })
  })

  // JSON, not Hono's plain-text default: every consumer of this app parses
  // JSON, and an HTML or bare-text body turns a 404 into a parse error that
  // says nothing about what went wrong.
  app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404))

  app.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400)
    console.error('API error:', err)
    return c.json({ error: 'Internal error', message: err.message }, 500)
  })

  return app
}
