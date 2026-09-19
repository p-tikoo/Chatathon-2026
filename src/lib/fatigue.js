/**
 * Fatigue / alertness model.
 *
 * Synthetic decision support. This is a demo implementation of a published
 * modelling approach, not a validated clinical instrument.
 *
 * The core is the two-process model of sleep regulation (Borbely):
 *
 *   Process S  homeostatic sleep pressure. Rises toward 1 while awake with
 *              time constant TAU_RISE, dissipates toward 0 during sleep with
 *              time constant TAU_FALL.
 *   Process C  circadian alertness rhythm. A 24h cosine with an acrophase in
 *              the late afternoon, plus a 12h harmonic that produces the
 *              early-afternoon dip.
 *
 * Effectiveness = 100 * (BASE - KS*S + KC*C), then reduced by four modifiers
 * that the two-process core does not cover on its own: chronic sleep debt,
 * time on task, sleep inertia, and cumulative night-shift load.
 *
 * Band thresholds follow the convention used in fatigue-risk management, where
 * an effectiveness of 77 and 65 are treated as roughly equivalent to blood
 * alcohol concentrations of 0.05% and 0.08%.
 */

import { HOUR, MIN, clamp, clockHour, startOfDay, atHour, overlaps } from './time.js'

// --- Two-process constants -------------------------------------------------

const TAU_RISE = 18.2 // h, homeostatic build-up while awake
const TAU_FALL = 4.2 // h, dissipation while asleep
const ACROPHASE = 16.5 // h, clock time of peak circadian alertness
/*
 * BASE/KS/KC are calibrated so that a rested surgeon on a 06:00 wake:
 *   14:00, 8h awake, circadian peak      ~99   fit
 *   22:00, 16h awake                     ~85   fit
 *   02:00, 20h awake                     ~70   caution
 *   04:00, 22h awake, circadian trough   ~67   caution, red once debt applies
 * A night-adapted surgeon with proper day sleep reads ~88 at 03:00, which is
 * the point of modelling adaptation rather than clock time alone.
 */
const BASE = 1.1
const KS = 0.42 // weight on homeostatic pressure
const KC = 0.115 // weight on circadian process

const IDEAL_SLEEP = 7.5 // h/night, the debt reference
const HISTORY_DAYS = 7 // how far back the simulation warms up
const STEP_MIN = 15 // integration step

export const BANDS = {
  fit: {
    key: 'fit',
    label: 'Fit',
    min: 77,
    note: 'No fatigue-related restriction.',
  },
  caution: {
    key: 'caution',
    label: 'Caution',
    min: 65,
    note: 'Impairment comparable to 0.05% BAC. Avoid high-acuity solo cases.',
  },
  risk: {
    key: 'risk',
    label: 'High risk',
    min: 0,
    note: 'Impairment comparable to 0.08% BAC. Reassignment recommended.',
  },
}

export function bandFor(score) {
  if (score >= BANDS.fit.min) return BANDS.fit
  if (score >= BANDS.caution.min) return BANDS.caution
  return BANDS.risk
}

// --- Process C -------------------------------------------------------------

function circadian(t, chronotypeShift = 0) {
  const h = clockHour(t)
  const phase = ACROPHASE + chronotypeShift
  const fundamental = Math.cos((2 * Math.PI * (h - phase)) / 24)
  const harmonic = 0.14 * Math.cos((4 * Math.PI * (h - phase - 3)) / 24)
  return fundamental + harmonic
}

export const CHRONOTYPE_SHIFT = {
  early: -1.6,
  neutral: 0,
  late: 1.6,
}

// --- Sleep timeline --------------------------------------------------------

/** Subtract `blocks` from [start, end], returning the remaining free spans. */
function subtractBlocks(start, end, blocks) {
  let spans = [[start, end]]
  for (const b of blocks) {
    const next = []
    for (const [s, e] of spans) {
      if (!overlaps(s, e, b.start, b.end)) {
        next.push([s, e])
        continue
      }
      if (b.start > s) next.push([s, Math.min(e, b.start)])
      if (b.end < e) next.push([Math.max(s, b.end), e])
    }
    spans = next
  }
  return spans
}

