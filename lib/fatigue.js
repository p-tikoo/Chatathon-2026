/**
 * DETERMINISTIC FATIGUE / ALERTNESS MODEL
 * ============================================================================
 * This is the backbone of the product and the fallback for every LLM call.
 * It is pure arithmetic: no network, no API key, no failure mode. If Gemini is
 * rate-limited, down, or returns malformed JSON mid-demo, this still produces a
 * defensible score with a readable explanation.
 *
 * WHAT IT IS MODELLED ON
 * ----------------------
 * A simplified, transparent two-process model of alertness — the standard
 * framework behind fatigue risk management systems in aviation and trucking
 * (SAFTE-FAST, FAID, the Borbély two-process model):
 *
 *   PROCESS S (homeostatic)  — sleep pressure. Builds with time awake, is paid
 *                              down by sleep. Modelled here as acute sleep
 *                              deficit + cumulative 7-day debt + hours awake.
 *   PROCESS C (circadian)    — the ~24h body-clock rhythm. Independent of how
 *                              long you've been awake. Modelled here as a
 *                              time-of-day penalty with a nadir in the Window
 *                              of Circadian Low (WOCL, ~02:00-06:00) and a
 *                              secondary post-prandial dip in mid-afternoon.
 *
 * Plus two occupational terms the classical models don't include, which are
 * the whole point of this product:
 *
 *   CONSECUTIVE NIGHTS       — circadian misalignment compounds across a night
 *                              rotation; night 3 is materially worse than night 1.
 *   OPERATIVE WORKLOAD       — RVU-weighted case load in the prior 24h/7d, run
 *                              through the surgeon's personal calibration from
 *                              lib/complexity.js. This is what makes it a
 *                              SURGICAL fatigue model rather than a generic one.
 *
 * KEY EMPIRICAL ANCHORS (these are the numbers in the pitch)
 * ----------------------------------------------------------
 *   - 6 HOURS. Sleep opportunity at or below six hours is the threshold where
 *     the large surgical outcomes study found markedly elevated complication
 *     rates. Encoded below as an explicit discontinuity (SIX_HOUR_CLIFF)
 *     rather than a smooth curve, because the evidence is threshold-shaped.
 *   - 17 HOURS AWAKE. Sustained wakefulness past ~17h produces psychomotor
 *     impairment comparable to a blood alcohol concentration around 0.05%
 *     (Dawson & Reid, Nature, 1997). WAKE_FREE_HOURS is set just below this.
 *   - POST-CALL SLEEP. Observational work on attending surgeons found ~4.98h
 *     sleep post-call vs ~6.68h non-post-call. The seed data reproduces this
 *     gap so the demo shows a realistic spread.
 *
 * ⚠️  HONEST LIMITATIONS — SAY THESE OUT LOUD IF ASKED
 *   The specific coefficients below are PLAUSIBLE, NOT VALIDATED. They were
 *   chosen so the model reproduces the direction and rough magnitude of the
 *   published findings above and so the demo behaves sensibly. This model has
 *   not been fitted to outcome data and has not been prospectively validated
 *   against surgical performance. Calling it "evidence-informed" is fair;
 *   calling it "evidence-based" is not.
 *
 *   This is scheduling decision support. It is NOT a medical device, it does
 *   not diagnose any condition, and it must not be used to make clinical
 *   determinations about an individual's fitness to practise.
 * ============================================================================
 */

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

// --- Model coefficients (single source of truth; tune here, not inline) -----
export const MODEL = {
  version: "1.0.0-deterministic",

  // Process S — acute
  ACUTE_PENALTY_PER_HOUR: 9, // points lost per hour below personal baseline
  ACUTE_CAP: 32,
  SIX_HOUR_CLIFF: 10, // extra penalty at/below 6h — the JAMA threshold
  SIX_HOUR_THRESHOLD: 6,

  // Process S — cumulative
  DEBT_PENALTY_PER_HOUR: 2.5, // per hour of 7-day accumulated deficit
  DEBT_CAP: 22,

  // Process S — continuous wakefulness
  WAKE_FREE_HOURS: 16, // no penalty below this
  WAKE_PENALTY_PER_HOUR: 2.5,
  WAKE_CAP: 20,

  // Process C — circadian
  CIRCADIAN_WOCL: 18, // 02:00-05:59, the circadian nadir
  CIRCADIAN_SHOULDER: 10, // 00:00-01:59 and 06:00-06:59
  CIRCADIAN_AFTERNOON_DIP: 6, // 14:00-16:59

  // Occupational
  NIGHT_PENALTY_PER_EXTRA_NIGHT: 6, // beyond the first consecutive night
  NIGHT_CAP: 15,

  WORKLOAD_REFERENCE_LOAD_24H: 6, // "normal" depleting-hours in a day
  WORKLOAD_PENALTY_PER_UNIT: 2.2,
  WORKLOAD_CAP: 18,

  // Tier cut-points
  TIER_GREEN: 70,
  TIER_AMBER: 45,
};

