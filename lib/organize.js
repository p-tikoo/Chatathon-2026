/**
 * SCHEDULE ORGANIZATION ENGINE
 * ============================================================================
 * Takes every surgery and event in a window and organizes the whole board:
 * scores each case on complexity and cognitive load, matches each against the
 * assigned surgeon's predicted state at that moment, sorts on whichever axis
 * the user wants, detects structural problems, and hands the result to the LLM
 * for a scheduler's action plan.
 *
 * THE SIX SORT AXES, AND WHY EACH ONE EXISTS
 * ------------------------------------------
 *   chronological  What's happening, in order. The default calendar view.
 *   urgency        Emergent first. What a trauma lead needs.
 *   complexity     Technically hardest first. Resource and equipment planning.
 *   cognitive      Most mind-burning first. The SURG-TLX axis — this is the
 *                  one that surfaces the short, brutal, high-stakes cases that
 *                  every duration-based system renders invisible.
 *   mismatch       Demand-vs-capacity risk first. THE DEFAULT, and the one that
 *                  matters: it surfaces where a hard case has landed on a
 *                  depleted surgeon, which is the actual thing this product
 *                  exists to prevent. Neither "hardest cases" nor "most tired
 *                  surgeons" finds those on its own.
 *   balanced       A weighted composite for a general triage view.
 *
 * DIVISION OF LABOUR WITH THE LLM
 * -------------------------------
 * Everything above is deterministic. Sorting is something code does correctly,
 * cheaply, and identically every time; an LLM would be worse on all three.
 *
 * The LLM gets the sorted, scored, flagged board and answers the question code
 * cannot: what should a human DO about it. Which three of forty cases matter.
 * Which two problems share a root cause. Where fixing one thing breaks another.
 * That is judgment over structured data, and it is where the model earns its
 * place in the pipeline.
 *
 * Every LLM path here degrades to the deterministic board on failure. The sort,
 * the scores, and the flags never depend on an API call succeeding.
 * ============================================================================
 */

import { assessSurgeon, enrichCases } from "./assessment.js";
import { cognitiveLoad, cognitiveProfile, demandCapacityMismatch } from "./cognitive.js";
import { tryGenerateJSON } from "./llm.js";
import {
  ORGANIZE_SCHEMA,
  ORGANIZE_SYSTEM,
  buildOrganizeUserPrompt,
  validateOrganizeOutput,
} from "./prompts.js";

const HOUR = 3600000;

export const SORT_AXES = [
  "mismatch",
  "cognitive",
  "complexity",
  "urgency",
  "chronological",
  "balanced",
];

export const GROUP_BY = ["none", "surgeon", "day", "specialty", "mind_burn", "risk"];

/**
 * Organize the board.
 *
 * @param {Object} store
 * @param {Object} opts
 * @param {Date}   opts.from
 * @param {Date}   opts.to
 * @param {string} [opts.sortBy]   one of SORT_AXES (default "mismatch")
 * @param {string} [opts.groupBy]  one of GROUP_BY (default "none")
 * @param {boolean}[opts.useLLM]   generate the action plan (default true)
 */
