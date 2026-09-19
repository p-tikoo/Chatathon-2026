/**
 * GET /api/ui/roster
 *
 * The frontend's single read. Returns the real backend store — surgeons,
 * duty, sleep, commitments, cases — in the vocabulary src/ already speaks.
 *
 * This is a UI-facing convenience view, not a replacement for /api/roster.
 * /api/roster is the privacy-enforced leadership endpoint and stays the
 * canonical one; see lib/ui-adapter.js for why this seam exists.
 */

import { handler, ok } from "@/lib/http.js";
import { getStore } from "@/lib/store.js";
import { buildUiDataset } from "@/lib/ui-adapter.js";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const store = await getStore();
  const [dataset, entries] = await Promise.all([
    buildUiDataset(store, { now: Date.now() }),
    store.audit.list({ limit: 500 }),
  ]);

  // Self-reported stand-downs live in the audit trail (see /api/ui/flag) and
  // are replayed onto the roster here, so a flag raised on the surgeon view
  // shows up on the director board without any shared client state.
  const flags = replayFlags(entries);
  for (const surgeon of dataset.surgeons) {
    surgeon.flags = flags.get(surgeon.backendId) ?? [];
  }

  return ok(dataset);
});

function replayFlags(entries) {
  const out = new Map();
  const chronological = [...entries].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at),
  );

  for (const e of chronological) {
    if (e.action === "flag.raise") {
      out.set(e.subject_surgeon_id, [
        ...(out.get(e.subject_surgeon_id) ?? []),
        {
          at: new Date(e.created_at).getTime(),
          reason: e.detail?.reason ?? "",
          severity: e.detail?.severity ?? "advisory",
        },
      ]);
    } else if (e.action === "flag.clear") {
      out.delete(e.subject_surgeon_id);
    }
  }
  return out;
}