/**
 * Project the sleep a surgeon is likely to get between `from` and `to`, given
 * their habitual window and the duty they are already committed to.
 *
 * `assumption` shifts the habitual window and the quality credited to it. The
 * default reproduces the habitual window exactly; the variants in SLEEP_SPREAD
 * are what turn the forward curve into a range instead of a single line.
 */
function planSleep(surgeon, from, to, logged = [], assumption = null) {
  const habitual = surgeon.habitualSleep
  const bedHour = habitual.bedHour + (assumption?.bedShift ?? 0)
  const wakeHour = habitual.wakeHour + (assumption?.wakeShift ?? 0)
  const duration = (wakeHour - bedHour + 24) % 24 || 7.5
  const quality = assumption?.quality ?? 0.92
  const duty = surgeon.duty ?? []
  const planned = []

  for (let day = startOfDay(from) - 24 * HOUR; day <= to; day += 24 * HOUR) {
    const candStart = atHour(day, bedHour)
    const candEnd = candStart + duration * HOUR
    if (candEnd <= from || candStart >= to) continue

    // This window has already been slept and logged. Projecting into what is
    // left of it would invent a nap minutes after the surgeon got up.
    if (logged.some((l) => overlaps(l.start, l.end, candStart, candEnd))) continue

    const dutyClash = duty.some((b) => overlaps(b.start, b.end, candStart, candEnd))
    const windowStart = Math.max(candStart, from)
    const free = subtractBlocks(windowStart, candEnd, duty)
    const longest = free.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0]

    if (longest && (longest[1] - longest[0]) / HOUR >= 3) {
      planned.push({ start: longest[0], end: longest[1], quality, projected: true })
      continue
    }

    // Only duty earns a recovery sleep. A window that is merely clipped by the
    // start of the simulation is not a missed night.
    if (!dutyClash) continue

    // Habitual window is consumed by duty. Look for recovery sleep in the
    // first usable gap in the 14h that follow.
    const searchEnd = candEnd + 14 * HOUR
    const gaps = subtractBlocks(candEnd, searchEnd, duty)
    const gap = gaps.find((g) => (g[1] - g[0]) / HOUR >= 4.5)
    if (gap) {
      const start = gap[0] + 0.75 * HOUR // time to get home and wind down
      const end = Math.min(gap[1] - 0.5 * HOUR, start + 6 * HOUR)
      if ((end - start) / HOUR >= 3) {
        // Sleep snatched after a shift is never as good as the habitual window.
        planned.push({
          start,
          end,
          quality: quality - 0.2,
          projected: true,
          recovery: true,
        })
      }
    }
  }
  return planned
}

/** Logged sleep plus projected future sleep, ordered and non-overlapping. */
export function sleepTimeline(surgeon, from, to, assumption = null) {
  const logged = (surgeon.sleepLog ?? [])
    .filter((s) => s.end > from && s.start < to)
    .map((s) => ({ ...s, projected: false }))

  const lastLogged = logged.reduce((m, s) => Math.max(m, s.end), from)
  const projected = planSleep(surgeon, Math.max(lastLogged, from), to, logged, assumption)

  return [...logged, ...projected]
    .sort((a, b) => a.start - b.start)
    .filter((s, i, arr) => i === 0 || s.start >= arr[i - 1].end)
}

// --- Modifiers -------------------------------------------------------------

/** Rolling sleep debt across the 7 days preceding `t`, in hours. */
function sleepDebt(episodes, t) {
  const windowStart = t - HISTORY_DAYS * 24 * HOUR
  let slept = 0
  for (const s of episodes) {
    const a = Math.max(s.start, windowStart)
    const b = Math.min(s.end, t)
    // Quality already slows dissipation in process S. Weight it only lightly
    // here, or broken sleep is charged against the surgeon twice.
    if (b > a) slept += ((b - a) / HOUR) * (0.6 + 0.4 * (s.quality ?? 0.9))
  }
  const expected = IDEAL_SLEEP * HISTORY_DAYS
  return Math.max(0, expected - slept)
}

