/**
 * GET /api/health
 *
 * Tells you exactly what the backend is running on right now: which store,
 * which LLM provider, whether the key is actually present, and whether scoring
 * is LLM-assisted or deterministic-only.
 *
 * Hit this first when something looks wrong, and hit it before the demo. It is
 * also the honest answer to "what's real vs. simulated?" — the API reports its
 * own configuration rather than asking anyone to take it on trust.
 */

import { describeRuntime } from "@/lib/config.js";
import { handler, ok } from "@/lib/http.js";
import { getStore } from "@/lib/store.js";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const store = await getStore();
  const surgeons = await store.surgeons.list();

  return ok({
    status: "ok",
    runtime: describeRuntime(),
    counts: { surgeons: surgeons.length },
    notes: [
      "All personnel and case data is synthetic. No real surgeon, patient, or hospital is represented.",
      "This system stores no patient data of any kind.",
      "Fatigue scoring is decision support, not a medical device, and does not diagnose.",
    ],
  });
});
