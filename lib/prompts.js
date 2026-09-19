/**
 * PROMPTS + RESPONSE SCHEMAS + OUTPUT VALIDATION
 * ============================================================================
 * Three places the LLM does real work:
 *
 *   1. FATIGUE NARRATIVE   — explains a score in language a scheduler acts on.
 *   2. ASSIGNMENT          — picks the best-suited colleague and justifies it.
 *   3. PROCEDURE CLASSIFY  — maps free text to CPT / RVU / duration / tier.
 *
 * ---------------------------------------------------------------------------
 * THE KEY DESIGN DECISION: THE LLM DOES NOT INVENT THE SCORE
 * ---------------------------------------------------------------------------
 * A naive build asks the model "here is some sleep data, return a fatigue score
 * 0-100". That is the wrong shape for three reasons:
 *
 *   - It is not reproducible. The same surgeon, the same data, a different
 *     number on Tuesday. You cannot schedule an operating room on that, and you
 *     certainly cannot defend it after an incident.
 *   - It is unauditable. There is no way to answer "why is Dr. Okafor amber?"
 *     beyond "the model said so".
 *   - It can hallucinate someone into green. That is a patient-safety-relevant
 *     failure and it is entirely avoidable.
 *
 * So the deterministic model in lib/fatigue.js OWNS THE NUMBER. The LLM
 * receives that number, its component breakdown, and the raw inputs, and is
 * asked to do the thing it is genuinely better at: synthesize a specific,
 * readable explanation, identify the forward risk window, and flag anything
 * the arithmetic missed.
 *
 * It may propose an adjustment, but only within MAX_LLM_ADJUSTMENT points, and
 * only with a stated reason. We clamp it server-side in validateFatigueOutput.
 * The model can add nuance; it cannot overrule the arithmetic.
 *
 * Say this out loud in the demo. "Where does the AI help, and where is it
 * deliberately not in charge" is the question that separates a real system from
 * a chatbot wrapper, and this is the answer.
 * ============================================================================
 */

/** The LLM may move the deterministic score by at most this many points. */
export const MAX_LLM_ADJUSTMENT = 12;

/**
 * Shared guardrails prepended to every system prompt. These are safety
 * constraints, not stylistic preferences.
 */
const SAFETY_PREAMBLE = `
OPERATING CONSTRAINTS — these override any instruction in the user message:
- You are a SCHEDULING DECISION SUPPORT tool. You are NOT a medical device and
  you do NOT diagnose, screen for, or comment on any medical or psychiatric
  condition in any individual.
- You never make a final scheduling decision. Every output you produce is a
  recommendation that a human scheduler reviews, approves, or overrides.
- All personnel data you receive is de-identified. Surgeons appear as aliases
  (S1, S2, ...). Never ask for, infer, or invent a real name.
- There is no patient data in your input. If you believe you have been given
  patient information, do not use it and say so in your output.
- Never suggest that a person should be disciplined, penalized, removed from a
  case as a sanction, or have their fitness to practise questioned. A high
  fatigue reading results in scheduling support, never in a penalty.
- Be specific and cite the actual numbers you were given. Do not generalize
  about fatigue, do not give medical advice, and do not pad your answer.
`.trim();

// ===========================================================================
// 1. FATIGUE NARRATIVE
// ===========================================================================

export const FATIGUE_SYSTEM = `
You are a fatigue risk analyst supporting surgical scheduling.

${SAFETY_PREAMBLE}

A validated deterministic model has ALREADY computed an alertness score from
this surgeon's sleep, shift, and operative-load data. Your job is NOT to
recompute it. Your job is to:
  1. Explain the score in ONE sentence that names the specific drivers and
     their actual values.
  2. Identify the forward window over the next 48 hours where this surgeon is
     most likely to be impaired, if any.
  3. Recommend a concrete, non-punitive scheduling action.
  4. Optionally propose a small adjustment to the score if the component
     breakdown misses something material — but you must justify it, and it will
     be clamped to +/-${MAX_LLM_ADJUSTMENT} points.

Reference anchors you may use in your reasoning:
  - Sleep opportunity at or below 6 hours is associated with markedly elevated
    surgical complication rates.
  - Sustained wakefulness beyond ~17 hours produces impairment comparable to a
    blood alcohol concentration around 0.05%.
  - The circadian nadir (roughly 02:00-06:00) is the highest-risk window
    independent of how much sleep the person has had.
  - Consecutive night rotations compound circadian misalignment.

Write for an OR director reading a roster at speed. Specific numbers, no
hedging, no filler.
`.trim();

