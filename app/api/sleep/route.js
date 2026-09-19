/**
 * /api/sleep  —  sleep logging
 *
 * GET  /api/sleep?surgeon_id=1&days=7   Own logs only. Self access, always.
 * POST /api/sleep                       Log a night's sleep.
 *
 * WHY MANUAL LOGGING EXISTS AT ALL
 * --------------------------------
 * The roadmap is wearable ingestion (WHOOP/Oura) precisely because self-report
 * is the weak link — research tracking surgeon sleep hit poor device compliance
 * and concluded that engagement efforts were needed. But manual entry is not
 * just a placeholder: it is the fallback for the surgeon who won't wear a
 * device, and refusing to wear one must not mean being excluded from the
 * system. `source` records which path the data came from so the confidence
 * calculation can weight them differently later.
 *
 * ACCESS: sleep data is biometric. Under lib/privacy.js HARD_RULES it is
 * self-only — a director cannot read it through this endpoint or any other.
 */

import { ApiError, created, getViewer, handler, ok, readJson } from "@/lib/http.js";
import { getStore } from "@/lib/store.js";
import { asEnum, asInt, asNumber, asString, requireFields } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

const SOURCES = ["manual", "whoop", "oura", "fitbit", "healthkit", "synthetic-wearable"];

export const GET = handler(async (request) => {
  const viewer = getViewer(request);
  const url = new URL(request.url);

  const surgeonId = asInt(url.searchParams.get("surgeon_id"), "surgeon_id", { min: 1 });
  const days = asInt(url.searchParams.get("days") ?? "7", "days", { min: 1, max: 90 });

  // HARD RULE. Not overridable by role, not configurable.
  if (!(viewer.role === "self" && viewer.id === surgeonId)) {
    throw new ApiError(
      403,
      "Sleep data is visible only to the surgeon it belongs to. This restriction is not configurable and applies to directors and admins as well.",
    );
  }

  const store = await getStore();
  const logs = await store.sleepLogs.listForSurgeon(surgeonId, { days });

  const withValues = logs.filter((l) => Number.isFinite(Number(l.hours_slept)));
  const mean =
    withValues.length > 0
      ? withValues.reduce((a, l) => a + Number(l.hours_slept), 0) / withValues.length
      : null;

  return ok({
    logs,
    count: logs.length,
    window_days: days,
    stats: {
      mean_hours: mean === null ? null : Math.round(mean * 10) / 10,
      nights_under_six: withValues.filter((l) => Number(l.hours_slept) <= 6).length,
      nights_logged: withValues.length,
      coverage: `${withValues.length}/${days} nights`,
    },
  });
});

export const POST = handler(async (request) => {
  const viewer = getViewer(request);
  const body = await readJson(request);
  requireFields(body, ["surgeon_id", "hours_slept"]);

  const surgeonId = asInt(body.surgeon_id, "surgeon_id", { min: 1 });

  if (!(viewer.role === "self" && viewer.id === surgeonId)) {
    throw new ApiError(403, "A sleep log can only be created by the surgeon it belongs to.");
  }

  const store = await getStore();
  const surgeon = await store.surgeons.get(surgeonId);
  if (!surgeon) throw new ApiError(404, `No surgeon with id ${surgeonId}`);

  // Default to today. Dates are stored as plain YYYY-MM-DD: a sleep log belongs
  // to a calendar night, not an instant, and storing a timestamp here would
  // make the 7-day debt window timezone-dependent.
  const logDate = body.log_date
    ? asString(body.log_date, "log_date", { maxLength: 10 })
    : new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(logDate)) {
    throw new ApiError(400, "log_date must be in YYYY-MM-DD format");
  }
  if (new Date(logDate) > new Date(Date.now() + 86400000)) {
    throw new ApiError(400, "log_date cannot be in the future");
  }

  const row = {
    surgeon_id: surgeonId,
    log_date: logDate,
    hours_slept: asNumber(body.hours_slept, "hours_slept", { min: 0, max: 24 }),
    wake_time: body.wake_time
      ? new Date(asString(body.wake_time, "wake_time")).toISOString()
      : null,
    // Optional wearable recovery score. Distinct from sleep duration on
    // purpose — recovery is not just how long you were unconscious.
    recovery_score: asInt(body.recovery_score, "recovery_score", {
      optional: true,
      min: 0,
      max: 100,
    }),
    source: asEnum(body.source, "source", SOURCES, { optional: true, fallback: "manual" }),
  };

  // Upsert by (surgeon_id, log_date): re-logging the same night updates it.
  // Without this, logging twice double-counts that night's deficit in the
  // 7-day debt term and the score drifts every time you demo it.
  const log = await store.sleepLogs.create(row);

  await store.audit.record({
    action: "sleep.log",
    actor_role: viewer.role,
    actor_surgeon_id: viewer.id,
    subject_surgeon_id: surgeonId,
    // Never log the actual value into the audit trail — the audit log is
    // readable by admins and biometric values must not leak through it.
    detail: { log_date: logDate, source: row.source },
  });

  return created({
    log,
    next: `POST /api/fatigue with {"surgeon_id": ${surgeonId}} to recompute the alertness score`,
  });
});
