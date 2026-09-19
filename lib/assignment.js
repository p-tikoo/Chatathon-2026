/**
 * ASSIGNMENT RECOMMENDATION ENGINE  —  "the money feature"
 * ============================================================================
 * Given an incoming case, work out who should take it and why.
 *
 * THE PIPELINE, AND WHY EACH GATE IS BEFORE THE LLM
 * -------------------------------------------------
 *   1. COMPETENCY FILTER   — wrong specialty, excluded. Non-negotiable and not
 *                            something an LLM should be reasoning about.
 *   2. AVAILABILITY FILTER — already in an OR at that time, excluded.
 *   3. DUTY-HOUR GATE      — would breach ACGME limits, excluded (residents) or
 *                            flagged (attendings). See lib/acgme.js.
 *   4. DETERMINISTIC RANK  — recovery margin, competency fit, workload equity.
 *                            Always produces an answer.
 *   5. LLM RE-RANK         — the model sees ONLY candidates that survived 1-3,
 *                            ranks them, and writes the justification a human
 *                            will actually read.
 *   6. HUMAN APPROVAL      — the suggestion is persisted as `pending`. Nothing
 *                            is reassigned until a person approves it.
 *
 * The ordering is the design. By the time the LLM is involved, every option in
 * front of it is already safe, legal, and clinically appropriate — so the worst
 * case if the model reasons badly is a suboptimal choice among valid options,
 * never an unsafe one. And if the model hallucinates a surgeon who isn't on the
 * list, `validateAssignmentOutput` catches it and we fall back to the
 * deterministic ranking.
 *
 * ADVISORY, ALWAYS. There is deliberately no code path in this file that
 * mutates a case's surgeon_id. Reassignment happens only in the approval route,
 * only on an explicit human decision, and it is written to the audit log.
 * ============================================================================
 */

import { assessSurgeon } from "./assessment.js";
import { isAssignmentPermitted } from "./acgme.js";
import { objectiveComplexity } from "./complexity.js";
import { tryGenerateJSON } from "./llm.js";
import {
  ASSIGNMENT_SCHEMA,
  ASSIGNMENT_SYSTEM,
  buildAssignmentUserPrompt,
  validateAssignmentOutput,
} from "./prompts.js";

const HOUR = 3600000;
const DAY = 86400000;

/**
 * Cross-cover map: which specialties can safely take another's cases.
 * Conservative on purpose — a rested surgeon in the wrong specialty is not a
 * solution, and "the AI moved a valve case to a general surgeon" is exactly the
 * headline this product cannot afford.
 */
const CROSS_COVER = {
  "Trauma Surgery": ["General Surgery"],
  "General Surgery": ["Trauma Surgery", "Surgical Oncology"],
  "Surgical Oncology": ["General Surgery"],
  "Cardiothoracic Surgery": [],
  Neurosurgery: [],
  "Orthopaedic Surgery": [],
  "Vascular Surgery": [],
  Urology: [],
  Obstetrics: [],
};

/** Competency fit score, 0-100. Returns null when the surgeon cannot take it. */
function competencyFit(surgeon, requiredSpecialty, procedureName) {
  if (!requiredSpecialty) return 70; // unspecified — everyone is a weak fit
  if (surgeon.specialty === requiredSpecialty) {
    // Subspecialty keyword overlap with the procedure name is a bonus.
    const subs = surgeon.subspecialties ?? [];
    const name = String(procedureName ?? "").toLowerCase();
    const hit = subs.some((sub) =>
      String(sub)
        .toLowerCase()
        .split(/[\s/-]+/)
        .filter((t) => t.length > 4)
        .some((t) => name.includes(t)),
    );
    return hit ? 100 : 88;
  }
  const canCover = (CROSS_COVER[requiredSpecialty] ?? []).includes(surgeon.specialty);
  return canCover ? 58 : null;
}

