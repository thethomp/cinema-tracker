import { Masthead } from './components/Masthead'
import type { FilmEntry } from './api'
import { splitTags, summarizeShowtimes, venueSummary } from './entry'
import { formatRuntime, formatTime, relativeDayLabel, formatLongDate } from './format'

/**
 * Static sample, shaped exactly like the read model, so the programme
 * aesthetic can be judged before any data is wired in.
 *
 * The three chosen are the hierarchy problem in miniature: a 151-showtime
 * 70mm release, a 99-showtime wide release, and a single 35mm print.
 */
const SAMPLE: FilmEntry[] = [
  {
    filmId: 1,
    title: 'The Odyssey',
    rawTitle: 'The Odyssey (70mm)',
    year: 2026,
    director: 'Christopher Nolan',
    runtimeMinutes: 185,
    score: 95,
    reasons: [
      { label: '70MM', weight: 50 },
      { label: 'Christopher Nolan', weight: 30 },
      { label: 'ARTHOUSE', weight: 15 },
    ],
    tags: ['70MM', 'ARTHOUSE'],
    venues: [
      { id: 'siff-uptown', name: 'SIFF Cinema Uptown', chain: 'SIFF' },
      { id: 'amc-pacific-place', name: 'AMC Pacific Place 11', chain: 'AMC' },
      { id: 'cinemark-lincoln-square', name: 'Cinemark Lincoln Square', chain: 'Cinemark' },
    ],
    showtimes: [
      st(1, '2026-08-22', '2026-08-23T01:30:00.000Z'),
      st(2, '2026-08-22', '2026-08-23T02:45:00.000Z'),
      st(3, '2026-08-22', '2026-08-23T04:00:00.000Z'),
      st(4, '2026-08-23', '2026-08-23T20:00:00.000Z'),
      st(5, '2026-08-23', '2026-08-24T01:15:00.000Z'),
    ],
    firstSeenAt: '2026-08-14T09:00:00.000Z',
    isNew: false,
  },
  {
    filmId: 2,
    title: 'The End of Oak Street',
    rawTitle: 'The End of Oak Street',
    year: 2026,
    director: 'Amara Lindqvist',
    runtimeMinutes: 118,
    score: 100,
    reasons: [{ label: 'On your watchlist', weight: 100 }],
    tags: ['DOLBY'],
    venues: [
      { id: 'amc-alderwood', name: 'AMC Alderwood Mall 16', chain: 'AMC' },
      { id: 'amc-pacific-place', name: 'AMC Pacific Place 11', chain: 'AMC' },
      { id: 'cinemark-totem-lake', name: 'Cinemark Totem Lake', chain: 'Cinemark' },
      { id: 'siff-downtown', name: 'SIFF Cinema Downtown', chain: 'SIFF' },
    ],
    showtimes: [
      st(10, '2026-08-22', '2026-08-22T20:10:00.000Z'),
      st(11, '2026-08-22', '2026-08-22T22:40:00.000Z'),
      st(12, '2026-08-22', '2026-08-23T01:05:00.000Z'),
      st(13, '2026-08-22', '2026-08-23T03:30:00.000Z'),
      st(14, '2026-08-23', '2026-08-23T19:30:00.000Z'),
      st(15, '2026-08-23', '2026-08-23T22:00:00.000Z'),
    ],
    firstSeenAt: '2026-08-21T09:00:00.000Z',
    isNew: true,
  },
  {
    filmId: 3,
    title: 'GoldenEye',
    rawTitle: 'GoldenEye (35mm)',
    year: 1995,
    director: 'Martin Campbell',
    runtimeMinutes: 130,
    score: 65,
    reasons: [
      { label: '35MM', weight: 50 },
      { label: 'SIFF', weight: 15 },
    ],
    tags: ['35MM'],
    venues: [{ id: 'siff-uptown', name: 'SIFF Cinema Uptown', chain: 'SIFF' }],
    showtimes: [st(20, '2026-08-29', '2026-08-30T02:30:00.000Z')],
    firstSeenAt: '2026-08-20T09:00:00.000Z',
    isNew: false,
  },
]

