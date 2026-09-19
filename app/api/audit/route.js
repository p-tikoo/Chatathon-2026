/**
 * GET /api/audit  —  the accountability trail
 *
 * Every assignment suggestion, every human decision, every profile change, and
 * every fatigue assessment is recorded here with who did it and when.
 *
 * WHY A HACKATHON BACKEND HAS AN AUDIT LOG
 * ----------------------------------------
 * Because the honest answer to "what happens after an incident?" cannot be
 * "we don't know what the system recommended". If a scheduling tool influences
 * who operates, its recommendations and the human decisions taken on them have
 * to be reconstructable. That is also what makes "advisory, not autonomous" a
 * verifiable claim rather than a slide.
 *
 * WHAT IS DELIBERATELY *NOT* IN HERE
 * ----------------------------------
 * No sleep hours, no recovery scores, no numeric alertness scores, no private
 * event titles. The audit log is admin-readable, so writing biometric values
 * into it would be a back door around the privacy rules in lib/privacy.js.
 * Entries record tiers, actions, and identifiers only — check the `detail`
 * objects at each `store.audit.record(...)` call site and keep it that way.
 */

import { ApiError, getViewer, handler, ok } from "@/lib/http.js";
import { getStore } from "@/lib/store.js";
import { asInt } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

export const GET = handler(async (request) => {
  const viewer = getViewer(request);
  const url = new URL(request.url);

  if (!["director", "admin"].includes(viewer.role)) {
    throw new ApiError(403, "The audit log is visible to directors and admins only.");
  }

  const limit = asInt(url.searchParams.get("limit") ?? "100", "limit", { min: 1, max: 500 });
  const action = url.searchParams.get("action");

  const store = await getStore();
  let entries = await store.audit.list({ limit });
  if (action) entries = entries.filter((e) => e.action === action);

  const decisions = entries.filter((e) => e.action.startsWith("assignment."));
  const overrides = decisions.filter((e) => e.detail?.diverged_from_recommendation);

  return ok({
    entries,
    count: entries.length,
    stats: {
      assignment_decisions: decisions.length,
      human_overrides: overrides.length,
      // The number worth watching. A high override rate is not a bug report —
      // it is the schedulers telling you where the model's reasoning is wrong.
      override_rate:
        decisions.length > 0 ? Math.round((overrides.length / decisions.length) * 100) : null,
    },
    notice:
      "The audit log records actions, tiers, and identifiers. It deliberately contains no sleep, biometric, or numeric fatigue values, and no private event titles.",
  });
});
