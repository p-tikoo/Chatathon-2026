/**
 * /api/cases  —  the case / event database
 *
 * GET  /api/cases?from=&to=&surgeon_id=&status=   Upcoming and past cases.
 * POST /api/cases                                 Add a case.
 *
 * On POST, complexity is resolved automatically through the three-layer model:
 *   1. CPT code supplied            -> exact RVU lookup from the catalog
 *   2. No CPT, recognisable name    -> keyword/token match against the catalog
 *   3. Neither                      -> LLM classifier (set classify=true)
 *
 * The response always says which path was taken (`match_method`) and how
 * confident it is, so an unrecognised procedure is visible rather than silently
 * defaulted to a middling guess.
 */

import { ApiError, created, getViewer, handler, ok, readJson } from "@/lib/http.js";
import { scoreCase } from "@/lib/complexity.js";
import { enrichCases } from "@/lib/assessment.js";
import { getStore } from "@/lib/store.js";
import { tryGenerateJSON } from "@/lib/llm.js";
import {
  CLASSIFY_SCHEMA,
  CLASSIFY_SYSTEM,
  buildClassifyUserPrompt,
  validateClassifyOutput,
} from "@/lib/prompts.js";
import { asBool, asInt, asNumber, asString, requireFields } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

const STATUSES = ["scheduled", "in_progress", "completed", "cancelled"];

export const GET = handler(async (request) => {
  const url = new URL(request.url);
  const store = await getStore();

  const surgeonId = url.searchParams.get("surgeon_id")
    ? asInt(url.searchParams.get("surgeon_id"), "surgeon_id", { min: 1 })
    : null;
  const status = url.searchParams.get("status");
  if (status && !STATUSES.includes(status)) {
    throw new ApiError(400, `status must be one of: ${STATUSES.join(", ")}`);
  }

  // Default window: 2 days back, 5 days forward — enough for "upcoming events"
  // without dragging the whole history over the wire.
  const now = new Date();
  const from = url.searchParams.get("from")
    ? new Date(url.searchParams.get("from"))
    : new Date(now.getTime() - 2 * 86400000);
  const to = url.searchParams.get("to")
    ? new Date(url.searchParams.get("to"))
    : new Date(now.getTime() + 5 * 86400000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ApiError(400, "`from` and `to` must be valid ISO 8601 date/times");
  }

  const rows = await store.cases.list({ surgeonId, from, to, status });

  // Personalize complexity per surgeon using their own exertion history.
  const cases = surgeonId !== null ? enrichCases(rows, { surgeonId }) : rows;

  return ok({
    cases,
    count: cases.length,
    window: { from: from.toISOString(), to: to.toISOString() },
    upcoming: cases.filter((c) => new Date(c.scheduled_at) >= now).length,
  });
});

export const POST = handler(async (request) => {
  const viewer = getViewer(request);
  const body = await readJson(request);
  requireFields(body, ["procedure_name", "scheduled_at"]);

  const store = await getStore();

  const procedureName = asString(body.procedure_name, "procedure_name", { maxLength: 200 });
  const scheduledAt = new Date(asString(body.scheduled_at, "scheduled_at"));
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new ApiError(400, "scheduled_at must be a valid ISO 8601 date/time");
  }

  const surgeonId = body.surgeon_id
    ? asInt(body.surgeon_id, "surgeon_id", { min: 1 })
    : null;

  if (surgeonId !== null) {
    const surgeon = await store.surgeons.get(surgeonId);
    if (!surgeon) throw new ApiError(404, `No surgeon with id ${surgeonId}`);
  }

  const isEmergent = asBool(body.is_emergent, "is_emergent", { fallback: false });
  const wantsClassification = asBool(body.classify, "classify", { fallback: false });

  // --- Layers 1 + 2: catalog lookup and personal calibration ---------------
  let scored = scoreCase({
    cpt: body.cpt,
    procedure_name: procedureName,
    rvu: body.rvu,
    duration_hrs: body.duration_hrs,
    is_emergent: isEmergent,
    specialty: body.specialty,
  });

  let classification = null;

  // --- Layer 3: LLM fill-in when structured data is missing ----------------
  if (scored.needs_llm_classification && wantsClassification) {
    const llm = await tryGenerateJSON({
      system: CLASSIFY_SYSTEM,
      user: buildClassifyUserPrompt(procedureName, {
        specialty: body.specialty,
        is_emergent: isEmergent,
      }),
      schema: CLASSIFY_SCHEMA,
      maxTokens: 600,
    });

    if (llm.ok) {
      classification = validateClassifyOutput(llm.data);
      // Re-score using the model's estimates as explicit overrides, so the
      // arithmetic stays the same regardless of where the RVU came from.
      scored = scoreCase({
        cpt: classification.cpt_code,
        procedure_name: procedureName,
        rvu: classification.work_rvu,
        duration_hrs: classification.duration_hrs,
        is_emergent: isEmergent,
        specialty: classification.specialty,
      });
      scored.match_method = "llm-classified";
      scored.match_confidence = classification.confidence;
    } else {
      // Unclassifiable and the LLM is unavailable. Say so in the response
      // rather than pretending the default guess is a real estimate.
      classification = { error: llm.code, message: llm.error, source: "unavailable" };
    }
  }

  const row = {
    surgeon_id: surgeonId,
    procedure_name: procedureName,
    cpt: classification?.cpt_code ?? asString(body.cpt, "cpt", { optional: true, maxLength: 10 }),
    specialty:
      asString(body.specialty, "specialty", { optional: true, maxLength: 80 }) ??
      scored.matched_procedure?.specialty ??
      classification?.specialty ??
      null,
    rvu: scored.rvu,
    duration_hrs: asNumber(body.duration_hrs, "duration_hrs", {
      optional: true,
      min: 0.25,
      max: 24,
    }) ?? scored.duration_hrs,
    is_emergent: isEmergent,
    scheduled_at: scheduledAt.toISOString(),
    status: "scheduled",
    perceived_exertion: null,
    complexity_score: scored.objective_score,
    complexity_tier: scored.objective_tier,
    fatigue_load: scored.fatigue_load,
    created_at: new Date().toISOString(),
  };

  const created_case = await store.cases.create(row);

  await store.audit.record({
    action: "case.create",
    actor_role: viewer.role,
    actor_surgeon_id: viewer.id,
    subject_surgeon_id: surgeonId,
    detail: { case_id: created_case.id, cpt: row.cpt, method: scored.match_method },
  });

  return created({
    case: created_case,
    complexity: {
      objective_score: scored.objective_score,
      tier: scored.objective_tier,
      fatigue_load: scored.fatigue_load,
      rvu: scored.rvu,
      duration_hrs: scored.duration_hrs,
      modifiers: scored.modifiers,
      match_method: scored.match_method,
      match_confidence: scored.match_confidence,
      matched_procedure: scored.matched_procedure,
    },
    classification,
    ...(surgeonId === null
      ? {
          next: `POST /api/assign with {"case_id": ${created_case.id}} to get an assignment recommendation`,
        }
      : {}),
  });
});
