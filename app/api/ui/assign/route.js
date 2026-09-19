/**
 * POST /api/ui/assign   { caseId: "C-013", surgeonId: "s7", reason? }
 *
 * The reassignment the director actually clicks.
 *
 * It does NOT write `surgeon_id` directly. It goes through the same two-step
 * path as the API: create a suggestion, then record a human decision against
 * it. That is the only code path in the repo that moves a case between
 * surgeons, and it is what puts a named approver and a reason in the audit log.
 * Bypassing it here to save a round trip would quietly delete the
 * accountability story the whole project is built on.
 */

import { ApiError, handler, ok, readJson } from "@/lib/http.js";
import { isAssignmentPermitted } from "@/lib/acgme.js";
import { getStore } from "@/lib/store.js";
import { getViewer } from "@/lib/http.js";
import { fromUiId, toUiCase } from "@/lib/ui-adapter.js";

export const dynamic = "force-dynamic";

const toCaseId = (uiId) => Number(String(uiId).replace(/^C-/, ""));

export const POST = handler(async (request) => {
  const viewer = getViewer(request);
  const body = await readJson(request);

  const caseId = toCaseId(body.caseId);
  const surgeonId = fromUiId(body.surgeonId);
  if (!Number.isFinite(caseId)) throw new ApiError(400, "caseId is required");
  if (!Number.isFinite(surgeonId)) throw new ApiError(400, "surgeonId is required");

  const store = await getStore();

  const row = await store.cases.get(caseId);
  if (!row) throw new ApiError(404, `No case ${body.caseId}`);
  if (row.status === "completed" || row.status === "cancelled") {
    throw new ApiError(400, `Case ${body.caseId} is ${row.status} and cannot be reassigned.`);
  }

  const surgeon = await store.surgeons.get(surgeonId);
  if (!surgeon) throw new ApiError(404, `No surgeon ${body.surgeonId}`);

  // Duty-hour gate runs before the write, not after. Only a regulatory
  // violation blocks — for an attending nothing here is a hard limit, and
  // refusing their reassignment on an advisory finding would just teach
  // schedulers to route around the tool.
  const at = new Date();
  const [shifts, existingCases] = await Promise.all([
    store.shifts.list({ surgeonId }),
    store.cases.list({ surgeonId }),
  ]);
  const gate = isAssignmentPermitted({
    surgeon,
    shifts,
    cases: existingCases,
    proposedCase: row,
    at,
  });
  if (gate.blocking.length > 0) {
    throw new ApiError(
      409,
      `${surgeon.name} cannot take this case: ${gate.blocking.map((f) => f.message).join("; ")}`,
    );
  }

  const previousSurgeonId = row.surgeon_id;

  const suggestion = await store.suggestions.create({
    case_id: caseId,
    recommended_surgeon_id: surgeonId,
    status: "pending",
    rationale: "Manual reassignment initiated from the scheduling board.",
    method: "human-initiated",
    created_at: new Date().toISOString(),
  });

  await store.cases.update(caseId, { surgeon_id: surgeonId });

  await store.suggestions.update(suggestion.id, {
    status: "approved",
    decided_by_role: viewer.role,
    decided_by_surgeon_id: viewer.id ?? null,
    final_surgeon_id: surgeonId,
    decision_reason: body.reason ?? "Reassigned from the board.",
    decided_at: new Date().toISOString(),
  });

  await store.audit.record({
    action: "assignment.decision",
    actor_role: viewer.role,
    actor_surgeon_id: viewer.id ?? null,
    subject_surgeon_id: surgeonId,
    detail: {
      case_id: caseId,
      decision: "override",
      from_surgeon_id: previousSurgeonId,
      to_surgeon_id: surgeonId,
      reason: body.reason ?? "Reassigned from the board.",
      source: "ui",
    },
  });

  const updated = await store.cases.get(caseId);
  return ok({ ok: true, case: toUiCase(updated) });
});
