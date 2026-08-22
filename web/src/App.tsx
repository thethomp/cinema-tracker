import { useCallback, useMemo } from 'react'
import { fetchHealth, fetchHighlights, fetchVenues } from './api'
import { HighlightFeed } from './components/HighlightFeed'
import { SpecialPresentations } from './components/SpecialPresentations'
import { Masthead } from './components/Masthead'
import { localDateIn } from './format'
import { useResource } from './useResource'

/** The window the feed covers. Matches the API's own default. */
const DAYS = 14
const HIGHLIGHT_LIMIT = 40
const DAY_MS = 24 * 60 * 60 * 1000

export default function App() {
  // Pinned once per mount. Deriving "today" inside a render would let a tab
  // left open overnight start labelling yesterday's screenings "Tonight".
  const mountedAt = useMemo(() => new Date(), [])
  const todayLocalDate = localDateIn(mountedAt)
  const windowEndLocalDate = localDateIn(new Date(mountedAt.getTime() + DAYS * DAY_MS))

  const highlights = useResource(
    useCallback(() => fetchHighlights({ days: DAYS, limit: HIGHLIGHT_LIMIT }), []),
    `highlights:${DAYS}:${HIGHLIGHT_LIMIT}`,
  )
  const health = useResource(useCallback(() => fetchHealth(), []), 'health')
  const venues = useResource(useCallback(() => fetchVenues(), []), 'venues')

  return (
    <>
      <div className="grain" aria-hidden="true" />
      <div className="sheet">
        <Masthead
          fromLocalDate={todayLocalDate}
          toLocalDate={windowEndLocalDate}
          lastSweepAt={health.status === 'ready' ? health.data.lastRunAt : null}
          venueCount={venues.status === 'ready' ? venues.data.length : null}
          highlightCount={highlights.status === 'ready' ? highlights.data.length : null}
        />

        {highlights.status === 'ready' ? (
          <SpecialPresentations entries={highlights.data} todayLocalDate={todayLocalDate} />
        ) : null}

        <HighlightFeed resource={highlights} todayLocalDate={todayLocalDate} days={DAYS} />
      </div>
    </>
  )
}
