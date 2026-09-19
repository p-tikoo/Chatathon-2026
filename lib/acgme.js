/**
 * DUTY-HOUR COMPLIANCE CHECKING
 * ============================================================================
 * Every AI-suggested assignment is run through this module BEFORE it is shown
 * to a human. A recommendation that would breach duty-hour limits is never
 * presented as an option — it is presented as blocked, with the reason.
 *
 * This matters for the pitch: it is the difference between "an LLM suggested a
 * name" and "a scheduling system made a recommendation inside the rules the
 * department is actually bound by". It also closes the obvious objection that
 * an AI optimizing for recovery would just quietly overwork whoever slept well.
 *
 * SOURCE OF THE RULES
 * -------------------
 * ACGME Common Program Requirements, Section VI.F (Clinical Experience and
 * Education / duty hours). These bind ACCREDITED RESIDENTS AND FELLOWS in the
 * United States. Current requirements:
 *   https://www.acgme.org/programs-and-institutions/programs/common-program-requirements/
 *
 * ⚠️  IMPORTANT SCOPE LIMITATION — DO NOT OVERSTATE THIS IN THE PITCH
 *   ACGME duty-hour limits DO NOT APPLY TO ATTENDING SURGEONS. There is no
 *   federal cap on attending hours in the US. For attendings this module runs
 *   the same arithmetic but downgrades every finding from "violation" to
 *   "advisory" and labels it as institutional policy, not regulation.
 *
 *   The relevant expectation for attendings is softer: The Joint Commission
 *   expects accredited hospitals to assess and mitigate fatigue-related risk
 *   in staffing (and some states, e.g. New York, regulate resident hours in
 *   statute), but neither sets an enforceable hour ceiling for attendings.
 *
 *   The honest framing: for residents this is a hard compliance gate; for
 *   attendings it is an institutional guardrail the department sets for itself.
 *
 *   Note also that the PGY-1-specific 16-hour cap was removed in 2017 — all
 *   residency levels now share the 24+4 limit encoded below.
 * ============================================================================
 */

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/** Roles subject to ACGME as a regulatory matter. */
const TRAINEE_ROLES = ["resident", "fellow", "intern", "pgy1", "trainee"];

export const ACGME_LIMITS = {
  /** Max hours/week, averaged over 4 weeks, inclusive of in-house call and moonlighting. */
  MAX_WEEKLY_HOURS: 80,
  WEEKLY_AVERAGING_WEEKS: 4,

  /** Max continuous scheduled clinical work. */
  MAX_CONTINUOUS_HOURS: 24,
  /** Additional time permitted for transitions of care (no new patients). */
  TRANSITION_HOURS: 4,

  /** Minimum time free between scheduled work periods. */
  MIN_REST_HOURS: 8,
  /** Required free time after 24h of in-house call. */
  MIN_REST_AFTER_24H_CALL: 14,

  /** 1 day in 7 free from all clinical and educational responsibility, averaged over 4 weeks. */
  FREE_DAYS_PER_28: 4,

  /** In-house call no more frequently than every third night, averaged over 4 weeks. */
  MIN_NIGHTS_BETWEEN_CALL: 3,
};

export function isTrainee(surgeon) {
  const role = String(surgeon?.role ?? "attending").toLowerCase();
  return TRAINEE_ROLES.some((r) => role.includes(r));
}

/**
 * Evaluate a surgeon's duty-hour position, optionally including a proposed new
 * assignment.
 *
 * @param {Object} args
 * @param {Object} args.surgeon
 * @param {Array}  args.shifts             Existing shifts
 * @param {Array}  args.cases              Existing cases
 * @param {Object} [args.proposedCase]     { scheduled_at, duration_hrs } being considered
 * @param {Date}   [args.at]
 * @returns {{compliant: boolean, regulatory: boolean, findings: Array, summary: string}}
 */
