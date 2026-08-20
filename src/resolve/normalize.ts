export interface NormalizedTitle {
  /** Title with venue decoration removed. Never empty. */
  title: string
  /** The decoration that was removed, outermost last, in source order. */
  hints: string[]
  /**
   * True when the decoration marks a re-release or anniversary showing. The
   * caller must NOT use any year in that marker as a TMDB year hint — a 2026
   * re-release of Goblet of Fire is still the 2005 film.
   */
  isReissue: boolean
}

/**
 * Words that identify a trailing parenthetical as venue decoration rather than
 * part of the title. Without this check, "Cléo from 5 to 7 (Cléo de 5 à 7)"
 * would lose its original-language title.
 */
const DECORATION = /\b(?:\d{2,3}\s?mm|subtitle|subtitles|spoken|dubbed|dub|re-?release|reissue|anniversary|restored|restoration|remaster(?:ed)?|imax|3d|open caption|sing-?along)\b/i

const REISSUE = /\b(?:re-?release|reissue|anniversary|restored|restoration|remaster(?:ed)?)\b/i

/**
 * A trailing parenthetical that is nothing but a four-digit year, e.g. the live
 * corpus's "The Hunger Games: Mockingjay Part 1 (2026)". No decoration word
 * appears, so the word list alone leaves it stuck to the title.
 *
 * It is treated as a reissue marker even though it does not say so. A bare year
 * is ambiguous — it can mark a genuinely new film or, as here, a re-release of
 * an older one (these are the 2012-2023 films) — and there is no way to tell
 * which from the string. Feeding an ambiguous year to TMDB as a hint returns a
 * confidently wrong film; declining to use it merely costs a hint we did not
 * need. `isReissue` is the flag that suppresses the hint, so it is set.
 */
const BARE_YEAR = /^(?:19|20)\d{2}$/

/** e.g. "25th Anniversary", "50th Anniversary" appended without parentheses. */
const TRAILING_ANNIVERSARY = /\s+(\d{1,3}(?:st|nd|rd|th)\s+anniversary)\s*$/i

export function normalizeTitle(rawTitle: string): NormalizedTitle {
  let title = rawTitle.trim()
  const hints: string[] = []

  // Repeatedly peel trailing parentheticals that look like decoration.
  for (;;) {
    const match = /\s*\(([^()]*)\)\s*$/.exec(title)
    const inner = match?.[1]?.trim() ?? ''
    if (!match || !(DECORATION.test(inner) || BARE_YEAR.test(inner))) break
    const stripped = title.slice(0, match.index).trim()
    if (!stripped) break // Never reduce a title to nothing.
    hints.unshift(match[1]!.trim())
    title = stripped
  }

  const anniversary = TRAILING_ANNIVERSARY.exec(title)
  if (anniversary) {
    const stripped = title.slice(0, anniversary.index).trim()
    if (stripped) {
      hints.push(anniversary[1]!.trim())
      title = stripped
    }
  }

  return {
    title,
    hints,
    isReissue: hints.some((hint) => REISSUE.test(hint) || BARE_YEAR.test(hint)),
  }
}

const LEADING_ARTICLE = /^(?:the|a|an)\s+/i

/**
 * A comparison key for deciding whether two titles refer to the same film.
 * Lossy by design — only ever compare keys, never display them.
 */
export function matchKey(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(LEADING_ARTICLE, '')
    // Apostrophes are elided, not spaced: "Sorcerer's" must key the same as
    // "Sorcerers". Collapsing them to a space instead splits one token into two
    // and quietly lowers every downstream token-overlap score.
    .replace(/['\u2019\u02bc]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