export async function organizeBoard(store, opts = {}) {
  const {
    from,
    to,
    sortBy = "mismatch",
    groupBy = "none",
    useLLM = true,
    specialty = null,
  } = opts;

  const at = new Date();

  const [allCases, surgeons] = await Promise.all([
    store.cases.list({ from, to }),
    store.surgeons.list(),
  ]);

  const surgeonById = new Map(surgeons.map((s) => [s.id, s]));

  // --- Assess every surgeon who appears on the board, once -----------------
  // Assessing per-case would re-run the fatigue model dozens of times for the
  // same person. Build the map first.
  const involvedIds = [...new Set(allCases.map((c) => c.surgeon_id).filter(Boolean))];
  const assessments = new Map();
  const profiles = new Map();

  for (const id of involvedIds) {
    const assessment = await assessSurgeon(store, id, { useLLM: false, at });
    if (assessment) assessments.set(id, assessment);

    // Person-specific cognitive sensitivity, learned from their own ratings.
    const history = await store.cases.list({ surgeonId: id });
    const rated = enrichCases(history, { surgeonId: id })
      .filter((c) => Number.isFinite(Number(c.perceived_exertion)))
      .map((c) => ({
        perceived_exertion: c.perceived_exertion,
        duration_hrs: c.duration_hrs,
        cognitive_load: cognitiveLoad(c).cognitive_load,
      }));
    profiles.set(id, cognitiveProfile(rated));
  }

  // --- Score every case ----------------------------------------------------
  const items = [];
  let refCounter = 1;

  for (const c of allCases) {
    if (specialty && c.specialty !== specialty) continue;

    const cognitive = cognitiveLoad(c);
    const surgeon = c.surgeon_id ? surgeonById.get(c.surgeon_id) : null;
    const assessment = c.surgeon_id ? assessments.get(c.surgeon_id) : null;
    const profile = c.surgeon_id ? profiles.get(c.surgeon_id) : null;

    const scheduledAt = new Date(c.scheduled_at);
    const projected = assessment
      ? projectedScoreAt(assessment.projection, scheduledAt)
      : null;

    const mismatch =
      assessment !== null
        ? demandCapacityMismatch(
            cognitive.cognitive_load,
            projected ?? assessment.score,
            { cognitiveSensitivity: profile?.cognitive_sensitivity },
          )
        : null;

    items.push({
      // Stable reference the LLM uses instead of a case id — keeps the prompt
      // de-identified and makes hallucinated references easy to detect.
      ref: `REF-${refCounter++}`,
      case_id: c.id,
      procedure_name: c.procedure_name,
      cpt: c.cpt,
      specialty: c.specialty,
      scheduled_at: c.scheduled_at,
      ends_at: new Date(scheduledAt.getTime() + (Number(c.duration_hrs) || 2) * HOUR).toISOString(),
      duration_hrs: c.duration_hrs,
      is_emergent: Boolean(c.is_emergent),
      status: c.status,

      complexity_score: c.complexity_score,
      complexity_tier: c.complexity_tier,
      fatigue_load: c.fatigue_load,

      cognitive_load: cognitive.cognitive_load,
      mind_burn: cognitive.mind_burn,
      cognitive_dimensions: cognitive.dimensions,
      dominant_dimensions: cognitive.dominant_dimensions,
      cognitive_recovery_hours: cognitive.cognitive_recovery_hours,

      surgeon_id: c.surgeon_id ?? null,
      surgeon_name: surgeon?.name ?? null,
      surgeon_alias: c.surgeon_id ? `S${c.surgeon_id}` : null,
      surgeon_tier: assessment?.tier ?? null,
      projected_alertness: projected ?? assessment?.score ?? null,

      mismatch_score: mismatch?.mismatch_score ?? null,
      risk_level: mismatch?.risk_level ?? (c.surgeon_id ? null : "unassigned"),
      mismatch_explanation: mismatch?.explanation ?? null,
    });
  }

  // --- Structural problem detection (deterministic) ------------------------
  const flags = detectFlags(items, assessments, surgeonById);

  // --- Sort ----------------------------------------------------------------
  const sorted = sortItems(items, sortBy);

  // --- Per-surgeon workload rollup -----------------------------------------
  const workload = buildWorkloadSummary(sorted, surgeonById, assessments, profiles);

  const board = {
    window: { from: from.toISOString(), to: to.toISOString() },
    sorted_by: sortBy,
    grouped_by: groupBy,
    count: sorted.length,
    items: groupBy === "none" ? sorted : undefined,
    groups: groupBy === "none" ? undefined : groupItems(sorted, groupBy),
    flags,
    workload,
    summary: buildSummary(sorted, flags),
    sort_axes_available: SORT_AXES,
    generated_at: at.toISOString(),
  };

  if (!useLLM || sorted.length === 0) {
    return {
      ...board,
      plan: null,
      method: sorted.length === 0 ? "empty-board" : "deterministic",
    };
  }

  // --- LLM action plan ------------------------------------------------------
  const llm = await tryGenerateJSON({
    system: ORGANIZE_SYSTEM,
    user: buildOrganizeUserPrompt({
      // Cap what goes to the model. A 200-case board would blow the context
      // and produce worse advice than the top slice by risk.
      items: sorted.slice(0, 40),
      surgeons: workload.map((w) => ({
        alias: w.alias,
        specialty: w.specialty,
        fatigue_tier: w.fatigue_tier,
        case_count: w.case_count,
        total_cognitive_load: w.total_cognitive_load,
        max_cognitive_load: w.max_cognitive_load,
        cognitive_sensitivity: w.cognitive_sensitivity,
      })),
      window: board.window,
      sortBy,
      flags,
    }),
    schema: ORGANIZE_SCHEMA,
    maxTokens: 1800,
  });

  if (!llm.ok) {
    return {
      ...board,
      plan: null,
      method: "deterministic-fallback",
      llm_status: { ok: false, code: llm.code, message: llm.error },
      note: "The board is fully scored, sorted, and flagged. Only the AI narrative plan is unavailable.",
    };
  }

  const validRefs = sorted.map((i) => i.ref);
  const plan = validateOrganizeOutput(llm.data, validRefs);

  // Resolve REF ids back to real cases for the UI. The model only ever saw refs.
  const refMap = new Map(sorted.map((i) => [i.ref, i]));
  const resolvedActions = plan.priority_actions.map((a) => {
    const item = refMap.get(a.case_ref);
    return {
      ...a,
      case_id: item?.case_id ?? null,
      procedure_name: item?.procedure_name ?? null,
      surgeon_name: item?.surgeon_name ?? null,
      scheduled_at: item?.scheduled_at ?? null,
    };
  });

  return {
    ...board,
    plan: { ...plan, priority_actions: resolvedActions },
    method: "llm-assisted",
    llm_status: {
      ok: true,
      provider: llm.provider,
      model: llm.model,
      latency_ms: llm.latency_ms,
      attempts: llm.attempts,
    },
  };
}

