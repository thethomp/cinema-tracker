/**
 * "New since you last looked", and why it is computed twice.
 *
 * The read model already returns `isNew` per entry, measured against
 * `app_state.last_visit_at`. That value is correct for the render that fetched
 * it — and then `POST /api/visit` overwrites it. Anything refetched afterwards
 * in the same session would come back with every mark cleared.
 *
 * So the client pins the *previous* stamp the POST hands back and measures
 * against that for the rest of the visit. The server flag is the answer until
 * the stamp arrives; the pinned baseline is the answer after.
 */

export type VisitBaseline =
  /** The visit has not been stamped yet; the server's flag still stands. */
  | { known: false }
  /** Stamped. `previous` is the prior visit, or null if there was never one. */
  | { known: true; previous: string | null }

export interface NewnessInput {
  /** ISO instant the screening first appeared in a sweep. */
  firstSeenAt: string
  /** The read model's own verdict, measured server-side. */
  isNew: boolean
}

/** Whether to mark an entry NEW for this viewer, on this visit. */
export function isNewToViewer(entry: NewnessInput, baseline: VisitBaseline): boolean {
  if (!baseline.known) return entry.isNew
  // A first-ever visit marks nothing. Everything is technically newer than
  // "never", but a page of NEW marks says nothing at all -- and the read model
  // makes the same choice, so the two must not disagree.
  if (baseline.previous == null) return false
  return entry.firstSeenAt > baseline.previous
}
