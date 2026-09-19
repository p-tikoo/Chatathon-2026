/**
 * /api/fatigue  —  alertness scoring
 *
 * GET  /api/fatigue?surgeon_id=1&horizon_hours=48   Deterministic, fast.
 * POST /api/fatigue  {surgeon_id, use_llm}          Full assessment + narrative.
 *
 * THE SPLIT IS INTENTIONAL:
 *   GET  is cheap, deterministic, and safe to poll — use it for charts and
 *        anything that refreshes.
 *   POST runs the LLM narrative and persists a score row — use it when a human
 *        is about to read the explanation.
 *
 * Both return the full projection series, which is what the alertness curve on
 * the surgeon view is drawn from.
 *
 * ACCESS: the numeric score and its reasoning are biometric-adjacent and
 * self-only. Directors calling this get the tier and nothing else, via
 * redactFatigue(). See lib/privacy.js.
 */

import { assessSurgeon } from "@/lib/assessment.js";
import { ApiError, getViewer, handler, ok, readJson } from "@/lib/http.js";
import { redactFatigue } from "@/lib/privacy.js";
import { getStore } from "@/lib/store.js";
import { asBool, asInt } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

export const GET = handler(async (request) => {
  const viewer = getViewer(request);
  const url = new URL(request.url);

  const surgeonId = asInt(url.searchParams.get("surgeon_id"), "surgeon_id", { min: 1 });
  const horizonHours = asInt(url.searchParams.get("horizon_hours") ?? "48", "horizon_hours", {
    min: 12,
    max: 72,
  });

  const store = await getStore();
  const assessment = await assessSurgeon(store, surgeonId, { useLLM: false, horizonHours });
  if (!assessment) throw new ApiError(404, `No surgeon with id ${surgeonId}`);

  return ok({
    assessment: redactFatigue(assessment, viewer, surgeonId),
    disclaimer: DISCLAIMER,
  });
});

export const POST = handler(async (request) => {
  const viewer = getViewer(request);
  const body = await readJson(request);

  const surgeonId = asInt(body.surgeon_id, "surgeon_id", { min: 1 });
  const useLLM = asBool(body.use_llm, "use_llm", { fallback: true });
  const horizonHours = asInt(body.horizon_hours ?? 48, "horizon_hours", { min: 12, max: 72 });

  const store = await getStore();
  const assessment = await assessSurgeon(store, surgeonId, { useLLM, horizonHours });
  if (!assessment) throw new ApiError(404, `No surgeon with id ${surgeonId}`);

  // Persist the score so the roster and the audit trail have a history, and so
  // "what did the system say before the incident?" is an answerable question.
  await store.fatigueScores.create({
    surgeon_id: surgeonId,
    score: assessment.score,
    tier: assessment.tier,
    reasoning: assessment.reasoning,
    method: assessment.method,
    model_version: assessment.model_version,
  });

  await store.audit.record({
    action: "fatigue.assess",
    actor_role: viewer.role,
    actor_surgeon_id: viewer.id,
    subject_surgeon_id: surgeonId,
    // Tier only, never the numeric score — the audit log is admin-readable.
    detail: { tier: assessment.tier, method: assessment.method },
  });

  return ok({
    assessment: redactFatigue(assessment, viewer, surgeonId),
    disclaimer: DISCLAIMER,
  });
});

const DISCLAIMER =
  "Scheduling decision support only. This is not a medical device, does not diagnose any condition, and must not be used to assess an individual's fitness to practise. A raised fatigue reading should result in scheduling support, never in a penalty.";
