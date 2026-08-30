export interface SchedulerOptions {
  /** How often the run should happen, in milliseconds. */
  intervalMs: number
  run: () => Promise<void>
  /**
   * Epoch milliseconds of the last run, or null if there has never been one.
   *
   * This is what makes a restart cheap. Without it every boot would start a
   * fresh interval and sweep immediately, and a process that restarts a few
   * times in a row would put several full sweeps minutes apart — Cinemark
   * rate-limits at roughly 88 requests inside four minutes.
   */
  lastRunAt?: number | null
  /** Injected so tests are not at the mercy of the wall clock. */
  now?: () => number
  /** A run that threw. The scheduler carries on either way. */
  onError?: (error: unknown) => void
}

export interface Scheduler {
  start(): void
  stop(): void
}

/**
 * A single-flight timer.
 *
 * Deliberately not `setInterval`. An interval fires on a fixed cadence whether
 * or not the previous callback has finished, so a sweep that overran its
 * window would find a second one already underway — two passes hitting every
 * venue at once, at double the request rate the fetcher was designed around.
 * Here there is one timer at a time and one `running` flag, and a tick that
 * arrives mid-run defers instead of starting anything.
 *
 * The next tick is scheduled from the *start* of a run rather than its end, so
 * the cadence stays "every six hours" instead of drifting by however long each
 * run happened to take.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { intervalMs, run, onError } = options
  const now = options.now ?? (() => Date.now())

  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let stopped = false
  let running = false

  function schedule(delayMs: number): void {
    if (stopped) return
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(() => void tick(), Math.max(0, delayMs))
  }

  async function tick(): Promise<void> {
    timer = null
    if (stopped) return

    if (running) {
      // Defer, do not stack. The run in flight is doing the work this tick
      // would have done; starting a second one gains nothing and costs a
      // doubled request rate at every venue.
      schedule(intervalMs)
      return
    }

    running = true
    schedule(intervalMs)
    try {
      await run()
    } catch (error) {
      // A source being down is normal operation, not a reason to stop
      // sweeping. The next tick is already on the clock.
      onError?.(error)
    } finally {
      running = false
    }
  }

  return {
    start(): void {
      if (started) return
      started = true
      stopped = false

      const lastRunAt = options.lastRunAt ?? null
      if (lastRunAt == null) {
        void tick()
        return
      }

      const elapsed = now() - lastRunAt
      if (elapsed >= intervalMs) {
        void tick()
        return
      }

      // Clamped to one interval. A stored time in the future — a clock that
      // went backwards, or a timestamp written by a machine ahead of this one
      // — would otherwise park the sweep for as long as the skew.
      schedule(Math.min(intervalMs, intervalMs - elapsed))
    },

    stop(): void {
      stopped = true
      started = false
      if (timer != null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