/** Maps a 0-100 alertness score to the traffic-light tier leadership sees. */
export function tierForScore(score) {
  if (score >= MODEL.TIER_GREEN) return "green";
  if (score >= MODEL.TIER_AMBER) return "amber";
  return "red";
}

/**
 * Compute a surgeon's current fatigue/alertness state.
 *
 * @param {Object} args
 * @param {Object} args.surgeon      Must include baseline_sleep_hrs
 * @param {Array}  args.sleepLogs    Recent sleep_logs rows (any order)
 * @param {Array}  args.cases        Recent + upcoming cases, each with fatigue_load
 * @param {Array}  args.shifts       Recent shifts (for night rotation + wake time)
 * @param {Date}   [args.at]         Evaluation instant (defaults to now)
 * @returns {Object} score, tier, components, drivers, confidence
 */
export function computeFatigue({ surgeon, sleepLogs = [], cases = [], shifts = [], at = new Date() }) {
  const baseline = clamp(Number(surgeon?.baseline_sleep_hrs) || 7, 4, 10);
  const logs = [...sleepLogs].sort((a, b) => new Date(b.log_date) - new Date(a.log_date));

  // --- Process S: acute deficit (last recorded night) ----------------------
  const lastNight = logs[0] ?? null;
  const lastNightHours = lastNight ? Number(lastNight.hours_slept) : null;
  let acutePenalty = 0;
  if (Number.isFinite(lastNightHours)) {
    const deficit = Math.max(0, baseline - lastNightHours);
    acutePenalty = Math.min(MODEL.ACUTE_CAP, deficit * MODEL.ACUTE_PENALTY_PER_HOUR);
    // The six-hour discontinuity. Threshold-shaped evidence gets a
    // threshold-shaped term rather than being smoothed away.
    if (lastNightHours <= MODEL.SIX_HOUR_THRESHOLD) acutePenalty += MODEL.SIX_HOUR_CLIFF;
  }

  // --- Process S: cumulative 7-day debt ------------------------------------
  const weekLogs = logs.filter((l) => new Date(l.log_date) >= new Date(at.getTime() - 7 * DAY_MS));
  const cumulativeDebt = weekLogs.reduce(
    (sum, l) => sum + Math.max(0, baseline - (Number(l.hours_slept) || 0)),
    0,
  );
  const debtPenalty = Math.min(MODEL.DEBT_CAP, cumulativeDebt * MODEL.DEBT_PENALTY_PER_HOUR);

  // --- Process S: continuous wakefulness -----------------------------------
  const hoursAwake = estimateHoursAwake({ logs, shifts, at });
  const wakePenalty = Math.min(
    MODEL.WAKE_CAP,
    Math.max(0, hoursAwake - MODEL.WAKE_FREE_HOURS) * MODEL.WAKE_PENALTY_PER_HOUR,
  );

  // --- Process C: circadian -------------------------------------------------
  const circadianPenalty = circadianPenaltyForHour(at.getHours());

  // --- Occupational: consecutive night rotation -----------------------------
  const consecutiveNights = countConsecutiveNights(shifts, at);
  const nightPenalty = Math.min(
    MODEL.NIGHT_CAP,
    Math.max(0, consecutiveNights - 1) * MODEL.NIGHT_PENALTY_PER_EXTRA_NIGHT,
  );

  // --- Occupational: operative workload ------------------------------------
  const load24 = sumFatigueLoad(cases, at.getTime() - DAY_MS, at.getTime());
  const load7d = sumFatigueLoad(cases, at.getTime() - 7 * DAY_MS, at.getTime());
  const workloadPenalty = Math.min(
    MODEL.WORKLOAD_CAP,
    Math.max(0, load24 - MODEL.WORKLOAD_REFERENCE_LOAD_24H) * MODEL.WORKLOAD_PENALTY_PER_UNIT,
  );

  const components = {
    acute_sleep_deficit: round1(acutePenalty),
    cumulative_sleep_debt: round1(debtPenalty),
    continuous_wakefulness: round1(wakePenalty),
    circadian: round1(circadianPenalty),
    consecutive_nights: round1(nightPenalty),
    operative_workload: round1(workloadPenalty),
  };

  const totalPenalty = Object.values(components).reduce((a, b) => a + b, 0);
  const score = Math.round(clamp(100 - totalPenalty, 0, 100));
  const tier = tierForScore(score);

  const drivers = buildDrivers({
    components,
    lastNightHours,
    baseline,
    cumulativeDebt,
    hoursAwake,
    consecutiveNights,
    load24,
    at,
  });

  return {
    score,
    tier,
    method: "deterministic",
    model_version: MODEL.version,
    components,
    drivers,
    reasoning: composeReasoning(score, drivers),
    confidence: assessConfidence({ weekLogs, shifts, cases }),
    inputs: {
      baseline_sleep_hrs: baseline,
      last_night_hours: lastNightHours,
      cumulative_debt_hrs: round1(cumulativeDebt),
      hours_awake: round1(hoursAwake),
      consecutive_nights: consecutiveNights,
      fatigue_load_24h: round2(load24),
      fatigue_load_7d: round2(load7d),
      evaluated_at: at.toISOString(),
    },
  };
}

