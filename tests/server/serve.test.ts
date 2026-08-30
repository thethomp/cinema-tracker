import { describe, expect, it } from 'vitest'
import {
  LAST_RUN_KEY,
  pipelineConfigFromEnv,
  readLastRunAt,
  writeLastRunAt,
} from '../../src/server/serve.js'
import { unconfiguredIntegrations } from '../../src/pipeline/passes.js'
import { recordRun } from '../../src/store/runs.js'
import { appState } from '../../src/db/schema.js'
import { emptyDb } from '../read/fixture.js'

const AT = (iso: string): Date => new Date(iso)

describe('readLastRunAt', () => {
  it('returns null on a database that has never been swept', async () => {
    const { db, close } = await emptyDb()
    try {
      expect(await readLastRunAt(db)).toBeNull()
    } finally {
      close()
    }
  })

  it('reads the recorded pipeline run', async () => {
    const { db, close } = await emptyDb()
    try {
      await writeLastRunAt(db, AT('2026-08-22T12:00:00.000Z'))
      expect(await readLastRunAt(db)).toBe(AT('2026-08-22T12:00:00.000Z').getTime())
    } finally {
      close()
    }
  })

  it('falls back to the newest sweep when no pipeline run has been recorded', async () => {
    /*
     * This is the case that stops the first `npm run serve` on an existing
     * database from sweeping the moment it boots. The CLI writes `source_runs`
     * and never touches `app_state`, so a database swept by hand an hour ago
     * has no key to read -- and treating that as "never run" would put a
     * second full sweep an hour behind the first. Cinemark rate-limits at
     * roughly 88 requests inside four minutes.
     */
    const { db, close } = await emptyDb()
    try {
      await recordRun(db, {
        source: 'siff',
        startedAt: AT('2026-08-22T06:00:00.000Z'),
        finishedAt: AT('2026-08-22T06:02:00.000Z'),
        status: 'ok',
        itemCount: 63,
      })
      await recordRun(db, {
        source: 'amc',
        startedAt: AT('2026-08-22T09:30:00.000Z'),
        finishedAt: AT('2026-08-22T09:34:00.000Z'),
        status: 'ok',
        itemCount: 1262,
      })

      expect(await readLastRunAt(db)).toBe(AT('2026-08-22T09:30:00.000Z').getTime())
    } finally {
      close()
    }
  })

  it('counts a failed sweep as a run', async () => {
    // The requests were still made. A failure that reset the clock would let a
    // crash loop sweep on every restart, which is the worst case of all.
    const { db, close } = await emptyDb()
    try {
      await recordRun(db, {
        source: 'cinemark',
        startedAt: AT('2026-08-22T09:00:00.000Z'),
        finishedAt: AT('2026-08-22T09:01:00.000Z'),
        status: 'failed',
        itemCount: 0,
        error: 'HTTP 403',
      })
      expect(await readLastRunAt(db)).toBe(AT('2026-08-22T09:00:00.000Z').getTime())
    } finally {
      close()
    }
  })

  it('prefers the recorded pipeline run over an older sweep', async () => {
    const { db, close } = await emptyDb()
    try {
      await recordRun(db, {
        source: 'siff',
        startedAt: AT('2026-08-22T06:00:00.000Z'),
        finishedAt: AT('2026-08-22T06:02:00.000Z'),
        status: 'ok',
        itemCount: 63,
      })
      await writeLastRunAt(db, AT('2026-08-22T12:00:00.000Z'))
      expect(await readLastRunAt(db)).toBe(AT('2026-08-22T12:00:00.000Z').getTime())
    } finally {
      close()
    }
  })

  it('falls back rather than trusting an unparseable stored value', async () => {
    const { db, close } = await emptyDb()
    try {
      await db.insert(appState).values({ key: LAST_RUN_KEY, value: 'not a date' })
      await recordRun(db, {
        source: 'siff',
        startedAt: AT('2026-08-22T06:00:00.000Z'),
        finishedAt: AT('2026-08-22T06:02:00.000Z'),
        status: 'ok',
        itemCount: 63,
      })
      // NaN would compare false against every interval and sweep on every
      // boot, which is precisely the behaviour being guarded against.
      expect(await readLastRunAt(db)).toBe(AT('2026-08-22T06:00:00.000Z').getTime())
    } finally {
      close()
    }
  })
})

describe('writeLastRunAt', () => {
  it('upserts rather than accumulating a row per run', async () => {
    const { db, close } = await emptyDb()
    try {
      await writeLastRunAt(db, AT('2026-08-22T00:00:00.000Z'))
      await writeLastRunAt(db, AT('2026-08-22T06:00:00.000Z'))

      const rows = await db.select().from(appState)
      expect(rows).toEqual([{ key: LAST_RUN_KEY, value: '2026-08-22T06:00:00.000Z' }])
    } finally {
      close()
    }
  })

  it('leaves the visit stamp alone', async () => {
    // Both live in app_state and both are single rows keyed by name. An upsert
    // that targeted the table rather than the key would clobber the other.
    const { db, close } = await emptyDb()
    try {
      await db.insert(appState).values({ key: 'last_visit_at', value: '2026-08-20T00:00:00.000Z' })
      await writeLastRunAt(db, AT('2026-08-22T06:00:00.000Z'))

      const rows = await db.select().from(appState)
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.key === 'last_visit_at')?.value).toBe('2026-08-20T00:00:00.000Z')
    } finally {
      close()
    }
  })
})

describe('pipelineConfigFromEnv', () => {
  it('reads the Letterboxd username the sync pass needs', () => {
    /*
     * The gap this branch closes. `LETTERBOXD_USERNAME` sat in `.env` and in
     * the `sync` CLI command while the scheduler swept, resolved and scored
     * without ever touching Letterboxd -- so the diary was whatever the owner
     * last synced by hand, seven days earlier, and the taste model scored
     * three weeks of showtimes against it.
     */
    expect(
      pipelineConfigFromEnv({
        AMC_API_KEY: 'amc',
        TMDB_API_KEY: 'tmdb',
        LETTERBOXD_USERNAME: 'thethomp',
        LETTERBOXD_CSV_DIR: '/tmp/export',
      }),
    ).toEqual({
      amcApiKey: 'amc',
      tmdbApiKey: 'tmdb',
      letterboxdUsername: 'thethomp',
      letterboxdCsvDir: '/tmp/export',
    })
  })

  it('leaves an absent variable out entirely, so it is reported as unconfigured', () => {
    // A key present-but-undefined would read as configured to every `?:`
    // check downstream, which is how a missing integration goes quiet.
    const config = pipelineConfigFromEnv({})
    expect(config).toEqual({})
    expect(unconfiguredIntegrations(config)).toEqual([
      { source: 'amc', variable: 'AMC_API_KEY' },
      { source: 'letterboxd', variable: 'LETTERBOXD_USERNAME' },
      { source: 'resolve', variable: 'TMDB_API_KEY' },
    ])
  })

  it('omits the CSV directory when unset, leaving the pass to default it', () => {
    // `data/letterboxd` lives in one place -- DEFAULT_LETTERBOXD_CSV_DIR --
    // so the CLI and the scheduler cannot read different exports.
    expect(pipelineConfigFromEnv({ LETTERBOXD_USERNAME: 'thethomp' })).toEqual({
      letterboxdUsername: 'thethomp',
    })
  })
})
