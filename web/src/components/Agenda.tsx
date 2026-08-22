import { useEffect, useMemo, useState } from 'react'
import type { AgendaDay } from '../api'
import {
  applyFilters,
  countEntries,
  emptyFilters,
  filterOptions,
  parseFilters,
  serializeFilters,
  type Filters as FilterState,
} from '../filters'
import type { Resource } from '../useResource'
import { DayGroup } from './DayGroup'
import { Filters } from './Filters'

export interface AgendaProps {
  resource: Resource<AgendaDay[]>
  todayLocalDate: string
}

/**
 * The day-by-day programme: everything on, not just what scored.
 */
export function Agenda({ resource, todayLocalDate }: AgendaProps) {
  const [filters, setFilters] = useState<FilterState>(() =>
    typeof window === 'undefined' ? emptyFilters() : parseFilters(window.location.search),
  )

  // The filter state lives in the URL so a filtered view is a link. replaceState
  // rather than pushState: ticking three boxes should not put three entries in
  // the back stack.
  useEffect(() => {
    const query = serializeFilters(filters)
    window.history.replaceState(null, '', `${window.location.pathname}${query}`)
  }, [filters])

  // Back and forward still have to work if something else pushes a state.
  useEffect(() => {
    const onPop = () => setFilters(parseFilters(window.location.search))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const days = resource.status === 'ready' ? resource.data : []
  const options = useMemo(() => filterOptions(days), [days])
  const visible = useMemo(() => applyFilters(days, filters), [days, filters])

  return (
    <section className="agenda" aria-labelledby="agenda-heading">
      <div className="section-head">
        <h2 className="section-head__title" id="agenda-heading">
          Day by day
        </h2>
        <p className="section-head__note">Everything on, not just what scored</p>
      </div>

      {resource.status === 'ready' ? (
        <Filters
          value={filters}
          onChange={setFilters}
          venues={options.venues}
          tags={options.tags}
          shown={countEntries(visible)}
          total={countEntries(days)}
        />
      ) : null}

      <div className="agenda__body">
        {resource.status === 'loading' ? (
          <p className="notice">
            <span className="label">Reading the listings…</span>
          </p>
        ) : null}

        {resource.status === 'error' ? (
          <div className="notice notice--error" role="alert">
            <p className="notice__lead">The agenda did not load.</p>
            <p>
              <code>{resource.message}</code>
            </p>
          </div>
        ) : null}

        {resource.status === 'ready' && visible.length === 0 ? (
          <div className="notice">
            <p className="notice__lead">
              {countEntries(days) === 0
                ? 'Nothing on in this window.'
                : 'Nothing matches those filters.'}
            </p>
            <p>
              {countEntries(days) === 0
                ? 'Either the sweep has not run or every venue is dark. Check the sweep time in the masthead.'
                : 'There are screenings in this window, but none at that venue with that tag.'}
            </p>
          </div>
        ) : null}

        {visible.map((day) => (
          <DayGroup key={day.date} day={day} isToday={day.date === todayLocalDate} />
        ))}
      </div>
    </section>
  )
}