/** Does this surgeon already have something booked over the case window? */
function findConflicts({ cases, shifts, events }, start, end, excludeCaseId = null) {
  const conflicts = [];
  const overlaps = (s, e) => new Date(s) < end && new Date(e) > start;

  for (const c of cases) {
    if (excludeCaseId !== null && c.id === excludeCaseId) continue;
    const cStart = new Date(c.scheduled_at);
    const cEnd = new Date(cStart.getTime() + (Number(c.duration_hrs) || 2) * HOUR);
    if (overlaps(cStart, cEnd)) {
      conflicts.push({ type: "case", id: c.id, label: c.procedure_name, start: c.scheduled_at });
    }
  }
  for (const e of events) {
    if (!overlaps(e.start_time, e.end_time)) continue;
    conflicts.push({
      type: "event",
      id: e.id,
      // Never leak a private event's title into a conflict message shown to a
      // scheduler — the block is visible, the reason is not.
      label: e.visibility === "private" ? "Unavailable (private)" : e.title,
      start: e.start_time,
    });
  }
  return conflicts;
}

/**
 * Build the candidate list for a case: everyone who is competent, available,
 * and duty-hour clear, each with a deterministic suitability score.
 */
export async function buildCandidates(store, caseSpec, { at = new Date(), excludeSurgeonId = null } = {}) {
  const start = new Date(caseSpec.scheduled_at);
  const end = new Date(start.getTime() + (Number(caseSpec.duration_hrs) || 2) * HOUR);

  const surgeons = await store.surgeons.list();
  const candidates = [];
  const blocked = [];

  for (const surgeon of surgeons) {
    const alias = `S${surgeon.id}`;

    if (excludeSurgeonId !== null && surgeon.id === Number(excludeSurgeonId)) {
      blocked.push({ alias, surgeon_id: surgeon.id, reason: "Currently assigned to this case" });
      continue;
    }
    if (surgeon.opted_in === false) {
      blocked.push({ alias, surgeon_id: surgeon.id, reason: "Has not opted in to fatigue-aware scheduling" });
      continue;
    }

    // --- Gate 1: competency -------------------------------------------------
    const fit = competencyFit(surgeon, caseSpec.specialty, caseSpec.procedure_name);
    if (fit === null) {
      blocked.push({
        alias,
        surgeon_id: surgeon.id,
        reason: `Specialty mismatch (${surgeon.specialty}, case requires ${caseSpec.specialty})`,
      });
      continue;
    }

    const assessment = await assessSurgeon(store, surgeon.id, { useLLM: false, at });
    if (!assessment) continue;

    const [cases, shifts, events] = await Promise.all([
      store.cases.list({
        surgeonId: surgeon.id,
        from: new Date(at.getTime() - 7 * DAY),
        to: new Date(at.getTime() + 7 * DAY),
      }),
      store.shifts.list({
        surgeonId: surgeon.id,
        from: new Date(at.getTime() - 28 * DAY),
        to: new Date(at.getTime() + 7 * DAY),
      }),
      store.events.list({ surgeonId: surgeon.id, from: start, to: end }),
    ]);

    // --- Gate 2: availability ----------------------------------------------
    const conflicts = findConflicts({ cases, shifts, events }, start, end, caseSpec.id ?? null);
    if (conflicts.length > 0) {
      blocked.push({
        alias,
        surgeon_id: surgeon.id,
        reason: `Schedule conflict: ${conflicts[0].label}`,
        conflicts,
      });
      continue;
    }

    // --- Gate 3: duty hours -------------------------------------------------
    const duty = isAssignmentPermitted({
      surgeon,
      shifts,
      cases,
      proposedCase: { scheduled_at: caseSpec.scheduled_at, duration_hrs: caseSpec.duration_hrs },
      at,
    });
    if (!duty.permitted) {
      blocked.push({
        alias,
        surgeon_id: surgeon.id,
        reason: `Duty-hour violation: ${duty.blocking[0]?.message ?? "limit exceeded"}`,
        duty_check: duty.check,
      });
      continue;
    }

    const load7d = assessment.inputs.fatigue_load_7d;
    const load24 = assessment.inputs.fatigue_load_24h;

    candidates.push({
      alias,
      surgeon_id: surgeon.id,
      specialty: surgeon.specialty,
      subspecialties: surgeon.subspecialties ?? [],
      role: surgeon.role,
      on_call: Boolean(surgeon.on_call),
      fatigue_score: assessment.score,
      fatigue_tier: assessment.tier,
      consecutive_nights: assessment.inputs.consecutive_nights,
      load_24h: load24,
      load_7d: load7d,
      competency_fit: fit,
      duty_advisories: duty.advisory,
      // Projected alertness during the case itself, not right now. A surgeon
      // who is green at 09:00 may not be green for a 22:00 start, and the
      // whole premise of the product is scheduling on the forward view.
      projected_score_at_case: projectedScoreAt(assessment.projection, start),
    });
  }

  // --- Deterministic ranking -------------------------------------------------
  const maxLoad = Math.max(1, ...candidates.map((c) => c.load_7d));
  for (const c of candidates) {
    const recovery = c.projected_score_at_case ?? c.fatigue_score;
    const equity = 100 * (1 - c.load_7d / maxLoad);

    c.suitability = round1(0.5 * recovery + 0.3 * c.competency_fit + 0.2 * equity);

    // Hard safety rule, applied after scoring so it is visible rather than
    // buried: a red-tier surgeon is heavily penalized for a complex case.
    if (c.fatigue_tier === "red" && ["complex", "critical"].includes(caseSpec.complexity_tier)) {
      c.suitability = round1(c.suitability * 0.55);
      c.safety_flag = "Red-tier surgeon on a high-complexity case — strongly discouraged";
    }
  }
  candidates.sort((a, b) => b.suitability - a.suitability);

  return { candidates, blocked };
}

