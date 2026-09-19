/**
 * COGNITIVE LOAD MODEL  —  the "mind-burn" axis
 * ============================================================================
 * WHY THIS IS A SEPARATE FILE FROM complexity.js AND fatigue.js
 * ------------------------------------------------------------
 * Three different questions, three different models, and conflating them is
 * the mistake that makes scheduling tools useless:
 *
 *   complexity.js  HOW HARD IS THIS CASE?        (RVU-anchored, objective)
 *   fatigue.js     HOW RECOVERED IS THIS PERSON? (sleep/circadian, objective)
 *   cognitive.js   HOW MUCH WILL THIS CASE BURN? (task demand, this file)
 *
 * A seven-hour routine hip revision and a ninety-minute redo aneurysm clipping
 * are nowhere near each other on this axis, even though duration says the hip
 * is "bigger" and the RVU gap understates the difference. One is physically
 * grinding; the other is ninety minutes of sustained, unrecoverable-error,
 * high-consequence decision-making. They deplete a surgeon in different ways,
 * over different timescales, and they should not be scheduled the same way.
 *
 * That distinction is the thing existing duty-hour systems cannot see at all,
 * because an hour is an hour to them.
 *
 * THE SCIENTIFIC ANCHOR: SURG-TLX
 * -------------------------------
 * The six dimensions below are those of SURG-TLX, a validated surgery-specific
 * adaptation of the NASA Task Load Index, which is the standard instrument for
 * measuring operative workload:
 *
 *     1. Mental demands        4. Task complexity
 *     2. Physical demands      5. Situational stress
 *     3. Temporal demands      6. Distractions
 *
 * SURG-TLX is normally administered as a post-operative questionnaire — you ask
 * the surgeon afterwards. That is useless for scheduling, which needs the
 * number BEFOREHAND.
 *
 * So this module ESTIMATES the six dimensions ex ante from data that exists
 * before the case starts: the CPT code and its work RVU, expected duration,
 * elective vs. emergent status, free-text modifiers (redo, trauma, pediatric),
 * and the specialty's characteristic demand profile. The LLM refines the
 * estimate for procedures the catalog doesn't know.
 *
 * ⚠️  HONEST LIMITATION: SURG-TLX itself is validated. THIS EX-ANTE ESTIMATION
 *     OF IT IS NOT. The dimension weights and specialty profiles below are
 *     reasoned approximations, not fitted to measured SURG-TLX scores. The
 *     defensible claim is "structured on a validated instrument"; the claim
 *     "validated" would be false. The honest version is more persuasive anyway,
 *     and the fix is a real one: collect post-case SURG-TLX ratings and fit
 *     these weights to them. The one-tap exertion rating is the first step.
 * ============================================================================
 */

import { objectiveComplexity } from "./complexity.js";

/**
 * Per-specialty demand characteristics, 0-100.
 *
 *   cognitive   sustained attention, decision density, working-memory load
 *   physical    standing time, static posture, force, ergonomic strain
 *   precision   tolerance for error — how small a mistake ends the case badly
 *   consequence severity of a bad outcome, which drives situational stress
 *   volatility  how often the plan changes intraoperatively
 */
const SPECIALTY_PROFILE = {
  Neurosurgery: { cognitive: 95, physical: 70, precision: 98, consequence: 98, volatility: 72 },
  "Cardiothoracic Surgery": { cognitive: 92, physical: 75, precision: 90, consequence: 96, volatility: 70 },
  "Trauma Surgery": { cognitive: 88, physical: 85, precision: 70, consequence: 92, volatility: 98 },
  "Vascular Surgery": { cognitive: 82, physical: 70, precision: 88, consequence: 88, volatility: 74 },
  Obstetrics: { cognitive: 76, physical: 70, precision: 70, consequence: 90, volatility: 88 },
  "Surgical Oncology": { cognitive: 78, physical: 65, precision: 82, consequence: 82, volatility: 66 },
  "General Surgery": { cognitive: 70, physical: 66, precision: 72, consequence: 72, volatility: 62 },
  Urology: { cognitive: 68, physical: 55, precision: 80, consequence: 66, volatility: 54 },
  "Orthopaedic Surgery": { cognitive: 64, physical: 90, precision: 74, consequence: 68, volatility: 56 },
};

