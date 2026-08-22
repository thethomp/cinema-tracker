export const TAGS = [
  '70MM',
  '35MM',
  'IMAX',
  'DOLBY',
  'LIVE_SCORE',
  'Q_AND_A',
  'ANNIVERSARY',
  'RE_RELEASE',
  'FESTIVAL',
  'SING_ALONG',
  'MEMBER_ONLY',
  'ARTHOUSE',
  'EVENT',
] as const

export type Tag = (typeof TAGS)[number]

/**
 * The tags that make a screening worth surfacing on its own, and that waive
 * already-watched suppression: a 70mm print of something already seen is
 * exactly the rewatch worth surfacing.
 */
export const SPECIAL_EVENT_TAGS: ReadonlySet<Tag> = new Set<Tag>([
  '70MM',
  '35MM',
  'LIVE_SCORE',
  'Q_AND_A',
  'ANNIVERSARY',
])

export interface TagInput {
  rawTitle: string
  description?: string | undefined
  formatHints: string[]
}

/**
 * Async from the start so an LLM implementation is a drop-in swap, per the
 * spec. The rule implementation below is v1 and doubles as the test corpus the
 * LLM version will be measured against.
 */
export interface TagExtractor {
  extract(input: TagInput): Promise<Tag[]>
}

/** Which fields a rule is allowed to look at. */
type Field = 'title' | 'description' | 'hints'

interface Rule {
  tag: Tag
  fields: Field[]
  patterns: RegExp[]
}

/**
 * Rules are narrow on purpose.
 *
 * The corpus is full of near-misses that a loose rule would swallow whole:
 * "(Hindi with English Subtitles)" appears on hundreds of rows and would read
 * as live accompaniment under a generic "... with ..." rule, and Cinemark's
 * `data-print-type-name` glues seating and language onto the format string, so
 * anything matched loosely against a hint picks up "STANDARD FORMAT LUXURY
 * LOUNGER". Every pattern here is anchored on a word boundary and names the
 * thing it is looking for.
 */
const RULES: Rule[] = [
  { tag: '70MM', fields: ['title', 'description', 'hints'], patterns: [/\b70\s?mm\b/i] },
  { tag: '35MM', fields: ['title', 'description', 'hints'], patterns: [/\b35\s?mm\b/i] },
  { tag: 'IMAX', fields: ['title', 'description', 'hints'], patterns: [/\bimax\b/i] },
  { tag: 'DOLBY', fields: ['description', 'hints'], patterns: [/\bdolby\b/i] },
  {
    tag: 'LIVE_SCORE',
    fields: ['title', 'description'],
    patterns: [
      /\blive\s+(?:musical\s+)?(?:score|accompaniment|orchestra|band|music)\b/i,
      /\bscore\s+performed\s+live\b/i,
      /\bperformed\s+live\s+by\b/i,
      /\blive\s+scored?\s+by\b/i,
      // SIFF's recurring silent-film ensembles. Named explicitly because the
      // listing says only "Faust with The Invincible Czars" -- there is no
      // generic phrase in the title to match, and a generic "with <name>" rule
      // would tag every subtitled screening in the database.
      /\bwith\s+the\s+invincible\s+czars\b/i,
      /\bwith\s+the\s+alloy\s+orchestra\b/i,
    ],
  },
  {
    tag: 'Q_AND_A',
    fields: ['title', 'description'],
    patterns: [/\bq\s*&\s*a\b/i, /\bq\s+and\s+a\b/i, /\bin\s+person\b/i, /\bin\s+conversation\b/i],
  },
  {
    tag: 'ANNIVERSARY',
    fields: ['title', 'description'],
    patterns: [/\banniversary\b/i],
  },
  {
    tag: 'RE_RELEASE',
    fields: ['title', 'description'],
    patterns: [
      /\bre-?\s?release\b/i,
      /\bre-?\s?issue\b/i,
      /\bremastered\b/i,
      /\brestor(?:ed|ation)\b/i,
      /\brevival\b/i,
      // AMC and Cinemark disambiguate a reissue by appending the reissue year:
      // "The Hunger Games (2026)" is the 2012 film. A film genuinely released
      // this year and listed the same way would be tagged wrongly; RE_RELEASE
      // carries no scoring weight, so the cost of that is a stray label.
      /\(\s*(?:19|20)\d{2}\s*\)\s*$/,
    ],
  },
  {
    tag: 'FESTIVAL',
    fields: ['title', 'description'],
    patterns: [/\bfestival\b/i, /\bfest\s+(?:19|20)\d{2}\b/i],
  },
  { tag: 'SING_ALONG', fields: ['title', 'description'], patterns: [/\bsing[\s-]?along\b/i] },
  {
    tag: 'MEMBER_ONLY',
    fields: ['title', 'description'],
    patterns: [/\bmembers?[\s-]only\b/i, /\bmembers?\s+(?:screening|preview|night)\b/i],
  },
  {
    tag: 'ARTHOUSE',
    fields: ['title', 'description'],
    // "AMC Artisan Films" is AMC's arthouse programming strand and arrives on
    // the description. It is null everywhere until the AMC adapter lands.
    patterns: [/\bartisan\s+films\b/i, /\bart\s?house\b/i],
  },
  {
    tag: 'EVENT',
    // Description only. "60th Anniversary Event" is a title suffix on a dozen
    // Star Trek rows that ANNIVERSARY already covers; letting EVENT fire on
    // titles would double-label them for nothing.
    fields: ['description'],
    patterns: [/(?:^|,)\s*event\s*(?:,|$)/i, /\bspecial\s+event\b/i],
  },
]

/**
 * ANNIVERSARY implies RE_RELEASE: a 25th-anniversary screening is a reissue of
 * an old film whether or not the listing says so.
 */
const IMPLIES: Partial<Record<Tag, Tag[]>> = {
  ANNIVERSARY: ['RE_RELEASE'],
}

export class RuleTagExtractor implements TagExtractor {
  async extract(input: TagInput): Promise<Tag[]> {
    const fields: Record<Field, string[]> = {
      title: [input.rawTitle],
      description: input.description ? [input.description] : [],
      hints: input.formatHints,
    }

    const found = new Set<Tag>()
    for (const rule of RULES) {
      const haystacks = rule.fields.flatMap((field) => fields[field])
      if (haystacks.some((text) => rule.patterns.some((pattern) => pattern.test(text)))) {
        found.add(rule.tag)
        for (const implied of IMPLIES[rule.tag] ?? []) found.add(implied)
      }
    }

    // Canonical order, so a stored tag list diffs cleanly between runs.
    return TAGS.filter((tag) => found.has(tag))
  }
}
