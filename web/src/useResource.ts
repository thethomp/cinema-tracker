import { useEffect, useState } from 'react'
import { ApiError } from './api'

export type Resource<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string }

/**
 * Run a fetch once per key and expose exactly three states.
 *
 * There is no fourth "empty" state on purpose: an empty list is a `ready`
 * result and the view decides what to say about it. Conflating "nothing on"
 * with "nothing loaded" is how a UI ends up spinning at a working API.
 */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [state, setState] = useState<Resource<T>>({ status: 'loading' })

  useEffect(() => {
    let live = true
    setState({ status: 'loading' })

    load()
      .then((data) => {
        if (live) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!live) return
        const message =
          error instanceof ApiError || error instanceof Error
            ? error.message
            : 'Something failed, and it did not say what.'
        setState({ status: 'error', message })
      })

    // Guards against a slow first response overwriting a newer one, and
    // against StrictMode's double mount setting state on a dead component.
    return () => {
      live = false
    }
    // `key`, not `load`: the caller's closure is recreated on every render and
    // depending on it would refetch in a loop. The key is the request's
    // identity and is the only thing that should retrigger it.
  }, [key])

  return state
}
