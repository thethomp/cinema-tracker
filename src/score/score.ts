import type { ScoreReason } from '../core/types.js'
import { decadeOf, type AffinityDimension } from '../taste/affinities.js'
import { SPECIAL_EVENT_TAGS } from '../tags/extract.js'

/** A row of `taste_rules`, as the scorer needs it. */
export interface ScoringRule {
  kind: string
  value: string
  weight: number
  enabled: boolean
}

/** A row of `taste_affinities`, as the scorer needs it. */
export interface ScoringAffinity {
  dimension: AffinityDimension
  value: string
  weight: number
}

export interface ScoringModel {
  rules: ScoringRule[]
  affinities: ScoringAffinity[]
}

export interface ScoreInput {
  tags: string[]
  genres: string[]
  originalLanguage?: string | null
  director?: string | null
  year?: number | null
  /** The venue's chain, which is what venue weight is keyed on. */
  venueChain: string
  onWatchlist: boolean
  alreadyWatched: boolean
}

export interface ScoreResult {
  score: number
  highlight: boolean
  reasons: ScoreReason[]
}

/** Score at or above this and the screening belongs in the highlight feed. */
export const HIGHLIGHT_THRESHOLD = 40

/** Sentinel rule values for the two signals that are not film properties. */
const WATCHLIST_RULE = 'match'
const WATCHED_RULE = 'seen'
/** Sentinel `language` rule value meaning "any original language but English". */
const NON_ENGLISH_RULE = 'non-english'

function ci(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Score a screening against the rule set.
 *
 * **Pure.** No database, no clock, no I/O. Everything it needs arrives in the
 * two arguments, and every weight comes from `model` — an empty rule table
 * produces a flat feed rather than silently reinstating defaults that nothing
 * in the database explains.
 */
export function score(input: ScoreInput, model: ScoringModel): ScoreResult {
  const enabled = model.rules.filter((rule) => rule.enabled)
  const byKind = new Map<string, ScoringRule[]>()
  for (const rule of enabled) {
    const list = byKind.get(rule.kind) ?? []
    list.push(rule)
    byKind.set(rule.kind, list)
  }
  const find = (kind: string, value: string): ScoringRule | undefined =>
    byKind.get(kind)?.find((rule) => ci(rule.value) === ci(value))

  const reasons: ScoreReason[] = []
  const add = (signal: string, detail: string, weight: number): void => {
    if (weight === 0) return
    reasons.push({ signal, detail, weight })
  }

  if (input.onWatchlist) {
    const rule = find('watchlist', WATCHLIST_RULE)
    if (rule) add('watchlist', 'on the watchlist', rule.weight)
  }

  const genres = input.genres.map(ci)
  for (const rule of byKind.get('declared') ?? []) {
    if (genres.includes(ci(rule.value))) add('declared', rule.value, rule.weight)
  }

  // The special-event bonus is paid once. A 35mm anniversary print is one
  // special event, not two, and stacking them would let a single screening
  // outrank a watchlist hit on formatting alone.
  const tags = input.tags
  const specialRules = (byKind.get('tag') ?? []).filter(
    (rule) => SPECIAL_EVENT_TAGS.has(rule.value as never) && tags.some((t) => ci(t) === ci(rule.value)),
  )
  const hasSpecialEvent = specialRules.length > 0
  if (hasSpecialEvent) {
    const best = specialRules.reduce((a, b) => (b.weight > a.weight ? b : a))
    add('special-event', specialRules.map((r) => r.value).join(', '), best.weight)
  }

  const affinityMatches = model.affinities.filter((affinity) => {
    switch (affinity.dimension) {
      case 'genre':
        return genres.includes(ci(affinity.value))
      case 'language':
        return input.originalLanguage != null && ci(input.originalLanguage) === ci(affinity.value)
      case 'director':
        return input.director != null && ci(input.director) === ci(affinity.value)
      case 'decade':
        return decadeOf(input.year) === affinity.value
      default:
        return false
    }
  })
  if (affinityMatches.length > 0) {
    // Once, not once per dimension — the spec is explicit, and a film matching
    // genre, director and decade is not three times the recommendation.
    const best = affinityMatches.reduce((a, b) => (b.weight > a.weight ? b : a))
    add('affinity', affinityMatches.map((a) => `${a.dimension} ${a.value}`).join(', '), best.weight)
  }

  const language = input.originalLanguage?.trim()
  if (language) {
    const exact = find('language', language)
    const nonEnglish = ci(language) === 'en' ? undefined : find('language', NON_ENGLISH_RULE)
    const rule = exact ?? nonEnglish
    if (rule) add('language', language, rule.weight)
  }

  for (const rule of byKind.get('genre') ?? []) {
    if (genres.includes(ci(rule.value))) add('genre', rule.value, rule.weight)
  }

  const venueRule = find('venue', input.venueChain)
  if (venueRule) add('venue', input.venueChain, venueRule.weight)

  for (const rule of byKind.get('tag') ?? []) {
    if (SPECIAL_EVENT_TAGS.has(rule.value as never)) continue
    if (tags.some((tag) => ci(tag) === ci(rule.value))) add('tag', rule.value, rule.weight)
  }

  // Suppression is waived for a special-event screening: a 70mm print of
  // something already seen is exactly the rewatch worth surfacing.
  if (input.alreadyWatched && !hasSpecialEvent) {
    const rule = find('watched', WATCHED_RULE)
    if (rule) add('watched', 'already logged on Letterboxd', rule.weight)
  }

  const total = reasons.reduce((sum, reason) => sum + reason.weight, 0)
  return { score: total, highlight: total >= HIGHLIGHT_THRESHOLD, reasons }
}
