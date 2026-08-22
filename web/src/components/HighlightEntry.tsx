import type { FilmEntry } from '../api'
import { entryDomId, isStamped, splitTags, summarizeShowtimes, venueSummary } from '../entry'
import { formatLongDate, formatRuntime, formatTime, relativeDayLabel } from '../format'
import { FormatStamp } from './FormatStamp'

/**
 * How much of a run gets printed.
 *
 * Two days, six times a day. Past that the run is stated rather than listed.
 */
const MAX_DAYS = 2
const MAX_TIMES_PER_DAY = 6
const MAX_NAMED_VENUES = 2

export interface HighlightEntryProps {
  entry: FilmEntry
  /** 1-based position in the feed. */
  rank: number
  /** Seattle's calendar date, for "Tonight" / "Tomorrow". */
  todayLocalDate: string
  /** Index-stepped load animation. */
  delayMs: number
}

export function HighlightEntry({ entry, rank, todayLocalDate, delayMs }: HighlightEntryProps) {
  const { chips } = splitTags(entry.tags)
  const summary = summarizeShowtimes(entry.showtimes, {
    maxDays: MAX_DAYS,
    maxPerDay: MAX_TIMES_PER_DAY,
  })
  const venues = venueSummary(entry.venues, MAX_NAMED_VENUES)
  const isSpecial = entry.tags.some(isStamped)

  const meta = [
    entry.director,
    entry.year != null ? String(entry.year) : null,
    formatRuntime(entry.runtimeMinutes),
  ].filter((part): part is string => part != null && part !== '')

  return (
    <article
      id={entryDomId(entry)}
      className={`entry ink-in${isSpecial ? ' entry--special' : ''}`}
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div className="entry__margin">
        <span className="entry__rank mono">{String(rank).padStart(2, '0')}</span>
        <span className="entry__score mono" title="Highlight score">
          {Math.round(entry.score)}
        </span>
      </div>

      <div className="entry__body">
        <div className="entry__headline">
          <h3 className="entry__title">{entry.title}</h3>
          {entry.tags.map((tag) => (
            <FormatStamp key={tag} tag={tag} />
          ))}
          {entry.isNew ? <span className="entry__new">New</span> : null}
        </div>

        {(meta.length > 0 || chips.length > 0) && (
          <p className="entry__meta">
            {meta.join(' · ')}
            {meta.length > 0 && chips.length > 0 ? <span className="entry__meta-sep" /> : null}
            {chips.length > 0 ? (
              <span className="label entry__tags">{chips.join(' · ')}</span>
            ) : null}
          </p>
        )}

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
                  <span className="entry__day-label">
                    {relativeDayLabel(day.localDate, todayLocalDate)}
                  </span>
                  {day.times.map((time) => (
                    <a
                      className="showtime"
                      key={time.id}
                      href={time.ticketUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {formatTime(time.startsAtUtc)}
                    </a>
                  ))}
                </div>
              ))}
            </div>

            {/*
              A wide release states its run; a one-off states its scarcity. Both
              occupy one line, which is what stops 99 showtimes from outweighing
              a single 35mm print on the page.
            */}
            {summary.hiddenCount > 0 && summary.lastLocalDate != null ? (
              <p className="entry__run">
                + {summary.hiddenCount} more showtimes, running through{' '}
                {formatLongDate(summary.lastLocalDate)}
              </p>
            ) : null}
            {summary.total === 1 && summary.lastLocalDate != null ? (
              <p className="entry__run entry__run--rare">
                One screening only — {formatLongDate(summary.lastLocalDate)}
              </p>
            ) : null}
          </dd>
        </dl>

        {entry.reasons.length > 0 ? (
          <div className="entry__signals">
            <span className="label entry__signals-key">Why</span>
            {entry.reasons.map((reason) => (
              <span className="chip" key={`${reason.label}:${reason.weight}`}>
                {reason.label}
                <span className="chip__weight">
                  {reason.weight >= 0 ? '+' : '−'}
                  {Math.abs(Math.round(reason.weight))}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  )
}
