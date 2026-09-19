/**
 * /api/surgeons/[id]
 *
 * GET   Profile, redacted for the calling viewer.
 * PATCH Update own profile and privacy settings. Self only.
 *
 * Note the asymmetry: anyone can GET (and receive a heavily redacted view),
 * but only the surgeon themselves can PATCH. There is deliberately no admin
 * override for editing a surgeon's disclosure settings — "my director changed
 * my privacy settings" must not be a thing this system can do.
 */

import { ApiError, getViewer, handler, ok, readJson } from "@/lib/http.js";
import { redactSurgeon, sanitizeVisibility } from "@/lib/privacy.js";
import { getStore } from "@/lib/store.js";
import { asBool, asNumber, asString } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

export const GET = handler(async (request, { params }) => {
  const { id } = await params; // Next.js 15: params is async
  const viewer = getViewer(request);
  const store = await getStore();

  const surgeon = await store.surgeons.get(id);
  if (!surgeon) throw new ApiError(404, `No surgeon with id ${id}`);

  return ok({ surgeon: redactSurgeon(surgeon, viewer) });
});

export const PATCH = handler(async (request, { params }) => {
  const { id } = await params;
  const viewer = getViewer(request);
  const store = await getStore();

  const surgeon = await store.surgeons.get(id);
  if (!surgeon) throw new ApiError(404, `No surgeon with id ${id}`);

  if (!(viewer.role === "self" && viewer.id === surgeon.id)) {
    throw new ApiError(
      403,
      "A surgeon's profile and privacy settings can only be changed by that surgeon.",
    );
  }

  const body = await readJson(request);
  const patch = {};

  if (body.pronouns !== undefined) {
    patch.pronouns = asString(body.pronouns, "pronouns", { optional: true, maxLength: 40 });
  }
  if (body.phone !== undefined) {
    patch.phone = asString(body.phone, "phone", { optional: true, maxLength: 40 });
  }
  if (body.bio !== undefined) {
    patch.bio = asString(body.bio, "bio", { optional: true, maxLength: 600 });
  }
  if (body.subspecialties !== undefined) {
    if (!Array.isArray(body.subspecialties)) {
      throw new ApiError(400, "subspecialties must be an array");
    }
    patch.subspecialties = body.subspecialties.slice(0, 8).map((s) => String(s).slice(0, 80));
  }
  if (body.baseline_sleep_hrs !== undefined) {
    patch.baseline_sleep_hrs = asNumber(body.baseline_sleep_hrs, "baseline_sleep_hrs", {
      min: 4,
      max: 10,
    });
  }
  if (body.on_call !== undefined) {
    patch.on_call = asBool(body.on_call, "on_call", { optional: false });
  }
  if (body.availability_notes !== undefined) {
    patch.availability_notes = asString(body.availability_notes, "availability_notes", {
      optional: true,
      maxLength: 300,
    });
  }
  if (body.opted_in !== undefined) {
    patch.opted_in = asBool(body.opted_in, "opted_in", { optional: false });
  }
  if (body.visibility !== undefined) {
    // sanitizeVisibility silently drops attempts to set visibility on biometric
    // or fixed fields — those are not the surgeon's to loosen.
    patch.visibility = sanitizeVisibility(body.visibility, surgeon.visibility);
  }

  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "No updatable fields supplied");
  }

  const updated = await store.surgeons.update(id, patch);

  await store.audit.record({
    action: "surgeon.update",
    actor_role: viewer.role,
    actor_surgeon_id: viewer.id,
    subject_surgeon_id: surgeon.id,
    detail: { fields: Object.keys(patch) },
  });

  return ok({ surgeon: redactSurgeon(updated, viewer) });
});
