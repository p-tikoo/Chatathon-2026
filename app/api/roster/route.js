/**
 * GET /api/roster
 *
 * THE DIRECTOR HEATMAP ENDPOINT. This is the one that makes the product a
 * workplace tool rather than another wellness tracker, so it is the one that
 * must not be cut.
 *
 * Returns the whole department as forward-looking risk tiers over the next
 * 24-48 hours, before the schedule locks.
 *
 * WHAT A DIRECTOR GETS, AND WHAT THEY DO NOT
 * ------------------------------------------
 *   YES: name, specialty, on-call status, a green/amber/red tier, the number of
 *        upcoming cases, duty-hour compliance status, and the projected tier
 *        per 6-hour block across the horizon.
 *   NO:  the numeric alertness score, the reasoning, the driver breakdown,
 *        hours slept, recovery score, HRV, or any raw biometric value.
 *
 * That restriction is enforced by redactFatigue() in lib/privacy.js and is not
 * configurable by the director, the surgeon, or an admin. The reasoning is in
 * the header comment of lib/privacy.js and it is the single most important
 * thing to say in the ethics section of the pitch.
 *
 * Query params:
 *   horizon_hours  24 | 48 (default 48)
 *   specialty      filter
 *   tier           filter to green|amber|red
 */

import { assessRoster } from "@/lib/assessment.js";
import { ApiError, getViewer, handler, ok } from "@/lib/http.js";
import { redactFatigue, redactSurgeon } from "@/lib/privacy.js";
import { getStore } from "@/lib/store.js";

export const dynamic = "force-dynamic";

const BLOCK_HOURS = 6;

export const GET = handler(async (request) => {
  const viewer = getViewer(request);
  const url = new URL(request.url);

  if (!["director", "admin", "self", "colleague"].includes(viewer.role)) {
    throw new ApiError(
      403,
      "The roster view requires a director, admin, colleague, or self viewer role. Set the x-viewer-role header.",
    );
  }

  const horizonHours = Math.min(
    Math.max(Number.parseInt(url.searchParams.get("horizon_hours") ?? "48", 10) || 48, 12),
    72,
  );
  const specialtyFilter = url.searchParams.get("specialty");
  const tierFilter = url.searchParams.get("tier");

  const store = await getStore();
  const at = new Date();
  const results = await assessRoster(store, { at, horizonHours });

  let rows = results.map(({ surgeon, assessment }) => {
    const redactedFatigue = redactFatigue(assessment, viewer, surgeon.id);

    return {
      surgeon: redactSurgeon(surgeon, viewer),
      // Tier only for leadership; the full object only if it's your own record.
      fatigue: redactedFatigue,
      // Coarse forward view: the worst tier in each 6-hour block. Enough to
      // colour a heatmap cell, not enough to reverse-engineer the score.
      forecast: summarizeForecast(assessment.projection, horizonHours),
      upcoming_cases: assessment.upcoming_cases,
      duty_hours: {
        compliant: assessment.duty_hours.compliant,
        regulatory: assessment.duty_hours.regulatory,
        violation_count: assessment.duty_hours.violation_count,
        warning_count: assessment.duty_hours.warning_count,
        summary: assessment.duty_hours.summary,
      },
      // Surfaced deliberately: a confident-looking tier computed from two data
      // points is how these systems lose the trust of the people they schedule.
      confidence: assessment.confidence.level,
      _tier_for_filter: assessment.tier,
    };
  });

  if (specialtyFilter) rows = rows.filter((r) => r.surgeon.specialty === specialtyFilter);
  if (tierFilter) rows = rows.filter((r) => r._tier_for_filter === tierFilter);

  const summary = {
    total: rows.length,
    green: rows.filter((r) => r._tier_for_filter === "green").length,
    amber: rows.filter((r) => r._tier_for_filter === "amber").length,
    red: rows.filter((r) => r._tier_for_filter === "red").length,
    on_call: rows.filter((r) => r.surgeon.on_call).length,
    duty_hour_violations: rows.filter((r) => !r.duty_hours.compliant).length,
  };

  // Sort worst-first: the director should see the problems without scrolling.
  const order = { red: 0, amber: 1, green: 2 };
  rows.sort((a, b) => order[a._tier_for_filter] - order[b._tier_for_filter]);

  return ok({
    roster: rows.map(({ _tier_for_filter, ...rest }) => rest),
    summary,
    horizon_hours: horizonHours,
    generated_at: at.toISOString(),
    scoring: {
      method: "deterministic",
      note: "The roster is scored deterministically for speed and reproducibility. Open a single surgeon to generate the LLM narrative for that person.",
    },
    privacy_notice:
      "Leadership views show risk tiers only. Numeric scores, fatigue reasoning, and all sleep and biometric data are visible solely to the individual surgeon and cannot be exposed by any setting.",
  });
});

/** Worst projected tier per 6-hour block — one heatmap cell each. */
function summarizeForecast(projection, horizonHours) {
  const blocks = [];
  const series = projection?.series ?? [];
  if (series.length === 0) return blocks;

  const severity = { green: 0, amber: 1, red: 2 };
  const label = ["green", "amber", "red"];

  for (let start = 0; start < horizonHours; start += BLOCK_HOURS) {
    const slice = series.filter((p, i) => i >= start && i < start + BLOCK_HOURS);
    if (slice.length === 0) continue;

    const worst = slice.reduce((acc, p) => Math.max(acc, severity[p.tier] ?? 0), 0);
    blocks.push({
      starts_at: slice[0].t,
      hours: slice.length,
      tier: label[worst],
      // Whether the surgeon is actually scheduled to work in this block. A red
      // tier at 03:00 while someone is asleep at home is not a scheduling risk,
      // and colouring it red would train directors to ignore the heatmap.
      has_scheduled_work: slice.some((p) => p.busy),
    });
  }
  return blocks;
}
