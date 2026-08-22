import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseWatchlistPage } from '../../src/letterboxd/watchlist.js'

const html = readFileSync('tests/fixtures/letterboxd-watchlist.html', 'utf8')

/** Minimal stand-in for the real markup, for cases the fixture doesn't contain. */
function gridPage(names: [name: string, slug: string][]): string {
  const items = names
    .map(
      ([name, slug]) =>
        `<li class="griditem"><div class="react-component" data-component-class="LazyPoster"` +
        ` data-item-name="${name}" data-item-slug="${slug}"` +
        ` data-item-link="/film/${slug}/"></div></li>`,
    )
    .join('\n')
  return `<html><body><ul class="grid">${items}</ul></body></html>`
}

describe('parseWatchlistPage', () => {
  const page = parseWatchlistPage(html)

  it('parses every entry on the page', () => {
    // Letterboxd serves exactly 28 per watchlist page. Fewer means the parser
    // dropped rows, not that the watchlist shrank.
    expect(page.entries).toHaveLength(28)
  })

  it('parses the first entry exactly', () => {
    expect(page.entries[0]).toEqual({
      filmSlug: 'streetwise',
      title: 'Streetwise',
      year: 1984,
    })
  })

  it('parses the last entry exactly', () => {
    expect(page.entries[27]).toEqual({
      filmSlug: 'in-the-line-of-fire',
      title: 'In the Line of Fire',
      year: 1993,
    })
  })

  it('splits the year out of every data-item-name on the fixture', () => {
    expect(page.entries.every((e) => e.year !== undefined)).toBe(true)
    expect(page.entries.every((e) => !/\(\d{4}\)$/.test(e.title))).toBe(true)
    expect(page.entries.slice(0, 4).map((e) => `${e.title}|${e.year}`)).toEqual([
      'Streetwise|1984',
      'Needful Things|1993',
      'The Orphanage|2007',
      'Picnic at Hanging Rock|1975',
    ])
  })

  it('takes the slug from the slug attribute, never from the title', () => {
    // Letterboxd year-disambiguates slugs ("companion-2025"), so a slug derived
    // from the title silently points at the wrong film.
    const parsed = parseWatchlistPage(gridPage([['Companion (2025)', 'companion-2025']]))
    expect(parsed.entries[0]).toEqual({
      filmSlug: 'companion-2025',
      title: 'Companion',
      year: 2025,
    })
  })

  it('leaves the year undefined when the name carries none', () => {
    const parsed = parseWatchlistPage(gridPage([['Untitled Kelly Reichardt Project', 'untitled-kr']]))
    expect(parsed.entries[0]).toEqual({
      filmSlug: 'untitled-kr',
      title: 'Untitled Kelly Reichardt Project',
      year: undefined,
    })
  })

  it('keeps parentheses that belong to the title', () => {
    // Only a *trailing* "(YYYY)" is a year. Greedy matching would maul this
    // title into "Céline and Julie Go Boating".
    const parsed = parseWatchlistPage(
      gridPage([
        ['Céline and Julie Go Boating (Phantom Ladies Over Paris) (1974)', 'celine-and-julie-go-boating'],
        ['Fantastic Planet (La planète sauvage)', 'fantastic-planet'],
        ['Blade Runner 2049', 'blade-runner-2049'],
      ]),
    )
    expect(parsed.entries).toEqual([
      {
        filmSlug: 'celine-and-julie-go-boating',
        title: 'Céline and Julie Go Boating (Phantom Ladies Over Paris)',
        year: 1974,
      },
      { filmSlug: 'fantastic-planet', title: 'Fantastic Planet (La planète sauvage)', year: undefined },
      // A trailing four-digit run that isn't parenthesized is part of the title.
      { filmSlug: 'blade-runner-2049', title: 'Blade Runner 2049', year: undefined },
    ])
  })

  it('reports the highest pagination number found', () => {
    // The watchlist is 9 pages. Crawling only page 1 yields 28 of ~240 films —
    // the same class of bug as a default page size.
    expect(page.maxPage).toBe(9)
  })

  it('counts the current page when it is the last one', () => {
    // On the final page the current number is a <span>, not a link, so link
    // hrefs alone under-report the page count.
    const lastPage = parseWatchlistPage(
      `<html><body>${gridPage([['X (2022)', 'x-2022']])}
       <div class="pagination"><div class="paginate-pages"><ul>
         <li class="paginate-page"><a href="/thethomp/watchlist/page/8/">8</a></li>
         <li class="paginate-page paginate-current"><span>9</span></li>
       </ul></div></div></body></html>`,
    )
    expect(lastPage.maxPage).toBe(9)
  })

  it('defaults maxPage to 1 when there is no pagination', () => {
    expect(parseWatchlistPage(gridPage([['Streetwise (1984)', 'streetwise']])).maxPage).toBe(1)
  })

  it('returns no entries for markup that contains none', () => {
    expect(parseWatchlistPage('<html><body><p>Nothing here</p></body></html>')).toEqual({
      entries: [],
      maxPage: 1,
    })
  })
})
