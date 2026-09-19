/**
 * /api/schedule/organize  —  THE AI ORGANIZING ENDPOINT
 * ===========================================================================
 * The centrepiece. Takes every surgery in a window and organizes the entire
 * board: scores each case on technical complexity AND cognitive load, matches
 * each against the assigned surgeon's predicted state at that exact time,
 * sorts on any of six axes, detects structural problems no per-case score can
 * see, and produces an AI action plan for the scheduler.
 *
 *   GET  /api/schedule/organize?sort_by=mismatch&group_by=surgeon
 *   POST /api/schedule/organize   { from, to, sort_by, group_by, use_llm }
 *
 * GET is the deterministic board — fast, reproducible, safe to poll, no LLM.
 * POST adds the AI action plan. Same split as /api/fatigue and for the same
 * reason: the expensive non-deterministic step runs where a human is about to
 * read it, not on every refresh.
 *
 * SORT AXES
 *   mismatch       (default) demand-vs-capacity risk. Hard cases on depleted
 *                  surgeons float to the top. This is the view that finds the
 *                  problem neither "hardest cases" nor "most tired people" can.
 *   cognitive      most mind-burning first (SURG-TLX six-dimension estimate)
 *   complexity     technically hardest first (RVU-anchored)
 *   urgency        emergent first
 *   chronological  plain calendar order
 *   balanced       weighted composite triage view
 *
 * GROUP BY: none | surgeon | day | specialty | mind_burn | risk
 *
 * ---------------------------------------------------------------------------
 * PRIVACY: leadership sees tiers, never scores.
 * The board exposes each case's demand scores (properties of the SURGERY, not
 * of a person) and the assigned surgeon's TIER. It deliberately does not carry
 * anyone's numeric alertness score, sleep data, or fatigue reasoning for a
 * non-self viewer — those are stripped below, consistent with the hard rules
 * in lib/privacy.js.
 *
 * The one exception is `projected_alertness`, which IS a derived capacity
 * number. It is included for schedulers because a mismatch score is not
 * actionable without knowing which side of it is the problem — but it is a
 * point-in-time projection for one case slot, not the surgeon's health record,
 * and it carries no sleep, recovery, or biometric detail. If your deployment
 * disagrees, strip it in `redactBoardForViewer` below; nothing else breaks.
 * ===========================================================================
 */

import { ApiError, getViewer, handler, ok, readJson } from "@/lib/http.js";
import { GROUP_BY, SORT_AXES, organizeBoard } from "@/lib/organize.js";
import { getStore } from "@/lib/store.js";
import { asBool, asEnum, asString } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

const DAY = 86400000;

export const GET = handler(async (request) => {
  const viewer = getViewer(request);
  requireScheduler(viewer);

  const url = new URL(request.url);
  const { from, to } = resolveWindow(
    url.searchParams.get("from"),
    url.searchParams.get("to"),
  );

  const store = await getStore();
  const board = await organizeBoard(store, {
    from,
    to,
    sortBy: asEnum(url.searchParams.get("sort_by"), "sort_by", SORT_AXES, {
      optional: true,
      fallback: "mismatch",
    }),
    groupBy: asEnum(url.searchParams.get("group_by"), "group_by", GROUP_BY, {
      optional: true,
      fallback: "none",
    }),
    specialty: url.searchParams.get("specialty"),
    useLLM: false,
  });

  return ok({ ...redactBoardForViewer(board, viewer), notice: NOTICE });
});

export const POST = handler(async (request) => {
  const viewer = getViewer(request);
  requireScheduler(viewer);

  const body = await readJson(request);
  const { from, to } = resolveWindow(body.from, body.to);

  const sortBy = asEnum(body.sort_by, "sort_by", SORT_AXES, {
    optional: true,
    fallback: "mismatch",
  });
  const groupBy = asEnum(body.group_by, "group_by", GROUP_BY, {
    optional: true,
    fallback: "none",
  });
  const useLLM = asBool(body.use_llm, "use_llm", { fallback: true });

  const store = await getStore();
  const board = await organizeBoard(store, {
    from,
    to,
    sortBy,
    groupBy,
    specialty: asString(body.specialty, "specialty", { optional: true, maxLength: 80 }),
    useLLM,
  });

  await store.audit.record({
    action: "schedule.organize",
    actor_role: viewer.role,
    actor_surgeon_id: viewer.id,
    subject_surgeon_id: null,
    detail: {
      sort_by: sortBy,
      group_by: groupBy,
      cases: board.count,
      method: board.method,
      critical_flags: board.summary.critical_flags,
    },
  });

  return ok({ ...redactBoardForViewer(board, viewer), notice: NOTICE });
});

// ---------------------------------------------------------------------------

function requireScheduler(viewer) {
  if (!["director", "admin"].includes(viewer.role)) {
    throw new ApiError(
      403,
      "The organized board is a scheduling view and requires a director or admin viewer role. Individual surgeons should use /api/fatigue and /api/calendar for their own view.",
    );
  }
}

/** Default window: now -> +7 days. Max 14 days. */
function resolveWindow(rawFrom, rawTo) {
  const now = new Date();
  const from = rawFrom ? new Date(rawFrom) : now;
  const to = rawTo ? new Date(rawTo) : new Date(from.getTime() + 7 * DAY);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ApiError(400, "`from` and `to` must be valid ISO 8601 date/times");
  }
  if (to <= from) throw new ApiError(400, "`to` must be after `from`");
  if (to - from > 14 * DAY) {
    throw new ApiError(400, "The organizing window may not exceed 14 days");
  }
  return { from, to };
}

/**
 * Strip person-level detail the viewer isn't entitled to.
 *
 * Case demand scores (complexity, cognitive load, SURG-TLX dimensions) are
 * properties of the SURGERY and stay. Person-level cognitive sensitivity is a
 * self-only signal and is removed from the workload rollup — it exists to fit
 * the schedule to the person, never to let leadership rank people by what
 * drains them.
 */
function redactBoardForViewer(board, viewer) {
  const isSelfView = viewer.role === "self";

  const scrubWorkload = (rows) =>
    (rows ?? []).map((w) => {
      const { cognitive_sensitivity, dominant_cost, ...rest } = w;
      // Self sees their own learned profile; schedulers never do.
      return isSelfView && viewer.id === w.surgeon_id
        ? { ...rest, cognitive_sensitivity, dominant_cost }
        : rest;
    });

  return { ...board, workload: scrubWorkload(board.workload) };
}

const NOTICE =
  "Case demand scores describe the surgery, not the surgeon. Surgeon state is shown as a risk tier plus a point-in-time alertness projection for that case slot — never sleep, recovery, or biometric data. All scores are advisory: no case is reassigned without a human decision via POST /api/assign/{id}.";