function projectedScoreAt(projection, when) {
  if (!projection?.series?.length) return null;
  const target = when.getTime();
  let best = null;
  for (const p of projection.series) {
    const diff = Math.abs(new Date(p.t).getTime() - target);
    if (best === null || diff < best.diff) best = { diff, score: p.score };
  }
  // Only trust the projection if we have a point within ~90 minutes.
  return best && best.diff <= 1.5 * HOUR ? best.score : null;
}

/**
 * Produce a full recommendation for a case.
 *
 * @returns {Object} recommendation with candidates, blocked list, ACGME check,
 *                   justification, and the LLM's status. Never mutates a case.
 */
export async function recommendAssignment(store, caseSpec, { at = new Date(), useLLM = true } = {}) {
  // Normalize the case so complexity is always populated, even for a free-text
  // case that has never been through the classifier.
  const complexity = objectiveComplexity({
    cpt: caseSpec.cpt,
    procedure_name: caseSpec.procedure_name,
    rvu: caseSpec.rvu,
    duration_hrs: caseSpec.duration_hrs,
    is_emergent: caseSpec.is_emergent,
  });

  const normalized = {
    ...caseSpec,
    rvu: caseSpec.rvu ?? complexity.rvu,
    duration_hrs: caseSpec.duration_hrs ?? complexity.duration_hrs,
    specialty: caseSpec.specialty ?? complexity.matched_procedure?.specialty ?? null,
    complexity_score: complexity.score,
    complexity_tier: complexity.tier,
  };

  const { candidates, blocked } = await buildCandidates(store, normalized, {
    at,
    excludeSurgeonId: caseSpec.surgeon_id ?? null,
  });

  const deterministicPick = candidates[0] ?? null;

  const base = {
    case: normalized,
    candidates,
    blocked,
    deterministic_recommendation: deterministicPick
      ? {
          surgeon_id: deterministicPick.surgeon_id,
          alias: deterministicPick.alias,
          suitability: deterministicPick.suitability,
          rationale: describeDeterministic(deterministicPick, candidates),
        }
      : null,
    all_candidates_red:
      candidates.length > 0 && candidates.every((c) => c.fatigue_tier === "red"),
    generated_at: new Date().toISOString(),
  };

  if (candidates.length === 0) {
    return {
      ...base,
      recommendation: null,
      method: "no-eligible-candidates",
      justification:
        "No surgeon is simultaneously competency-matched, available, and duty-hour compliant for this case. Escalate to the department lead: options are the backup rota, delaying an elective case, or a transfer.",
      requires_human_approval: true,
    };
  }

  if (!useLLM) {
    return {
      ...base,
      recommendation: base.deterministic_recommendation,
      method: "deterministic",
      justification: base.deterministic_recommendation.rationale,
      requires_human_approval: true,
    };
  }

  // --- LLM re-rank + justification -----------------------------------------
  const llm = await tryGenerateJSON({
    system: ASSIGNMENT_SYSTEM,
    user: buildAssignmentUserPrompt({
      incomingCase: normalized,
      candidates,
      blocked: blocked.map((b) => ({ alias: b.alias, reason: b.reason })),
    }),
    schema: ASSIGNMENT_SCHEMA,
    maxTokens: 900,
  });

  if (!llm.ok) {
    return {
      ...base,
      recommendation: base.deterministic_recommendation,
      method: "deterministic-fallback",
      justification: base.deterministic_recommendation.rationale,
      llm_status: { ok: false, code: llm.code, message: llm.error },
      requires_human_approval: true,
    };
  }

  const aliases = candidates.map((c) => c.alias);
  const validated = validateAssignmentOutput(llm.data, aliases);

  // The model named someone who wasn't on the list. Do not surface it.
  if (validated.hallucinated || validated.recommended_alias === null) {
    return {
      ...base,
      recommendation: base.deterministic_recommendation,
      method: "deterministic-fallback",
      justification: base.deterministic_recommendation.rationale,
      llm_status: {
        ok: false,
        code: "invalid_candidate",
        message: "The model recommended a surgeon outside the eligible candidate list; discarded.",
      },
      requires_human_approval: true,
    };
  }

  if (validated.recommended_alias === "NONE") {
    return {
      ...base,
      recommendation: null,
      method: "llm-declined",
      justification: validated.justification,
      risks: validated.risks,
      llm_status: { ok: true, provider: llm.provider, model: llm.model, latency_ms: llm.latency_ms },
      requires_human_approval: true,
    };
  }

  const picked = candidates.find((c) => c.alias === validated.recommended_alias);
  const runnerUp = candidates.find((c) => c.alias === validated.runner_up_alias) ?? null;

  return {
    ...base,
    recommendation: {
      surgeon_id: picked.surgeon_id,
      alias: picked.alias,
      suitability: picked.suitability,
      rationale: validated.justification,
    },
    runner_up: runnerUp
      ? { surgeon_id: runnerUp.surgeon_id, alias: runnerUp.alias, reason: validated.runner_up_reason }
      : null,
    method: "llm-assisted",
    justification: validated.justification,
    risks: validated.risks,
    confidence: validated.confidence,
    // Surfaced so a reviewer can see when the model disagreed with the
    // arithmetic. Disagreement isn't wrong, but it should be visible.
    agrees_with_deterministic: picked.surgeon_id === deterministicPick?.surgeon_id,
    llm_status: {
      ok: true,
      provider: llm.provider,
      model: llm.model,
      latency_ms: llm.latency_ms,
      attempts: llm.attempts,
    },
    requires_human_approval: true,
  };
}

function describeDeterministic(pick, all) {
  const parts = [
    `${pick.alias} scores ${pick.suitability}/100 on suitability`,
    `alertness ${pick.projected_score_at_case ?? pick.fatigue_score}/100 (${pick.fatigue_tier}) at the scheduled time`,
    `competency fit ${pick.competency_fit}/100`,
    `${pick.load_7d} RVU-weighted depleting hours over the last 7 days`,
  ];
  const next = all[1];
  const comparison = next
    ? ` Next best is ${next.alias} at ${next.suitability}/100 (${next.fatigue_tier}).`
    : " No alternative candidate is available.";
  return `${parts.join("; ")}.${comparison}`;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
