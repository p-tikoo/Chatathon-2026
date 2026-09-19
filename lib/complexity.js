/**
 * CASE COMPLEXITY — THE THREE-LAYER MODEL
 * ============================================================================
 * The design problem: "how hard is this surgery" is the kind of question that
 * produces garbage if you just put a 1-10 slider in front of a surgeon. People
 * anchor differently, rate strategically, and rate inconsistently across days.
 *
 * The fix is to never ask that question directly. Instead:
 *
 *   LAYER 1 — OBJECTIVE BASE (lib/procedures.js)
 *     Derived from the CPT code's work RVU + expected duration + emergent
 *     status + free-text modifiers (redo, trauma, pediatric...). Zero
 *     subjectivity: these numbers already exist in the billing system.
 *
 *   LAYER 2 — PERSONAL CALIBRATION (this file)
 *     After a case, the surgeon taps a single 1-10 perceived exertion rating.
 *     We never use that rating as the difficulty. We use it to learn a
 *     PER-SURGEON MULTIPLIER on the objective base — the amount by which this
 *     specific surgeon runs harder or easier than the RVU predicts for this
 *     kind of work. That turns a noisy subjective input into a calibration
 *     signal, which is what it is actually good for.
 *
 *     Borrowed from sports science: this is Borg RPE (rating of perceived
 *     exertion) used the way training-load models use it — as a personal
 *     scaling factor on an objective external load, not as the load itself.
 *
 *   LAYER 3 — LLM FILL-IN (lib/llm.js + lib/prompts.js)
 *     When a case arrives as free text with no CPT code ("redo aortic valve
 *     replacement"), the LLM estimates the code, RVU, duration, and tier so
 *     layers 1 and 2 still have something to work with.
 *
 * Result: difficulty is objective by default, personalized over time, and
 * defensible when a scheduler asks "why did you say this case is hard?"
 * ============================================================================
 */

import { detectModifiers, findProcedureByName, getProcedureByCpt } from "./procedures.js";

/** Complexity tiers, in ascending order. */
export const COMPLEXITY_TIERS = ["routine", "moderate", "complex", "critical"];

// Calibration constants for normalizing raw load onto a 0-100 scale. Chosen so
// the catalog's easiest case (pacemaker, ~7.8 wRVU / 1h) lands near 5 and its
// hardest (aortic root replacement, ~65 wRVU / 7.5h) lands near 95.
const RAW_MIN = 8;
const RAW_MAX = 85;
const DURATION_WEIGHT = 2.5; // hours are weighted relative to one wRVU

/**
 * LAYER 1: objective complexity, 0-100, from structured data alone.
 *
 * @param {Object} input
 * @param {string} [input.cpt]             CPT code, if known
 * @param {string} [input.procedure_name]  Free text, used for lookup + modifiers
 * @param {number} [input.rvu]             Explicit override
 * @param {number} [input.duration_hrs]    Explicit override
 * @param {boolean} [input.is_emergent]
 */
export function objectiveComplexity(input = {}) {
  const resolved = resolveProcedure(input);

  const rvu = numberOr(input.rvu, resolved.procedure?.work_rvu, 12);
  const duration = numberOr(
    input.duration_hrs,
    resolved.procedure?.typical_duration_hrs,
    2,
  );

  // Raw operative load: RVU already encodes skill/stress; duration encodes
  // sustained-attention cost, which RVU under-weights for long routine cases.
  const raw = rvu + duration * DURATION_WEIGHT;
  let score = ((raw - RAW_MIN) / (RAW_MAX - RAW_MIN)) * 100;

  // Modifiers detected from the free-text name (redo, trauma, pediatric...).
  const modifiers = detectModifiers(input.procedure_name ?? "");
  let multiplier = modifiers.reduce((acc, m) => acc * m.multiplier, 1);

  // Emergent status is a structured field, so honour it even when the name
  // does not say "emergency" — but don't double-count if the text already did.
  if (input.is_emergent && !modifiers.some((m) => m.key === "emergent")) {
    multiplier *= 1.2;
    modifiers.push({ key: "emergent", label: "Emergent", multiplier: 1.2 });
  }

  score = clamp(score * multiplier, 0, 100);

  return {
    score: round1(score),
    tier: tierFor(score),
    rvu: round1(rvu),
    duration_hrs: round1(duration),
    modifiers,
    matched_procedure: resolved.procedure
      ? {
          cpt: resolved.procedure.cpt,
          name: resolved.procedure.name,
          specialty: resolved.procedure.specialty,
        }
      : null,
    match_method: resolved.method,
    match_confidence: resolved.confidence,
    // True when we had to guess at RVU/duration because nothing matched. The
    // route uses this to decide whether to escalate to the LLM classifier.
    needs_llm_classification: !resolved.procedure && input.rvu == null,
  };
}