function st(id: number, localDate: string, startsAtUtc: string) {
  return {
    id,
    localDate: localDate.replace(/T$/, ''),
    startsAtUtc,
    ticketUrl: 'https://example.test/',
    venueId: 'siff-uptown',
  }
}

const TODAY = '2026-08-22'

export default function App() {
  return (
    <>
      <div className="grain" aria-hidden="true" />
      <div className="sheet">
        <Masthead
          fromLocalDate="2026-08-22"
          toLocalDate="2026-09-05"
          lastSweepAt="2026-08-22T16:10:00.000Z"
          venueCount={9}
          highlightCount={30}
        />

        <div className="section-head">
          <h2 className="section-head__title">Worth your attention</h2>
          <p className="section-head__note">Next 14 days, ranked</p>
        </div>

        <div className="feed">
          {SAMPLE.map((entry, index) => (
            <SampleEntry key={entry.filmId} entry={entry} rank={index + 1} />
          ))}
        </div>
      </div>
    </>
  )
}

function SampleEntry({ entry, rank }: { entry: FilmEntry; rank: number }) {
  const { stamps, chips } = splitTags(entry.tags)
  const summary = summarizeShowtimes(entry.showtimes, { maxDays: 2, maxPerDay: 6 })
  const venues = venueSummary(entry.venues, 2)
  const runtime = formatRuntime(entry.runtimeMinutes)
  const meta = [entry.director, entry.year ? String(entry.year) : null, runtime].filter(Boolean)

  return (
    <article
      className={`entry ink-in${stamps.length > 0 ? ' entry--special' : ''}`}
      style={{ animationDelay: `${rank * 40}ms` }}
    >
      <div className="entry__margin">
        <span className="entry__rank mono">{String(rank).padStart(2, '0')}</span>
        <span className="entry__score mono">{entry.score}</span>
      </div>

      <div className="entry__body">
        <div className="entry__headline">
          <h3 className="entry__title">{entry.title}</h3>
          {stamps.map((stamp) => (
            <span className="stamp" key={stamp}>
              {stamp}
            </span>
          ))}
          {entry.isNew ? <span className="entry__new">New</span> : null}
        </div>

        <p className="entry__meta">
          {meta.join(' · ')}
          {chips.length > 0 ? (
            <>
              <span className="entry__meta-sep" />
              <span className="label entry__tags">{chips.join(' · ')}</span>
            </>
          ) : null}
        </p>

        <dl className="entry__where">
          <dt className="label">Playing</dt>
          <dd className="entry__venues">
            {venues.named.join(' · ')}
            {venues.extra > 0 ? ` + ${venues.extra} more` : ''}
          </dd>

          <dt className="label">Times</dt>
          <dd>
            <div className="entry__days">
              {summary.days.map((day) => (
                <div className="entry__day" key={day.localDate}>
                  <span className="entry__day-label">{relativeDayLabel(day.localDate, TODAY)}</span>
                  {day.times.map((time) => (
                    <a className="showtime" key={time.id} href={time.ticketUrl}>
                      {formatTime(time.startsAtUtc)}
                    </a>
                  ))}
                </div>
              ))}
            </div>
            {summary.hiddenCount > 0 ? (
              <p className="entry__run">
                + {summary.hiddenCount} more showtimes, running through{' '}
                {formatLongDate(summary.lastLocalDate ?? '')}
              </p>
            ) : null}
            {summary.total === 1 ? (
              <p className="entry__run entry__run--rare">
                One screening only — {formatLongDate(summary.lastLocalDate ?? '')}
              </p>
            ) : null}
          </dd>
        </dl>

        <div className="entry__signals">
          <span className="label entry__signals-key">Why</span>
          {entry.reasons.map((reason) => (
            <span className="chip" key={reason.label}>
              {reason.label}
              <span className="chip__weight">+{reason.weight}</span>
            </span>
          ))}
        </div>
      </div>
    </article>
  )
}
