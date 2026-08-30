import type { AgendaDay } from '../api'
import { entryDomId, splitTags, venueSummary } from '../entry'
import { formatDayNumeral, formatMonthLabel, formatTime, formatWeekday } from '../format'
import { FormatStamp } from './FormatStamp'

export interface DayGroupProps {
  day: AgendaDay
  /** Marks the current day's column, which is the one the eye looks for. */
  isToday: boolean
}

/**
 * One day of the programme: the date set large in the left margin, the day's
 * films hanging to its right on alternating grounds.
 *
 * The date column is sticky. A busy Saturday runs to thirty entries, and a
 * date that scrolls away leaves a column of times attached to nothing.
 */
export function DayGroup({ day, isToday }: DayGroupProps) {
  return (
    <section className={`daygroup${isToday ? ' daygroup--today' : ''}`}>
      <div className="daygroup__date">
        <span className="daygroup__weekday label">{formatWeekday(day.date)}</span>
        <span className="daygroup__numeral mono">{formatDayNumeral(day.date)}</span>
        <span className="daygroup__month label">{formatMonthLabel(day.date)}</span>
        {isToday ? <span className="daygroup__today label">Today</span> : null}
      </div>

      <ol className="daygroup__films">
        {day.entries.map((entry) => {
          const { chips } = splitTags(entry.tags)
          const venues = venueSummary(entry.venues, 2)

          return (
            <li className="agenda-row" key={`${day.date}:${entryDomId(entry)}`}>
              <div className="agenda-row__what">
                <span className="agenda-row__title">{entry.title}</span>
                {entry.tags.map((tag) => (
                  <FormatStamp key={tag} tag={tag} />
                ))}
                <span className="agenda-row__venue">
                  {venues.named.join(' · ')}
                  {venues.extra > 0 ? ` +${venues.extra}` : ''}
                  {chips.length > 0 ? (
                    <span className="agenda-row__tags"> · {chips.join(' · ')}</span>
                  ) : null}
                </span>
              </div>

              <div className="agenda-row__times">
                {entry.showtimes.map((showtime) => (
                  <a
                    className="showtime"
                    key={showtime.id}
                    href={showtime.ticketUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {formatTime(showtime.startsAtUtc)}
                  </a>
                ))}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
