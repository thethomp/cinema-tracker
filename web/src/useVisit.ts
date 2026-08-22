import { useEffect, useRef, useState } from 'react'
import { recordVisit } from './api'
import type { VisitBaseline } from './visit'

/**
 * Stamp this visit, once, and hand back what the previous one was.
 *
 * Two properties matter and both are easy to lose:
 *
 * 1. **It must fire after the highlights have rendered.** `POST /api/visit`
 *    destroys the timestamp `isNew` is measured against. Stamping on mount
 *    would mark the whole programme as seen before the reader had seen any of
 *    it, and there is no way to recover the old value afterwards. The caller
 *    gates this with `ready`, which is only true once the feed is on screen.
 *
 * 2. **It must fire exactly once.** A second POST returns the *first* POST's
 *    timestamp as `previous`, which is a baseline of "a moment ago" -- the
 *    same destruction, one round trip later. StrictMode double-invokes effects
 *    in development, so the request is memoised in a ref and both invocations
 *    await the same promise rather than each sending one.
 */
export function useVisit(ready: boolean): VisitBaseline {
  const [baseline, setBaseline] = useState<VisitBaseline>({ known: false })
  const request = useRef<Promise<{ previous: string | null }> | null>(null)

  useEffect(() => {
    if (!ready) return

    // Deliberately not cancelled on cleanup. StrictMode's cleanup runs between
    // the two effect invocations, and a `live` flag set there would discard
    // the one response this hook is ever going to get.
    request.current ??= recordVisit()
    request.current
      .then(({ previous }) => setBaseline({ known: true, previous }))
      .catch(() => {
        // The stamp failed. Leaving the baseline unknown keeps the server's
        // own isNew flags in play, which is the right fallback: worse than a
        // pinned baseline, far better than clearing every mark on the page.
      })
  }, [ready])

  return baseline
}
