/**
 * POST /api/ui/sleep-log   { surgeonId: "s3", start, end, quality?, source? }
 *
 * Writes a real sleep log to the backend store, which is what every downstream
 * fatigue number is computed from. `start`/`end` are epoch ms from the UI; the
 * store keeps a log date, a duration, and a wake time.
 */

import { ApiError, created, handler, readJson } from "@/lib/http.js";
import { getStore } from "@/lib/store.js";
import { buildUiDataset, fromUiId } from "@/lib/ui-adapter.js";

export const dynamic = "force-dynamic";

export const POST = handler(async (request) => {
  const body = await readJson(request);
  const surgeonId = fromUiId(body.surgeonId);
  if (!Number.isFinite(surgeonId)) throw new ApiError(400, "surgeonId is required");

  const start = Number(body.start);
  const end = Number(body.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new ApiError(400, "start and end must be epoch milliseconds with end after start");
  }

  const hours = (end - start) / 3600000;
  if (hours > 18) throw new ApiError(400, "A single sleep episode may not exceed 18 hours");

  const store = await getStore();
  const surgeon = await store.surgeons.get(surgeonId);
  if (!surgeon) throw new ApiError(404, `No surgeon ${body.surgeonId}`);

  await store.sleepLogs.create({
    surgeon_id: surgeonId,
    // The night is attributed to the day the surgeon woke up, matching how the
    // seed data and the 7-day debt window are keyed.
    log_date: new Date(end).toISOString().slice(0, 10),
    hours_slept: Math.round(hours * 10) / 10,
    wake_time: new Date(end).toISOString(),
    recovery_score:
      body.quality != null ? Math.round(Math.max(0, Math.min(1, body.quality)) * 100) : null,
    source: body.source === "wearable" ? "synthetic-wearable" : "manual",
  });

  await store.audit.record({
    action: "sleep.log",
    actor_role: "self",
    actor_surgeon_id: surgeonId,
    subject_surgeon_id: surgeonId,
    detail: { hours_slept: Math.round(hours * 10) / 10, source: body.source ?? "manual" },
  });

  const dataset = await buildUiDataset(store, { now: Date.now() });
  return created({
    ok: true,
    surgeon: dataset.surgeons.find((s) => s.id === body.surgeonId) ?? null,
  });
});
