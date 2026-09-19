/**
 * POST /api/ui/flag   { surgeonId, reason, severity }
 * DELETE (via POST { clear: true })
 *
 * A surgeon standing themselves down. This is the one signal in the system that
 * overrides the model outright, so it is recorded in the audit log rather than
 * held in UI state: "I said I was not safe to operate" has to survive a refresh.
 *
 * Flags live in the audit trail because the backend store has no flags table.
 * The trail is append-only, so clearing writes a matching `flag.clear` entry
 * rather than deleting anything.
 */

import { ApiError, created, handler, readJson } from "@/lib/http.js";
import { getStore } from "@/lib/store.js";
import { fromUiId, toUiId } from "@/lib/ui-adapter.js";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const store = await getStore();
  return created({ flags: await activeFlags(store) });
});

export const POST = handler(async (request) => {
  const body = await readJson(request);
  const surgeonId = fromUiId(body.surgeonId);
  if (!Number.isFinite(surgeonId)) throw new ApiError(400, "surgeonId is required");

  const store = await getStore();
  const clearing = body.clear === true;

  await store.audit.record({
    action: clearing ? "flag.clear" : "flag.raise",
    actor_role: "self",
    actor_surgeon_id: surgeonId,
    subject_surgeon_id: surgeonId,
    detail: clearing
      ? {}
      : {
          reason: String(body.reason ?? "").slice(0, 400),
          severity: body.severity === "stand-down" ? "stand-down" : "advisory",
        },
  });

  return created({ ok: true, flags: await activeFlags(store) });
});

/** Replay the trail: a flag is active if it has not been cleared since. */
async function activeFlags(store) {
  const entries = await store.audit.list({ limit: 500 });
  const bySurgeon = new Map();

  for (const e of [...entries].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
    if (e.action === "flag.raise") {
      const key = toUiId(e.subject_surgeon_id);
      bySurgeon.set(key, [
        ...(bySurgeon.get(key) ?? []),
        {
          at: new Date(e.created_at).getTime(),
          reason: e.detail?.reason ?? "",
          severity: e.detail?.severity ?? "advisory",
        },
      ]);
    } else if (e.action === "flag.clear") {
      bySurgeon.delete(toUiId(e.subject_surgeon_id));
    }
  }
  return Object.fromEntries(bySurgeon);
}