// ---------------------------------------------------------------------------
// sorting
// ---------------------------------------------------------------------------

function sortItems(items, axis) {
  const byTime = (a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at);
  const list = [...items];

  switch (axis) {
    case "chronological":
      return list.sort(byTime);

    case "urgency":
      // Emergent first, then soonest. Within emergent, time still governs.
      return list.sort((a, b) => {
        if (a.is_emergent !== b.is_emergent) return a.is_emergent ? -1 : 1;
        return byTime(a, b);
      });

    case "complexity":
      return list.sort((a, b) => (b.complexity_score ?? 0) - (a.complexity_score ?? 0) || byTime(a, b));

    case "cognitive":
      return list.sort((a, b) => (b.cognitive_load ?? 0) - (a.cognitive_load ?? 0) || byTime(a, b));

    case "balanced":
      return list.sort((a, b) => balancedPriority(b) - balancedPriority(a) || byTime(a, b));

    case "mismatch":
    default:
      // Unassigned cases sort to the very top: an unassigned case has no
      // mismatch score precisely because nobody is doing it, and that is the
      // most urgent kind of gap on a board, not the least.
      return list.sort((a, b) => {
        const aUn = a.surgeon_id === null;
        const bUn = b.surgeon_id === null;
        if (aUn !== bUn) return aUn ? -1 : 1;
        return (b.mismatch_score ?? -1) - (a.mismatch_score ?? -1) || byTime(a, b);
      });
  }
}

/** Composite triage priority for the "balanced" axis. */
function balancedPriority(item) {
  const urgency = item.is_emergent ? 100 : 30;
  return (
    0.34 * (item.mismatch_score ?? 0) +
    0.26 * (item.cognitive_load ?? 0) +
    0.22 * urgency +
    0.18 * (item.complexity_score ?? 0)
  );
}

