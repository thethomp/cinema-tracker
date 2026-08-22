/**
 * String formatting for the programme.
 *
 * Everything here is pure and timezone-explicit. The read models hand the UI
 * two shapes of time: absolute instants (`startsAtUtc`) and venue-local
 * calendar dates ("YYYY-MM-DD"). They are formatted differently and must never
 * be run through each other's helpers -- parsing "2026-08-22" with the browser
 * clock gives midnight UTC, which is the 21st in Seattle, and the agenda then
 * prints every day one off.
 */

/** Every venue in this project is in Seattle. */
export const TZ = 'America/Los_Angeles'

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/**
 * A local calendar date read as a fixed point, not as an instant.
 *
 * Noon UTC, formatted in UTC: far enough from either midnight that no offset
 * on earth moves it to a neighbouring day.
 */
function asFixedDay(localDate: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return null
  const day = new Date(`${localDate}T12:00:00.000Z`)
  return Number.isNaN(day.getTime()) ? null : day
}

const weekdayShort = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' })
const weekdayLong = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' })
const monthLong = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' })

const seattleParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

const seattleDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The Seattle calendar date an instant falls on. */
export function localDateIn(instant: Date, timeZone: string = TZ): string {
  const formatter =
    timeZone === TZ
      ? seattleDate
      : new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        })
  return formatter.format(instant)
}

/**
 * A showtime in newspaper-listings style: `7:15p`.
 *
 * Compact on purpose. A wide release carries dozens of times per day and
 * "7:15 PM" wraps them onto three lines; `7:15p` keeps a day on one.
 */
export function formatTime(iso: string): string {
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return '--:--'
  let hour = ''
  let minute = ''
  let period = ''
  for (const part of seattleParts.formatToParts(instant)) {
    if (part.type === 'hour') hour = part.value
    else if (part.type === 'minute') minute = part.value
    else if (part.type === 'dayPeriod') period = part.value
  }
  return `${hour}:${minute}${period.toLowerCase().startsWith('p') ? 'p' : 'a'}`
}

/** `Tonight`, `Tomorrow`, or `Sat 29`. */
export function relativeDayLabel(localDate: string, todayLocalDate: string): string {
  if (localDate === todayLocalDate) return 'Tonight'
  const today = asFixedDay(todayLocalDate)
  const day = asFixedDay(localDate)
  if (today && day && day.getTime() - today.getTime() === 86_400_000) return 'Tomorrow'
  return `${formatWeekday(localDate)} ${formatDayNumeral(localDate)}`
}

export function formatWeekday(localDate: string): string {
  const day = asFixedDay(localDate)
  return day ? weekdayShort.format(day) : ''
}

export function formatDayNumeral(localDate: string): string {
  return localDate.slice(8, 10)
}

export function formatMonthLabel(localDate: string): string {
  const index = Number(localDate.slice(5, 7)) - 1
  return MONTHS[index] ?? ''
}

/** `Saturday 22 August`, for the agenda's day headers. */
export function formatLongDate(localDate: string): string {
  const day = asFixedDay(localDate)
  if (!day) return localDate
  return `${weekdayLong.format(day)} ${Number(formatDayNumeral(localDate))} ${monthLong.format(day)}`
}

/** `3h 05m`, or `42m` for a short. Null when the runtime is unknown. */
export function formatRuntime(minutes: number | undefined | null): string | null {
  if (minutes == null || minutes <= 0) return null
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest}m`
  return `${hours}h ${String(rest).padStart(2, '0')}m`
}

/** `22 AUG – 05 SEP 2026`, with the year stated once unless the range crosses it. */
export function formatDateRange(fromLocalDate: string, toLocalDate: string): string {
  const fromYear = fromLocalDate.slice(0, 4)
  const toYear = toLocalDate.slice(0, 4)
  const from = `${formatDayNumeral(fromLocalDate)} ${formatMonthLabel(fromLocalDate)}`
  const to = `${formatDayNumeral(toLocalDate)} ${formatMonthLabel(toLocalDate)}`
  if (fromYear === toYear) return `${from} – ${to} ${toYear}`
  return `${from} ${fromYear} – ${to} ${toYear}`
}

/**
 * Sweep freshness.
 *
 * `never` and `unknown` are distinct answers: a source that has never run and
 * a timestamp the server sent in a shape this page cannot read are different
 * problems, and collapsing them would hide the second.
 */
export function formatAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (iso == null || iso === '') return 'never'
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return 'unknown'

  const seconds = Math.round((now.getTime() - then.getTime()) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
