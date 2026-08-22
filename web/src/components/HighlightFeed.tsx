import type { FilmEntry } from '../api'
import type { Resource } from '../useResource'
import { HighlightEntry } from './HighlightEntry'

/** Stepped load animation, per the design's one-gesture motion budget. */
const STAGGER_MS = 40
/** Past this the stagger becomes a wait rather than a flourish. */
const MAX_STAGGERED = 12

export interface HighlightFeedProps {
  resource: Resource<FilmEntry[]>
  todayLocalDate: string
  days: number
}

export function HighlightFeed({ resource, todayLocalDate, days }: HighlightFeedProps) {
  return (
    <section aria-labelledby="highlights-heading">
      <div className="section-head">
        <h2 className="section-head__title" id="highlights-heading">
          Worth your attention
        </h2>
        <p className="section-head__note">Next {days} days, ranked</p>
      </div>

      <div className="feed">
        <FeedBody resource={resource} todayLocalDate={todayLocalDate} days={days} />
      </div>
    </section>
  )
}

function FeedBody({ resource, todayLocalDate, days }: HighlightFeedProps) {
  if (resource.status === 'loading') {
    // Not a spinner. A line of type that says what is happening and vanishes
    // when the answer arrives.
    return (
      <p className="notice">
        <span className="label">Reading the listings…</span>
      </p>
    )
  }

  if (resource.status === 'error') {
    return (
      <div className="notice notice--error" role="alert">
        <p className="notice__lead">The listings did not load.</p>
        <p>
          <code>{resource.message}</code>
        </p>
      </div>
    )
  }

  if (resource.data.length === 0) {
    return (
      <div className="notice">
        <p className="notice__lead">Nothing noteworthy in this window.</p>
        <p>
          Every screening in the next {days} days scored below the threshold. The agenda below
          still lists the lot.
        </p>
      </div>
    )
  }

  return (
    <>
      {resource.data.map((entry, index) => (
        <HighlightEntry
          key={entry.filmId ?? `raw:${entry.rawTitle}`}
          entry={entry}
          rank={index + 1}
          todayLocalDate={todayLocalDate}
          delayMs={Math.min(index, MAX_STAGGERED) * STAGGER_MS}
        />
      ))}
    </>
  )
}