const DEFAULT_PROFILE = { cognitive: 72, physical: 68, precision: 75, consequence: 75, volatility: 65 };

/**
 * Dimension weights for the composite. Mental demands and task complexity carry
 * the most weight because this score exists to answer "how mind-burning is
 * this", not "how tiring". Physical demand is deliberately down-weighted here —
 * it is already captured by `fatigue_load` in complexity.js, and double-counting
 * it would make every long case look cognitively brutal.
 */
const WEIGHTS = {
  mental_demands: 0.28,
  task_complexity: 0.24,
  situational_stress: 0.18,
  temporal_demands: 0.14,
  distractions: 0.09,
  physical_demands: 0.07,
};

export const MIND_BURN_TIERS = ["light", "moderate", "heavy", "extreme"];

/**
 * Estimate the six SURG-TLX dimensions and the composite cognitive load for a
 * single case, before it happens.
 *
 * @param {Object} caseInput  { cpt, procedure_name, rvu, duration_hrs, is_emergent, specialty, scheduled_at }
 * @returns {Object} dimensions, cognitive_load, mind_burn tier, recovery tail
 */
export function cognitiveLoad(caseInput = {}) {
  const complexity = objectiveComplexity(caseInput);
  const specialty =
    caseInput.specialty ?? complexity.matched_procedure?.specialty ?? null;
  const profile = SPECIALTY_PROFILE[specialty] ?? DEFAULT_PROFILE;

  const rvu = complexity.rvu;
  const duration = complexity.duration_hrs;
  const isEmergent = Boolean(caseInput.is_emergent);
  const modifierKeys = new Set(complexity.modifiers.map((m) => m.key));

  // Normalize RVU onto 0-100 across the catalog's realistic range (~8-65).
  const rvuNorm = clamp(((rvu - 8) / 57) * 100, 0, 100);

  // --- 1. MENTAL DEMANDS ---------------------------------------------------
  // Work RVU explicitly incorporates mental effort and judgment, so it is the
  // strongest single predictor available before the case. Specialty cognitive
  // intensity and redo status modulate it.
  let mental = 0.6 * rvuNorm + 0.4 * profile.cognitive;
  if (modifierKeys.has("redo")) mental += 12; // distorted anatomy, no landmarks
  if (modifierKeys.has("pediatric")) mental += 6; // smaller margins, weight-based dosing

  // --- 2. PHYSICAL DEMANDS -------------------------------------------------
  // Duration-dominated: static posture and standing time are the drivers.
  // Saturating rather than linear — hour eight is not twice hour four.
  const durationStrain = 100 * (1 - Math.exp(-duration / 3.5));
  let physical = 0.65 * durationStrain + 0.35 * profile.physical;
  if (modifierKeys.has("robotic")) physical -= 12; // seated console, less strain

  // --- 3. TEMPORAL DEMANDS -------------------------------------------------
  // Time pressure. Emergent cases have it by definition; elective ones mostly
  // don't. Overnight adds pressure from thin staffing.
  let temporal = isEmergent ? 82 : 28;
  if (modifierKeys.has("trauma")) temporal = Math.max(temporal, 92);
  if (caseInput.scheduled_at) {
    const hour = new Date(caseInput.scheduled_at).getHours();
    if (hour >= 22 || hour < 6) temporal += 10; // reduced overnight support
  }
  temporal += 0.15 * profile.volatility;

  // --- 4. TASK COMPLEXITY --------------------------------------------------
  // Straight from the RVU-anchored objective model — no need to re-derive it.
  const taskComplexity = complexity.score;

  // --- 5. SITUATIONAL STRESS -----------------------------------------------
  // Consequence severity plus error intolerance. This is the dimension that
  // separates "difficult" from "frightening".
  let stress = 0.55 * profile.consequence + 0.45 * profile.precision;
  if (isEmergent) stress += 10;
  if (modifierKeys.has("redo")) stress += 8;
  if (modifierKeys.has("trauma")) stress += 10;

  // --- 6. DISTRACTIONS -----------------------------------------------------
  // Interruptions, team churn, competing demands. Emergent and overnight work
  // scores highest; a planned elective list in a familiar room lowest.
  let distractions = isEmergent ? 70 : 34;
  distractions += 0.2 * profile.volatility;
  if (caseInput.scheduled_at) {
    const hour = new Date(caseInput.scheduled_at).getHours();
    if (hour >= 22 || hour < 6) distractions += 12;
  }

  const dimensions = {
    mental_demands: round1(clamp(mental, 0, 100)),
    physical_demands: round1(clamp(physical, 0, 100)),
    temporal_demands: round1(clamp(temporal, 0, 100)),
    task_complexity: round1(clamp(taskComplexity, 0, 100)),
    situational_stress: round1(clamp(stress, 0, 100)),
    distractions: round1(clamp(distractions, 0, 100)),
  };

  const cognitive = Object.entries(WEIGHTS).reduce(
    (sum, [dim, w]) => sum + dimensions[dim] * w,
    0,
  );

  // --- RECOVERY TAIL -------------------------------------------------------
  // Cognitive depletion outlasts the case. A heavy case leaves a surgeon
  // measurably degraded for hours afterwards, which is exactly why stacking two
  // extreme cases back-to-back is worse than the sum of its parts — and why the
  // organizer flags that pattern.
  const recoveryHours = round1(0.5 + (cognitive / 100) ** 2 * 5.5);

  return {
    cognitive_load: round1(cognitive),
    mind_burn: mindBurnTier(cognitive),
    dimensions,
    // Sorted so a UI can render "what makes this case hard" without re-ranking.
    dominant_dimensions: Object.entries(dimensions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([dim, value]) => ({ dimension: dim, value, label: DIMENSION_LABELS[dim] })),
    cognitive_recovery_hours: recoveryHours,
    specialty,
    instrument: "SURG-TLX (six-dimension), estimated ex ante — see lib/cognitive.js",
  };
}

