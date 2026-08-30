import { formatAgo, formatDateRange } from '../format'

export interface MastheadProps {
  /** Venue-local dates bounding the programme. */
  fromLocalDate: string
  toLocalDate: string
  /**
   * Most recent sweep. Null while health is still in flight *or* when nothing
   * has ever run -- the masthead cannot tell those apart, so it prints an em
   * dash rather than asserting "never" at a database it has not read yet.
   */
  lastSweepAt: string | null
  venueCount: number | null
  highlightCount: number | null
}

/**
 * The head of the programme.
 *
 * Asymmetric: the title is a block of ink on the left, the practical facts are
 * set small and flush right, and one heavy rule with a hairline under it
 * closes the block. Centring this would turn it into a website header.
 */
export function Masthead({
  fromLocalDate,
  toLocalDate,
  lastSweepAt,
  venueCount,
  highlightCount,
}: MastheadProps) {
  return (
    <header>
      <div className="masthead">
        <div>
          <h1 className="masthead__title">
            <span>Cinema</span>
            <span>Tracker</span>
          </h1>
          <span className="masthead__range mono">
            Seattle · {formatDateRange(fromLocalDate, toLocalDate)}
          </span>
        </div>

        <dl className="masthead__meta">
          {/*
            Each pair is wrapped so that a narrow screen cannot wrap a value
            away from its own label -- "NOTED" on one line and "30" on the next
            is worse than no figure at all.
          */}
          <div>
            <dt className="label">Last swept</dt>
            <dd className="mono">{lastSweepAt == null ? '—' : formatAgo(lastSweepAt)}</dd>
          </div>
          <div>
            <dt className="label">Venues</dt>
            <dd className="mono">{venueCount ?? '—'}</dd>
          </div>
          <div>
            <dt className="label">Noted</dt>
            <dd className="mono">{highlightCount ?? '—'}</dd>
          </div>
        </dl>
      </div>
      <div className="masthead-underline" />
    </header>
  )
}