export function checkDutyHours({ surgeon, shifts = [], cases = [], proposedCase = null, at = new Date() }) {
  const regulatory = isTrainee(surgeon);
  const findings = [];

  // Treat shifts and cases uniformly as work intervals.
  const intervals = toIntervals(shifts, cases);
  if (proposedCase) {
    const start = new Date(proposedCase.scheduled_at);
    const end = new Date(start.getTime() + (Number(proposedCase.duration_hrs) || 2) * HOUR_MS);
    if (!Number.isNaN(start.getTime())) {
      intervals.push({ start, end, is_night: isNightInterval(start, end), proposed: true });
    }
  }
  intervals.sort((a, b) => a.start - b.start);

  // --- Rule 1: 80-hour week, averaged over 4 weeks -------------------------
  const windowStart = new Date(at.getTime() - ACGME_LIMITS.WEEKLY_AVERAGING_WEEKS * 7 * DAY_MS);
  const windowEnd = new Date(at.getTime() + 7 * DAY_MS); // include the proposed week
  const totalHours = intervals.reduce(
    (sum, i) => sum + overlapHours(i, windowStart, windowEnd),
    0,
  );
  const avgWeekly = totalHours / (ACGME_LIMITS.WEEKLY_AVERAGING_WEEKS + 1);
  if (avgWeekly > ACGME_LIMITS.MAX_WEEKLY_HOURS) {
    findings.push(
      finding(
        regulatory,
        "max_weekly_hours",
        `Averaged weekly hours ${round1(avgWeekly)}h exceed the ${ACGME_LIMITS.MAX_WEEKLY_HOURS}h limit`,
        { limit: ACGME_LIMITS.MAX_WEEKLY_HOURS, actual: round1(avgWeekly), unit: "hours/week" },
      ),
    );
  }

  // --- Rule 2: max continuous duty ------------------------------------------
  const longest = longestContinuousBlock(intervals);
  const hardCap = ACGME_LIMITS.MAX_CONTINUOUS_HOURS + ACGME_LIMITS.TRANSITION_HOURS;
  if (longest.hours > hardCap) {
    findings.push(
      finding(
        regulatory,
        "max_continuous_hours",
        `Continuous scheduled duty of ${round1(longest.hours)}h exceeds the ${ACGME_LIMITS.MAX_CONTINUOUS_HOURS}h limit (+${ACGME_LIMITS.TRANSITION_HOURS}h transition)`,
        { limit: hardCap, actual: round1(longest.hours), unit: "hours", block: longest.range },
      ),
    );
  } else if (longest.hours > ACGME_LIMITS.MAX_CONTINUOUS_HOURS) {
    findings.push({
      rule: "max_continuous_hours",
      severity: "warning",
      message: `Continuous duty of ${round1(longest.hours)}h is inside the ${ACGME_LIMITS.TRANSITION_HOURS}h transition allowance — no new patient care may be accepted`,
      detail: { limit: ACGME_LIMITS.MAX_CONTINUOUS_HOURS, actual: round1(longest.hours), unit: "hours" },
    });
  }

  // --- Rule 3: minimum rest between work periods ----------------------------
  if (proposedCase) {
    const proposedStart = new Date(proposedCase.scheduled_at);
    const priorEnd = intervals
      .filter((i) => !i.proposed && i.end <= proposedStart)
      .reduce((latest, i) => (latest === null || i.end > latest ? i.end : latest), null);

    if (priorEnd) {
      const restHours = (proposedStart - priorEnd) / HOUR_MS;
      const priorWasLongCall = intervals.some(
        (i) =>
          !i.proposed &&
          i.end.getTime() === priorEnd.getTime() &&
          (i.end - i.start) / HOUR_MS >= ACGME_LIMITS.MAX_CONTINUOUS_HOURS,
      );
      const required = priorWasLongCall
        ? ACGME_LIMITS.MIN_REST_AFTER_24H_CALL
        : ACGME_LIMITS.MIN_REST_HOURS;

      if (restHours < required) {
        findings.push(
          finding(
            regulatory,
            "min_rest_between_shifts",
            `Only ${round1(restHours)}h free before this assignment; ${required}h required${priorWasLongCall ? " following 24h call" : ""}`,
            { limit: required, actual: round1(restHours), unit: "hours" },
          ),
        );
      }
    }
  }

  // --- Rule 4: one day in seven free ----------------------------------------
  const freeDays = countFreeDays(intervals, at, 28);
  if (freeDays < ACGME_LIMITS.FREE_DAYS_PER_28) {
    findings.push(
      finding(
        regulatory,
        "one_day_in_seven_free",
        `Only ${freeDays} duty-free day(s) in the last 28; ${ACGME_LIMITS.FREE_DAYS_PER_28} required`,
        { limit: ACGME_LIMITS.FREE_DAYS_PER_28, actual: freeDays, unit: "days/28" },
      ),
    );
  }

  // --- Rule 5: in-house call frequency --------------------------------------
  const nights = intervals
    .filter((i) => i.is_night && i.start <= windowEnd && i.start >= windowStart)
    .map((i) => i.start)
    .sort((a, b) => a - b);

  for (let i = 1; i < nights.length; i += 1) {
    const gapNights = (nights[i] - nights[i - 1]) / DAY_MS;
    if (gapNights < ACGME_LIMITS.MIN_NIGHTS_BETWEEN_CALL - 0.5) {
      findings.push(
        finding(
          regulatory,
          "call_frequency",
          `In-house call scheduled more often than every ${ACGME_LIMITS.MIN_NIGHTS_BETWEEN_CALL}rd night (${round1(gapNights)} night gap)`,
          {
            limit: ACGME_LIMITS.MIN_NIGHTS_BETWEEN_CALL,
            actual: round1(gapNights),
            unit: "nights between call",
          },
        ),
      );
      break; // one finding per rule is enough for the UI
    }
  }

  const violations = findings.filter((f) => f.severity === "violation");

  return {
    compliant: violations.length === 0,
    regulatory,
    applies_to: regulatory ? "ACGME resident/fellow duty-hour requirements" : "institutional fatigue policy (advisory)",
    findings,
    violation_count: violations.length,
    warning_count: findings.length - violations.length,
    summary: summarize(findings, regulatory),
    metrics: {
      averaged_weekly_hours: round1(avgWeekly),
      longest_continuous_hours: round1(longest.hours),
      free_days_in_28: freeDays,
      night_shifts_in_window: nights.length,
    },
    disclaimer: regulatory
      ? "ACGME limits apply to accredited residents and fellows. This is an automated pre-check, not a substitute for the program's official duty-hour reporting."
      : "ACGME duty-hour limits do not apply to attending surgeons. These findings are advisory guardrails set by the department, not regulatory requirements.",
  };
}