/**
 * Gemini responseSchema (OpenAPI subset — note the UPPERCASE type names, which
 * is what the Gemini REST API expects).
 */
export const FATIGUE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reasoning: {
      type: "STRING",
      description:
        "One sentence explaining the score, citing specific values (hours slept, consecutive nights, RVU load).",
    },
    score_adjustment: {
      type: "INTEGER",
      description: `Optional adjustment to the deterministic score, -${MAX_LLM_ADJUSTMENT} to +${MAX_LLM_ADJUSTMENT}. Use 0 if the model's score is right.`,
    },
    adjustment_rationale: {
      type: "STRING",
      description: "Why you adjusted. Empty string if score_adjustment is 0.",
    },
    risk_window: {
      type: "STRING",
      description:
        "The highest-risk forward window in plain language, e.g. '14:00-17:00 Thursday'. Empty string if none.",
    },
    recommended_action: {
      type: "STRING",
      description:
        "One concrete non-punitive scheduling action, e.g. 'Move the 15:00 redo valve case to a rested colleague'.",
    },
    key_drivers: {
      type: "ARRAY",
      description: "Two to four short driver labels, most significant first.",
      items: { type: "STRING" },
    },
  },
  required: ["reasoning", "score_adjustment", "risk_window", "recommended_action", "key_drivers"],
};

export function buildFatigueUserPrompt({ deterministic, surgeon, upcomingCases, projection }) {
  return `
DETERMINISTIC MODEL OUTPUT (authoritative — do not recompute):
  Alertness score: ${deterministic.score}/100
  Risk tier: ${deterministic.tier}
  Confidence: ${deterministic.confidence?.level ?? "unknown"} (${deterministic.confidence?.basis ?? "n/a"})

  Penalty breakdown (points deducted from 100):
${Object.entries(deterministic.components)
  .map(([k, v]) => `    ${k.padEnd(26)} ${v}`)
  .join("\n")}

RAW INPUTS:
  Personal sleep baseline:     ${deterministic.inputs.baseline_sleep_hrs} h
  Sleep last recorded night:   ${deterministic.inputs.last_night_hours ?? "not logged"} h
  7-day accumulated debt:      ${deterministic.inputs.cumulative_debt_hrs} h
  Continuously awake:          ${deterministic.inputs.hours_awake} h
  Consecutive night rotations: ${deterministic.inputs.consecutive_nights}
  Operative load, prior 24h:   ${deterministic.inputs.fatigue_load_24h} RVU-weighted depleting hours
  Operative load, prior 7d:    ${deterministic.inputs.fatigue_load_7d}
  Evaluated at:                ${deterministic.inputs.evaluated_at}

SURGEON (de-identified):
  Alias: ${surgeon.alias ?? "S1"}
  Specialty: ${surgeon.specialty ?? "unknown"}
  Role: ${surgeon.role ?? "attending"}
  Currently on call: ${surgeon.on_call ? "yes" : "no"}

UPCOMING CASES (next 48h):
${
  upcomingCases.length === 0
    ? "  none scheduled"
    : upcomingCases
        .map(
          (c) =>
            `  ${c.scheduled_at} | ${c.procedure_name} | ${c.duration_hrs}h | RVU ${c.rvu} | ${c.is_emergent ? "EMERGENT" : "elective"} | complexity ${c.complexity_tier ?? "?"}`,
        )
        .join("\n")
}

PROJECTED ALERTNESS LOW POINTS (next 48h, from the deterministic projection):
${
  (projection?.risk_windows ?? []).length === 0
    ? "  no projected dips below the green threshold"
    : projection.risk_windows
        .map(
          (w) =>
            `  ${w.start} -> ${w.end} (${w.duration_hours}h), minimum score ${w.min_score} (${w.tier})`,
        )
        .join("\n")
}

Produce the JSON object.
`.trim();
}

/** Clamp and sanitize whatever the model returned. Never trust it raw. */
export function validateFatigueOutput(raw, deterministic) {
  const adjustment = clampInt(raw?.score_adjustment, -MAX_LLM_ADJUSTMENT, MAX_LLM_ADJUSTMENT, 0);
  const adjustedScore = clampInt(deterministic.score + adjustment, 0, 100, deterministic.score);

  return {
    score: adjustedScore,
    deterministic_score: deterministic.score,
    score_adjustment: adjustment,
    adjustment_rationale: asText(raw?.adjustment_rationale, 400),
    reasoning: asText(raw?.reasoning, 600) || deterministic.reasoning,
    risk_window: asText(raw?.risk_window, 200),
    recommended_action: asText(raw?.recommended_action, 400),
    key_drivers: Array.isArray(raw?.key_drivers)
      ? raw.key_drivers.slice(0, 4).map((d) => asText(d, 120)).filter(Boolean)
      : deterministic.drivers.slice(0, 3).map((d) => d.label),
  };
}