const DIMENSION_LABELS = {
  mental_demands: "Mental demand — sustained attention and decision density",
  physical_demands: "Physical demand — standing time and postural strain",
  temporal_demands: "Time pressure",
  task_complexity: "Technical complexity",
  situational_stress: "Situational stress — consequence of error",
  distractions: "Distractions and interruptions",
};

export function mindBurnTier(load) {
  if (load < 40) return "light";
  if (load < 58) return "moderate";
  if (load < 75) return "heavy";
  return "extreme";
}

/**
 * PERSON-SPECIFIC COGNITIVE PROFILE
 * ---------------------------------
 * Two surgeons with identical recovery scores are not interchangeable. One is
 * worn down by long cases; another sails through a seven-hour list but is
 * flattened by a short, high-stakes, high-precision one. Scheduling them the
 * same way wastes both.
 *
 * This learns which it is, from the one-tap exertion ratings already being
 * collected. For each rated case we have the reported exertion, the duration,
 * and the estimated cognitive load. Comparing how exertion co-varies with each
 * tells us what actually costs this person.
 *
 * `cognitive_sensitivity` > 1 means cognitively demanding cases hit this
 * surgeon harder than the model expects. `duration_sensitivity` > 1 means long
 * cases do. Both are shrunk toward 1.0 by sample size and hard-clamped, for
 * the same reasons as personalCalibration in lib/complexity.js — two data
 * points must not produce a confident conclusion about a person.
 *
 * ⚠️  This is a SCHEDULING PREFERENCE SIGNAL, not an assessment of ability.
 *     A high cognitive sensitivity does not mean a surgeon is worse at complex
 *     cases — plenty of people find the work they are best at the most
 *     draining. It must never be exposed to leadership, used in evaluation, or
 *     used to steer work away from someone. It is self-only under the
 *     biometric hard rules in lib/privacy.js, and it exists to make the
 *     schedule fit the person, not to rank people.
 */
