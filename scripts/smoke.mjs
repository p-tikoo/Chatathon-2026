#!/usr/bin/env node
/**
 * SMOKE TEST
 * ===========================================================================
 *   npm run dev          (in one terminal)
 *   npm run smoke        (in another)
 *
 * Exercises every endpoint against a running server and asserts the things
 * that actually matter — especially the privacy rules, which are the easiest
 * thing to break with a well-intentioned refactor and the most expensive thing
 * to have broken on stage.
 *
 * Run this before the demo, and run it after every merge to main.
 *
 * Pass a different base URL as the first argument to test the deployed build:
 *   node scripts/smoke.mjs https://your-app.vercel.app
 * ===========================================================================
 */

const BASE = process.argv[2] ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(path, { method = "GET", body, viewer } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (viewer) {
    headers["x-viewer-role"] = viewer.role;
    if (viewer.id != null) headers["x-viewer-id"] = String(viewer.id);
  }
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* non-JSON response */
  }
  return { status: response.status, json };
}

const SELF = { role: "self", id: 1 };
const DIRECTOR = { role: "director" };
const COLLEAGUE = { role: "colleague", id: 2 };

async function main() {
  console.log(`\nSmoke testing ${BASE}\n`);

  // --- health ---------------------------------------------------------------
  console.log("health");
  const health = await call("/api/health");
  check("GET /api/health returns 200", health.status === 200, `got ${health.status}`);
  check("reports a store backend", Boolean(health.json?.data?.runtime?.store));
  check("reports a scoring mode", Boolean(health.json?.data?.runtime?.scoring_mode));
  if (health.status !== 200) {
    console.error("\n✗ Server is not responding. Is `npm run dev` running?\n");
    process.exit(1);
  }
  console.log(
    `    store=${health.json.data.runtime.store} llm=${health.json.data.runtime.llm_provider} ` +
      `enabled=${health.json.data.runtime.llm_enabled} mode=${health.json.data.runtime.scoring_mode}`,
  );

  // --- surgeons + privacy ---------------------------------------------------
  console.log("\nsurgeons & privacy redaction");
  const asSelf = await call("/api/surgeons/1", { viewer: SELF });
  check("self can read own profile", asSelf.status === 200);
  check(
    "self sees own sleep baseline",
    asSelf.json?.data?.surgeon?.baseline_sleep_hrs !== undefined,
  );

  const asDirector = await call("/api/surgeons/1", { viewer: DIRECTOR });
  check("director can read a profile", asDirector.status === 200);
  check(
    "director does NOT see sleep baseline (biometric hard rule)",
    asDirector.json?.data?.surgeon?.baseline_sleep_hrs === undefined,
  );
  check(
    "director does NOT see email (private by default)",
    asDirector.json?.data?.surgeon?.email === undefined,
  );
  check(
    "withheld fields are declared, not silently dropped",
    (asDirector.json?.data?.surgeon?._privacy?.withheld_count ?? 0) > 0,
  );

  // --- sleep: the hard rule -------------------------------------------------
  console.log("\nsleep logs (self-only hard rule)");
  const sleepSelf = await call("/api/sleep?surgeon_id=1&days=7", { viewer: SELF });
  check("self can read own sleep logs", sleepSelf.status === 200);
  check("sleep stats are returned", sleepSelf.json?.data?.stats !== undefined);

  const sleepDirector = await call("/api/sleep?surgeon_id=1&days=7", { viewer: DIRECTOR });
  check(
    "director is BLOCKED from sleep logs (403)",
    sleepDirector.status === 403,
    `got ${sleepDirector.status}`,
  );

  const sleepColleague = await call("/api/sleep?surgeon_id=1&days=7", { viewer: COLLEAGUE });
  check("colleague is BLOCKED from sleep logs (403)", sleepColleague.status === 403);

  // --- fatigue --------------------------------------------------------------
  console.log("\nfatigue scoring");
  const fatigueSelf = await call("/api/fatigue?surgeon_id=1", { viewer: SELF });
  check("self gets a fatigue assessment", fatigueSelf.status === 200);
  const a = fatigueSelf.json?.data?.assessment;
  check("score is 0-100", Number.isFinite(a?.score) && a.score >= 0 && a.score <= 100, `score=${a?.score}`);
  check("tier is green/amber/red", ["green", "amber", "red"].includes(a?.tier));
  check("reasoning names specific drivers", typeof a?.reasoning === "string" && a.reasoning.length > 20);
  check("projection series is populated", (a?.projection?.series?.length ?? 0) > 24);
  check("component breakdown is present", Object.keys(a?.components ?? {}).length === 6);
  check("confidence is reported", Boolean(a?.confidence?.level));

  const fatigueDirector = await call("/api/fatigue?surgeon_id=1", { viewer: DIRECTOR });
  const da = fatigueDirector.json?.data?.assessment;
  check("director gets a tier", ["green", "amber", "red"].includes(da?.tier));
  check("director does NOT get the numeric score", da?.score === undefined, `score=${da?.score}`);
  check("director does NOT get the reasoning", da?.reasoning === undefined);
  check("director does NOT get the component breakdown", da?.components === undefined);
  check("redaction level is declared", da?._privacy?.level === "tier-only");

  // --- roster ---------------------------------------------------------------
  console.log("\nroster (director heatmap)");
  const roster = await call("/api/roster?horizon_hours=48", { viewer: DIRECTOR });
  check("director can load the roster", roster.status === 200);
  const rows = roster.json?.data?.roster ?? [];
  check("roster has surgeons", rows.length >= 10, `got ${rows.length}`);
  check(
    "summary counts tiers",
    Number.isFinite(roster.json?.data?.summary?.red) &&
      Number.isFinite(roster.json?.data?.summary?.green),
  );
  check(
    "seeded demo has at least one red surgeon",
    (roster.json?.data?.summary?.red ?? 0) > 0,
    `red=${roster.json?.data?.summary?.red}`,
  );
  check("every row carries a forecast", rows.every((r) => Array.isArray(r.forecast)));
  check(
    "no row leaks a numeric score to the director",
    rows.every((r) => r.fatigue?.score === undefined),
  );

  // --- procedures -----------------------------------------------------------
  console.log("\nprocedure catalog");
  const procs = await call("/api/procedures?q=valve");
  check("catalog search works", procs.status === 200 && (procs.json?.data?.count ?? 0) > 0);
  const cpt = await call("/api/procedures?cpt=33405");
  check("CPT lookup works", cpt.json?.data?.procedure?.cpt === "33405");
  check("RVU disclaimer is present", typeof cpt.json?.data?.disclaimer === "string");

  const classify = await call("/api/procedures/classify", {
    method: "POST",
    viewer: DIRECTOR,
    body: { procedure_name: "Laparoscopic cholecystectomy" },
  });
  check("known procedure classifies from the catalog with no LLM call", classify.json?.data?.llm_used === false);

  // --- cases + exertion -----------------------------------------------------
  console.log("\ncases");
  const cases = await call("/api/cases?surgeon_id=1", { viewer: SELF });
  check("cases list works", cases.status === 200);
  check("cases have complexity", (cases.json?.data?.cases ?? []).every((c) => c.complexity_tier));

  const newCase = await call("/api/cases", {
    method: "POST",
    viewer: DIRECTOR,
    body: {
      procedure_name: "Laparoscopic appendectomy",
      scheduled_at: new Date(Date.now() + 36 * 3600000).toISOString(),
      is_emergent: true,
    },
  });
  check("can create a case", newCase.status === 201, `got ${newCase.status}`);
  check("CPT auto-resolved from the name", newCase.json?.data?.complexity?.matched_procedure?.cpt === "44970");
  check(
    "emergent modifier applied",
    (newCase.json?.data?.complexity?.modifiers ?? []).some((m) => m.key === "emergent"),
  );
  const newCaseId = newCase.json?.data?.case?.id;

  // Reassignment must be refused here.
  const badReassign = await call(`/api/cases/${newCaseId}`, {
    method: "PATCH",
    viewer: DIRECTOR,
    body: { surgeon_id: 3 },
  });
  check(
    "PATCH /api/cases/{id} REFUSES to reassign (400)",
    badReassign.status === 400,
    `got ${badReassign.status}`,
  );

  // --- calendar -------------------------------------------------------------
  console.log("\ncalendar & privacy");
  const calSelf = await call("/api/calendar?surgeon_id=1", { viewer: SELF });
  check("self can read own calendar", calSelf.status === 200);

  const calDirector = await call("/api/calendar?surgeon_id=1", { viewer: DIRECTOR });
  check("director can read the calendar", calDirector.status === 200);
  const personal = (calDirector.json?.data?.entries ?? []).filter(
    (e) => e.kind === "personal" || e.is_private,
  );
  check(
    "private events are opaque to the director",
    personal.every((e) => e.title === "Unavailable" && e.is_private === true),
    `${personal.length} personal entries checked`,
  );

  // --- the AI organizing engine ---------------------------------------------
  console.log("\nschedule organization (AI sorting engine)");
  const board = await call("/api/schedule/organize?sort_by=mismatch", { viewer: DIRECTOR });
  check("director can organize the board", board.status === 200, `got ${board.status}`);
  const b = board.json?.data;
  check("board has cases", (b?.count ?? 0) > 0, `${b?.count} cases`);
  check("sorted_by is echoed", b?.sorted_by === "mismatch");

  const boardItems = b?.items ?? [];
  check("every case has a cognitive load", boardItems.every((i) => Number.isFinite(i.cognitive_load)));
  check(
    "every case has a mind-burn tier",
    boardItems.every((i) => ["light", "moderate", "heavy", "extreme"].includes(i.mind_burn)),
  );
  check(
    "every case has all six SURG-TLX dimensions",
    boardItems.every((i) => Object.keys(i.cognitive_dimensions ?? {}).length === 6),
  );
  check(
    "assigned cases have a mismatch score",
    boardItems.filter((i) => i.surgeon_id).every((i) => Number.isFinite(i.mismatch_score)),
  );
  check(
    "mismatch sort is descending",
    boardItems
      .filter((i) => i.surgeon_id)
      .every((i, n, arr) => n === 0 || arr[n - 1].mismatch_score >= i.mismatch_score),
  );
  check("workload rollup is present", (b?.workload?.length ?? 0) > 0);
  check(
    "workload rollup hides person-specific cognitive sensitivity from schedulers",
    (b?.workload ?? []).every((w) => w.cognitive_sensitivity === undefined),
  );
  check("summary breaks down by mind_burn", Boolean(b?.summary?.by_mind_burn));
  console.log(
    `    ${b?.count} cases | mean cognitive ${b?.summary?.mean_cognitive_load} | ` +
      `max mismatch ${b?.summary?.max_mismatch} | ${b?.summary?.critical_flags} critical flags`,
  );

  // Every sort axis must work and must not lose or duplicate cases.
  for (const axis of ["cognitive", "complexity", "urgency", "chronological", "balanced"]) {
    const sorted = await call(`/api/schedule/organize?sort_by=${axis}`, { viewer: DIRECTOR });
    check(
      `sort_by=${axis} returns the same case count`,
      sorted.json?.data?.count === b?.count,
      `${sorted.json?.data?.count} vs ${b?.count}`,
    );
  }

  const cogSorted = await call("/api/schedule/organize?sort_by=cognitive", { viewer: DIRECTOR });
  check(
    "cognitive sort is descending",
    (cogSorted.json?.data?.items ?? []).every(
      (i, n, arr) => n === 0 || arr[n - 1].cognitive_load >= i.cognitive_load,
    ),
  );

  const grouped = await call("/api/schedule/organize?group_by=surgeon", { viewer: DIRECTOR });
  check("group_by=surgeon returns groups", (grouped.json?.data?.groups?.length ?? 0) > 0);
  check(
    "grouped total matches ungrouped count",
    (grouped.json?.data?.groups ?? []).reduce((s, g) => s + g.count, 0) === b?.count,
  );

  const boardBlocked = await call("/api/schedule/organize", { viewer: SELF });
  check("a surgeon cannot open the scheduling board (403)", boardBlocked.status === 403);

  // --- assignment: the money feature ----------------------------------------
  console.log("\nassignment recommendation");
  const assign = await call("/api/assign", {
    method: "POST",
    viewer: DIRECTOR,
    body: { case_id: newCaseId },
  });
  check("director can request a recommendation", assign.status === 201, `got ${assign.status}`);
  const rec = assign.json?.data;
  check("a suggestion id is returned", Number.isFinite(rec?.suggestion_id));
  check("status is pending — nothing was reassigned", rec?.status === "pending");
  check("requires_human_approval is true", rec?.requires_human_approval === true);
  check("candidates were evaluated", (rec?.candidates?.length ?? 0) > 0, `${rec?.candidates?.length} candidates`);
  check("a justification is present", typeof rec?.justification === "string" && rec.justification.length > 20);
  check(
    "candidate list exposes tiers, not scores",
    (rec?.candidates ?? []).every((c) => c.fatigue_tier && c.fatigue_score === undefined),
  );
  console.log(`    method=${rec?.method} llm_ok=${rec?.llm_status?.ok}`);

  const surgeonAsked = await call("/api/assign", {
    method: "POST",
    viewer: SELF,
    body: { case_id: newCaseId },
  });
  check("a surgeon cannot request assignments (403)", surgeonAsked.status === 403);

  // --- human approval -------------------------------------------------------
  console.log("\nhuman approval");
  if (rec?.suggestion_id && rec?.recommendation?.surgeon_id) {
    const approve = await call(`/api/assign/${rec.suggestion_id}`, {
      method: "POST",
      viewer: DIRECTOR,
      body: { decision: "approve" },
    });
    check("director can approve", approve.status === 200, `got ${approve.status}`);
    check("case is now assigned", approve.json?.data?.case?.surgeon_id === rec.recommendation.surgeon_id);

    const again = await call(`/api/assign/${rec.suggestion_id}`, {
      method: "POST",
      viewer: DIRECTOR,
      body: { decision: "approve" },
    });
    check("cannot decide the same suggestion twice (409)", again.status === 409);
  } else {
    check("recommendation produced a surgeon to approve", false, "no recommendation returned");
  }

  // --- audit ----------------------------------------------------------------
  console.log("\naudit log");
  const audit = await call("/api/audit?limit=50", { viewer: DIRECTOR });
  check("director can read the audit log", audit.status === 200);
  check("entries were recorded", (audit.json?.data?.entries?.length ?? 0) > 0);
  const auditBlocked = await call("/api/audit", { viewer: SELF });
  check("a surgeon cannot read the audit log (403)", auditBlocked.status === 403);

  const leaks = (audit.json?.data?.entries ?? []).filter(
    (e) => e.detail && ("hours_slept" in e.detail || "score" in e.detail),
  );
  check("audit log contains no biometric values", leaks.length === 0, `${leaks.length} leaking entries`);

  // --- summary --------------------------------------------------------------
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log("");
    process.exit(1);
  }
  console.log("\n✓ All checks passed.\n");
}

main().catch((error) => {
  console.error("\n✗ Smoke test crashed:", error.message);
  console.error("  Is the dev server running?  npm run dev\n");
  process.exit(1);
});
