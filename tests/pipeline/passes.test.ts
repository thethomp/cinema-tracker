import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configuredSourceIds,
  syncPass,
  unconfiguredIntegrations,
} from '../../src/pipeline/passes.js'
import { createDatabase } from '../../src/db/client.js'
import { letterboxdEntries, sourceRuns } from '../../src/db/schema.js'

const RSS = readFileSync('tests/fixtures/letterboxd-rss.xml', 'utf8')
const WATCHLIST_PAGE_1 = readFileSync('tests/fixtures/letterboxd-watchlist.html', 'utf8')

/**
 * A directory that does not exist, passed wherever the export is beside the
 * point. The default is the owner's real `data/letterboxd`, which is
 * gitignored: a test that read it would pass here and fail on a fresh clone.
 */
const MISSING_DIR = join(tmpdir(), 'cinema-tracker-no-such-export')

describe('unconfiguredIntegrations', () => {
  it('names both missing keys when neither is set', () => {
    /*
     * The state `npm run serve` was actually in for a week. Neither key was in
     * the environment, so the AMC adapter was never built and the resolve pass
     * was skipped with a console.warn -- and neither fact reached the health
     * report, the API, or the UI. A pass that cannot run has to be visible as
     * a pass that is not running.
     */
    expect(unconfiguredIntegrations({})).toEqual([
      { source: 'amc', variable: 'AMC_API_KEY' },
      { source: 'letterboxd', variable: 'LETTERBOXD_USERNAME' },
      { source: 'resolve', variable: 'TMDB_API_KEY' },
    ])
  })

  it('names only the resolve pass when TMDB is the one missing', () => {
    expect(unconfiguredIntegrations({ amcApiKey: 'KEY', letterboxdUsername: 'thethomp' })).toEqual([
      { source: 'resolve', variable: 'TMDB_API_KEY' },
    ])
  })

  it('names only AMC when TMDB is configured', () => {
    expect(
      unconfiguredIntegrations({ tmdbApiKey: 'TOKEN', letterboxdUsername: 'thethomp' }),
    ).toEqual([{ source: 'amc', variable: 'AMC_API_KEY' }])
  })

  it('names Letterboxd when only its username is missing', () => {
    /*
     * The state this branch created. `runPipeline` now syncs Letterboxd on
     * the same six-hour schedule as the sweep, so a missing username stops a
     * pass that used to be nobody's business but the CLI's -- and a skipped
     * pass that says nothing is how the taste model went a week stale in the
     * first place.
     */
    expect(unconfiguredIntegrations({ amcApiKey: 'KEY', tmdbApiKey: 'TOKEN' })).toEqual([
      { source: 'letterboxd', variable: 'LETTERBOXD_USERNAME' },
    ])
  })

  it('reports nothing when everything is configured', () => {
    expect(
      unconfiguredIntegrations({
        amcApiKey: 'KEY',
        tmdbApiKey: 'TOKEN',
        letterboxdUsername: 'thethomp',
      }),
    ).toEqual([])
  })

  it('treats empty strings as unset', () => {
    expect(
      unconfiguredIntegrations({ amcApiKey: '', tmdbApiKey: '', letterboxdUsername: '' }),
    ).toEqual([
      { source: 'amc', variable: 'AMC_API_KEY' },
      { source: 'letterboxd', variable: 'LETTERBOXD_USERNAME' },
      { source: 'resolve', variable: 'TMDB_API_KEY' },
    ])
  })
})

describe('configuredSourceIds', () => {
  it('includes letterboxd once a username is configured', () => {
    /*
     * Letterboxd is swept by the scheduler like any venue, so the health
     * report has to know it is expected *before* its first successful run.
     * Deriving the list from `source_runs` alone would leave a Letterboxd
     * sync that has never succeeded looking like a source nobody asked for.
     */
    expect(configuredSourceIds({ letterboxdUsername: 'thethomp' })).toContain('letterboxd')
  })

  it('omits letterboxd when no username is configured', () => {
    // It is reported by `unconfiguredIntegrations` instead, which names the
    // variable; listing it here too would say "never run" over the top of it.
    expect(configuredSourceIds({})).not.toContain('letterboxd')
  })
})

/** A later watchlist page: two entries, and pagination that still says 9. */
function watchlistPage(page: number): string {
  const items = [1, 2]
    .map((n) => {
      const slug = `film-p${page}-${n}`
      return `<li class="griditem"><div class="react-component" data-item-name="Film P${page}N${n} (200${n})" data-item-slug="${slug}" data-item-link="/film/${slug}/"></div></li>`
    })
    .join('')
  return `<html><body><ul class="grid">${items}</ul>
    <div class="pagination"><div class="paginate-pages"><ul>
      <li class="paginate-page"><a href="/thethomp/watchlist/page/1/">1</a></li>
      <li class="paginate-page"><a href="/thethomp/watchlist/page/9/">9</a></li>
    </ul></div></div></body></html>`
}