export function cognitiveProfile(ratedCases = []) {
  const PRIOR_STRENGTH = 4;

  const rows = ratedCases.filter(
    (c) =>
      Number.isFinite(Number(c.perceived_exertion)) &&
      Number.isFinite(Number(c.cognitive_load)) &&
      Number.isFinite(Number(c.duration_hrs)),
  );

  if (rows.length < 3) {
    return {
      cognitive_sensitivity: 1.0,
      duration_sensitivity: 1.0,
      dominant_cost: "unknown",
      sample_size: rows.length,
      note: "Not enough rated cases yet. At least 3 are needed before any personal pattern is inferred.",
    };
  }

  // Expected exertion from each axis independently, on the surgeon's 1-10 scale.
  const cogRatios = [];
  const durRatios = [];

  for (const c of rows) {
    const reported = Number(c.perceived_exertion);
    const expectedCog = clamp(1 + (Number(c.cognitive_load) / 100) * 9, 1, 10);
    // Duration expectation: a ~6h case is a 10 on physical grind alone.
    const expectedDur = clamp(1 + (Number(c.duration_hrs) / 6) * 9, 1, 10);
    cogRatios.push(reported / expectedCog);
    durRatios.push(reported / expectedDur);
  }

  const n = rows.length;
  const shrink = (ratios) => {
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    return clamp(1 + (mean - 1) * (n / (n + PRIOR_STRENGTH)), 0.7, 1.4);
  };

  const cognitive_sensitivity = round2(shrink(cogRatios));
  const duration_sensitivity = round2(shrink(durRatios));

  let dominant = "balanced";
  if (cognitive_sensitivity > duration_sensitivity * 1.12) dominant = "cognitive";
  else if (duration_sensitivity > cognitive_sensitivity * 1.12) dominant = "duration";

  return {
    cognitive_sensitivity,
    duration_sensitivity,
    dominant_cost: dominant,
    sample_size: n,
    note:
      dominant === "cognitive"
        ? "High-stakes, high-precision cases cost this surgeon more than their length suggests. Protect recovery around them rather than around long lists."
        : dominant === "duration"
          ? "Long cases cost this surgeon more than their complexity suggests. Watch total operative hours, not just case difficulty."
          : "This surgeon tracks close to the model on both axes.",
    disclaimer:
      "Scheduling-fit signal only. Not a measure of skill or capability, never shared with leadership, and never used in evaluation.",
  };
}

/**
 * DEMAND vs. CAPACITY MISMATCH  —  the number that makes the board sortable.
 *
 * Sorting a schedule by complexity tells you which cases are hard. Sorting by
 * fatigue tells you who is tired. Neither tells you where the PROBLEM is.
 *
 * The problem is where a high-demand case meets a low-capacity surgeon. This
 * multiplies the two into a single 0-100 risk number, so the director sorts one
 * column and the genuinely dangerous pairings float to the top — regardless of
 * whether the cause was the case, the person, or the interaction.
 *
 * @param {number} cognitiveLoadScore  case demand, 0-100
 * @param {number} alertnessScore      surgeon capacity at case time, 0-100
 * @param {Object} [opts]
 * @param {number} [opts.cognitiveSensitivity]  from cognitiveProfile()
 */
export function demandCapacityMismatch(cognitiveLoadScore, alertnessScore, opts = {}) {
  const sensitivity = clamp(Number(opts.cognitiveSensitivity) || 1, 0.7, 1.4);

  const demand = clamp(cognitiveLoadScore * sensitivity, 0, 100) / 100;
  const deficit = clamp(100 - alertnessScore, 0, 100) / 100;

  // Multiplicative, not additive. A brutal case assigned to a fully rested
  // surgeon is fine; an easy case on an exhausted one is survivable; the
  // product is what is actually dangerous, and an additive score would rank a
  // rested surgeon on a hard case as equally risky. It is not.
  const raw = demand * deficit;

  // sqrt spreads the low end, which is where most of the board sits — without
  // it almost everything compresses into 0-15 and the column stops being useful.
  const score = round1(Math.sqrt(raw) * 100);

  return {
    mismatch_score: score,
    risk_level: score >= 55 ? "high" : score >= 35 ? "elevated" : score >= 18 ? "watch" : "low",
    demand_component: round1(demand * 100),
    capacity_deficit: round1(deficit * 100),
    explanation:
      score >= 55
        ? "High-demand case assigned to a surgeon with reduced recovery margin. Review before the schedule locks."
        : score >= 35
          ? "Elevated mismatch between case demand and predicted alertness."
          : score >= 18
            ? "Minor mismatch. Worth a glance, not action."
            : "Case demand is well within this surgeon's predicted capacity.",
  };
}

// --- helpers ----------------------------------------------------------------
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