/** Unbroken hours on duty ending at `t`, counting breaks under 1h as continuous. */
export function timeOnTask(duty, t) {
  const active = duty
    .filter((b) => b.start <= t && b.end > t)
    .sort((a, b) => a.start - b.start)[0]
  if (!active) return 0

  let start = active.start
  let guard = 0
  while (guard++ < 20) {
    const prev = duty
      .filter((b) => b.end <= start && start - b.end < 1 * HOUR)
      .sort((a, b) => b.end - a.end)[0]
    if (!prev) break
    start = prev.start
  }
  return (t - start) / HOUR
}

/** Duty blocks overlapping 00:00-06:00 in the 7 days before `t`. */
function nightLoad(duty, t) {
  const windowStart = t - HISTORY_DAYS * 24 * HOUR
  const nights = new Set()
  for (const b of duty) {
    if (b.end <= windowStart || b.start >= t) continue
    for (let day = startOfDay(b.start); day <= b.end; day += 24 * HOUR) {
      if (overlaps(b.start, b.end, atHour(day, 0), atHour(day, 6))) nights.add(day)
    }
  }
  return nights.size
}

// --- Simulation ------------------------------------------------------------

/**
 * Integrate process S across the sleep/wake timeline and sample effectiveness
 * every STEP_MIN minutes between `from` and `to`.
 */
export function simulate(surgeon, from, to, { sleep = null } = {}) {
  const warmup = from - HISTORY_DAYS * 24 * HOUR
  const episodes = sleepTimeline(surgeon, warmup - 2 * 24 * HOUR, to, sleep)
  const duty = surgeon.duty ?? []
  const shift = CHRONOTYPE_SHIFT[surgeon.chronotype] ?? 0

  const step = STEP_MIN * MIN
  const dtHours = STEP_MIN / 60

  let S = 0.38 // neutral starting pressure at the top of the warm-up
  let lastWake = warmup
  const samples = []

  for (let t = warmup; t <= to; t += step) {
    const asleep = episodes.find((s) => s.start <= t && s.end > t)

    if (asleep) {
      S = S * Math.exp((-dtHours * (asleep.quality ?? 0.9)) / TAU_FALL)
      lastWake = asleep.end
    } else {
      S = 1 - (1 - S) * Math.exp(-dtHours / TAU_RISE)
    }

    if (t < from) continue

    const C = circadian(t, shift)
    const raw = 100 * (BASE - KS * S + KC * C)

    const debt = sleepDebt(episodes, t)
    const pDebt = Math.min(14, debt * 1.15)

    const tot = timeOnTask(duty, t)
    const pTask = Math.min(10, Math.max(0, tot - 8) * 0.95)

    const sinceWake = (t - lastWake) / MIN
    const pInertia = asleep ? 0 : sinceWake < 30 ? 12 * (1 - sinceWake / 30) : 0

    const nights = nightLoad(duty, t)
    const pNights = Math.min(6, Math.max(0, nights - 2) * 2)

    const score = clamp(raw - pDebt - pTask - pInertia - pNights, 3, 100)

    samples.push({
      t,
      score: Math.round(score * 10) / 10,
      asleep: Boolean(asleep),
      inertia: pInertia > 1,
      onDuty: duty.some((b) => b.start <= t && b.end > t),
      S,
      C,
      hoursAwake: asleep ? 0 : (t - lastWake) / HOUR,
      debt,
      timeOnTask: tot,
      nights,
      parts: {
        circadian: 100 * KC * C,
        homeostatic: -100 * KS * S,
        debt: -pDebt,
        timeOnTask: -pTask,
        inertia: -pInertia,
        nights: -pNights,
      },
    })
  }

  return samples
}

