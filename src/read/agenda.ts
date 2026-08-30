import type { Db } from '../db/client.js'
import {
  getLastVisitAt,
  groupByFilm,
  loadScreeningRows,
  type FilmEntry,
  type ReadWindow,
  type ScreeningRow,
} from './query.js'

export interface AgendaDay {
  /** Local calendar date at the venue, "YYYY-MM-DD". */
  date: string
  entries: FilmEntry[]
}

export type AgendaEntry = FilmEntry

/**
 * The day-by-day listing: every live screening in the window, grouped by local
 * date and then by film.
 *
 * Unlike the highlight feed this applies no score floor — the agenda is the
 * full programme, including the things the owner will scroll past.
 *
 * A day with nothing on is absent from the result rather than present and
 * empty, so the UI never has to render a blank panel to say "nothing".
 */
export async function getAgenda(db: Db, window: ReadWindow): Promise<AgendaDay[]> {
  const rows = await loadScreeningRows(db, window)
  const lastVisitAt = await getLastVisitAt(db)

  const byDate = new Map<string, ScreeningRow[]>()
  for (const row of rows) {
    const bucket = byDate.get(row.localDate)
    if (bucket) bucket.push(row)
    else byDate.set(row.localDate, [row])
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayRows]) => ({
      date,
      // Grouped within the day, so a film with three showtimes on the 22nd is
      // one line carrying three times — and carries only that day's times.
      entries: groupByFilm(dayRows, lastVisitAt).sort(
        (a, b) =>
          a.showtimes[0]!.startsAtUtc.localeCompare(b.showtimes[0]!.startsAtUtc) ||
          b.score - a.score ||
          a.title.localeCompare(b.title),
      ),
    }))
}
