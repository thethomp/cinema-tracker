import { describe, it, expect } from 'vitest'
import {
  RuleTagExtractor,
  SPECIAL_EVENT_TAGS,
  TAGS,
  tagLabel,
  type TagInput,
} from '../../src/tags/extract.js'

const extractor = new RuleTagExtractor()

function input(rawTitle: string, extra: Partial<TagInput> = {}): TagInput {
  return { rawTitle, formatHints: [], ...extra }
}

describe('RuleTagExtractor', () => {
  it('tags a 70mm print from the title and from a format hint alike', async () => {
    expect(await extractor.extract(input('The Odyssey (70mm)'))).toEqual(['70MM'])
    expect(await extractor.extract(input('The Odyssey', { formatHints: ['70MM'] }))).toEqual(['70MM'])
  })

  it('tags 35mm', async () => {
    expect(await extractor.extract(input('Teenage Sex and Death at Camp Miasma (35mm)'))).toEqual([
      '35MM',
    ])
    expect(await extractor.extract(input('American Astronaut', { formatHints: ['35MM'] }))).toEqual([
      '35MM',
    ])
  })

  it('does not repeat a tag the title and the format hint both carry', async () => {
    expect(
      await extractor.extract(input('The Odyssey (70mm)', { formatHints: ['70MM'] })),
    ).toEqual(['70MM'])
  })

  it('tags a live-accompaniment screening', async () => {
    expect(
      await extractor.extract(input('100 Years of the Uptown: Faust with The Invincible Czars')),
    ).toEqual(['LIVE_SCORE'])
    expect(await extractor.extract(input('Nosferatu with Live Score'))).toEqual(['LIVE_SCORE'])
  })

  it('tags an anniversary revival as both an anniversary and a re-release', async () => {
    expect(
      await extractor.extract(input("Harry Potter and the Sorcerer's Stone 25th Anniversary")),
    ).toEqual(['ANNIVERSARY', 'RE_RELEASE'])
  })

  it('tags an explicit re-release without calling it an anniversary', async () => {
    expect(
      await extractor.extract(input('Harry Potter and the Chamber of Secrets (2026 Re-Release)')),
    ).toEqual(['RE_RELEASE'])
  })

  it('reads a bare trailing year as the re-release marker chains use', async () => {
    expect(await extractor.extract(input('The Hunger Games (2026)'))).toEqual(['RE_RELEASE'])
  })

  it('reads AMC programming strands out of the description', async () => {
    expect(
      await extractor.extract(
        input('The Odyssey', { description: 'AMC Artisan Films, Reserved Seating, 70mm' }),
      ),
    ).toEqual(['70MM', 'ARTHOUSE'])
    expect(
      await extractor.extract(input('KATSEYE: WILD HEARTS', { description: 'Event, Closed Caption' })),
    ).toEqual(['EVENT'])
  })

  it('tags premium formats from hints', async () => {
    expect(await extractor.extract(input('Spider-Man: Brand New Day', { formatHints: ['IMAX'] }))).toEqual(
      ['IMAX'],
    )
    expect(await extractor.extract(input('The Odyssey', { formatHints: ['IMAX 2D'] }))).toEqual([
      'IMAX',
    ])
    expect(
      await extractor.extract(input('La La Land 10th Anniversary', { formatHints: ['DOLBY'] })),
    ).toEqual(['DOLBY', 'ANNIVERSARY', 'RE_RELEASE'])
  })

  it('tags festivals, sing-alongs, member screenings, and Q&As', async () => {
    expect(
      await extractor.extract(input('Castle in the Sky 40th Anniversary - Studio Ghibli Fest 2026')),
    ).toEqual(['ANNIVERSARY', 'RE_RELEASE', 'FESTIVAL', 'EVENT'])
    expect(await extractor.extract(input('Grease Sing-Along'))).toEqual(['SING_ALONG', 'EVENT'])
    expect(await extractor.extract(input('Members Only Preview: The Dog Stars'))).toEqual([
      'MEMBER_ONLY',
    ])
    expect(await extractor.extract(input('Blue Velvet + Q&A with Kyle MacLachlan'))).toEqual([
      'Q_AND_A',
    ])
  })

  it('infers EVENT from an event-shaped title, not only from a description', async () => {
    // The bug this pins: AMC's API returns an `Event` attribute in the
    // description and Cinemark's HTML returns no description at all, so the
    // same Star Trek 60th-anniversary double feature scored 80 at AMC and 50
    // at Cinemark. The programme is identical; only the chain's chattiness
    // differed.
    expect(
      await extractor.extract(
        input('Star Trek Double Feature - The Changeling & Star Trek: The Motion Picture'),
      ),
    ).toEqual(['EVENT'])
    expect(
      await extractor.extract(
        input('Star Trek Double Feature - Space Seed & Star Trek II: The Wrath of Khan'),
      ),
    ).toEqual(['EVENT'])
    expect(
      await extractor.extract(
        input('The Changeling + Star Trek: The Motion Picture 60th Anniversary Event'),
      ),
    ).toEqual(['ANNIVERSARY', 'RE_RELEASE', 'EVENT'])
    expect(
      await extractor.extract(
        input('The Uprising: Early Access Live Q&A with Paul Greengrass and Andrew Garfield'),
      ),
    ).toEqual(['Q_AND_A', 'EVENT'])
  })

  it('does not read a plain anniversary re-release as an event', async () => {
    // ANNIVERSARY already carries +50. Letting a bare "25th Anniversary" also
    // fire EVENT would pay twice for one fact and put half the repertory
    // calendar in the feed. Only "Anniversary Event" -- the phrase the chains
    // use for a ticketed one-off -- qualifies.
    expect(
      await extractor.extract(input("Harry Potter and the Sorcerer's Stone 25th Anniversary")),
    ).toEqual(['ANNIVERSARY', 'RE_RELEASE'])
    expect(await extractor.extract(input('Spider-Man: Brand New Day'))).toEqual([])
    expect(await extractor.extract(input('Agadha (Telugu with English Subtitles)'))).toEqual([])
  })

  it('reads a branded "Fest" strand as an event but a festival as neither', async () => {
    // "Fest" is a handful of nights -- Studio Ghibli Fest 2026 is six live
    // screenings. "Festival" is an institution: SIFF's runs to hundreds of
    // screenings, and +30 on every one of them would mean nothing is special.
    // The word boundary in /\bfest\b/ is what keeps them apart.
    expect(await extractor.extract(input('Fathom Big Screen Fest: Casablanca'))).toEqual(['EVENT'])
    expect(
      await extractor.extract(input('Seattle International Film Festival: Opening Night')),
    ).toEqual(['FESTIVAL'])
  })

  it('requires a marathon to be named as a programme, not as a film title', async () => {
    // "Marathon Man" and "Brittany Runs a Marathon" are films. A bare
    // /marathon/ would tag both, and over-tagging is the failure that costs
    // the feed its meaning.
    expect(await extractor.extract(input('Lord of the Rings Trilogy Marathon'))).toEqual(['EVENT'])
    expect(await extractor.extract(input('Marathon Man'))).toEqual([])
    expect(await extractor.extract(input('Brittany Runs a Marathon'))).toEqual([])
  })

  it('leaves an ordinary screening untagged', async () => {
    // The whole point. An extractor that tags everything is worse than none.
    expect(await extractor.extract(input('Spider-Man: Brand New Day'))).toEqual([])
    expect(await extractor.extract(input('Coyote vs. Acme'))).toEqual([])
    expect(await extractor.extract(input('Toy Story 5'))).toEqual([])
  })

  it("ignores Cinemark's concatenated seating and language hints", async () => {
    // data-print-type-name glues format, seating, and language together. None
    // of it is a premium format, and reading it as one was a live bug here.
    const noise = [
      'STANDARD FORMAT LUXURY LOUNGER',
      'TELUGU SPOKEN WITH ENGLISH SUBTITLES STANDARD FORMAT LUXURY LOUNGER',
      'OPEN CAPTION STANDARD FORMAT',
      'XD LUXURY LOUNGER REALD 3D D-BOX',
      'PARTY SPACE FOR UP TO 30 PEOPLE',
    ]
    for (const hint of noise) {
      expect(await extractor.extract(input('Some Film', { formatHints: [hint] }))).toEqual([])
    }
  })

  it('does not read a language subtitle note as a live score', async () => {
    // "with English Subtitles" is the commonest phrase in the corpus. A loose
    // "... with ..." live-score rule would tag a third of the database.
    expect(await extractor.extract(input('Toxic (Hindi with English Subtitles)'))).toEqual([])
    expect(
      await extractor.extract(input('Cocoon One Summer of Girlhood (Japanese with English Subtitles)')),
    ).toEqual([])
  })

  it('returns tags in a stable order regardless of where they were found', async () => {
    const tags = await extractor.extract(
      input('Point Break 35th Anniversary (35mm)', { formatHints: ['IMAX'] }),
    )
    expect(tags).toEqual(['35MM', 'IMAX', 'ANNIVERSARY', 'RE_RELEASE'])
  })

  it('exposes the special-event tags the scorer waives suppression for', () => {
    expect([...SPECIAL_EVENT_TAGS].sort()).toEqual([
      '35MM',
      '70MM',
      'ANNIVERSARY',
      'LIVE_SCORE',
      'Q_AND_A',
    ])
  })
})

