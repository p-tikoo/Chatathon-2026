/**
 * POST /api/procedures/classify  —  LLM procedure classification
 *
 * Body: { procedure_name, specialty?, is_emergent? }
 *
 * Layer 3 of the complexity model. Takes a free-text procedure description that
 * the CPT catalog cannot match — "redo aortic valve replacement with root
 * enlargement" — and returns an estimated CPT code, work RVU, duration,
 * specialty, and complexity tier.
 *
 * This is a clean, honest, demoable use of an LLM: a genuine text-to-structure
 * problem with no deterministic solution, where the output is bounded,
 * validated, clearly labelled as an estimate, and feeds arithmetic that the
 * model does not control.
 *
 * ORDER OF OPERATIONS: the catalog is always tried first. The LLM is only
 * invoked when the cheap path fails, so a demo of a known procedure costs zero
 * tokens and zero latency.
 */

import { objectiveComplexity, scoreCase } from "@/lib/complexity.js";
import { getViewer, handler, ok, readJson } from "@/lib/http.js";
import { LLM_ENABLED } from "@/lib/config.js";
import { tryGenerateJSON } from "@/lib/llm.js";
import { detectModifiers } from "@/lib/procedures.js";
import {
  CLASSIFY_SCHEMA,
  CLASSIFY_SYSTEM,
  buildClassifyUserPrompt,
  validateClassifyOutput,
} from "@/lib/prompts.js";
import { asBool, asString, requireFields } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

export const POST = handler(async (request) => {
  const viewer = getViewer(request);
  const body = await readJson(request);
  requireFields(body, ["procedure_name"]);

  const procedureName = asString(body.procedure_name, "procedure_name", { maxLength: 200 });
  const specialty = asString(body.specialty, "specialty", { optional: true, maxLength: 80 });
  const isEmergent = asBool(body.is_emergent, "is_emergent", { fallback: false });

  // --- Cheap path: the catalog already knows this one ----------------------
  const catalogMatch = objectiveComplexity({
    procedure_name: procedureName,
    is_emergent: isEmergent,
  });

  if (!catalogMatch.needs_llm_classification) {
    return ok({
      source: "catalog",
      llm_used: false,
      procedure: catalogMatch.matched_procedure,
      estimate: {
        cpt_code: catalogMatch.matched_procedure?.cpt ?? null,
        canonical_name: catalogMatch.matched_procedure?.name ?? procedureName,
        specialty: catalogMatch.matched_procedure?.specialty ?? specialty,
        work_rvu: catalogMatch.rvu,
        duration_hrs: catalogMatch.duration_hrs,
        complexity_tier: catalogMatch.tier,
        modifiers_detected: catalogMatch.modifiers.map((m) => m.key),
        confidence: catalogMatch.match_confidence,
      },
      complexity: catalogMatch,
      note: "Matched against the local CPT/RVU catalog. No LLM call was needed.",
    });
  }

  // --- LLM path -------------------------------------------------------------
  if (!LLM_ENABLED) {
    return ok({
      source: "unavailable",
      llm_used: false,
      estimate: null,
      complexity: catalogMatch,
      note: "This procedure is not in the catalog and no LLM provider is configured. The complexity shown is a neutral default, not a real estimate. Set GEMINI_API_KEY in .env.local — see .env.example.",
    });
  }

  const llm = await tryGenerateJSON({
    system: CLASSIFY_SYSTEM,
    user: buildClassifyUserPrompt(procedureName, { specialty, is_emergent: isEmergent }),
    schema: CLASSIFY_SCHEMA,
    maxTokens: 600,
  });

  if (!llm.ok) {
    return ok({
      source: "fallback",
      llm_used: false,
      estimate: null,
      complexity: catalogMatch,
      llm_status: { ok: false, code: llm.code, message: llm.error },
      note: "The LLM classifier was unavailable. Falling back to a neutral default complexity — treat it as unverified.",
    });
  }

  const estimate = validateClassifyOutput(llm.data);

  // Re-run the deterministic scorer over the model's estimates, so the
  // complexity arithmetic is identical regardless of where the RVU came from.
  const scored = scoreCase({
    cpt: estimate.cpt_code,
    procedure_name: procedureName,
    rvu: estimate.work_rvu,
    duration_hrs: estimate.duration_hrs,
    is_emergent: isEmergent,
    specialty: estimate.specialty,
  });

  return ok({
    source: "llm",
    llm_used: true,
    estimate,
    complexity: scored,
    // Regex-detected modifiers shown alongside the model's, so a reviewer can
    // see the two agreeing (or not) rather than trusting either alone.
    deterministic_modifiers: detectModifiers(procedureName).map((m) => m.key),
    llm_status: {
      ok: true,
      provider: llm.provider,
      model: llm.model,
      latency_ms: llm.latency_ms,
      attempts: llm.attempts,
    },
    note: "LLM estimate for scheduling purposes only. Not verified against the CMS Physician Fee Schedule and not suitable for billing.",
  });
});
