/**
 * GET /api/calendar  —  the shared department calendar
 *
 * Merges shifts, cases, and non-clinical events into a single privacy-filtered
 * timeline. This is the one endpoint the frontend needs for any calendar view,
 * whether that's one surgeon's day or the whole department's week.
 *
 * Query params:
 *   surgeon_id   restrict to one surgeon (omit for the whole department)
 *   from, to     ISO 8601 window (default: now -> +7 days, max 14 days)
 *   group_by     "day" to bucket the response by date, omit for a flat list
 *
 * PRIVACY: every entry goes through redactCalendarEntry(). Clinical work is
 * visible to the care team; personal commitments collapse to an opaque
 * "Unavailable" block for everyone except the surgeon themselves. The
 * scheduler learns the constraint without learning the reason.
 */

import { ApiError, getViewer, handler, ok } from "@/lib/http.js";
import { redactCalendarEntry } from "@/lib/privacy.js";
import { getStore } from "@/lib/store.js";
import { asInt, parseWindow } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

const HOUR = 3600000;

export const GET = handler(async (request) => {
  const viewer = getViewer(request);
  const url = new URL(request.url);
  const store = await getStore();

  const surgeonId = url.searchParams.get("surgeon_id")
    ? asInt(url.searchParams.get("surgeon_id"), "surgeon_id", { min: 1 })
    : null;

  const { from, to } = parseWindow(url.searchParams, { defaultDays: 7, maxDays: 14 });
  const groupBy = url.searchParams.get("group_by");

  const [shifts, cases, events, surgeons] = await Promise.all([
    store.shifts.list({ surgeonId, from, to }),
    store.cases.list({ surgeonId, from, to }),
    store.events.list({ surgeonId, from, to }),
    store.surgeons.list(),
  ]);

  const nameById = new Map(surgeons.map((s) => [s.id, s.name]));

  const entries = [
    ...shifts.map((s) => ({
      id: `shift-${s.id}`,
      surgeon_id: s.surgeon_id,
      kind: "shift",
      title: s.is_night ? "Night shift" : "Day shift",
      start_time: s.start_time,
      end_time: s.end_time,
      is_night: s.is_night,
    })),
    ...cases.map((c) => ({
      id: `case-${c.id}`,
      case_id: c.id,
      surgeon_id: c.surgeon_id,
      kind: "case",
      title: c.procedure_name,
      start_time: c.scheduled_at,
      end_time: new Date(
        new Date(c.scheduled_at).getTime() + (Number(c.duration_hrs) || 2) * HOUR,
      ).toISOString(),
      cpt: c.cpt,
      rvu: c.rvu,
      is_emergent: c.is_emergent,
      complexity_tier: c.complexity_tier,
      status: c.status,
    })),
    ...events.map((e) => ({
      id: `event-${e.id}`,
      event_id: e.id,
      surgeon_id: e.surgeon_id,
      kind: e.kind,
      title: e.title,
      start_time: e.start_time,
      end_time: e.end_time,
      visibility: e.visibility,
    })),
  ];

  const visible = entries
    .map((e) => redactCalendarEntry(e, viewer))
    .filter(Boolean)
    .map((e) => ({
      ...e,
      // Attach the surgeon's name only when the viewer could see it anyway.
      surgeon_name: viewer.role === "public" ? undefined : nameById.get(e.surgeon_id),
    }))
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  const payload = {
    window: { from: from.toISOString(), to: to.toISOString() },
    count: visible.length,
    hidden_count: entries.length - visible.length,
    privacy_notice:
      "Personal commitments appear as opaque 'Unavailable' blocks to anyone other than the surgeon. Times are shared so the schedule can work around them; reasons are not.",
  };

  if (groupBy === "day") {
    const days = new Map();
    for (const e of visible) {
      const key = e.start_time.slice(0, 10);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(e);
    }
    return ok({
      ...payload,
      days: [...days.entries()].map(([date, items]) => ({ date, entries: items })),
    });
  }

  return ok({ ...payload, entries: visible });
});