function resolveProcedure(input) {
  const byCpt = getProcedureByCpt(input.cpt);
  if (byCpt) return { procedure: byCpt, method: "cpt", confidence: 1.0 };

  const byName = findProcedureByName(input.procedure_name);
  if (byName) return byName;

  return { procedure: null, method: "none", confidence: 0 };
}

/**
 * LAYER 2: personal calibration multiplier for one surgeon.
 *
 * Compares the exertion this surgeon actually reported against the exertion the
 * objective model predicted, over their rated history.
 *
 * Two statistical guards, both important:
 *   1. SHRINKAGE TOWARD 1.0 by sample size. With two rated cases you should not
 *      conclude a surgeon runs 30% hot. The multiplier is pulled toward neutral
 *      by n / (n + PRIOR_STRENGTH), so it only moves meaningfully once there is
 *      real history. This is standard empirical-Bayes shrinkage.
 *   2. HARD CLAMP to [0.75, 1.35]. Prevents one outlier day (a surgeon rating a
 *      hernia a 10 because their kid was up all night) from distorting the model.
 *
 * @param {Array} ratedCases  Past cases with a non-null perceived_exertion
 * @param {Object} target     { cpt, specialty } of the case being scored
 */
export function personalCalibration(ratedCases = [], target = {}) {
  const PRIOR_STRENGTH = 3;

  // Prefer same-CPT history, fall back to same-specialty, then to everything.
  const tiers = [
    { label: "same-procedure", rows: ratedCases.filter((c) => target.cpt && c.cpt === target.cpt) },
    {
      label: "same-specialty",
      rows: ratedCases.filter((c) => target.specialty && c.specialty === target.specialty),
    },
    { label: "all-cases", rows: ratedCases },
  ];

  const chosen = tiers.find((t) => t.rows.length >= 2) ?? { label: "insufficient-data", rows: [] };
  const rows = chosen.rows.filter(
    (c) => Number.isFinite(c.perceived_exertion) && Number.isFinite(c.objective_score),
  );

  if (rows.length === 0) {
    return {
      multiplier: 1.0,
      basis: "insufficient-data",
      sample_size: 0,
      note: "No rated cases yet — using the objective score unadjusted.",
    };
  }

  // Map objective 0-100 onto the 1-10 exertion scale the surgeon uses.
  const ratios = rows.map((c) => {
    const expected = clamp(1 + (c.objective_score / 100) * 9, 1, 10);
    return c.perceived_exertion / expected;
  });

  const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const n = rows.length;
  const shrunk = 1 + (meanRatio - 1) * (n / (n + PRIOR_STRENGTH));
  const multiplier = clamp(shrunk, 0.75, 1.35);

  return {
    multiplier: round2(multiplier),
    basis: chosen.label,
    sample_size: n,
    raw_ratio: round2(meanRatio),
    note:
      multiplier > 1.08
        ? "This surgeon consistently reports higher exertion than the RVU predicts for this work."
        : multiplier < 0.92
          ? "This surgeon consistently reports lower exertion than the RVU predicts for this work."
          : "This surgeon tracks close to the objective model.",
  };
}

/**
 * Full three-layer score for a single case, for one surgeon.
 *
 * `fatigue_load` is the number that feeds the fatigue model and it is
 * intentionally NOT the same as `complexity`. Complexity is how hard the case
 * is; fatigue load is how much it DEPLETES the person doing it. A seven-hour
 * routine case is more depleting than a one-hour critical one. Units are
 * roughly "equivalent depleting hours".
 */
export function scoreCase(caseInput, { ratedCases = [] } = {}) {
  const objective = objectiveComplexity(caseInput);
  const calibration = personalCalibration(ratedCases, {
    cpt: objective.matched_procedure?.cpt ?? caseInput.cpt,
    specialty: objective.matched_procedure?.specialty ?? caseInput.specialty,
  });

  const personalized = clamp(objective.score * calibration.multiplier, 0, 100);
  const fatigueLoad = (personalized / 100) * objective.duration_hrs;

  return {
    objective_score: objective.score,
    objective_tier: objective.tier,
    personalized_score: round1(personalized),
    personalized_tier: tierFor(personalized),
    fatigue_load: round2(fatigueLoad),
    rvu: objective.rvu,
    duration_hrs: objective.duration_hrs,
    modifiers: objective.modifiers,
    matched_procedure: objective.matched_procedure,
    match_method: objective.match_method,
    match_confidence: objective.match_confidence,
    needs_llm_classification: objective.needs_llm_classification,
    calibration,
  };
}

export function tierFor(score) {
  if (score < 30) return "routine";
  if (score < 55) return "moderate";
  if (score < 78) return "complex";
  return "critical";
}

// --- small numeric helpers --------------------------------------------------
function numberOr(...candidates) {
  for (const c of candidates) if (Number.isFinite(Number(c)) && c !== null && c !== "") return Number(c);
  return 0;
}
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
