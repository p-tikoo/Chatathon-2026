/**
 * Assignment suggestion engine (local mock of POST /suggest-assignment).
 *
 * Ranks every credentialled surgeon for a case by their predicted
 * effectiveness across the operative window, then applies hard eligibility
 * rules and soft preferences. Each candidate carries the reasons behind its
 * position so the director sees why, not just what.
 */

import { HOUR, MIN, overlaps } from './time.js'
import { bandFor, curve, lowestDuring, timeOnTask, WAKE_PENALTY } from './fatigue.js'

const MAX_CONTINUOUS_DUTY = 16 // h, hard stop
const COMPLEXITY_FLOOR = { 1: 60, 2: 62, 3: 68, 4: 74, 5: 78 }

const LOOKBACK_H = 12
const HORIZON_H = 72

/**
 * Simulating every surgeon for every case is the obvious implementation and
 * far too slow: a 40-case roster would run 600 simulations. One curve per
 * surgeon covers every case in the horizon, so build them once and reuse.
 * The key changes whenever sleep or flags change, or the clock advances a
 * quarter hour.
 */
let cache = { key: null, curves: null }

function curvesFor(dataset, now) {
  const fingerprint = dataset.surgeons.reduce(
    (n, s) => n + s.sleepLog.length * 7 + s.flags.length * 13 + s.duty.length * 3,
    dataset.surgeons.length
  )
  const key = `${Math.floor(now / (15 * MIN))}:${fingerprint}`
  if (cache.key === key) return cache.curves

  const from = now - LOOKBACK_H * HOUR
  const to = now + HORIZON_H * HOUR
  const curves = new Map()
  for (const s of dataset.surgeons) curves.set(s.id, curve(s, from, to))
  cache = { key, curves }
  return curves
}

export function suggestAssignment(dataset, caseId, now = Date.now()) {
  const theCase = dataset.cases.find((c) => c.id === caseId)
  if (!theCase) return null

  const others = dataset.cases.filter((c) => c.id !== caseId)
  const floor = COMPLEXITY_FLOOR[theCase.complexity] ?? 70
  const curves = curvesFor(dataset, now)

  const candidates = dataset.surgeons.map((s) => {
    const samples = curves.get(s.id) ?? []
    let low = lowestDuring(samples, theCase.start, theCase.end)

    // Projected asleep for the whole window. They can still be called in;
    // they just arrive worse than the curve alone suggests.
    const wouldBeWoken = !low
    if (wouldBeWoken) {
      low = lowestDuring(samples, theCase.start, theCase.end, { includeAsleep: true })
    }
    const predicted = low
      ? Math.max(3, low.score - (wouldBeWoken ? WAKE_PENALTY : 0))
      : null

    const reasons = []
    const blockers = []

    if (s.specialty !== theCase.specialty) {
      blockers.push(`Not credentialled in ${theCase.specialty}`)
    }

    const conflict = others.find(
      (c) => c.surgeonId === s.id && overlaps(c.start, c.end, theCase.start, theCase.end)
    )
    if (conflict) {
      blockers.push(`Already in ${conflict.room} for ${conflict.id}`)
    }

    const commitment = (s.commitments ?? []).find((c) =>
      overlaps(c.start, c.end, theCase.start, theCase.end)
    )
    if (commitment) {
      blockers.push(`${commitment.label} at the same time`)
    }

    const standDown = (s.flags ?? []).find(
      (f) => f.severity === 'stand-down' && now - f.at < 12 * HOUR
    )
    if (standDown) {
      blockers.push('Self-reported stand-down in the last 12h')
    }

    const totAtEnd = timeOnTask(s.duty ?? [], theCase.end - 1)
    if (totAtEnd > MAX_CONTINUOUS_DUTY) {
      blockers.push(`Would pass ${MAX_CONTINUOUS_DUTY}h continuous duty`)
    }

    if (predicted == null) {
      blockers.push('No projection available for this window')
    }

    // Soft scoring, only meaningful once the hard rules pass.
    let rank = predicted ?? 0
    if (predicted != null) {
      const band = bandFor(predicted)
      reasons.push(
        `Predicted effectiveness ${predicted.toFixed(0)} at the low point of the case (${band.label.toLowerCase()})`
      )

      if (predicted < floor) {
        rank -= (floor - predicted) * 1.5
        reasons.push(
          `Below the floor of ${floor} for complexity ${theCase.complexity}`
        )
      }

      if (wouldBeWoken) {
        rank -= 8
        reasons.push(
          `Projected asleep, so would be woken for this case (${WAKE_PENALTY} points deducted for sleep inertia)`
        )
      }

      const onDuty = (s.duty ?? []).some(
        (b) => b.start <= theCase.start && b.end >= theCase.end
      )
      if (onDuty) {
        rank += 6
        reasons.push('Already rostered on duty for the full window')
      } else if (!wouldBeWoken) {
        rank -= 4
        reasons.push('Would need to be called in')
      }

      if (totAtEnd > 10 && totAtEnd <= MAX_CONTINUOUS_DUTY) {
        rank -= (totAtEnd - 10) * 1.2
        reasons.push(`${totAtEnd.toFixed(1)}h continuous duty by the end of the case`)
      }

      const sameDayLoad = others.filter(
        (c) =>
          c.surgeonId === s.id &&
          Math.abs(c.start - theCase.start) < 12 * HOUR
      ).length
      if (sameDayLoad >= 3) {
        rank -= (sameDayLoad - 2) * 2
        reasons.push(`${sameDayLoad} other cases within 12h`)
      }
    }

    return {
      surgeonId: s.id,
      name: s.name,
      specialty: s.specialty,
      role: s.role,
      predicted,
      band: predicted == null ? null : bandFor(predicted),
      rank: blockers.length ? -Infinity : rank,
      eligible: blockers.length === 0,
      blockers,
      reasons,
      isCurrent: s.id === theCase.surgeonId,
    }
  })

  const eligible = candidates
    .filter((c) => c.eligible)
    .sort((a, b) => b.rank - a.rank)
  const ineligible = candidates
    .filter((c) => !c.eligible && c.specialty === theCase.specialty)
    .sort((a, b) => (b.predicted ?? 0) - (a.predicted ?? 0))

  const current = candidates.find((c) => c.isCurrent) ?? null
  const best = eligible[0] ?? null

  let recommendation = 'keep'
  if (!current) recommendation = 'assign'
  else if (!current.eligible) recommendation = 'reassign'
  else if (best && best.surgeonId !== current.surgeonId) {
    const gain = (best.predicted ?? 0) - (current.predicted ?? 0)
    const currentBelowFloor = (current.predicted ?? 0) < floor
    if (currentBelowFloor && gain > 3) recommendation = 'reassign'
    else if (gain >= 8) recommendation = 'consider'
  }

  return {
    caseId,
    case: theCase,
    floor,
    recommendation,
    current,
    candidates: eligible,
    ineligible,
  }
}

/** Every case in the window that the model would flag, worst first. */
export function findAtRiskCases(dataset, from, to, now = Date.now()) {
  const out = []
  for (const c of dataset.cases) {
    if (c.start < from || c.start > to) continue
    const suggestion = suggestAssignment(dataset, c.id, now)
    if (!suggestion) continue
    if (suggestion.recommendation === 'keep') continue
    out.push(suggestion)
  }
  return out.sort((a, b) => {
    const order = { reassign: 0, assign: 1, consider: 2 }
    const d = order[a.recommendation] - order[b.recommendation]
    if (d !== 0) return d
    return (a.current?.predicted ?? 0) - (b.current?.predicted ?? 0)
  })
}
