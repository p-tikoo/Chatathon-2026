/**
 * FATIGUE ASSESSMENT SERVICE
 * ============================================================================
 * Orchestrates the full pipeline for one surgeon:
 *
 *   gather data -> score every case (3-layer complexity) -> deterministic
 *   fatigue model -> 48h forward projection -> optional LLM narrative
 *
 * PERFORMANCE NOTE THAT MATTERS FOR THE DEMO
 * ------------------------------------------
 * The director heatmap renders 12 surgeons at once. It runs DETERMINISTIC ONLY
 * — no LLM — because 12 sequential model calls would take 20+ seconds and burn
 * free-tier quota on every page refresh. The LLM narrative is generated for a
 * SINGLE surgeon on demand, which is also the only place the prose is actually
 * read.
 *
 * That is not a compromise, it's the right architecture: the expensive,
 * non-deterministic component runs where a human is about to read its output,
 * and the cheap deterministic one runs everywhere else.
 * ============================================================================
 */

import { FATIGUE_CACHE_TTL_SECONDS } from "./config.js";
import { cognitiveLoad } from "./cognitive.js";
import { scoreCase } from "./complexity.js";
import { computeFatigue, projectAlertness } from "./fatigue.js";
import { tryGenerateJSON } from "./llm.js";
import {
  FATIGUE_SCHEMA,
  FATIGUE_SYSTEM,
  buildFatigueUserPrompt,
  validateFatigueOutput,
} from "./prompts.js";
import { checkDutyHours } from "./acgme.js";

const DAY = 86400000;

/**
 * Attach a personalized fatigue_load to each case using this surgeon's own
 * exertion history. This is layer 2 of the complexity model doing real work.
 */
export function enrichCases(cases, { surgeonId } = {}) {
  const rated = cases
    .filter((c) => c.surgeon_id === surgeonId && Number.isFinite(Number(c.perceived_exertion)))
    .map((c) => ({
      cpt: c.cpt,
      specialty: c.specialty,
      perceived_exertion: Number(c.perceived_exertion),
      objective_score: Number(c.complexity_score) || 50,
    }));

  return cases.map((c) => {
    const scored = scoreCase(
      {
        cpt: c.cpt,
        procedure_name: c.procedure_name,
        rvu: c.rvu,
        duration_hrs: c.duration_hrs,
        is_emergent: c.is_emergent,
        specialty: c.specialty,
      },
      { ratedCases: rated },
    );

    // The second demand axis: how mind-burning this case is, distinct from how
    // physically depleting it is. See lib/cognitive.js for why these are
    // separate models rather than one number.
    const cognitive = cognitiveLoad(c);

    return {
      ...c,
      complexity_score: scored.personalized_score,
      complexity_tier: scored.personalized_tier,
      objective_complexity_score: scored.objective_score,
      fatigue_load: scored.fatigue_load,
      calibration: scored.calibration,
      cognitive_load: cognitive.cognitive_load,
      mind_burn: cognitive.mind_burn,
      cognitive_dimensions: cognitive.dimensions,
      dominant_dimensions: cognitive.dominant_dimensions,
      cognitive_recovery_hours: cognitive.cognitive_recovery_hours,
    };
  });
}

/**
 * Gather every input the models need for one surgeon, in one place.
 * Looks 7 days back (for sleep debt and duty hours) and 3 days forward.
 */
export async function gatherContext(store, surgeonId, { at = new Date() } = {}) {
  const surgeon = await store.surgeons.get(surgeonId);
  if (!surgeon) return null;

  const from = new Date(at.getTime() - 7 * DAY);
  const to = new Date(at.getTime() + 3 * DAY);

  const [sleepLogs, shifts, rawCases, events] = await Promise.all([
    store.sleepLogs.listForSurgeon(surgeonId, { days: 7 }),
    store.shifts.list({ surgeonId, from, to }),
    store.cases.list({ surgeonId, from, to }),
    store.events.list({ surgeonId, from, to }),
  ]);

  const cases = enrichCases(rawCases, { surgeonId: Number(surgeonId) });

  return { surgeon, sleepLogs, shifts, cases, events, at };
}

/**
 * Full assessment for one surgeon.
 *
 * @param {Object} store
 * @param {number} surgeonId
 * @param {Object} [opts]
 * @param {boolean} [opts.useLLM]        Generate the narrative (default false)
 * @param {number}  [opts.horizonHours]  Projection horizon (default 48)
 * @param {Date}    [opts.at]
 */
