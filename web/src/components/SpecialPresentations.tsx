import type { FilmEntry } from '../api'
import { entryDomId, selectSpecialPresentations, venueSummary } from '../entry'
import { formatTime, formatWeekday, formatDayNumeral, relativeDayLabel } from '../format'
import { FormatStamp } from './FormatStamp'

/** Long enough to be a diary, short enough to stay a strip. */
const MAX_ROWS = 6

export interface SpecialPresentationsProps {
  entries: FilmEntry[]
  todayLocalDate: string
}

/**
 * The strip a repertory programme always has: the prints and one-offs, in
 * date order, above the ranked feed.
 *
 * It exists because the feed cannot solve this on its own. Ordered by score,
 * the only 35mm print in the city lands below four wide releases, and the one
 * thing worth rearranging an evening for is the one thing you have to scroll
 * to find. Nothing here is new information -- every row is also in the feed
 * below, and links to it.
 */
export function SpecialPresentations({ entries, todayLocalDate }: SpecialPresentationsProps) {
  const rows = selectSpecialPresentations(entries, MAX_ROWS)
  if (rows.length === 0) return null

  return (
    <section className="specials" aria-labelledby="specials-heading">
      <div className="section-head section-head--tight">
        <h2 className="section-head__title section-head__title--small" id="specials-heading">
          Prints &amp; one-offs
        </h2>
        <p className="section-head__note">Formats you cannot get another night</p>
      </div>

      <ul className="specials__list">
        {rows.map((entry) => {
          const next = [...entry.showtimes].sort((a, b) =>
            a.startsAtUtc.localeCompare(b.startsAtUtc),
          )[0]!
          const venues = venueSummary(entry.venues, 1)

          return (
            <li className="specials__row" key={entryDomId(entry)}>
              <span className="specials__stamp">
                {entry.tags.map((tag) => (
                  <FormatStamp key={tag} tag={tag} />
                ))}
              </span>
              <a className="specials__title" href={`#${entryDomId(entry)}`}>
                {entry.title}
              </a>
              <span className="specials__venue">
                {venues.named[0] ?? '—'}
                {venues.extra > 0 ? ` +${venues.extra}` : ''}
              </span>
              <span className="specials__when mono">
                {relativeDayLabel(next.localDate, todayLocalDate) === 'Tonight'
                  ? 'TONIGHT'
                  : `${formatWeekday(next.localDate).toUpperCase()} ${formatDayNumeral(next.localDate)}`}
                <span className="specials__time">{formatTime(next.startsAtUtc)}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
