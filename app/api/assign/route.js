/**
 * /api/assign  —  AI-suggested assignment (advisory, human-approved)
 *
 * GET  /api/assign?status=pending    List suggestions awaiting a decision.
 * POST /api/assign                   Generate a recommendation for a case.
 *
 * POST body — one of:
 *   { case_id: 12 }                            an existing case
 *   { procedure_name, scheduled_at, ... }      an incoming case not yet saved
 * Optional: { use_llm: false } to force deterministic ranking.
 *
 * ---------------------------------------------------------------------------
 * THIS ENDPOINT NEVER REASSIGNS ANYONE.
 * ---------------------------------------------------------------------------
 * It creates a suggestion with status "pending" and returns it. The case is
 * untouched. A human must call POST /api/assign/{id} with approve or override
 * before anything changes hands, and that decision is written to the audit log
 * with the approver's identity attached.
 *
 * That is not a limitation we ran out of time to remove — it is the product.
 * An autonomous system that moves surgeons between operating rooms based on a
 * fatigue estimate is not something anyone should deploy, and saying so out
 * loud is more persuasive than a demo of it working.
 *
 * Pipeline detail, including why the competency / availability / duty-hour
 * gates all run BEFORE the model sees anything: lib/assignment.js.
 */

import { recommendAssignment } from "@/lib/assignment.js";
import { ApiError, created, getViewer, handler, ok, readJson } from "@/lib/http.js";
import { getStore } from "@/lib/store.js";
import { asBool, asInt, asNumber, asString } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

export const GET = handler(async (request) => {
  const viewer = getViewer(request);
  const url = new URL(request.url);

  if (!["director", "admin"].includes(viewer.role)) {
    throw new ApiError(403, "Assignment suggestions are visible to schedulers only.");
  }

  const store = await getStore();
  const status = url.searchParams.get("status");
  const suggestions = await store.suggestions.list({ status: status ?? null });

  return ok({
    suggestions,
    count: suggestions.length,
    pending: suggestions.filter((s) => s.status === "pending").length,
  });
});

export const POST = handler(async (request) => {
  const viewer = getViewer(request);

  if (!["director", "admin"].includes(viewer.role)) {
    throw new ApiError(
      403,
      "Only a scheduler (director or admin) can request an assignment recommendation.",
    );
  }

  const body = await readJson(request);
  const store = await getStore();
  const useLLM = asBool(body.use_llm, "use_llm", { fallback: true });

  // --- Resolve the case ------------------------------------------------------
  let caseSpec;
  let existingCaseId = null;

  if (body.case_id !== undefined) {
    const caseId = asInt(body.case_id, "case_id", { min: 1 });
    const row = await store.cases.get(caseId);
    if (!row) throw new ApiError(404, `No case with id ${caseId}`);
    if (row.status === "completed" || row.status === "cancelled") {
      throw new ApiError(400, `Case ${caseId} is ${row.status} and cannot be reassigned.`);
    }
    caseSpec = row;
    existingCaseId = caseId;
  } else {
    if (!body.procedure_name || !body.scheduled_at) {
      throw new ApiError(
        400,
        "Supply either case_id, or procedure_name + scheduled_at for an unsaved incoming case.",
      );
    }
    const scheduledAt = new Date(asString(body.scheduled_at, "scheduled_at"));
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new ApiError(400, "scheduled_at must be a valid ISO 8601 date/time");
    }
    caseSpec = {
      procedure_name: asString(body.procedure_name, "procedure_name", { maxLength: 200 }),
      cpt: asString(body.cpt, "cpt", { optional: true, maxLength: 10 }),
      specialty: asString(body.specialty, "specialty", { optional: true, maxLength: 80 }),
      rvu: asNumber(body.rvu, "rvu", { optional: true, min: 0, max: 100 }),
      duration_hrs: asNumber(body.duration_hrs, "duration_hrs", {
        optional: true,
        min: 0.25,
        max: 24,
      }),
      is_emergent: asBool(body.is_emergent, "is_emergent", { fallback: false }),
      scheduled_at: scheduledAt.toISOString(),
      surgeon_id: null,
    };
  }

  // --- Run the pipeline ------------------------------------------------------
  const recommendation = await recommendAssignment(store, caseSpec, { useLLM });

  // --- Persist as PENDING. Nothing is reassigned. ---------------------------
  const suggestion = await store.suggestions.create({
    case_id: existingCaseId,
    case_snapshot: recommendation.case,
    current_surgeon_id: caseSpec.surgeon_id ?? null,
    recommended_surgeon_id: recommendation.recommendation?.surgeon_id ?? null,
    justification: recommendation.justification,
    method: recommendation.method,
    risks: recommendation.risks ?? [],
    candidate_count: recommendation.candidates.length,
    blocked_count: recommendation.blocked.length,
    status: "pending",
    requested_by_role: viewer.role,
  });

  await store.audit.record({
    action: "assignment.suggest",
    actor_role: viewer.role,
    actor_surgeon_id: viewer.id,
    subject_surgeon_id: recommendation.recommendation?.surgeon_id ?? null,
    detail: {
      suggestion_id: suggestion.id,
      case_id: existingCaseId,
      method: recommendation.method,
      candidates: recommendation.candidates.length,
    },
  });

  // Map aliases back to real surgeon names for the scheduler's UI. The LLM
  // only ever saw the aliases.
  const surgeons = await store.surgeons.list();
  const nameById = new Map(surgeons.map((s) => [s.id, s.name]));

  return created({
    suggestion_id: suggestion.id,
    status: "pending",
    case: recommendation.case,
    recommendation: recommendation.recommendation
      ? {
          ...recommendation.recommendation,
          surgeon_name: nameById.get(recommendation.recommendation.surgeon_id) ?? null,
        }
      : null,
    runner_up: recommendation.runner_up
      ? {
          ...recommendation.runner_up,
          surgeon_name: nameById.get(recommendation.runner_up.surgeon_id) ?? null,
        }
      : null,
    justification: recommendation.justification,
    risks: recommendation.risks ?? [],
    confidence: recommendation.confidence ?? null,
    method: recommendation.method,
    agrees_with_deterministic: recommendation.agrees_with_deterministic ?? null,
    deterministic_recommendation: recommendation.deterministic_recommendation,
    all_candidates_red: recommendation.all_candidates_red,
    // Tier only — a scheduler comparing candidates sees risk tiers, never
    // anyone's numeric score or sleep data.
    candidates: recommendation.candidates.map((c) => ({
      surgeon_id: c.surgeon_id,
      surgeon_name: nameById.get(c.surgeon_id) ?? null,
      specialty: c.specialty,
      subspecialties: c.subspecialties,
      role: c.role,
      on_call: c.on_call,
      fatigue_tier: c.fatigue_tier,
      suitability: c.suitability,
      competency_fit: c.competency_fit,
      safety_flag: c.safety_flag ?? null,
      duty_advisories: c.duty_advisories,
    })),
    blocked: recommendation.blocked.map((b) => ({
      surgeon_id: b.surgeon_id,
      surgeon_name: nameById.get(b.surgeon_id) ?? null,
      reason: b.reason,
    })),
    llm_status: recommendation.llm_status ?? { ok: false, code: "llm_disabled" },
    requires_human_approval: true,
    next: `POST /api/assign/${suggestion.id} with {"decision": "approve" | "override" | "reject"}`,
    notice:
      "This is a recommendation, not a change. The case has not been reassigned. A human scheduler must approve it, and a raised fatigue tier results in schedule support, never a penalty for the surgeon involved.",
  });
});