/** Full assessment at a single instant, with the reasons behind the number. */
export function assess(surgeon, now) {
  const samples = simulate(surgeon, now, now + 30 * MIN)
  const s = samples[0]
  const band = bandFor(s.score)

  const drivers = [
    {
      key: 'circadian',
      label: 'Circadian phase',
      detail: describeCircadian(now, CHRONOTYPE_SHIFT[surgeon.chronotype] ?? 0),
      points: s.parts.circadian,
    },
    {
      key: 'homeostatic',
      label: 'Sleep pressure',
      detail: s.asleep
        ? `Asleep, pressure falling (${Math.round(s.S * 100)}%)`
        : `${s.hoursAwake.toFixed(1)}h awake, pressure ${Math.round(s.S * 100)}%`,
      points: s.parts.homeostatic,
    },
    {
      key: 'debt',
      label: 'Sleep debt (7d)',
      detail: `${s.debt.toFixed(1)}h below ${IDEAL_SLEEP}h/night`,
      points: s.parts.debt,
    },
    {
      key: 'timeOnTask',
      label: 'Continuous duty',
      detail: s.timeOnTask > 0 ? `${s.timeOnTask.toFixed(1)}h on shift` : 'Off duty',
      points: s.parts.timeOnTask,
    },
    {
      key: 'nights',
      label: 'Night shifts (7d)',
      detail: `${s.nights} block${s.nights === 1 ? '' : 's'} crossing 00:00-06:00`,
      points: s.parts.nights,
    },
    {
      key: 'inertia',
      label: 'Sleep inertia',
      detail: 'Within 30 min of waking',
      points: s.parts.inertia,
    },
  ].filter((d) => Math.abs(d.points) >= 0.5)

  drivers.sort((a, b) => a.points - b.points)

  return {
    score: s.score,
    band,
    hoursAwake: s.hoursAwake,
    sleepDebt: s.debt,
    timeOnTask: s.timeOnTask,
    nights: s.nights,
    asleep: s.asleep,
    onDuty: s.onDuty,
    drivers,
  }
}

function describeCircadian(t, shift) {
  const h = clockHour(t)
  const phase = (h - (ACROPHASE + shift) + 24) % 24
  if (phase > 8 && phase < 16) return 'Near the circadian low'
  if (phase < 3 || phase > 21) return 'Near the circadian peak'
  return 'Mid-range'
}

/** Sample the curve between two instants, for charts and heatmaps. */
export function curve(surgeon, from, to) {
  return simulate(surgeon, from, to)
}

/**
 * The forward curve is only as good as its sleep assumption, so quoting it as a
 * single number past `now` overstates what the model knows. These two variants
 * bracket the habitual window: a short late night, and an undisturbed one.
 */
export const SLEEP_SPREAD = {
  low: { bedShift: 1, wakeShift: -0.5, quality: 0.8 },
  high: { bedShift: -0.25, wakeShift: 0.5, quality: 0.95 },
}

/** The sleep each variant assumes, in hours, for captioning the chart. */
export function spreadHours(surgeon) {
  const { bedHour, wakeHour } = surgeon.habitualSleep
  const hours = (wakeHour - bedHour + 24) % 24 || 7.5
  const span = (v) => hours - v.bedShift + v.wakeShift
  return { hours, low: span(SLEEP_SPREAD.low), high: span(SLEEP_SPREAD.high) }
}

/**
 * Widen an existing curve into a range by re-running the simulation under both
 * sleep variants. The range closes to nothing over logged sleep, which is what
 * makes the past read as measured and the future as forecast.
 */
export function withSpread(surgeon, samples) {
  if (!samples.length) return samples
  const from = samples[0].t
  const to = samples[samples.length - 1].t
  const low = simulate(surgeon, from, to, { sleep: SLEEP_SPREAD.low })
  const high = simulate(surgeon, from, to, { sleep: SLEEP_SPREAD.high })

  return samples.map((s, i) => {
    const a = low[i]?.score ?? s.score
    const b = high[i]?.score ?? s.score
    return { ...s, lo: Math.min(s.score, a, b), hi: Math.max(s.score, a, b) }
  })
}

/**
 * Lowest predicted effectiveness across a window, ignoring time asleep.
 * Single pass with no allocation: this runs once per candidate per case.
 */
export function lowestDuring(samples, start, end, { includeAsleep = false } = {}) {
  let best = null
  for (const s of samples) {
    if (s.t < start) continue
    if (s.t > end) break
    if (s.asleep && !includeAsleep) continue
    if (!best || s.score < best.score) best = s
  }
  return best
}

/**
 * Penalty applied when a surgeon would have to be roused from projected sleep.
 * Being asleep is not a bar to operating - somebody has to take the 03:00
 * laparotomy - but they arrive in sleep inertia, so it costs.
 */
export const WAKE_PENALTY = 10

/** Effectiveness at a single instant, read off an existing curve. */
export function scoreAt(samples, t) {
  if (!samples.length) return null
  let best = samples[0]
  for (const s of samples) {
    if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s
  }
  return best
}
