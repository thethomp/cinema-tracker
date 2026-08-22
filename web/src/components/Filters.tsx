import type { Filters as FilterState } from '../filters'
import type { FilterOption } from '../filters'

export interface FiltersProps {
  value: FilterState
  onChange: (next: FilterState) => void
  venues: FilterOption[]
  tags: FilterOption[]
  /** Entries after filtering, and before, for the count line. */
  shown: number
  total: number
}

/**
 * Venue, tag and watchlist, as a ruled control strip.
 *
 * Native selects and a native checkbox, restyled: a bespoke dropdown would be
 * three hundred lines of focus management for something the platform already
 * does, and it would be the one part of the page that stopped looking printed
 * the moment it opened.
 */
export function Filters({ value, onChange, venues, tags, shown, total }: FiltersProps) {
  const filtered = shown !== total

  return (
    <div className="filters">
      <label className="filters__field">
        <span className="label">Venue</span>
        <select
          className="filters__select mono"
          value={value.venue}
          onChange={(event) => onChange({ ...value, venue: event.target.value })}
        >
          <option value="">All venues</option>
          {venues.map((venue) => (
            <option key={venue.value} value={venue.value}>
              {venue.label}
            </option>
          ))}
        </select>
      </label>

      <label className="filters__field">
        <span className="label">Tag</span>
        <select
          className="filters__select mono"
          value={value.tag}
          onChange={(event) => onChange({ ...value, tag: event.target.value })}
        >
          <option value="">Any</option>
          {tags.map((tag) => (
            <option key={tag.value} value={tag.value}>
              {tag.label.replaceAll('_', ' ')} ({tag.count})
            </option>
          ))}
        </select>
      </label>

      <label className="filters__check">
        <input
          type="checkbox"
          checked={value.watchlistOnly}
          onChange={(event) => onChange({ ...value, watchlistOnly: event.target.checked })}
        />
        <span className="label">Watchlist only</span>
      </label>

      <p className="filters__count mono">
        {filtered ? `${shown} / ${total}` : `${total}`}
        <span className="label filters__count-unit"> listings</span>
      </p>

      {filtered ? (
        <button className="filters__clear label" type="button" onClick={() => onChange({ venue: '', tag: '', watchlistOnly: false })}>
          Clear
        </button>
      ) : null}
    </div>
  )
}
