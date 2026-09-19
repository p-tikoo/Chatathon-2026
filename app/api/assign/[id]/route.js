/**
 * /api/assign/[id]  —  the human decision
 *
 * GET  Retrieve a suggestion.
 * POST Approve, override, or reject it.
 *
 * Body:
 *   { decision: "approve" }                                take the recommendation
 *   { decision: "override", surgeon_id: 7, reason: "..." } pick someone else
 *   { decision: "reject", reason: "..." }                  take none of it
 *
 * THIS IS THE ONLY PLACE IN THE CODEBASE THAT CHANGES A CASE'S SURGEON.
 * There is no other write path — POST /api/cases/[id] explicitly refuses
 * surgeon_id updates and points here. Every reassignment therefore carries a
 * justification, a named approver, and an audit record.
 *
 * OVERRIDE IS A FIRST-CLASS OUTCOME, NOT A FAILURE.
 * A scheduler knows things the model does not: a surgeon's continuity with a
 * patient, a training requirement, a conversation from this morning. The
 * `reason` on an override is required, and over time it is the most valuable
 * data this system collects — a log of exactly where the model's reasoning
 * diverges from expert judgment, which is what you would use to improve it.
 */

import { ApiError, getViewer, handler, ok, readJson } from "@/lib/http.js";
import { isAssignmentPermitted } from "@/lib/acgme.js";
import { getStore } from "@/lib/store.js";
import { asEnum, asInt, asString } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

const DECISIONS = ["approve", "override", "reject"];

export const GET = handler(async (request, { params }) => {
  const { id } = await params;
  const viewer = getViewer(request);

  if (!["director", "admin"].includes(viewer.role)) {
    throw new ApiError(403, "Assignment suggestions are visible to schedulers only.");
  }

  const store = await getStore();
  const suggestion = await store.suggestions.get(id);
  if (!suggestion) throw new ApiError(404, `No suggestion with id ${id}`);

  return ok({ suggestion });
});

export const POST = handler(async (request, { params }) => {
  const { id } = await params;
  const viewer = getViewer(request);

  // Only a human scheduler decides. There is no service-account path here.
  if (!["director", "admin"].includes(viewer.role)) {
    throw new ApiError(
      403,
      "Only a human scheduler (director or admin) can approve or override an assignment.",
    );
  }

  const store = await getStore();
  const suggestion = await store.suggestions.get(id);
  if (!suggestion) throw new ApiError(404, `No suggestion with id ${id}`);

  if (suggestion.status !== "pending") {
    throw new ApiError(
      409,
      `Suggestion ${id} has already been ${suggestion.status} and cannot be decided again.`,
    );
  }

  const body = await readJson(request);
  const decision = asEnum(body.decision, "decision", DECISIONS);
  const reason = asString(body.reason, "reason", { optional: true, maxLength: 600 });

  let finalSurgeonId = null;

  if (decision === "approve") {
    if (!suggestion.recommended_surgeon_id) {
      throw new ApiError(400, "This suggestion has no recommended surgeon to approve.");
    }
    finalSurgeonId = suggestion.recommended_surgeon_id;
  }

  if (decision === "override") {
    finalSurgeonId = asInt(body.surgeon_id, "surgeon_id", { min: 1 });
    if (!reason) {
      throw new ApiError(
        400,
        "An override requires a reason. It is recorded so the divergence between expert judgment and the model can be reviewed later.",
      );
    }
    const surgeon = await store.surgeons.get(finalSurgeonId);
    if (!surgeon) throw new ApiError(404, `No surgeon with id ${finalSurgeonId}`);
  }

  // --- Re-check duty hours at decision time --------------------------------
  // The suggestion may have been generated minutes or hours ago, and an
  // override picks someone the pipeline never vetted. Never write a
  // reassignment without re-running the compliance gate against live data.
  let dutyCheck = null;
  if (finalSurgeonId !== null && suggestion.case_snapshot) {
    const surgeon = await store.surgeons.get(finalSurgeonId);
    const from = new Date(Date.now() - 28 * 86400000);
    const to = new Date(Date.now() + 7 * 86400000);

    const [shifts, cases] = await Promise.all([
      store.shifts.list({ surgeonId: finalSurgeonId, from, to }),
      store.cases.list({ surgeonId: finalSurgeonId, from, to }),
    ]);

    const permitted = isAssignmentPermitted({
      surgeon,
      shifts,
      cases,
      proposedCase: {
        scheduled_at: suggestion.case_snapshot.scheduled_at,
        duration_hrs: suggestion.case_snapshot.duration_hrs,
      },
    });
    dutyCheck = permitted.check;

    if (!permitted.permitted) {
      // Hard stop for trainees. `isAssignmentPermitted` only returns
      // permitted=false when the findings are regulatory violations, which by
      // construction means the surgeon is a resident or fellow.
      throw new ApiError(
        409,
        `Assignment blocked: ${permitted.blocking[0]?.message ?? "duty-hour limit exceeded"}`,
        { duty_check: permitted.check },
      );
    }
  }

  // --- Apply -----------------------------------------------------------------
  let updatedCase = null;
  if (decision !== "reject" && suggestion.case_id) {
    updatedCase = await store.cases.update(suggestion.case_id, { surgeon_id: finalSurgeonId });
  }

  const updated = await store.suggestions.update(id, {
    status: decision === "reject" ? "rejected" : decision === "override" ? "overridden" : "approved",
    decided_at: new Date().toISOString(),
    decided_by_role: viewer.role,
    decided_by_surgeon_id: viewer.id,
    final_surgeon_id: finalSurgeonId,
    decision_reason: reason ?? null,
  });

  await store.audit.record({
    action: `assignment.${decision}`,
    actor_role: viewer.role,
    actor_surgeon_id: viewer.id,
    subject_surgeon_id: finalSurgeonId,
    detail: {
      suggestion_id: Number(id),
      case_id: suggestion.case_id,
      recommended_surgeon_id: suggestion.recommended_surgeon_id,
      final_surgeon_id: finalSurgeonId,
      // The signal worth keeping: did the human agree with the model?
      diverged_from_recommendation:
        decision === "override" && finalSurgeonId !== suggestion.recommended_surgeon_id,
      reason: reason ?? null,
    },
  });

  return ok({
    suggestion: updated,
    case: updatedCase,
    duty_check: dutyCheck,
    decided_by: { role: viewer.role, surgeon_id: viewer.id },
    notice:
      decision === "reject"
        ? "Suggestion rejected. The case is unchanged."
        : "Assignment applied by human approval and recorded in the audit log. No penalty attaches to any surgeon as a result of this change.",
  });
});
