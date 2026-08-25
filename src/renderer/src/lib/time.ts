// Relative "time ago" label for chat/project lists. Single source of truth for the
// format shared by MemoryChat and ProjectsScreen. Pure + UI-free so it's unit-testable.
//
// String inputs are DB timestamps stored as UTC WITHOUT a zone suffix, so a bare 'Z'
// is appended before parsing (matching the original per-component versions). But a
// string that ALREADY carries a zone (a trailing 'Z' or a +/-HH:MM offset, e.g. from
// toISOString()) must NOT get a second 'Z' - that yields an invalid date. Number
// (epoch ms) and Date inputs are used as-is.
const HAS_TZ = /[zZ]$|[+-]\d{2}:?\d{2}$/

/**
 * Parse a SQLite timestamp ('YYYY-MM-DD HH:MM:SS', stored in UTC with no zone)
 * into a Date: the space becomes an ISO 'T' and a 'Z' is appended so it parses as
 * UTC — unless the string already carries a zone (trailing Z or +/-HH:MM), then
 * it's used as-is. Single source for the parse that was inlined across ChatDetail
 * / ChatList (`dateStr.replace(' ', 'T') + 'Z'`).
 */
export function parseSqliteUtc(dateStr: string): Date {
  return new Date(HAS_TZ.test(dateStr) ? dateStr : `${dateStr.replace(' ', 'T')}Z`)
}

/** System-local midnight for the calendar day containing `date`. */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** Move by local calendar days. This remains correct across DST transitions. */
export function shiftLocalDay(date: Date, days: number): Date {
  const shifted = startOfLocalDay(date)
  shifted.setDate(shifted.getDate() + days)
  return shifted
}

/** Inclusive start and exclusive end of a local calendar day, in epoch milliseconds. */
export function localDayRangeMs(date: Date): [number, number] {
  return [startOfLocalDay(date).getTime(), shiftLocalDay(date, 1).getTime()]
}

function toDate(input: string | number | Date): Date {
  if (typeof input === 'string') return parseSqliteUtc(input)
  return new Date(input)
}

/** Relative label: "just now", "5m ago", "3h ago", "2d ago", else an absolute
 *  "Mon D" date once it's a week or more in the past. */
export function timeAgo(input: string | number | Date): string {
  const date = toDate(input)
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