/**
 * Convenience wrapper used by the assignment engine: is this surgeon eligible
 * to take this case at all?
 */
export function isAssignmentPermitted({ surgeon, shifts, cases, proposedCase, at }) {
  const result = checkDutyHours({ surgeon, shifts, cases, proposedCase, at });
  return {
    permitted: result.compliant,
    // For attendings nothing is a hard block, but we still surface the reasons.
    blocking: result.findings.filter((f) => f.severity === "violation"),
    advisory: result.findings.filter((f) => f.severity !== "violation"),
    check: result,
  };
}

// --- helpers ----------------------------------------------------------------

function finding(regulatory, rule, message, detail) {
  return {
    rule,
    // The same arithmetic, a different consequence, depending on who it's about.
    severity: regulatory ? "violation" : "advisory",
    message,
    detail,
  };
}

function toIntervals(shifts, cases) {
  const out = [];
  for (const s of shifts) {
    const start = new Date(s.start_time);
    const end = new Date(s.end_time);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start) {
      out.push({ start, end, is_night: Boolean(s.is_night) });
    }
  }
  for (const c of cases) {
    const start = new Date(c.scheduled_at);
    if (Number.isNaN(start.getTime())) continue;
    const end = new Date(start.getTime() + (Number(c.duration_hrs) || 2) * HOUR_MS);
    out.push({ start, end, is_night: isNightInterval(start, end) });
  }
  return out;
}

function isNightInterval(start, end) {
  // Counts as a night if any part falls between 22:00 and 06:00.
  const h1 = start.getHours();
  const h2 = end.getHours();
  const spansMidnight = end.getDate() !== start.getDate();
  return h1 >= 22 || h1 < 6 || h2 >= 22 || h2 < 6 || spansMidnight;
}

function overlapHours(interval, from, to) {
  const start = Math.max(interval.start.getTime(), from.getTime());
  const end = Math.min(interval.end.getTime(), to.getTime());
  return end > start ? (end - start) / HOUR_MS : 0;
}

/**
 * Longest run of work with no gap >= MIN_REST_HOURS. Short gaps between a
 * shift and a case do not reset the continuous-duty clock.
 */
function longestContinuousBlock(intervals) {
  if (intervals.length === 0) return { hours: 0, range: null };

  let best = { hours: 0, range: null };
  let blockStart = intervals[0].start;
  let blockEnd = intervals[0].end;

  const close = () => {
    const hours = (blockEnd - blockStart) / HOUR_MS;
    if (hours > best.hours) {
      best = {
        hours,
        range: { start: blockStart.toISOString(), end: blockEnd.toISOString() },
      };
    }
  };

  for (let i = 1; i < intervals.length; i += 1) {
    const gap = (intervals[i].start - blockEnd) / HOUR_MS;
    if (gap < ACGME_LIMITS.MIN_REST_HOURS) {
      if (intervals[i].end > blockEnd) blockEnd = intervals[i].end;
    } else {
      close();
      blockStart = intervals[i].start;
      blockEnd = intervals[i].end;
    }
  }
  close();
  return best;
}

function countFreeDays(intervals, at, days) {
  let free = 0;
  for (let d = 0; d < days; d += 1) {
    const dayStart = new Date(at.getTime() - d * DAY_MS);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const worked = intervals.some((i) => i.start < dayEnd && i.end > dayStart);
    if (!worked) free += 1;
  }
  return free;
}

function summarize(findings, regulatory) {
  if (findings.length === 0) {
    return regulatory
      ? "No ACGME duty-hour issues detected for this assignment."
      : "No institutional duty-hour concerns detected for this assignment.";
  }
  const violations = findings.filter((f) => f.severity === "violation");
  if (violations.length > 0) {
    return `Blocked: ${violations.length} ACGME duty-hour violation(s) — ${violations[0].message}`;
  }
  return `${findings.length} advisory duty-hour concern(s) — ${findings[0].message}`;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
