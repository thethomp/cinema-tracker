import * as cheerio from 'cheerio'

/**
 * Pure parsing of a Letterboxd watchlist page
 * (`https://letterboxd.com/<user>/watchlist/page/<n>/`).
 *
 * The page is server-rendered HTML: 28 entries per page, each an
 * `li.griditem` wrapping a `div.react-component` that carries the film in data
 * attributes. There are **no TMDB ids here** — unlike the diary RSS feed —
 * so title and year are what feed resolution later.
 *
 * The ratings pages (`/films/ratings/`) sit behind a Cloudflare challenge and
 * must not be scraped; this page and the RSS feed are the only usable HTML.
 */
export interface LetterboxdWatchlistEntry {
  filmSlug: string
  title: string
  year?: number
}

export interface LetterboxdWatchlistPage {
  entries: LetterboxdWatchlistEntry[]
  /** Highest page number the pagination advertises; 1 when there is none. */
  maxPage: number
}

/**
 * `data-item-name` is "Streetwise (1984)" — the year is glued onto the title.
 * Only a *trailing* parenthesized year counts: titles legitimately contain
 * parentheses ("Céline and Julie Go Boating (Phantom Ladies Over Paris)"), and
 * a greedy match would amputate them.
 */
const TRAILING_YEAR = /^(.*?)\s+\((\d{4})\)$/

function splitName(name: string): { title: string; year?: number } {
  const match = TRAILING_YEAR.exec(name)
  if (!match) return { title: name }
  return { title: match[1]!, year: Number(match[2]) }
}

const PAGE_NUMBER = /\/page\/(\d+)\/?/

export function parseWatchlistPage(html: string): LetterboxdWatchlistPage {
  const $ = cheerio.load(html)
  const entries: LetterboxdWatchlistEntry[] = []

  $('div.react-component[data-item-slug]').each((_, element) => {
    const $element = $(element)
    // The slug is authoritative: Letterboxd year-disambiguates slugs
    // ("companion-2025"), so deriving one from the title points at the wrong
    // film without ever failing.
    const filmSlug = $element.attr('data-item-slug')
    const name = $element.attr('data-item-name')
    if (!filmSlug || !name) return

    const { title, year } = splitName(name.trim())
    if (!title) return
    entries.push({ filmSlug, title, year })
  })

  let maxPage = 1
  const $pagination = $('.pagination')
  $pagination.find('a[href], span').each((_, element) => {
    const $element = $(element)
    // On the final page the current number is a bare <span>, not a link, so
    // reading hrefs alone under-reports the page count by one.
    const source = $element.attr('href') ?? ''
    const fromHref = PAGE_NUMBER.exec(source)?.[1]
    const fromText = /^\d+$/.test($element.text().trim()) ? $element.text().trim() : undefined
    for (const value of [fromHref, fromText]) {
      if (value !== undefined) maxPage = Math.max(maxPage, Number(value))
    }
  })

  return { entries, maxPage }
}
