/**
 * POST /api/ui/register
 *
 * Onboarding from the UI. Creates a real surgeon row plus the sleep baseline
 * the fatigue model needs, and seeds the seven nights of sleep the registration
 * form collects — without them a brand-new surgeon has no history and the model
 * correctly refuses to say anything confident about them.
 *
 * Privacy defaults are conservative: contact details are self-only unless the
 * surgeon opts in. The UI can loosen them later; it cannot loosen the biometric
 * rule, which is not a setting (see lib/privacy.js).
 */

import { ApiError, created, handler, readJson } from "@/lib/http.js";
import { getStore } from "@/lib/store.js";
import { buildUiDataset, toUiId } from "@/lib/ui-adapter.js";

export const dynamic = "force-dynamic";

const HOUR = 3600000;

export const POST = handler(async (request) => {
  const body = await readJson(request);

  const name = String(body.name ?? "").trim();
  if (!name) throw new ApiError(400, "name is required");

  const specialty = String(body.specialty ?? "General Surgery").trim();
  const habitual = body.habitualSleep ?? {};
  const bedHour = Number(habitual.bedHour ?? 23);
  const wakeHour = Number(habitual.wakeHour ?? 6.5);
  const baseline = Number(body.baselineSleepHrs ?? (((wakeHour - bedHour) % 24) + 24) % 24) || 7.5;

  const store = await getStore();

  const surgeon = await store.surgeons.create({
    name: name.startsWith("Dr.") ? name : `Dr. ${name}`,
    email: body.email ?? null,
    phone: body.phone ?? null,
    pronouns: body.pronouns ?? "they/them",
    specialty,
    subspecialties: body.subspecialties ?? [],
    years_experience: Number(body.yearsExperience ?? 0) || 0,
    role: /fellow|resident/i.test(body.role ?? "") ? "fellow" : "attending",
    credentials: body.credentials ?? null,
    bio: body.bio ?? `${specialty}.`,
    baseline_sleep_hrs: Math.round(baseline * 10) / 10,
    on_call: Boolean(body.onCall),
    availability_notes: body.availabilityNotes ?? null,
    visibility: {
      email: "self",
      phone: "self",
      bio: "colleague",
      specialty: "public",
      availability_notes: "care_team",
    },
    opted_in: true,
  });

  // Seed the recent nights the form collected, so the first fatigue read is
  // based on something. Missing nights are simply absent — the confidence
  // score is meant to fall when the history is thin.
  const nights = Array.isArray(body.recentSleep) ? body.recentSleep.slice(0, 7) : [];
  const today = new Date();
  for (const [index, entry] of nights.entries()) {
    const hours = Number(entry?.hours ?? entry);
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const wake = new Date(today.getTime() - index * 24 * HOUR);
    wake.setHours(Math.floor(wakeHour), Math.round((wakeHour % 1) * 60), 0, 0);
    await store.sleepLogs.create({
      surgeon_id: surgeon.id,
      log_date: wake.toISOString().slice(0, 10),
      hours_slept: Math.round(hours * 10) / 10,
      wake_time: wake.toISOString(),
      recovery_score: entry?.quality != null ? Math.round(entry.quality * 100) : null,
      source: "manual",
    });
  }

  await store.audit.record({
    action: "surgeon.register",
    actor_role: "self",
    actor_surgeon_id: surgeon.id,
    subject_surgeon_id: surgeon.id,
    detail: { specialty, nights_seeded: nights.length },
  });

  const dataset = await buildUiDataset(store, { now: Date.now() });
  return created({
    ok: true,
    surgeon: dataset.surgeons.find((s) => s.id === toUiId(surgeon.id)) ?? null,
  });
});
