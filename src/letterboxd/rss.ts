/**
 * Pure parsing of a Letterboxd diary RSS feed
 * (`https://letterboxd.com/<user>/rss/`).
 *
 * The feed carries the 50 most recent diary entries and — crucially — a
 * `tmdb:movieId` on every one, so rated films need no title resolution.
 * Ratings pages are behind a Cloudflare challenge; RSS and the CSV export are
 * the only usable sources.
 *
 * Parsed with regexes over `<item>` blocks rather than an XML dependency: this
 * is one known feed with a flat, stable shape, and the dependency list here is
 * deliberately short.
 */
export interface LetterboxdDiaryEntry {
  filmSlug: string
  tmdbId?: number
  title: string
  year?: number
  memberRating?: number
  watchedDate?: string
  rewatch: boolean
  liked: boolean
}

const ITEM = /<item>([\s\S]*?)<\/item>/g

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/**
 * Letterboxd writes apostrophes as the numeric entity `&#039;`, so
 * "Harry Potter and the Philosopher&#039;s Stone" arrives instead of the
 * title. Left encoded it matches nothing downstream.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(parseInt(body.slice(2), 16))
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)))
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)
  if (!match) return undefined
  const value = match[1]!
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .trim()
  return value ? decodeEntities(value) : undefined
}

/**
 * The feed spells booleans "Yes"/"No", not "true"/"false". Comparing against
 * "true" makes every entry false and silently erases the like and rewatch
 * signals, so accept either spelling.
 */
function isAffirmative(value: string | undefined): boolean {
  const normalized = value?.toLowerCase()
  return normalized === 'yes' || normalized === 'true'
}

export function parseLetterboxdRss(xml: string): LetterboxdDiaryEntry[] {
  // A Cloudflare challenge page or an error body must throw rather than parse
  // to an empty list — "no entries" and "feed is broken" have to be tellable
  // apart by the caller.
  if (!/<rss[\s>]/.test(xml)) throw new Error('not a Letterboxd RSS feed')

  const entries: LetterboxdDiaryEntry[] = []
  for (const match of xml.matchAll(ITEM)) {
    const block = match[1]!
    const title = tag(block, 'letterboxd:filmTitle')
    const link = tag(block, 'link')
    if (!title || !link) continue

    // Entry links are /<user>/film/<slug>/, so the slug is the film, not the
    // diary entry id.
    const slug = /\/film\/([a-z0-9-]+)/.exec(link)?.[1]
    if (!slug) continue

    const rating = tag(block, 'letterboxd:memberRating')
    const year = tag(block, 'letterboxd:filmYear')
    const tmdbId = tag(block, 'tmdb:movieId')

    entries.push({
      filmSlug: slug,
      tmdbId: tmdbId ? Number(tmdbId) : undefined,
      title,
      year: year ? Number(year) : undefined,
      memberRating: rating ? Number(rating) : undefined,
      watchedDate: tag(block, 'letterboxd:watchedDate'),
      rewatch: isAffirmative(tag(block, 'letterboxd:rewatch')),
      liked: isAffirmative(tag(block, 'letterboxd:memberLike')),
    })
  }
  return entries
}