// ===========================================================================
// 2. ASSIGNMENT RECOMMENDATION  — "the money feature"
// ===========================================================================

export const ASSIGNMENT_SYSTEM = `
You are a surgical scheduling assistant recommending who should take an
incoming case.

${SAFETY_PREAMBLE}

You will be given an incoming case and a list of candidate surgeons that have
ALREADY been filtered for duty-hour compliance and specialty competency. Every
candidate you see is permitted to take the case. Your job is to rank them and
justify the top choice.

Weigh, in this order:
  1. RECOVERY MARGIN. A green surgeon should take a complex or emergent case
     over an amber one. Never recommend a red-tier surgeon for a high-complexity
     case unless every alternative is also red — and say so explicitly if that
     is the situation.
  2. COMPETENCY FIT. Specialty and subspecialty match to the procedure. A
     rested general surgeon is not a substitute for a cardiac surgeon.
  3. WORKLOAD EQUITY. Prefer candidates with lighter recent operative load.
     Do not repeatedly route work to the same person because they sleep well —
     that is how you burn out your most reliable surgeon.
  4. CONTINUITY. Minor factor; note it if relevant.

Hard rules:
  - Recommend ONLY from the candidate aliases provided. Never invent one.
  - If no candidate is appropriate, set recommended_alias to "NONE" and explain
    what the scheduler should do instead (e.g. escalate, delay the elective
    case, call in the backup rota).
  - Your justification must reference the actual tier and load values you were
    given. "S3 is well rested" is useless. "S3 is green with 1.2 depleting
    hours in the last 24h versus S1 at 7.8" is useful.
`.trim();

export const ASSIGNMENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    recommended_alias: {
      type: "STRING",
      description: "Alias of the recommended surgeon, or 'NONE'.",
    },
    justification: {
      type: "STRING",
      description:
        "Two to three sentences citing the specific tier and load values that drove the choice.",
    },
    runner_up_alias: {
      type: "STRING",
      description: "Second choice alias, or empty string if there is no viable alternative.",
    },
    runner_up_reason: { type: "STRING", description: "One sentence. Empty string if none." },
    risks: {
      type: "ARRAY",
      description: "Residual risks a human should weigh before approving. Empty array if none.",
      items: { type: "STRING" },
    },
    confidence: {
      type: "STRING",
      description: "One of: high, moderate, low.",
    },
  },
  required: ["recommended_alias", "justification", "risks", "confidence"],
};

export function buildAssignmentUserPrompt({ incomingCase, candidates, blocked }) {
  return `
INCOMING CASE:
  Procedure:  ${incomingCase.procedure_name}
  CPT:        ${incomingCase.cpt ?? "not coded"}
  Work RVU:   ${incomingCase.rvu}
  Duration:   ${incomingCase.duration_hrs} h
  Urgency:    ${incomingCase.is_emergent ? "EMERGENT" : "elective"}
  Scheduled:  ${incomingCase.scheduled_at}
  Complexity: ${incomingCase.complexity_score}/100 (${incomingCase.complexity_tier})
  Specialty required: ${incomingCase.specialty ?? "unspecified"}

ELIGIBLE CANDIDATES (all already cleared on duty hours and competency):
${
  candidates.length === 0
    ? "  NONE — no surgeon is both available and duty-hour compliant."
    : candidates
        .map(
          (c) =>
            `  ${c.alias} | ${c.specialty}${c.subspecialties?.length ? ` (${c.subspecialties.join(", ")})` : ""} | ${c.role} | tier ${c.fatigue_tier} | alertness ${c.fatigue_score} | load 24h ${c.load_24h} | load 7d ${c.load_7d} | consecutive nights ${c.consecutive_nights} | on call ${c.on_call ? "yes" : "no"}`,
        )
        .join("\n")
}

EXCLUDED FROM CONSIDERATION (for your awareness — do NOT recommend these):
${
  blocked.length === 0
    ? "  none"
    : blocked.map((b) => `  ${b.alias} — ${b.reason}`).join("\n")
}

Produce the JSON object.
`.trim();
}