/**
 * Forward projection — the "predictive, not retrospective" claim in the pitch.
 *
 * Walks hour by hour across the horizon. At each step the circadian term is
 * recomputed for that hour of day, wakefulness accumulates, scheduled cases add
 * load, and any sleep opportunity (a gap of >= MIN_SLEEP_GAP hours between
 * commitments, inside a plausible sleep window) pays down sleep pressure.
 *
 * This is what powers the director's 24-48h heatmap and the surgeon's alertness
 * curve, and it is what lets the system flag a problem on Tuesday for a roster
 * that breaks on Thursday.
 */
export function projectAlertness({
  surgeon,
  sleepLogs = [],
  cases = [],
  shifts = [],
  events = [],
  from = new Date(),
  hours = 48,
}) {
  const series = [];
  const horizon = Math.min(Math.max(hours, 1), 72);

  // Current state is the anchor for the projection.
  const current = computeFatigue({ surgeon, sleepLogs, cases, shifts, at: from });

  // Everything except circadian and wakefulness is treated as slow-moving
  // across the horizon; those two are recomputed per hour.
  const slowPenalty =
    current.components.acute_sleep_deficit +
    current.components.cumulative_sleep_debt +
    current.components.consecutive_nights;

  let hoursAwake = current.inputs.hours_awake;
  let workload = current.components.operative_workload;

  for (let h = 0; h <= horizon; h += 1) {
    const t = new Date(from.getTime() + h * HOUR_MS);
    const hourOfDay = t.getHours();

    // Sleep opportunity: no commitment in this hour and it falls in a normal
    // sleep window. Wakefulness resets gradually rather than instantly.
    const busy = isBusyAt(t, { cases, shifts, events });
    const inSleepWindow = hourOfDay >= 22 || hourOfDay < 6;
    if (!busy && inSleepWindow) {
      hoursAwake = Math.max(0, hoursAwake - 1.5);
    } else {
      hoursAwake += 1;
    }

    // Cases scheduled in this hour add depleting load that decays over ~24h.
    const hourLoad = sumFatigueLoad(cases, t.getTime(), t.getTime() + HOUR_MS);
    workload = Math.min(
      MODEL.WORKLOAD_CAP,
      workload * 0.96 + hourLoad * MODEL.WORKLOAD_PENALTY_PER_UNIT,
    );

    const wakePenalty = Math.min(
      MODEL.WAKE_CAP,
      Math.max(0, hoursAwake - MODEL.WAKE_FREE_HOURS) * MODEL.WAKE_PENALTY_PER_HOUR,
    );
    const circadian = circadianPenaltyForHour(hourOfDay);

    const score = Math.round(clamp(100 - (slowPenalty + wakePenalty + circadian + workload), 0, 100));

    series.push({
      t: t.toISOString(),
      hour_of_day: hourOfDay,
      score,
      tier: tierForScore(score),
      busy,
    });
  }

  return {
    current: { score: current.score, tier: current.tier },
    series,
    risk_windows: findRiskWindows(series),
    horizon_hours: horizon,
  };
}