function groupItems(items, groupBy) {
  const keyFor = (i) => {
    switch (groupBy) {
      case "surgeon":
        return i.surgeon_name ?? "Unassigned";
      case "day":
        return i.scheduled_at.slice(0, 10);
      case "specialty":
        return i.specialty ?? "Unspecified";
      case "mind_burn":
        return i.mind_burn;
      case "risk":
        return i.risk_level ?? "unknown";
      default:
        return "all";
    }
  };

  const map = new Map();
  for (const i of items) {
    const k = keyFor(i);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }

  return [...map.entries()].map(([key, groupItemsList]) => ({
    key,
    count: groupItemsList.length,
    total_cognitive_load: round1(
      groupItemsList.reduce((s, i) => s + (i.cognitive_load ?? 0), 0),
    ),
    max_mismatch: Math.max(0, ...groupItemsList.map((i) => i.mismatch_score ?? 0)),
    items: groupItemsList,
  }));
}

// ---------------------------------------------------------------------------
// structural problem detection
// ---------------------------------------------------------------------------

/**
 * Problems that are invisible in any per-case score, because they are
 * properties of the board rather than of a case.
 */
function detectFlags(items, assessments, surgeonById) {
  const flags = [];

  // --- Unassigned cases ----------------------------------------------------
  for (const i of items.filter((x) => x.surgeon_id === null)) {
    flags.push({
      severity: i.is_emergent ? "critical" : "warning",
      type: "unassigned",
      ref: i.ref,
      case_id: i.case_id,
      message: `${i.procedure_name} at ${i.scheduled_at} has no assigned surgeon${i.is_emergent ? " and is EMERGENT" : ""}.`,
    });
  }

  // --- High demand-capacity mismatch --------------------------------------
  for (const i of items.filter((x) => (x.mismatch_score ?? 0) >= 55)) {
    flags.push({
      severity: "critical",
      type: "demand_capacity_mismatch",
      ref: i.ref,
      case_id: i.case_id,
      message: `${i.procedure_name} carries cognitive load ${i.cognitive_load} (${i.mind_burn}) but ${i.surgeon_name} is projected at ${i.projected_alertness} alertness (${i.surgeon_tier}) at that time. Mismatch ${i.mismatch_score}.`,
    });
  }

  // --- Per-surgeon sequencing ---------------------------------------------
  const bySurgeon = new Map();
  for (const i of items) {
    if (!i.surgeon_id) continue;
    if (!bySurgeon.has(i.surgeon_id)) bySurgeon.set(i.surgeon_id, []);
    bySurgeon.get(i.surgeon_id).push(i);
  }

  for (const [surgeonId, list] of bySurgeon) {
    const chrono = [...list].sort(
      (a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at),
    );
    const name = surgeonById.get(surgeonId)?.name ?? `Surgeon ${surgeonId}`;

    for (let n = 1; n < chrono.length; n += 1) {
      const prev = chrono[n - 1];
      const curr = chrono[n];
      const gapHours = (new Date(curr.scheduled_at) - new Date(prev.ends_at)) / HOUR;

      // Double booking.
      if (gapHours < 0) {
        flags.push({
          severity: "critical",
          type: "double_booked",
          ref: curr.ref,
          case_id: curr.case_id,
          message: `${name} is double-booked: ${prev.procedure_name} overruns into ${curr.procedure_name} by ${Math.abs(round1(gapHours))}h.`,
        });
        continue;
      }

      // Cognitive stacking. This is the flag that justifies the whole
      // cognitive model existing — two heavy cases back to back, where each
      // one individually looks acceptable, and the gap is shorter than the
      // recovery tail of the first.
      if (
        prev.cognitive_load >= 70 &&
        curr.cognitive_load >= 70 &&
        gapHours < prev.cognitive_recovery_hours
      ) {
        flags.push({
          severity: "warning",
          type: "cognitive_stacking",
          ref: curr.ref,
          case_id: curr.case_id,
          message: `${name} has two high-cognitive-load cases ${round1(gapHours)}h apart (${prev.cognitive_load} then ${curr.cognitive_load}). The first has an estimated ${prev.cognitive_recovery_hours}h cognitive recovery tail — the second starts before it clears.`,
        });
      }
    }

    // --- Duty hours across the whole assigned board ------------------------
    const surgeon = surgeonById.get(surgeonId);
    const assessment = assessments.get(surgeonId);
    if (surgeon && assessment && !assessment.duty_hours.compliant) {
      flags.push({
        severity: assessment.duty_hours.regulatory ? "critical" : "warning",
        type: "duty_hours",
        ref: null,
        surgeon_id: surgeonId,
        message: `${name}: ${assessment.duty_hours.summary}`,
      });
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------------------------------------------------------------------------
// rollups
// ---------------------------------------------------------------------------

function buildWorkloadSummary(items, surgeonById, assessments, profiles) {
  const bySurgeon = new Map();

  for (const i of items) {
    if (!i.surgeon_id) continue;
    if (!bySurgeon.has(i.surgeon_id)) bySurgeon.set(i.surgeon_id, []);
    bySurgeon.get(i.surgeon_id).push(i);
  }

  const rows = [...bySurgeon.entries()].map(([id, list]) => {
    const surgeon = surgeonById.get(id);
    const assessment = assessments.get(id);
    const profile = profiles.get(id);

    return {
      surgeon_id: id,
      alias: `S${id}`,
      surgeon_name: surgeon?.name ?? null,
      specialty: surgeon?.specialty ?? null,
      fatigue_tier: assessment?.tier ?? null,
      case_count: list.length,
      total_hours: round1(list.reduce((s, i) => s + (Number(i.duration_hrs) || 0), 0)),
      total_cognitive_load: round1(list.reduce((s, i) => s + (i.cognitive_load ?? 0), 0)),
      max_cognitive_load: Math.max(0, ...list.map((i) => i.cognitive_load ?? 0)),
      heavy_case_count: list.filter((i) => ["heavy", "extreme"].includes(i.mind_burn)).length,
      max_mismatch: Math.max(0, ...list.map((i) => i.mismatch_score ?? 0)),
      cognitive_sensitivity: profile?.cognitive_sensitivity ?? 1,
      dominant_cost: profile?.dominant_cost ?? "unknown",
    };
  });

  // Sort by cognitive burden carried, so the person absorbing the heavy work is
  // the first row a director sees. That distribution question is invisible
  // case-by-case and is how the most reliable surgeon in a department burns out.
  return rows.sort((a, b) => b.total_cognitive_load - a.total_cognitive_load);
}

function buildSummary(items, flags) {
  const assigned = items.filter((i) => i.surgeon_id !== null);
  const mismatches = assigned.map((i) => i.mismatch_score ?? 0);

  return {
    total_cases: items.length,
    unassigned: items.length - assigned.length,
    emergent: items.filter((i) => i.is_emergent).length,
    by_mind_burn: {
      light: items.filter((i) => i.mind_burn === "light").length,
      moderate: items.filter((i) => i.mind_burn === "moderate").length,
      heavy: items.filter((i) => i.mind_burn === "heavy").length,
      extreme: items.filter((i) => i.mind_burn === "extreme").length,
    },
    by_risk: {
      high: assigned.filter((i) => i.risk_level === "high").length,
      elevated: assigned.filter((i) => i.risk_level === "elevated").length,
      watch: assigned.filter((i) => i.risk_level === "watch").length,
      low: assigned.filter((i) => i.risk_level === "low").length,
    },
    mean_cognitive_load: items.length
      ? round1(items.reduce((s, i) => s + (i.cognitive_load ?? 0), 0) / items.length)
      : 0,
    max_mismatch: mismatches.length ? Math.max(...mismatches) : 0,
    critical_flags: flags.filter((f) => f.severity === "critical").length,
    warning_flags: flags.filter((f) => f.severity === "warning").length,
  };
}

function projectedScoreAt(projection, when) {
  if (!projection?.series?.length) return null;
  const target = when.getTime();
  let best = null;
  for (const p of projection.series) {
    const diff = Math.abs(new Date(p.t).getTime() - target);
    if (best === null || diff < best.diff) best = { diff, score: p.score };
  }
  return best && best.diff <= 1.5 * HOUR ? best.score : null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
