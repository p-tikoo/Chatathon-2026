/**
 * /api/cases/[id]
 *
 * GET   Case detail with full complexity breakdown.
 * PATCH Update status, or submit the post-case perceived exertion rating.
 *
 * THE PERCEIVED EXERTION TAP
 * --------------------------
 * One number, 1-10, one tap, after the case. It is small to build and it is the
 * answer to "isn't difficulty subjective?".
 *
 * Critically, this rating is NEVER used as the case's difficulty. It feeds
 * `personalCalibration` in lib/complexity.js, which learns how far this
 * surgeon's perceived effort runs from what the RVU predicts, and applies that
 * as a bounded multiplier on the objective score. A subjective input used as a
 * calibration signal is useful; the same input used as the measurement is
 * noise. See the header of lib/complexity.js.
 *
 * Only the surgeon who did the case may rate it.
 */

import { enrichCases } from "@/lib/assessment.js";
import { scoreCase } from "@/lib/complexity.js";
import { ApiError, getViewer, handler, ok, readJson } from "@/lib/http.js";
import { getStore } from "@/lib/store.js";
import { asEnum, asInt } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

const STATUSES = ["scheduled", "in_progress", "completed", "cancelled"];

export const GET = handler(async (request, { params }) => {
  const { id } = await params;
  const store = await getStore();

  const row = await store.cases.get(id);
  if (!row) throw new ApiError(404, `No case with id ${id}`);

  // Score it in the context of the assigned surgeon's rating history.
  let complexity;
  if (row.surgeon_id) {
    const history = await store.cases.list({ surgeonId: row.surgeon_id });
    const rated = history
      .filter((c) => Number.isFinite(Number(c.perceived_exertion)))
      .map((c) => ({
        cpt: c.cpt,
        specialty: c.specialty,
        perceived_exertion: Number(c.perceived_exertion),
        objective_score: Number(c.complexity_score) || 50,
      }));
    complexity = scoreCase(row, { ratedCases: rated });
  } else {
    complexity = scoreCase(row);
  }

  return ok({ case: row, complexity });
});

export const PATCH = handler(async (request, { params }) => {
  const { id } = await params;
  const viewer = getViewer(request);
  const store = await getStore();

  const row = await store.cases.get(id);
  if (!row) throw new ApiError(404, `No case with id ${id}`);

  const body = await readJson(request);
  const patch = {};

  if (body.status !== undefined) {
    patch.status = asEnum(body.status, "status", STATUSES);
  }

  if (body.perceived_exertion !== undefined) {
    if (!(viewer.role === "self" && viewer.id === row.surgeon_id)) {
      throw new ApiError(
        403,
        "Only the surgeon who performed a case may rate its perceived exertion.",
      );
    }
    if (row.status !== "completed" && patch.status !== "completed") {
      throw new ApiError(400, "Perceived exertion can only be recorded on a completed case.");
    }
    patch.perceived_exertion = asInt(body.perceived_exertion, "perceived_exertion", {
      min: 1,
      max: 10,
    });
  }

  if (body.surgeon_id !== undefined) {
    // Reassignment does not happen here. It happens only through an approved
    // assignment suggestion (POST /api/assign/[id]), so every change of hands
    // carries a justification and an approver in the audit log.
    throw new ApiError(
      400,
      "Reassignment is not permitted here. Create an assignment suggestion via POST /api/assign, then approve it via POST /api/assign/{id}.",
    );
  }

  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "No updatable fields supplied (status, perceived_exertion)");
  }

  const updated = await store.cases.update(id, patch);

  await store.audit.record({
    action: "case.update",
    actor_role: viewer.role,
    actor_surgeon_id: viewer.id,
    subject_surgeon_id: row.surgeon_id,
    detail: { case_id: Number(id), fields: Object.keys(patch) },
  });

  // When a rating comes in, show the caller how it moved their calibration —
  // this is the feedback loop that makes rating feel worth doing.
  let calibration = null;
  if (patch.perceived_exertion !== undefined && row.surgeon_id) {
    const history = await store.cases.list({ surgeonId: row.surgeon_id });
    const enriched = enrichCases(history, { surgeonId: row.surgeon_id });
    calibration = enriched.find((c) => c.id === Number(id))?.calibration ?? null;
  }

  return ok({
    case: updated,
    ...(calibration
      ? {
          calibration,
          note: "Your rating adjusts how this system estimates the load of similar cases for you specifically. It is never shared with leadership and never used to evaluate performance.",
        }
      : {}),
  });
});