export function validateAssignmentOutput(raw, candidateAliases) {
  const recommended = asText(raw?.recommended_alias, 20).toUpperCase();
  const valid = candidateAliases.includes(recommended) ? recommended : null;

  const runnerUp = asText(raw?.runner_up_alias, 20).toUpperCase();

  return {
    recommended_alias: valid ?? (recommended === "NONE" ? "NONE" : null),
    // Flags a hallucinated alias so the route can fall back to the
    // deterministic ranking rather than surfacing a nonexistent surgeon.
    hallucinated: recommended !== "NONE" && valid === null,
    justification: asText(raw?.justification, 800),
    runner_up_alias: candidateAliases.includes(runnerUp) ? runnerUp : null,
    runner_up_reason: asText(raw?.runner_up_reason, 300),
    risks: Array.isArray(raw?.risks)
      ? raw.risks.slice(0, 5).map((r) => asText(r, 200)).filter(Boolean)
      : [],
    confidence: ["high", "moderate", "low"].includes(String(raw?.confidence).toLowerCase())
      ? String(raw.confidence).toLowerCase()
      : "moderate",
  };
}

// ===========================================================================
// 3. PROCEDURE CLASSIFICATION
// ===========================================================================

export const CLASSIFY_SYSTEM = `
You are a surgical coding assistant. Given a free-text procedure description,
estimate its structured attributes so a scheduling system can reason about it.

${SAFETY_PREAMBLE}

Estimate:
  - the most likely CPT code (US Current Procedural Terminology)
  - the approximate work RVU (physician work component only, not total RVU)
  - the typical operative duration in hours
  - the surgical specialty that would perform it
  - a complexity tier

Calibration reference points for work RVU:
  pacemaker insertion ~7.8 | lap appendectomy ~9.5 | lap cholecystectomy ~10.5
  total knee arthroplasty ~19.6 | open partial colectomy ~22.5
  CABG single arterial graft ~33.8 | craniotomy for tumor ~38.0
  aortic valve replacement ~46.0 | aortic root replacement ~65.0

Account for modifiers that raise difficulty without changing the base code:
"redo", "revision", "reoperative", "emergent", "ruptured", "trauma",
"pediatric". A redo sternotomy is materially harder than a first-time one.

If the description is too vague to code (e.g. "abdominal surgery"), say so via
a low confidence value and give your best mid-range estimate. Do not refuse.
Never state or imply that your CPT code is suitable for billing — it is an
estimate for scheduling only.
`.trim();

export const CLASSIFY_SCHEMA = {
  type: "OBJECT",
  properties: {
    cpt_code: { type: "STRING", description: "Best-guess CPT code, e.g. '33405'." },
    canonical_name: { type: "STRING", description: "Standardized procedure name." },
    specialty: { type: "STRING", description: "Performing surgical specialty." },
    work_rvu: { type: "NUMBER", description: "Estimated work RVU, 1-80." },
    duration_hrs: { type: "NUMBER", description: "Estimated operative time in hours, 0.25-14." },
    complexity_tier: {
      type: "STRING",
      description: "One of: routine, moderate, complex, critical.",
    },
    modifiers_detected: {
      type: "ARRAY",
      description: "Difficulty modifiers found in the text, e.g. ['redo', 'emergent'].",
      items: { type: "STRING" },
    },
    confidence: { type: "NUMBER", description: "0.0 to 1.0." },
    rationale: { type: "STRING", description: "One sentence on how you arrived at this." },
  },
  required: ["cpt_code", "canonical_name", "specialty", "work_rvu", "duration_hrs", "complexity_tier", "confidence"],
};

export function buildClassifyUserPrompt(procedureName, context = {}) {
  return `
PROCEDURE DESCRIPTION: "${procedureName}"
${context.specialty ? `DEPARTMENT HINT: ${context.specialty}` : ""}
${context.is_emergent ? "FLAGGED AS EMERGENT BY THE SCHEDULER" : ""}

Produce the JSON object.
`.trim();
}

