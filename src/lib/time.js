export const MIN = 60 * 1000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

export function hoursBetween(a, b) {
  return (b - a) / HOUR
}

/** Hour of day as a float, e.g. 14.5 for 14:30. Local time. */
export function clockHour(t) {
  const d = new Date(t)
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
}

export function startOfHour(t) {
  const d = new Date(t)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

export function startOfDay(t) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Build a timestamp at `hour` (float, may exceed 24 to roll into next day). */
export function atHour(dayStart, hour) {
  return dayStart + Math.round(hour * HOUR)
}

export function fmtTime(t) {
  return new Date(t).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function fmtDayShort(t) {
  return new Date(t).toLocaleDateString([], { weekday: 'short' })
}

export function fmtDateTime(t) {
  const d = new Date(t)
  return `${fmtDayShort(t)} ${fmtTime(d)}`
}

export function fmtDuration(hours) {
  const total = Math.round(hours * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${String(m).padStart(2, '0')}m`
}

/** "in 3h 20m" / "2h ago" */
export function relTime(t, now = Date.now()) {
  const diff = t - now
  if (Math.abs(diff) < MIN) return 'just now'
  const label = fmtDuration(Math.abs(diff) / HOUR)
  return diff >= 0 ? `in ${label}` : `${label} ago`
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd
}

/** Clamp a value into [lo, hi]. */
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}