describe('tagLabel', () => {
  it('spells a tag the way the page does, not the way the database does', async () => {
    // The reason chips under WHY were printing the raw identifier -- "Q_AND_A
    // +50" -- directly under a format stamp reading "Q & A". Same tag, two
    // spellings, one of them a database dump.
    expect(tagLabel('Q_AND_A')).toBe('Q & A')
    expect(tagLabel('LIVE_SCORE')).toBe('Live score')
    expect(tagLabel('RE_RELEASE')).toBe('Re-release')
    expect(tagLabel('70MM')).toBe('70mm')
    expect(tagLabel('35MM')).toBe('35mm')
    expect(tagLabel('IMAX')).toBe('IMAX')
    expect(tagLabel('DOLBY')).toBe('Dolby')
    expect(tagLabel('ANNIVERSARY')).toBe('Anniversary')
    expect(tagLabel('FESTIVAL')).toBe('Festival')
    expect(tagLabel('SING_ALONG')).toBe('Sing-along')
    expect(tagLabel('MEMBER_ONLY')).toBe('Members only')
    expect(tagLabel('ARTHOUSE')).toBe('Arthouse')
    expect(tagLabel('EVENT')).toBe('Event')
  })

  it('has a label for every tag, and returns anything else untouched', async () => {
    // A tag added without a label is a compile error, not a mangled chip. The
    // fallback exists for a stored tag from an older schema; it prints the
    // identifier as-is rather than guessing at English.
    for (const tag of TAGS) expect(tagLabel(tag)).not.toBe('')
    expect(tagLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW')
    expect(tagLabel('on the watchlist')).toBe('on the watchlist')
  })
})
