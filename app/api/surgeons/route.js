/**
 * /api/surgeons  —  registration + directory
 *
 * GET  /api/surgeons          List surgeons, redacted for the calling viewer.
 * POST /api/surgeons          Register a new surgeon.
 *
 * THE REGISTRATION MODEL ("Hinge-like")
 * -------------------------------------
 * A surgeon registers once with their professional details, their personal
 * sleep baseline, and a per-field visibility map saying who may see what.
 * Defaults are private-leaning — you opt IN to sharing, never out.
 *
 * Biometric fields are NOT part of that choice. They are self-only under
 * lib/privacy.js HARD_RULES and no setting exposes them. See lib/privacy.js
 * for why that has to be structural rather than a policy promise.
 */

import { ApiError, created, getViewer, handler, ok, readJson } from "@/lib/http.js";
import { defaultVisibility, redactSurgeon, sanitizeVisibility } from "@/lib/privacy.js";
import { getStore } from "@/lib/store.js";
import { asBool, asEnum, asInt, asNumber, asString, requireFields } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

const ROLES = [
  "attending",
  "fellow",
  "resident-pgy1",
  "resident-pgy2",
  "resident-pgy3",
  "resident-pgy4",
  "resident-pgy5",
];

export const GET = handler(async (request) => {
  const viewer = getViewer(request);
  const store = await getStore();
  const url = new URL(request.url);

  const specialty = url.searchParams.get("specialty");
  const onCallOnly = url.searchParams.get("on_call") === "true";

  let surgeons = await store.surgeons.list();
  if (specialty) surgeons = surgeons.filter((s) => s.specialty === specialty);
  if (onCallOnly) surgeons = surgeons.filter((s) => s.on_call);

  return ok({
    surgeons: surgeons.map((s) => redactSurgeon(s, viewer)),
    count: surgeons.length,
    viewer: { role: viewer.role, id: viewer.id },
  });
});

export const POST = handler(async (request) => {
  const store = await getStore();
  const body = await readJson(request);

  requireFields(body, ["name", "specialty"]);

  const email = asString(body.email, "email", { optional: true, maxLength: 200 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "email must be a valid email address");
  }

  // Duplicate guard on email — re-registering the same person would split their
  // sleep history across two records and quietly wreck their baseline.
  if (email) {
    const existing = (await store.surgeons.list()).find(
      (s) => s.email && s.email.toLowerCase() === email.toLowerCase(),
    );
    if (existing) throw new ApiError(409, "A surgeon with that email is already registered");
  }

  const row = {
    name: asString(body.name, "name", { maxLength: 120 }),
    email,
    phone: asString(body.phone, "phone", { optional: true, maxLength: 40 }),
    // Never inferred from a name. If it isn't supplied, it stays null and the
    // UI should fall back to the person's name or they/them.
    pronouns: asString(body.pronouns, "pronouns", { optional: true, maxLength: 40 }),
    specialty: asString(body.specialty, "specialty", { maxLength: 80 }),
    subspecialties: Array.isArray(body.subspecialties)
      ? body.subspecialties.slice(0, 8).map((s) => String(s).slice(0, 80))
      : [],
    years_experience: asInt(body.years_experience, "years_experience", {
      optional: true,
      min: 0,
      max: 60,
    }),
    role: asEnum(body.role, "role", ROLES, { optional: true, fallback: "attending" }),
    credentials: asString(body.credentials, "credentials", { optional: true, maxLength: 80 }),
    bio: asString(body.bio, "bio", { optional: true, maxLength: 600 }),

    // Personal sleep baseline. This is the reference point every fatigue score
    // is measured against, and using a PERSONAL baseline rather than a
    // population average is what stops the model systematically flagging older
    // surgeons or anyone whose normal sleep differs from the mean.
    baseline_sleep_hrs: asNumber(body.baseline_sleep_hrs, "baseline_sleep_hrs", {
      optional: true,
      min: 4,
      max: 10,
    }) ?? 7,

    on_call: asBool(body.on_call, "on_call", { fallback: false }),
    availability_notes: asString(body.availability_notes, "availability_notes", {
      optional: true,
      maxLength: 300,
    }),

    visibility: sanitizeVisibility(body.visibility, defaultVisibility()),

    // Participation is opt-in. A surgeon who has not opted in is excluded from
    // assignment recommendations entirely (see lib/assignment.js) rather than
    // being scored silently.
    opted_in: asBool(body.opted_in, "opted_in", { fallback: true }),
    created_at: new Date().toISOString(),
  };

  const surgeon = await store.surgeons.create(row);

  await store.audit.record({
    action: "surgeon.register",
    actor_role: "self",
    subject_surgeon_id: surgeon.id,
    detail: { specialty: surgeon.specialty, opted_in: surgeon.opted_in },
  });

  // Echo back through the self view so the client sees exactly what it stored.
  return created({
    surgeon: redactSurgeon(surgeon, { role: "self", id: surgeon.id }),
    next_steps: [
      "POST /api/sleep to log last night's sleep",
      "POST /api/fatigue to compute an alertness score",
      "PATCH /api/surgeons/{id} to adjust per-field visibility",
    ],
  });
});
