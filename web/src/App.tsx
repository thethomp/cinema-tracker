import { useCallback, useMemo } from 'react'
import { fetchAgenda, fetchHealth, fetchHighlights, fetchVenues } from './api'
import { Agenda } from './components/Agenda'
import { Health, HealthNotice } from './components/Health'
import { HighlightFeed } from './components/HighlightFeed'
import { SpecialPresentations } from './components/SpecialPresentations'
import { Masthead } from './components/Masthead'
import { localDateIn } from './format'
import { useResource } from './useResource'
import { useVisit } from './useVisit'

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
  const agenda = useResource(
    useCallback(
      () => fetchAgenda({ from: todayLocalDate, to: windowEndLocalDate }),
      [todayLocalDate, windowEndLocalDate],
    ),
    `agenda:${todayLocalDate}:${windowEndLocalDate}`,
  )
  const health = useResource(useCallback(() => fetchHealth(), []), 'health')
  const venues = useResource(useCallback(() => fetchVenues(), []), 'venues')

  /*
   * The stamp waits for the feed.
   *
   * `POST /api/visit` overwrites the timestamp every NEW mark on this page was
   * measured against, and the old value is not recoverable. Gating on
   * `status === 'ready'` means the request cannot leave until the highlights
   * response is in hand and committed to the DOM -- and means a failed or
   * still-loading feed never stamps at all, because nothing was seen.
   */
  const visit = useVisit(highlights.status === 'ready')

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

        {/* First thing under the masthead rule, so a dead source cannot be
            scrolled past on the way to listings it has made wrong. */}
        <HealthNotice resource={health} />

        {highlights.status === 'ready' ? (
          <SpecialPresentations entries={highlights.data} todayLocalDate={todayLocalDate} />
        ) : null}

        <HighlightFeed
          resource={highlights}
          todayLocalDate={todayLocalDate}
          days={DAYS}
          visit={visit}
        />

        <Agenda resource={agenda} todayLocalDate={todayLocalDate} />

        <Health resource={health} />
      </div>
    </>
  )
}