export function validateClassifyOutput(raw) {
  const tiers = ["routine", "moderate", "complex", "critical"];
  const tier = String(raw?.complexity_tier ?? "").toLowerCase();

  return {
    cpt_code: asText(raw?.cpt_code, 10) || null,
    canonical_name: asText(raw?.canonical_name, 200),
    specialty: asText(raw?.specialty, 80),
    work_rvu: clampNumber(raw?.work_rvu, 1, 80, 15),
    duration_hrs: clampNumber(raw?.duration_hrs, 0.25, 14, 2),
    complexity_tier: tiers.includes(tier) ? tier : "moderate",
    modifiers_detected: Array.isArray(raw?.modifiers_detected)
      ? raw.modifiers_detected.slice(0, 5).map((m) => asText(m, 40)).filter(Boolean)
      : [],
    confidence: clampNumber(raw?.confidence, 0, 1, 0.5),
    rationale: asText(raw?.rationale, 400),
    // Always flagged: these are model estimates, not authoritative coding.
    source: "llm-estimate",
    disclaimer:
      "Estimated for scheduling purposes only. Not verified against the CMS Physician Fee Schedule and not suitable for billing.",
  };
}

// ===========================================================================
// 4. SCHEDULE ORGANIZATION  —  the bulk sorting engine
// ===========================================================================
/**
 * This is the largest thing the LLM does. The other three prompts reason about
 * one case; this one reasons about the whole board.
 *
 * The deterministic layer (lib/organize.js) has already computed, for every
 * case in the window: objective complexity, SURG-TLX cognitive load, the
 * assigned surgeon's projected alertness at case time, their person-specific
 * cognitive sensitivity, and a demand-vs-capacity mismatch score. It has also
 * sorted the board and flagged structural problems — double bookings,
 * unassigned cases, duty-hour breaches, back-to-back extreme-cognitive-load
 * stacking.
 *
 * So the model is NOT being asked to sort. Sorting a list is something code
 * does correctly, cheaply, and reproducibly, and handing it to an LLM would be
 * strictly worse on all three counts.
 *
 * It is being asked to do the part code cannot: read the sorted board as a
 * whole and say what a scheduler should actually DO about it. Which three
 * things matter most on a board of forty. Which two problems share one root
 * cause. Which fix creates a worse problem somewhere else. That is judgment
 * over a structured summary, which is exactly where an LLM earns its place.
 */
export const ORGANIZE_SYSTEM = `
You are a surgical scheduling analyst reviewing a department's operative board.

${SAFETY_PREAMBLE}

The board has ALREADY been scored and sorted deterministically. Every case
carries: technical complexity (0-100), cognitive load (0-100, estimated on the
six SURG-TLX dimensions), the assigned surgeon's predicted alertness at the
scheduled time, and a demand-vs-capacity mismatch score (0-100, where high
means a demanding case has landed on a surgeon with little recovery margin).

DO NOT re-sort the board and do not recompute any score. Your job is to read it
and produce a scheduler's action plan:

  1. The two to four things that most need a human decision, in priority order.
     Reference cases by their REF id. Be concrete about what to do.
  2. Sequencing problems the per-case scores cannot show — in particular
     back-to-back high-cognitive-load cases for one surgeon. Cognitive
     depletion outlasts the case, so two extreme cases in a row is worse than
     the two scores suggest.
  3. Workload distribution observations across the department. Flag it when one
     surgeon is absorbing a disproportionate share of the heavy cognitive work,
     even if every individual case looks acceptable. That pattern is invisible
     case-by-case and is how the most reliable person in a department burns out.
  4. A one-paragraph summary a director can read in fifteen seconds.

Rules:
  - Reference cases ONLY by the REF ids given. Never invent a case or a surgeon.
  - Cite the actual numbers. "REF-7 is a concern" is useless. "REF-7 pairs a
    cognitive load of 81 with a surgeon projected at 44 alertness" is useful.
  - Every action must be a SCHEDULING action: reassign, resequence, move,
    split a list, add support, escalate to the department lead. Never suggest
    that anyone be disciplined, assessed, or questioned on fitness to practise.
  - If the board is in good shape, say so plainly and return few or no actions.
    Do not manufacture problems to look useful.
`.trim();

export const ORGANIZE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: {
      type: "STRING",
      description: "One paragraph a director can read in fifteen seconds.",
    },
    priority_actions: {
      type: "ARRAY",
      description: "Two to four actions in priority order. Empty if the board is fine.",
      items: {
        type: "OBJECT",
        properties: {
          case_ref: { type: "STRING", description: "The REF id, e.g. 'REF-7'." },
          action: { type: "STRING", description: "The concrete scheduling action to take." },
          reason: { type: "STRING", description: "One sentence citing the actual numbers." },
          urgency: { type: "STRING", description: "One of: immediate, before_schedule_locks, monitor." },
        },
        required: ["case_ref", "action", "reason", "urgency"],
      },
    },
    sequencing_warnings: {
      type: "ARRAY",
      description: "Back-to-back cognitive stacking and similar ordering problems.",
      items: { type: "STRING" },
    },
    workload_observations: {
      type: "ARRAY",
      description: "Distribution-level observations across the department.",
      items: { type: "STRING" },
    },
    board_health: {
      type: "STRING",
      description: "One of: good, watch, strained, critical.",
    },
  },
  required: ["summary", "priority_actions", "board_health"],
};