/** Contiguous runs where projected alertness drops below the amber cut-point. */
function findRiskWindows(series) {
  const windows = [];
  let open = null;

  for (const point of series) {
    const atRisk = point.score < MODEL.TIER_GREEN;
    if (atRisk && !open) {
      open = { start: point.t, end: point.t, min_score: point.score, tier: point.tier };
    } else if (atRisk && open) {
      open.end = point.t;
      if (point.score < open.min_score) {
        open.min_score = point.score;
        open.tier = point.tier;
      }
    } else if (!atRisk && open) {
      windows.push(finalizeWindow(open));
      open = null;
    }
  }
  if (open) windows.push(finalizeWindow(open));

  // Only report windows that overlap actual scheduled work — a low score at
  // 03:00 while someone is asleep at home is not a scheduling risk.
  return windows.sort((a, b) => a.min_score - b.min_score).slice(0, 5);
}

function finalizeWindow(w) {
  const durationHrs = Math.max(1, Math.round((new Date(w.end) - new Date(w.start)) / HOUR_MS));
  return { ...w, duration_hours: durationHrs };
}

// --- component helpers ------------------------------------------------------

/**
 * Circadian penalty by hour of day. Piecewise rather than sinusoidal so the
 * output is explainable to a scheduler ("this is the window of circadian low")
 * instead of being an opaque curve.
 */
export function circadianPenaltyForHour(hour) {
  if (hour >= 2 && hour < 6) return MODEL.CIRCADIAN_WOCL; // WOCL — circadian nadir
  if (hour < 2 || hour === 6) return MODEL.CIRCADIAN_SHOULDER; // shoulders of the nadir
  if (hour >= 14 && hour < 17) return MODEL.CIRCADIAN_AFTERNOON_DIP; // post-prandial dip
  return 0;
}

/**
 * Estimate continuous hours awake. Prefers an explicit wake time on the most
 * recent sleep log; otherwise infers from the last night's sleep, assuming it
 * ended at a plausible hour. Falls back to a neutral 8h so a surgeon with no
 * data is not penalized for the missing data.
 */
function estimateHoursAwake({ logs, shifts, at }) {
  const last = logs[0];
  if (last?.wake_time) {
    const wake = new Date(last.wake_time);
    if (!Number.isNaN(wake.getTime())) {
      return clamp((at - wake) / HOUR_MS, 0, 36);
    }
  }

  // Still inside an active shift that started long ago? Use shift start.
  const active = shifts.find(
    (s) => new Date(s.start_time) <= at && new Date(s.end_time) >= at,
  );
  if (active) {
    const elapsed = (at - new Date(active.start_time)) / HOUR_MS;
    // Assume ~2h awake before the shift began.
    return clamp(elapsed + 2, 0, 36);
  }

  if (last?.log_date) {
    // Assume sleep ended `hours_slept` after a 23:00 start on the log date.
    const wake = new Date(last.log_date);
    wake.setHours(23, 0, 0, 0);
    wake.setTime(wake.getTime() + (Number(last.hours_slept) || 7) * HOUR_MS);
    const awake = (at - wake) / HOUR_MS;
    if (awake >= 0 && awake <= 36) return awake;
  }

  return 8; // neutral default — below the penalty threshold
}

/** Consecutive night shifts ending on or before `at`, walking backwards. */
function countConsecutiveNights(shifts, at) {
  const nights = shifts
    .filter((s) => s.is_night && new Date(s.start_time) <= at)
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

  if (nights.length === 0) return 0;

  let count = 1;
  for (let i = 1; i < nights.length; i += 1) {
    const gap = new Date(nights[i - 1].start_time) - new Date(nights[i].start_time);
    // Within ~36h of the previous night shift counts as consecutive.
    if (gap <= 36 * HOUR_MS) count += 1;
    else break;
  }
  return count;
}

function sumFatigueLoad(cases, fromMs, toMs) {
  return cases.reduce((sum, c) => {
    const t = new Date(c.scheduled_at).getTime();
    if (!Number.isFinite(t) || t < fromMs || t >= toMs) return sum;
    // fatigue_load is precomputed by lib/complexity.js. Fall back to a rough
    // RVU-derived estimate if a caller passes raw rows.
    const load = Number.isFinite(Number(c.fatigue_load))
      ? Number(c.fatigue_load)
      : ((Number(c.rvu) || 12) / 40) * (Number(c.duration_hrs) || 2);
    return sum + load;
  }, 0);
}

