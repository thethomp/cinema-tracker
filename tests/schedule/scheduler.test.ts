import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScheduler } from '../../src/schedule/scheduler.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const INTERVAL = 6 * HOUR

const START = new Date('2026-08-22T00:00:00.000Z')

/** A run whose completion the test decides. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createScheduler', () => {
  it('runs immediately when nothing has ever run', async () => {
    const run = vi.fn(async () => {})
    const scheduler = createScheduler({ intervalMs: INTERVAL, run, lastRunAt: null })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(run).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('runs immediately when the last run is older than the interval', async () => {
    const run = vi.fn(async () => {})
    const scheduler = createScheduler({
      intervalMs: INTERVAL,
      run,
      lastRunAt: START.getTime() - INTERVAL - MINUTE,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(run).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('does not run immediately when the last run is recent', async () => {
    // The whole point. A restart loop that swept on every boot would put two
    // full sweeps minutes apart, and Cinemark rate-limits at roughly 88
    // requests inside four minutes.
    const run = vi.fn(async () => {})
    const scheduler = createScheduler({
      intervalMs: INTERVAL,
      run,
      lastRunAt: START.getTime() - HOUR,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).not.toHaveBeenCalled()

    // Due five hours in: six since the last run, one of which has passed.
    await vi.advanceTimersByTimeAsync(5 * HOUR - 1)
    expect(run).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('schedules the next run one interval after the last one started', async () => {
    const run = vi.fn(async () => {})
    const scheduler = createScheduler({ intervalMs: INTERVAL, run, lastRunAt: null })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(run).toHaveBeenCalledTimes(3)
    scheduler.stop()
  })

  it('defers rather than stacking when a run is still in flight', async () => {
    // Two concurrent sweeps would double the request rate at every venue at
    // once. A slow run must push the next one back, never run alongside it.
    const first = deferred()
    const run = vi.fn(() => first.promise)
    const scheduler = createScheduler({ intervalMs: INTERVAL, run, lastRunAt: null })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    // Two intervals pass with the first run still going.
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(run).toHaveBeenCalledTimes(1)

    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    // Only the next scheduled tick starts one, and it starts exactly one.
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(run).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it('survives a throwing run and still schedules the next one', async () => {
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('cinemark returned 403'))
      .mockResolvedValue(undefined)
    const onError = vi.fn()
    const scheduler = createScheduler({ intervalMs: INTERVAL, run, lastRunAt: null, onError })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]![0] as Error).message).toBe('cinemark returned 403')

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(run).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(run).toHaveBeenCalledTimes(3)
    scheduler.stop()
  })

  it('stops cleanly', async () => {
    const run = vi.fn(async () => {})
    const scheduler = createScheduler({ intervalMs: INTERVAL, run, lastRunAt: null })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    scheduler.stop()
    await vi.advanceTimersByTimeAsync(4 * INTERVAL)
    expect(run).toHaveBeenCalledTimes(1)
    // No timer may outlive stop(), or the process will not exit on SIGINT.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('schedules nothing more when stopped mid-run', async () => {
    const first = deferred()
    const run = vi.fn(() => first.promise)
    const scheduler = createScheduler({ intervalMs: INTERVAL, run, lastRunAt: null })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    scheduler.stop()

    first.resolve()
    await vi.advanceTimersByTimeAsync(4 * INTERVAL)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a second start rather than doubling the cadence', async () => {
    const run = vi.fn(async () => {})
    const scheduler = createScheduler({ intervalMs: INTERVAL, run, lastRunAt: null })

    scheduler.start()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(run).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it('waits at most one interval when the stored run time is in the future', async () => {
    // A clock that went backwards, or a timestamp written by a machine ahead
    // of this one. Sleeping for the difference could park the sweep for days.
    const run = vi.fn(async () => {})
    const scheduler = createScheduler({
      intervalMs: INTERVAL,
      run,
      lastRunAt: START.getTime() + 30 * 24 * HOUR,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('takes its clock from the caller', async () => {
    const now = vi.fn(() => START.getTime())
    const run = vi.fn(async () => {})
    const scheduler = createScheduler({
      intervalMs: INTERVAL,
      run,
      lastRunAt: START.getTime() - 2 * HOUR,
      now,
    })

    scheduler.start()
    expect(now).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })
})
