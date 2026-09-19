/**
 * /api/events  —  non-clinical commitments
 *
 * GET  /api/events?surgeon_id=&from=&to=
 * POST /api/events
 *
 * WHY THIS EXISTS
 * ---------------
 * Duty-hour logs count operating time. They do not count clinic, admin, M&M,
 * teaching, research, or the fact that someone has a two-hour commute and a
 * newborn. A roster built only on OR time systematically underestimates load
 * for exactly the people carrying the most non-operative work.
 *
 * It is also the privacy feature that matters most day to day. A surgeon can
 * block time without disclosing why: `visibility: "private"` means a scheduler
 * sees an opaque "Unavailable" block. The constraint is honoured; the reason
 * stays with the person. Nobody should have to disclose a therapy appointment,
 * a fertility clinic, a family court date, or a job interview to get their
 * schedule respected.
 */

import { ApiError, created, getViewer, handler, ok, readJson } from "@/lib/http.js";
import { redactCalendarEntry } from "@/lib/privacy.js";
import { getStore } from "@/lib/store.js";
import { asBool, asEnum, asInt, asString, requireFields } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

const EVENT_KINDS = ["clinic", "admin", "academic", "research", "personal", "leave", "on_call"];
const EVENT_VISIBILITY = ["private", "care_team", "roster"];

export const GET = handler(async (request) => {
  const viewer = getViewer(request);
  const url = new URL(request.url);
  const store = await getStore();

  const surgeonId = url.searchParams.get("surgeon_id")
    ? asInt(url.searchParams.get("surgeon_id"), "surgeon_id", { min: 1 })
    : null;

  const now = new Date();
  const from = url.searchParams.get("from")
    ? new Date(url.searchParams.get("from"))
    : new Date(now.getTime() - 86400000);
  const to = url.searchParams.get("to")
    ? new Date(url.searchParams.get("to"))
    : new Date(now.getTime() + 7 * 86400000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ApiError(400, "`from` and `to` must be valid ISO 8601 date/times");
  }

  const rows = await store.events.list({ surgeonId, from, to });

  const events = rows
    .map((e) => redactCalendarEntry({ ...e, kind: e.kind }, viewer))
    .filter(Boolean);

  return ok({
    events,
    count: events.length,
    window: { from: from.toISOString(), to: to.toISOString() },
    privacy_notice:
      "Events marked private appear to other viewers as an opaque 'Unavailable' block. The time is visible so it can be scheduled around; the reason is not.",
  });
});

export const POST = handler(async (request) => {
  const viewer = getViewer(request);
  const body = await readJson(request);
  requireFields(body, ["surgeon_id", "kind", "start_time", "end_time"]);

  const surgeonId = asInt(body.surgeon_id, "surgeon_id", { min: 1 });

  // Clinical commitments can be entered by a scheduler; personal ones cannot.
  const kind = asEnum(body.kind, "kind", EVENT_KINDS);
  const isSelf = viewer.role === "self" && viewer.id === surgeonId;
  const isScheduler = ["director", "admin"].includes(viewer.role);

  if (!isSelf && !(isScheduler && kind !== "personal")) {
    throw new ApiError(
      403,
      kind === "personal"
        ? "Personal commitments can only be created by the surgeon they belong to."
        : "You do not have permission to create events for this surgeon.",
    );
  }

  const store = await getStore();
  const surgeon = await store.surgeons.get(surgeonId);
  if (!surgeon) throw new ApiError(404, `No surgeon with id ${surgeonId}`);

  const start = new Date(asString(body.start_time, "start_time"));
  const end = new Date(asString(body.end_time, "end_time"));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new ApiError(400, "start_time and end_time must be valid ISO 8601 date/times");
  }
  if (end <= start) throw new ApiError(400, "end_time must be after start_time");
  if (end - start > 14 * 86400000) {
    throw new ApiError(400, "An event may not span more than 14 days — use a leave record");
  }

  const row = {
    surgeon_id: surgeonId,
    kind,
    title: asString(body.title, "title", { optional: true, maxLength: 160 }) ?? defaultTitle(kind),
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    // Personal events default to private. This default is the feature.
    visibility: asEnum(body.visibility, "visibility", EVENT_VISIBILITY, {
      optional: true,
      fallback: kind === "personal" ? "private" : "care_team",
    }),
    // Personal time is not duty time — it blocks the calendar but must not
    // inflate someone's duty-hour total and push them over a cap.
    counts_toward_duty_hours: asBool(body.counts_toward_duty_hours, "counts_toward_duty_hours", {
      fallback: kind !== "personal" && kind !== "leave",
    }),
  };

  const event = await store.events.create(row);

  await store.audit.record({
    action: "event.create",
    actor_role: viewer.role,
    actor_surgeon_id: viewer.id,
    subject_surgeon_id: surgeonId,
    // Kind and visibility only. A private event's title never enters the
    // audit log, which admins can read.
    detail: { kind, visibility: row.visibility },
  });

  return created({ event });
});

function defaultTitle(kind) {
  return (
    {
      clinic: "Outpatient clinic",
      admin: "Administrative time",
      academic: "Teaching",
      research: "Research time",
      personal: "Personal commitment",
      leave: "Leave",
      on_call: "On call",
    }[kind] ?? "Commitment"
  );
}