function stubFetcher(options: { failOn?: RegExp } = {}) {
  const requested: string[] = []
  return {
    requested,
    async text(url: string): Promise<string> {
      requested.push(url)
      if (options.failOn?.test(url)) throw new Error(`GET ${url} failed: 403`)
      if (url.endsWith('/rss/')) return RSS
      const page = /\/watchlist\/page\/(\d+)\//.exec(url)?.[1]
      if (page === undefined || page === '1') return WATCHLIST_PAGE_1
      return watchlistPage(Number(page))
    },
  }
}

const SYNC_NOW = new Date('2026-08-22T12:00:00Z')

describe('syncPass', () => {
  it('syncs the diary and the watchlist for the configured user', async () => {
    /*
     * The gap this pass closes: `runPipeline` swept, resolved and scored, and
     * never synced. Letterboxd only moved when the owner ran `npm run sync` by
     * hand, so the taste model ran on whatever the last manual run stored --
     * and once staleness became a health check, the source alarmed forever.
     */
    const { db, close } = createDatabase(':memory:')
    try {
      const fetcher = stubFetcher()
      const result = await syncPass(db, {
        username: 'thethomp',
        csvDir: MISSING_DIR,
        fetcher,
        now: SYNC_NOW,
      })

      expect(result.status).toBe('ok')
      expect(result.diaryEntries).toBe(50)
      // 28 films on page 1, two on each of pages 2-9: the whole crawl, not
      // just the page that happens to answer first.
      expect(result.watchlistEntries).toBe(28 + 8 * 2)
      expect(result.pagesFetched).toBe(9)
      expect(fetcher.requested[0]).toBe('https://letterboxd.com/thethomp/rss/')

      const rows = await db.select().from(letterboxdEntries)
      expect(rows.filter((row) => row.kind === 'diary')).toHaveLength(50)
      expect(rows.filter((row) => row.kind === 'watchlist')).toHaveLength(44)
    } finally {
      close()
    }
  })

  it('records a source_runs row, so staleness can be judged', async () => {
    // Without this the pass would be invisible to `evaluateHealth` and the
    // 12-hour check would keep reporting a source that is in fact running.
    const { db, close } = createDatabase(':memory:')
    try {
      await syncPass(db, {
        username: 'thethomp',
        csvDir: MISSING_DIR,
        fetcher: stubFetcher(),
        now: SYNC_NOW,
      })

      const runs = await db.select().from(sourceRuns)
      expect(runs.map((run) => run.source)).toEqual(['letterboxd'])
      expect(runs[0]!.status).toBe('ok')
    } finally {
      close()
    }
  })

  it('returns a failed result rather than throwing when Letterboxd is down', async () => {
    /*
     * Failure isolation, and the reason this pass is not wrapped in a try in
     * `runPipeline`: a Letterboxd outage must cost the sync and nothing else.
     * If this threw, the scheduled resolve and score would never run.
     */
    const { db, close } = createDatabase(':memory:')
    try {
      const result = await syncPass(db, {
        username: 'thethomp',
        csvDir: MISSING_DIR,
        fetcher: stubFetcher({ failOn: /\/rss\// }),
        now: SYNC_NOW,
      })

      expect(result.status).toBe('failed')
      expect(result.error).toContain('403')

      const runs = await db.select().from(sourceRuns)
      expect(runs[0]!.status).toBe('failed')
    } finally {
      close()
    }
  })

  it('reads the CSV export from the directory it is given', async () => {
    // The scheduled pass has to see the same deep history the CLI does; a
    // csvDir that was accepted and dropped would silently halve the diary.
    const dir = mkdtempSync(join(tmpdir(), 'lbxd-pass-'))
    writeFileSync(
      join(dir, 'ratings.csv'),
      'Date,Name,Year,Letterboxd URI,Rating\n2019-04-02,Stalker,1979,https://boxd.it/29Nq,5\n',
    )

    const { db, close } = createDatabase(':memory:')
    try {
      await syncPass(db, {
        username: 'thethomp',
        csvDir: dir,
        fetcher: stubFetcher(),
        now: SYNC_NOW,
      })

      const rows = await db.select().from(letterboxdEntries)
      const stalker = rows.find((row) => row.title === 'Stalker')
      expect(stalker).toBeDefined()
      expect(stalker!.memberRating).toBe(5)
    } finally {
      close()
    }
  })
})
