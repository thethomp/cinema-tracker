import { useState } from 'react'
import type { FilmEntry } from '../api'
import { entryDomId, isStamped, splitTags, summarizeShowtimes, venueSummary } from '../entry'
import { formatLongDate, formatRuntime, formatTime, relativeDayLabel } from '../format'
import { isNewToViewer, type VisitBaseline } from '../visit'
import { FormatStamp } from './FormatStamp'

/**
 * How much of a run gets printed.
 *
 * Two days, six times a day. Past that the run is stated rather than listed.
 */
const MAX_DAYS = 2
const MAX_TIMES_PER_DAY = 6
const MAX_NAMED_VENUES = 2

/** Intrinsic size hint, in CSS pixels; the plate itself is sized in CSS. */
const POSTER_WIDTH = 92

export interface HighlightEntryProps {
  entry: FilmEntry
  /** 1-based position in the feed. */
  rank: number
  /** Seattle's calendar date, for "Tonight" / "Tomorrow". */
  todayLocalDate: string
  /** The previous visit, once stamped. See `visit.ts`. */
  visit: VisitBaseline
  /** Index-stepped load animation. */
  delayMs: number
}

export function HighlightEntry({
  entry,
  rank,
  todayLocalDate,
  visit,
  delayMs,
}: HighlightEntryProps) {
  const { chips } = splitTags(entry.tags)
  const summary = summarizeShowtimes(entry.showtimes, {
    maxDays: MAX_DAYS,
    maxPerDay: MAX_TIMES_PER_DAY,
  })
  const venues = venueSummary(entry.venues, MAX_NAMED_VENUES)
  const isSpecial = entry.tags.some(isStamped)

  /*
   * A TMDB poster path that 404s is a plate that never gets inked, not a
   * broken-image glyph. Falling back to `null` also drops the grid column, so
   * a rotted URL closes the row up exactly as a missing one does.
   *
   * Plateless is not the rare case it looks like from the film table. Only 3
   * of 252 *films* lack a poster, but an entry with no `film_id` -- an
   * unresolved raw title, which is what every Star Trek double bill and
   * early-access Q&A currently is -- has no film row to carry one. Eleven of
   * the twenty-three entries in the live feed print no plate.
   */
  const [posterBroken, setPosterBroken] = useState(false)
  const poster = !posterBroken && entry.posterUrl ? entry.posterUrl : null

  const meta = [
    entry.director,
    entry.year != null ? String(entry.year) : null,
    formatRuntime(entry.runtimeMinutes),
  ].filter((part): part is string => part != null && part !== '')

  return (
    <article
      id={entryDomId(entry)}
      className={`entry ink-in${isSpecial ? ' entry--special' : ''}${
        poster != null ? ' entry--plated' : ''
      }`}
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div className="entry__margin">
        <span className="entry__rank mono">{String(rank).padStart(2, '0')}</span>
        <span className="entry__score mono" title="Highlight score">
          {Math.round(entry.score)}
        </span>
      </div>

      {poster != null ? (
        <img
          className="entry__poster"
          src={poster}
          alt={`Poster for ${entry.title}`}
          width={POSTER_WIDTH}
          height={POSTER_WIDTH * 1.5}
          loading="lazy"
          decoding="async"
          onError={() => setPosterBroken(true)}
        />
      ) : null}

      <div className="entry__body">
        <div className="entry__headline">
          <h3 className="entry__title">{entry.title}</h3>
          {entry.tags.map((tag) => (
            <FormatStamp key={tag} tag={tag} />
          ))}
          {isNewToViewer(entry, visit) ? <span className="entry__new">New</span> : null}
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