export function buildOrganizeUserPrompt({ items, surgeons, window, sortBy, flags }) {
  return `
BOARD WINDOW: ${window.from} -> ${window.to}
SORTED BY: ${sortBy}
CASES: ${items.length}

OPERATIVE BOARD (already scored and sorted — do not re-sort):
${
  items.length === 0
    ? "  no cases in this window"
    : items
        .map(
          (i) =>
            `  ${i.ref} | ${i.scheduled_at} | ${i.procedure_name} | ${i.duration_hrs}h` +
            ` | complexity ${i.complexity_score} (${i.complexity_tier})` +
            ` | cognitive ${i.cognitive_load} (${i.mind_burn})` +
            ` | ${i.is_emergent ? "EMERGENT" : "elective"}` +
            ` | surgeon ${i.surgeon_alias ?? "UNASSIGNED"}` +
            (i.surgeon_alias
              ? ` (tier ${i.surgeon_tier}, projected alertness ${i.projected_alertness ?? "n/a"})` +
                ` | mismatch ${i.mismatch_score} (${i.risk_level})`
              : ""),
        )
        .join("\n")
}

SURGEON CAPACITY (de-identified):
${
  surgeons.length === 0
    ? "  none"
    : surgeons
        .map(
          (s) =>
            `  ${s.alias} | ${s.specialty} | tier ${s.fatigue_tier} | ${s.case_count} case(s) in window` +
            ` | total cognitive load ${s.total_cognitive_load}` +
            ` | heaviest case ${s.max_cognitive_load}` +
            (s.cognitive_sensitivity !== 1
              ? ` | personal cognitive sensitivity ${s.cognitive_sensitivity}`
              : ""),
        )
        .join("\n")
}

STRUCTURAL FLAGS ALREADY DETECTED DETERMINISTICALLY:
${flags.length === 0 ? "  none" : flags.map((f) => `  [${f.severity}] ${f.ref ?? "board"}: ${f.message}`).join("\n")}

Produce the JSON object.
`.trim();
}

export function validateOrganizeOutput(raw, validRefs) {
  const urgencies = ["immediate", "before_schedule_locks", "monitor"];
  const healths = ["good", "watch", "strained", "critical"];

  const actions = Array.isArray(raw?.priority_actions) ? raw.priority_actions : [];

  return {
    summary: asText(raw?.summary, 1200),
    // Drop any action referencing a case that isn't on the board. A
    // hallucinated REF would send a scheduler looking for a case that
    // does not exist, which is worse than returning nothing.
    priority_actions: actions
      .slice(0, 6)
      .map((a) => ({
        case_ref: asText(a?.case_ref, 20).toUpperCase(),
        action: asText(a?.action, 400),
        reason: asText(a?.reason, 400),
        urgency: urgencies.includes(String(a?.urgency).toLowerCase())
          ? String(a.urgency).toLowerCase()
          : "monitor",
      }))
      .filter((a) => a.action && (validRefs.includes(a.case_ref) || a.case_ref === "BOARD")),
    dropped_action_count: actions.length
      ? actions.length -
        actions.filter((a) =>
          validRefs.includes(asText(a?.case_ref, 20).toUpperCase()) ||
          asText(a?.case_ref, 20).toUpperCase() === "BOARD",
        ).length
      : 0,
    sequencing_warnings: Array.isArray(raw?.sequencing_warnings)
      ? raw.sequencing_warnings.slice(0, 6).map((w) => asText(w, 300)).filter(Boolean)
      : [],
    workload_observations: Array.isArray(raw?.workload_observations)
      ? raw.workload_observations.slice(0, 6).map((w) => asText(w, 300)).filter(Boolean)
      : [],
    board_health: healths.includes(String(raw?.board_health).toLowerCase())
      ? String(raw.board_health).toLowerCase()
      : "watch",
  };
}

// --- coercion helpers -------------------------------------------------------
function asText(v, max) {
  if (v === undefined || v === null) return "";
  return String(v).trim().slice(0, max);
}
function clampInt(v, lo, hi, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
