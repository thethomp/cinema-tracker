import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../../src/db/client.js'
import { letterboxdEntries, watchlist, sourceRuns } from '../../src/db/schema.js'
import { syncLetterboxd } from '../../src/letterboxd/sync.js'

const RSS = readFileSync('tests/fixtures/letterboxd-rss.xml', 'utf8')
const WATCHLIST_PAGE_1 = readFileSync('tests/fixtures/letterboxd-watchlist.html', 'utf8')

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

interface StubOptions {
  failOn?: RegExp
}

function stubFetcher(options: StubOptions = {}) {
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

const NOW = new Date('2026-08-22T12:00:00Z')

describe('syncLetterboxd', () => {
  it('stores RSS diary entries with kind "diary"', async () => {
    const { db } = createDatabase(':memory:')
    const fetcher = stubFetcher()

    const result = await syncLetterboxd(db, fetcher, { username: 'thethomp' }, NOW)

    expect(result.status).toBe('ok')
    expect(result.source).toBe('letterboxd')
    expect(result.diaryEntries).toBe(50)

    const diary = await db.select().from(letterboxdEntries)
    const newest = diary.find((row) => row.filmSlug === 'insidious-out-of-the-further')
    expect(newest).toMatchObject({
      kind: 'diary',
      tmdbId: 1291595,
      title: 'Insidious: Out of the Further',
      year: 2026,
      memberRating: 3,
      watchedDate: '2026-08-20',
      rewatch: false,
      liked: false,
    })
    // TMDB ids are the whole reason RSS beats the CSV export: no resolution.
    expect(diary.filter((r) => r.kind === 'diary' && r.tmdbId !== null)).toHaveLength(50)
  })

  it('follows watchlist pagination to the last page', async () => {
    const { db } = createDatabase(':memory:')
    const fetcher = stubFetcher()

    const result = await syncLetterboxd(db, fetcher, { username: 'thethomp' }, NOW)

    // Page 1 is the recorded fixture (28 entries, pagination advertising 9).
    // Stopping at page 1 would store 28 of ~240 films and look perfectly
    // healthy — the same class of bug as a default page size.
    expect(result.pagesFetched).toBe(9)
    expect(result.watchlistEntries).toBe(28 + 8 * 2)

    const pages = fetcher.requested.filter((url) => url.includes('/watchlist/'))
    expect(pages).toEqual([
      'https://letterboxd.com/thethomp/watchlist/page/1/',
      'https://letterboxd.com/thethomp/watchlist/page/2/',
      'https://letterboxd.com/thethomp/watchlist/page/3/',
      'https://letterboxd.com/thethomp/watchlist/page/4/',
      'https://letterboxd.com/thethomp/watchlist/page/5/',
      'https://letterboxd.com/thethomp/watchlist/page/6/',
      'https://letterboxd.com/thethomp/watchlist/page/7/',
      'https://letterboxd.com/thethomp/watchlist/page/8/',
      'https://letterboxd.com/thethomp/watchlist/page/9/',
    ])

    const rows = await db.select().from(letterboxdEntries)
    const stored = rows.filter((r) => r.kind === 'watchlist')
    expect(stored).toHaveLength(44)
    expect(stored.find((r) => r.filmSlug === 'streetwise')).toMatchObject({
      title: 'Streetwise',
      year: 1984,
      watchedDate: null,
      memberRating: null,
    })
    expect(stored.some((r) => r.filmSlug === 'film-p9-2')).toBe(true)
  })

  it('populates the watchlist table with source "letterboxd"', async () => {
    const { db } = createDatabase(':memory:')
    await syncLetterboxd(db, stubFetcher(), { username: 'thethomp' }, NOW)

    const rows = await db.select().from(watchlist)
    expect(rows).toHaveLength(44)
    expect(rows.every((r) => r.source === 'letterboxd')).toBe(true)
    expect(rows.find((r) => r.titlePattern === 'Streetwise')).toMatchObject({
      year: 1984,
      source: 'letterboxd',
    })
  })

  it('is idempotent across runs and refreshes changed ratings', async () => {
    const { db } = createDatabase(':memory:')
    await syncLetterboxd(db, stubFetcher(), { username: 'thethomp' }, NOW)

    // Pretend the stored rating is stale, then re-sync.
    const before = await db.select().from(letterboxdEntries)
    const beforeIds = before.map((r) => r.id).sort((a, b) => a - b)

    const csvDir = mkdtempSync(join(tmpdir(), 'lb-csv-'))
    writeFileSync(
      join(csvDir, 'ratings.csv'),
      `Date,Name,Year,Letterboxd URI,Rating\n` +
        `2026-08-20,Insidious: Out of the Further,2026,https://letterboxd.com/film/insidious-out-of-the-further/,1.5\n`,
    )
    // CSV runs first, RSS second: the feed is the fresher source and must win.
    await syncLetterboxd(db, stubFetcher(), { username: 'thethomp', csvDir }, NOW)

    const after = await db.select().from(letterboxdEntries)
    expect(after).toHaveLength(before.length)
    expect(after.map((r) => r.id).sort((a, b) => a - b)).toEqual(beforeIds)
    expect(after.find((r) => r.filmSlug === 'insidious-out-of-the-further')?.memberRating).toBe(3)
    expect(await db.select().from(watchlist)).toHaveLength(44)
  })

  it('backfills from a CSV export directory', async () => {
    const { db } = createDatabase(':memory:')
    const csvDir = mkdtempSync(join(tmpdir(), 'lb-csv-'))
    writeFileSync(
      join(csvDir, 'ratings.csv'),
      `Date,Name,Year,Letterboxd URI,Rating\n` +
        `2019-03-01,Stalker,1979,https://letterboxd.com/film/stalker/,5\n`,
    )
    writeFileSync(
      join(csvDir, 'watchlist.csv'),
      `Date,Name,Year,Letterboxd URI\n` +
        `2019-03-02,Sátántangó,1994,https://letterboxd.com/film/satantango/\n`,
    )

    const result = await syncLetterboxd(db, stubFetcher(), { username: 'thethomp', csvDir }, NOW)

    expect(result.status).toBe('ok')
    // 50 from RSS plus the one rated film the feed's window can't reach.
    expect(result.diaryEntries).toBe(51)
    const rows = await db.select().from(letterboxdEntries)
    expect(rows.find((r) => r.filmSlug === 'stalker')).toMatchObject({
      kind: 'diary',
      title: 'Stalker',
      year: 1979,
      memberRating: 5,
      watchedDate: '2019-03-01',
      tmdbId: null,
    })
    expect(rows.find((r) => r.filmSlug === 'satantango')?.kind).toBe('watchlist')
    expect((await db.select().from(watchlist)).some((r) => r.titlePattern === 'Sátántangó')).toBe(true)
  })

  it('treats a missing CSV directory as absent, not as an error', async () => {
    const { db } = createDatabase(':memory:')
    const result = await syncLetterboxd(
      db,
      stubFetcher(),
      { username: 'thethomp', csvDir: join(tmpdir(), 'definitely-not-here-2026') },
      NOW,
    )

    expect(result.status).toBe('ok')
    expect(result.diaryEntries).toBe(50)
    expect(result.watchlistEntries).toBe(44)
  })

  it('never overwrites or deletes a manual watchlist row', async () => {
    const { db } = createDatabase(':memory:')
    const addedAt = new Date('2026-01-01T00:00:00Z')
    await db.insert(watchlist).values([
      // Same film the Letterboxd crawl will report, entered by hand.
      { titlePattern: 'Streetwise', year: 1984, addedAt, notes: 'mine', source: 'manual' },
      // And one the crawl knows nothing about.
      { titlePattern: 'A Private Note', year: null, addedAt, notes: 'keep me', source: 'manual' },
    ])

    const first = await syncLetterboxd(db, stubFetcher(), { username: 'thethomp' }, NOW)
    const second = await syncLetterboxd(db, stubFetcher(), { username: 'thethomp' }, NOW)

    // Not merely "the row survived": the sync has to *recognize* the manual
    // row, not collide with it. Blindly inserting would trip the unique index
    // and fail the run, which would also leave the row intact.
    expect([first.status, second.status]).toEqual(['ok', 'ok'])

    const rows = await db.select().from(watchlist)
    // 44 crawled films, one of which the owner had already entered by hand.
    expect(rows).toHaveLength(45)
    expect(rows.filter((r) => r.source === 'letterboxd')).toHaveLength(43)
    const manual = rows.filter((r) => r.source === 'manual')
    expect(manual).toHaveLength(2)
    expect(manual.find((r) => r.titlePattern === 'Streetwise')).toMatchObject({
      source: 'manual',
      notes: 'mine',
      addedAt,
    })
    expect(manual.find((r) => r.titlePattern === 'A Private Note')?.notes).toBe('keep me')
    // The hand-entered Streetwise row is not duplicated by a Letterboxd copy.
    expect(rows.filter((r) => r.titlePattern === 'Streetwise')).toHaveLength(1)
  })

  it('records an ok source run so the health view can see it', async () => {
    const { db } = createDatabase(':memory:')
    await syncLetterboxd(db, stubFetcher(), { username: 'thethomp' }, NOW)

    const runs = await db.select().from(sourceRuns)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      source: 'letterboxd',
      status: 'ok',
      itemCount: 94,
      error: null,
    })
  })

  it('records a failed source run instead of throwing when a fetch fails', async () => {
    const { db } = createDatabase(':memory:')
    const result = await syncLetterboxd(
      db,
      stubFetcher({ failOn: /\/rss\// }),
      { username: 'thethomp' },
      NOW,
    )

    expect(result.status).toBe('failed')
    expect(result.error).toContain('403')

    const runs = await db.select().from(sourceRuns)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toContain('403')
  })

  it('fails loudly when a page before the last one comes back empty', async () => {
    // A Cloudflare challenge mid-crawl returns HTTP 200 with no entries.
    // Silently keeping the pages we got would look like a shrinking watchlist.
    const { db } = createDatabase(':memory:')
    const fetcher = {
      async text(url: string): Promise<string> {
        if (url.endsWith('/rss/')) return RSS
        const page = /\/watchlist\/page\/(\d+)\//.exec(url)?.[1] ?? '1'
        if (page === '1') return WATCHLIST_PAGE_1
        if (page === '4') return '<html><body>Just a moment...</body></html>'
        return watchlistPage(Number(page))
      },
    }

    const result = await syncLetterboxd(db, fetcher, { username: 'thethomp' }, NOW)
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/page 4/)
    expect((await db.select().from(sourceRuns))[0]!.status).toBe('failed')
  })
})