export async function assessSurgeon(store, surgeonId, opts = {}) {
  const { useLLM = false, horizonHours = 48, at = new Date() } = opts;

  const ctx = await gatherContext(store, surgeonId, { at });
  if (!ctx) return null;

  const { surgeon, sleepLogs, shifts, cases, events } = ctx;

  // --- 1. Deterministic score (authoritative) ------------------------------
  const deterministic = computeFatigue({ surgeon, sleepLogs, cases, shifts, at });

  // --- 2. Forward projection ------------------------------------------------
  const projection = projectAlertness({
    surgeon,
    sleepLogs,
    cases,
    shifts,
    events,
    from: at,
    hours: horizonHours,
  });

  // --- 3. Duty-hour position -----------------------------------------------
  const dutyHours = checkDutyHours({ surgeon, shifts, cases, at });

  const upcoming = cases
    .filter((c) => new Date(c.scheduled_at) >= at)
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));

  const assessment = {
    surgeon_id: surgeon.id,
    score: deterministic.score,
    tier: deterministic.tier,
    reasoning: deterministic.reasoning,
    drivers: deterministic.drivers,
    components: deterministic.components,
    confidence: deterministic.confidence,
    inputs: deterministic.inputs,
    model_version: deterministic.model_version,
    method: "deterministic",
    projection,
    duty_hours: dutyHours,
    upcoming_cases: upcoming.length,
    updated_at: new Date().toISOString(),
  };

  // --- 4. Optional LLM narrative -------------------------------------------
  if (!useLLM) return assessment;

  const llm = await tryGenerateJSON({
    system: FATIGUE_SYSTEM,
    user: buildFatigueUserPrompt({
      deterministic,
      // De-identified: alias instead of name, no email, no contact details.
      surgeon: {
        alias: `S${surgeon.id}`,
        specialty: surgeon.specialty,
        role: surgeon.role,
        on_call: surgeon.on_call,
      },
      upcomingCases: upcoming.slice(0, 8),
      projection,
    }),
    schema: FATIGUE_SCHEMA,
    maxTokens: 900,
  });

  if (!llm.ok) {
    // The whole point of the fallback: the caller still gets a complete,
    // usable assessment, and we are honest in the payload about what happened.
    return {
      ...assessment,
      method: "deterministic-fallback",
      llm_status: { ok: false, code: llm.code, message: llm.error },
    };
  }

  const validated = validateFatigueOutput(llm.data, deterministic);

  return {
    ...assessment,
    score: validated.score,
    tier: tierFromScore(validated.score),
    reasoning: validated.reasoning,
    method: "llm-assisted",
    llm_status: {
      ok: true,
      provider: llm.provider,
      model: llm.model,
      latency_ms: llm.latency_ms,
      attempts: llm.attempts,
    },
    llm_narrative: {
      risk_window: validated.risk_window,
      recommended_action: validated.recommended_action,
      key_drivers: validated.key_drivers,
      // Full transparency about what the model was allowed to change and by
      // how much. This is what makes the score auditable.
      score_adjustment: validated.score_adjustment,
      adjustment_rationale: validated.adjustment_rationale,
      deterministic_score: validated.deterministic_score,
    },
  };
}

/**
 * Assess every surgeon for the director heatmap. Deterministic only — see the
 * performance note at the top of this file.
 */
export async function assessRoster(store, { at = new Date(), horizonHours = 48 } = {}) {
  const surgeons = await store.surgeons.list();

  // Sequential rather than Promise.all: with Supabase this is several queries
  // per surgeon, and 12 surgeons x 4 queries fired at once trips the free-tier
  // connection limit. Deterministic scoring is fast enough that this is not
  // the bottleneck.
  const results = [];
  for (const s of surgeons) {
    const assessment = await assessSurgeon(store, s.id, { useLLM: false, horizonHours, at });
    if (assessment) results.push({ surgeon: s, assessment });
  }
  return results;
}

function tierFromScore(score) {
  if (score >= 70) return "green";
  if (score >= 45) return "amber";
  return "red";
}

/** Is a stored score still fresh enough to reuse? */
export function isFresh(row, ttlSeconds = FATIGUE_CACHE_TTL_SECONDS) {
  if (!row?.created_at) return false;
  return Date.now() - new Date(row.created_at).getTime() < ttlSeconds * 1000;
}