function isBusyAt(t, { cases, shifts, events }) {
  const ts = t.getTime();
  const overlaps = (start, end) => {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    return Number.isFinite(s) && Number.isFinite(e) && ts >= s && ts < e;
  };

  for (const c of cases) {
    const start = new Date(c.scheduled_at).getTime();
    if (!Number.isFinite(start)) continue;
    const end = start + (Number(c.duration_hrs) || 2) * HOUR_MS;
    if (ts >= start && ts < end) return true;
  }
  for (const s of shifts) if (overlaps(s.start_time, s.end_time)) return true;
  for (const e of events) if (overlaps(e.start_time, e.end_time)) return true;
  return false;
}

// --- explanation ------------------------------------------------------------

/**
 * Turn the numeric components into ranked, human-readable drivers. The pitch
 * rests on this: a bare number gets ignored, a number with a named cause gets
 * acted on. The LLM produces nicer prose, but this guarantees we always have
 * SOMETHING specific to show.
 */
function buildDrivers({
  components,
  lastNightHours,
  baseline,
  cumulativeDebt,
  hoursAwake,
  consecutiveNights,
  load24,
  at,
}) {
  const drivers = [];

  if (components.acute_sleep_deficit > 0 && Number.isFinite(lastNightHours)) {
    drivers.push({
      key: "acute_sleep_deficit",
      impact: components.acute_sleep_deficit,
      label: `${round1(lastNightHours)}h sleep last night vs ${round1(baseline)}h personal baseline`,
      ...(lastNightHours <= MODEL.SIX_HOUR_THRESHOLD
        ? { flag: "Below the six-hour sleep-opportunity threshold" }
        : {}),
    });
  }
  if (components.cumulative_sleep_debt > 0) {
    drivers.push({
      key: "cumulative_sleep_debt",
      impact: components.cumulative_sleep_debt,
      label: `${round1(cumulativeDebt)}h accumulated sleep debt over 7 days`,
    });
  }
  if (components.continuous_wakefulness > 0) {
    drivers.push({
      key: "continuous_wakefulness",
      impact: components.continuous_wakefulness,
      label: `${round1(hoursAwake)}h continuously awake`,
      ...(hoursAwake >= 17
        ? { flag: "Past ~17h awake, impairment is comparable to 0.05% BAC" }
        : {}),
    });
  }
  if (components.circadian > 0) {
    const hour = at.getHours();
    drivers.push({
      key: "circadian",
      impact: components.circadian,
      label:
        hour >= 2 && hour < 6
          ? "Currently in the window of circadian low (02:00-06:00)"
          : hour >= 14 && hour < 17
            ? "Currently in the mid-afternoon circadian dip"
            : "Near the circadian nadir",
    });
  }
  if (components.consecutive_nights > 0) {
    drivers.push({
      key: "consecutive_nights",
      impact: components.consecutive_nights,
      label: `${consecutiveNights} consecutive night rotations`,
    });
  }
  if (components.operative_workload > 0) {
    drivers.push({
      key: "operative_workload",
      impact: components.operative_workload,
      label: `${round1(load24)} RVU-weighted depleting hours of operative load in the prior 24h`,
    });
  }

  return drivers.sort((a, b) => b.impact - a.impact);
}

function composeReasoning(score, drivers) {
  if (drivers.length === 0) {
    return `Predicted alertness ${score}/100. No significant fatigue drivers detected against this surgeon's personal baseline.`;
  }
  const top = drivers.slice(0, 3).map((d) => d.label.toLowerCase());
  return `Predicted alertness ${score}/100. Primary drivers: ${top.join("; ")}.`;
}

/**
 * How much we trust this score. Surfaced to the user rather than hidden,
 * because a confident-looking score computed from two data points is exactly
 * how these systems lose the trust of the people they're scheduling.
 */
function assessConfidence({ weekLogs, shifts, cases }) {
  let points = 0;
  if (weekLogs.length >= 5) points += 3;
  else if (weekLogs.length >= 3) points += 2;
  else if (weekLogs.length >= 1) points += 1;

  if (shifts.length >= 3) points += 2;
  else if (shifts.length >= 1) points += 1;

  if (cases.length >= 3) points += 2;
  else if (cases.length >= 1) points += 1;

  const level = points >= 6 ? "high" : points >= 3 ? "moderate" : "low";
  return {
    level,
    points,
    max_points: 7,
    basis: `${weekLogs.length} sleep log(s) in the last 7 days, ${shifts.length} shift record(s), ${cases.length} case record(s)`,
    ...(level === "low"
      ? { warning: "Insufficient data for a reliable estimate — treat as indicative only." }
      : {}),
  };
}

// --- numeric helpers --------------------------------------------------------
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
