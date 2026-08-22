/**
 * Pure parsing of a Letterboxd data export (`ratings.csv`, `watchlist.csv`,
 * `diary.csv`).
 *
 * The export is the only way past the RSS feed's 50-entry window, but it is
 * optional: the owner may never have downloaded one. Everything here is
 * therefore forgiving — headers match case-insensitively, optional columns may
 * be absent, and a row without a `Name` is skipped rather than fatal.
 *
 * No CSV dependency: this is a known-shape file, and the export's only real
 * complications are quoted fields with embedded commas and doubled quotes.
 *
 * The export carries **no TMDB ids** (unlike the diary RSS feed) and no like
 * signal, so entries from here need title resolution and `liked` is always
 * false.
 */
export interface LetterboxdCsvEntry {
  filmSlug: string
  title: string
  year?: number
  memberRating?: number
  watchedDate?: string
  rewatch: boolean
  liked: boolean
}

/**
 * Splits CSV text into rows of fields, honoring quoted fields, doubled quotes
 * (`""` → `"`), embedded commas and newlines, and CRLF endings.
 */
export function parseCsvRows(text: string): string[][] {
  // A UTF-8 BOM would attach itself to the first header ("﻿Date"), which
  // silently breaks header matching on the first column.
  const input = text.replace(/^﻿/, '')

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let sawField = false

  const endField = (): void => {
    row.push(field)
    field = ''
    sawField = false
  }
  const endRow = (): void => {
    endField()
    // A trailing newline yields a final empty row; drop rows that are entirely
    // empty rather than emitting a phantom record.
    if (row.some((value) => value.trim() !== '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"' && !sawField) {
      quoted = true
      sawField = true
    } else if (char === ',') {
      endField()
    } else if (char === '\r') {
      // Swallow CR; the following LF ends the row.
      if (input[i + 1] !== '\n') endRow()
    } else if (char === '\n') {
      endRow()
    } else {
      field += char
      sawField = true
    }
  }
  if (field !== '' || row.length > 0) endRow()

  return rows
}

/**
 * Letterboxd's own slugs drop apostrophes rather than replacing them
 * ("harry-potter-and-the-philosophers-stone") and hyphenate everything else.
 *
 * This is a fallback only. Letterboxd year-disambiguates slugs when titles
 * collide ("companion-2025"), and nothing in the title says whether it did, so
 * a slug derived here can point at a different film. Prefer the `Letterboxd
 * URI` column whenever it names one.
 */
function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function slugFromUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined
  // diary.csv links the *entry* via a boxd.it short link, not the film, so
  // there is often no slug to take.
  return /\/film\/([a-z0-9-]+)/.exec(uri)?.[1]
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isAffirmative(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'yes' || normalized === 'true'
}

export function parseLetterboxdCsv(
  text: string,
  kind: 'diary' | 'watchlist',
): LetterboxdCsvEntry[] {
  const rows = parseCsvRows(text)
  const header = rows[0]
  if (!header) return []

  const columns = new Map<string, number>()
  header.forEach((name, index) => {
    const key = name.trim().toLowerCase()
    if (key && !columns.has(key)) columns.set(key, index)
  })

  const entries: LetterboxdCsvEntry[] = []
  for (const row of rows.slice(1)) {
    const cell = (name: string): string | undefined => {
      const index = columns.get(name)
      if (index === undefined) return undefined
      const value = row[index]
      return value === undefined || value.trim() === '' ? undefined : value.trim()
    }

    const title = cell('name')
    if (!title) continue // A row without a title is unusable, not fatal.

    entries.push({
      filmSlug: slugFromUri(cell('letterboxd uri')) ?? slugify(title),
      title,
      year: toNumber(cell('year')),
      memberRating: toNumber(cell('rating')),
      // On a watchlist export `Date` is when the film was *added*; recording
      // it as a watched date would be plausible and wrong. diary.csv has a
      // real `Watched Date`; ratings.csv has only the rating date, which is
      // the closest thing it knows.
      watchedDate: kind === 'watchlist' ? undefined : (cell('watched date') ?? cell('date')),
      rewatch: isAffirmative(cell('rewatch')),
      liked: false,
    })
  }

  return entries
}
