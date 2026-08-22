import { describe, it, expect } from 'vitest'
import { RuleTagExtractor, SPECIAL_EVENT_TAGS, type TagInput } from '../../src/tags/extract.js'

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
    ).toEqual(['ANNIVERSARY', 'RE_RELEASE', 'FESTIVAL'])
    expect(await extractor.extract(input('Grease Sing-Along'))).toEqual(['SING_ALONG'])
    expect(await extractor.extract(input('Members Only Preview: The Dog Stars'))).toEqual([
      'MEMBER_ONLY',
    ])
    expect(await extractor.extract(input('Blue Velvet + Q&A with Kyle MacLachlan'))).toEqual([
      'Q_AND_A',
    ])
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
