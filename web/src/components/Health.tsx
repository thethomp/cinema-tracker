import type { HealthReport } from '../api'
import type { Resource } from '../useResource'
import { formatAgo } from '../format'
import { sourceLabel, summarizeHealth } from '../health'

export interface HealthProps {
  resource: Resource<HealthReport>
}

/**
 * The errata slip at the head of the programme.
 *
 * This is the one place outside a format stamp where vermilion is spent, and
 * it is spent deliberately: a source that has stopped returning data means the
 * listings below are wrong, and wrong listings are the failure this whole
 * project is built to be loud about. It is also, in normal operation, absent —
 * so it dilutes nothing. If this rule is on the page every day, the answer is
 * to fix the source, not to tone down the notice.
 */
export function HealthNotice({ resource }: HealthProps) {
  // Nothing is claimed while the check is in flight. Asserting health at a
  // report that has not arrived is the same lie as a broken source reporting OK.
  if (resource.status === 'loading') return null

  if (resource.status === 'error') {
    return (
      <div className="alarm" role="alert">
        <p className="alarm__label">Sources unchecked</p>
        <p className="alarm__lead">The programme could not check where its listings came from.</p>
        <p className="alarm__foot mono">{resource.message}</p>
      </div>
    )
  }

  const summary = summarizeHealth(resource.data)
  if (summary.ok) return null

  return (
    <div className="alarm" role="alert">
      <p className="alarm__label">Source failure</p>
      <p className="alarm__lead">{summary.headline}</p>
      <ul className="alarm__list">
        {summary.failing.map((source) => (
          <li className="alarm__item" key={source.source}>
            <span className="alarm__source">{sourceLabel(source.source)}</span>
            <span className="alarm__reason mono">{source.reason}</span>
          </li>
        ))}
      </ul>
      <p className="alarm__foot">
        These listings are incomplete — assume anything from{' '}
        {summary.failing.length === 1 ? 'that venue' : 'those venues'} is missing.
      </p>
    </div>
  )
}

/**
 * The colophon: where the listings came from, set small at the foot.
 *
 * The detail lives here rather than in the notice above because it is
 * reference, not alarm. Every source is listed whether or not it is well, so
 * "SIFF last ran four days ago" is answerable without anything having failed.
 */
export function Health({ resource }: HealthProps) {
  return (
    <section className="colophon" aria-labelledby="sources-heading">
      <div className="section-head section-head--tight">
        <h2 className="section-head__title section-head__title--small" id="sources-heading">
          Sources
        </h2>
        <p className="section-head__note">Where these listings came from</p>
      </div>
      <ColophonBody resource={resource} />
    </section>
  )
}

function ColophonBody({ resource }: HealthProps) {
  if (resource.status === 'loading') {
    return (
      <p className="colophon__foot">
        <span className="label">Checking the sources…</span>
      </p>
    )
  }

  if (resource.status === 'error') {
    return <p className="colophon__foot">Could not read source health. {resource.message}</p>
  }

  const report = resource.data
  const unresolved =
    report.unresolvedTitles === 0
      ? 'Every title on sale is matched to a film.'
      : `${report.unresolvedTitles} ${report.unresolvedTitles === 1 ? 'title' : 'titles'} unmatched, ` +
        `across ${report.unresolvedScreenings} ${report.unresolvedScreenings === 1 ? 'screening' : 'screenings'}.`

  return (
    <>
      <ul className="colophon__list">
        {report.sources.map((source) => (
          <li
            className={`colophon__row${source.healthy ? '' : ' colophon__row--failed'}`}
            key={source.source}
          >
            <span className="colophon__mark" aria-hidden="true">
              {source.healthy ? '·' : '✕'}
            </span>
            <span className="colophon__name">{sourceLabel(source.source)}</span>
            <span className="colophon__state">
              {source.healthy ? 'Reporting' : (source.reason ?? 'not reporting')}
            </span>
            <span className="colophon__figures mono">
              {source.itemCount == null ? '—' : source.itemCount}
              <span className="colophon__ago">{formatAgo(source.lastRunAt)}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="colophon__foot">{unresolved}</p>
    </>
  )
}
