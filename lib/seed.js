/**
 * SYNTHETIC DATASET
 * ============================================================================
 * ⚠️  EVERY PERSON, SHIFT, AND CASE IN THIS FILE IS FICTIONAL.
 *
 *   - No real surgeon, hospital, or patient is represented.
 *   - There is NO PATIENT DATA of any kind — by design. A "case" here is a
 *     procedure name, a CPT code, a duration, and a time. There is no patient
 *     identifier field anywhere in the schema, which keeps the entire system
 *     out of HIPAA PHI scope.
 *   - Email addresses use the .invalid reserved TLD (RFC 2606) so they can
 *     never resolve or be accidentally mailed.
 *   - Pronouns are set to they/them for every synthetic record. We do not infer
 *     pronouns from names, and there is no real person here to have any.
 *
 * Say "this is synthetic, clearly labelled" in the demo — the submission guide
 * asks for it and judges check.
 *
 * REPRODUCIBILITY: generation is driven by a seeded PRNG, so the dataset is
 * identical on every run and on every machine. A demo that looks different each
 * time you refresh is a demo you cannot rehearse.
 *
 * DEMO CHOREOGRAPHY: the profiles below are tuned so the director heatmap is
 * never boring — roughly 3 red, 3 amber, and 6 green surgeons at any time of
 * day, with the red cases driven by realistic causes (post-call short sleep,
 * consecutive night rotations, heavy RVU load, a resident near the duty-hour
 * cap). All times are generated RELATIVE TO NOW, so there are always upcoming
 * cases no matter when you run it.
 * ============================================================================
 */

import { getProcedureByCpt, PROCEDURES } from "./procedures.js";
import { defaultVisibility } from "./privacy.js";
import { scoreCase } from "./complexity.js";

const HOUR = 3600000;
const DAY = 86400000;

/** Deterministic PRNG (mulberry32) so the dataset never shifts between runs. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Surgeon profiles. `pattern` drives the sleep/shift generator below and is
 * what determines whether this person shows up green, amber, or red.
 */
const SURGEON_PROFILES = [
  {
    name: "Dr. Amara Okafor",
    specialty: "Trauma Surgery",
    subspecialties: ["Acute care surgery", "Damage control"],
    years_experience: 12,
    role: "attending",
    credentials: "MD, FACS",
    baseline_sleep_hrs: 7.5,
    on_call: true,
    pattern: "post-call-night-rotation", // -> RED
  },
  {
    name: "Dr. Wei Chen",
    specialty: "Cardiothoracic Surgery",
    subspecialties: ["Adult cardiac", "Valve surgery"],
    years_experience: 18,
    role: "attending",
    credentials: "MD, PhD, FACS",
    baseline_sleep_hrs: 7,
    on_call: false,
    pattern: "heavy-load", // -> AMBER
  },
  {
    name: "Dr. Priya Raghunathan",
    specialty: "General Surgery",
    subspecialties: ["Minimally invasive", "Hernia"],
    years_experience: 9,
    role: "attending",
    credentials: "MD",
    baseline_sleep_hrs: 7,
    on_call: false,
    pattern: "well-rested", // -> GREEN
  },
  {
    name: "Dr. Daniel Vasquez",
    specialty: "Orthopaedic Surgery",
    subspecialties: ["Arthroplasty"],
    years_experience: 15,
    role: "attending",
    credentials: "MD, FAAOS",
    baseline_sleep_hrs: 7.5,
    on_call: false,
    pattern: "well-rested", // -> GREEN
  },
  {
    name: "Dr. Sofia Marchetti",
    specialty: "Neurosurgery",
    subspecialties: ["Skull base", "Neuro-oncology"],
    years_experience: 14,
    role: "attending",
    credentials: "MD, PhD",
    baseline_sleep_hrs: 7,
    on_call: true,
    pattern: "chronic-debt", // -> RED
  },
  {
    name: "Dr. James Aluko",
    specialty: "Vascular Surgery",
    subspecialties: ["Endovascular"],
    years_experience: 11,
    role: "attending",
    credentials: "MD, FACS",
    baseline_sleep_hrs: 7,
    on_call: false,
    pattern: "mild-deficit", // -> AMBER
  },
  {
    name: "Dr. Hana Kobayashi",
    specialty: "Urology",
    subspecialties: ["Endourology", "Robotics"],
    years_experience: 8,
    role: "attending",
    credentials: "MD",
    baseline_sleep_hrs: 7,
    on_call: false,
    pattern: "well-rested", // -> GREEN
  },
  {
    name: "Dr. Elena Petrova",
    specialty: "Surgical Oncology",
    subspecialties: ["Breast", "Melanoma"],
    years_experience: 16,
    role: "attending",
    credentials: "MD, FACS",
    baseline_sleep_hrs: 7.5,
    on_call: false,
    pattern: "well-rested", // -> GREEN
  },
  {
    name: "Dr. Marcus Bell",
    specialty: "General Surgery",
    subspecialties: [],
    years_experience: 4,
    role: "resident-pgy4", // ACGME limits apply — see lib/acgme.js
    credentials: "MD",
    baseline_sleep_hrs: 7.5,
    on_call: true,
    pattern: "duty-hour-edge", // -> RED, and trips ACGME checks
  },
  {
    name: "Dr. Yuki Tanaka",
    specialty: "Cardiothoracic Surgery",
    subspecialties: ["Thoracic", "VATS"],
    years_experience: 6,
    role: "fellow",
    credentials: "MD",
    baseline_sleep_hrs: 7,
    on_call: false,
    pattern: "mild-deficit", // -> AMBER
  },
  {
    name: "Dr. Omar Haddad",
    specialty: "Trauma Surgery",
    subspecialties: ["Acute care surgery", "Critical care"],
    years_experience: 13,
    role: "attending",
    credentials: "MD, FACS",
    baseline_sleep_hrs: 7,
    on_call: true,
    pattern: "well-rested", // -> GREEN, the obvious swap target in the demo
  },
  {
    name: "Dr. Rachel Adeyemi",
    specialty: "Obstetrics",
    subspecialties: ["Maternal-fetal medicine"],
    years_experience: 10,
    role: "attending",
    credentials: "MD, FACOG",
    baseline_sleep_hrs: 7,
    on_call: false,
    pattern: "mild-deficit", // -> AMBER
  },
];

/**
 * Sleep-hour generators per pattern. Index 0 = last night, 6 = a week ago.
 *
 * These values are tuned against the coefficients in lib/fatigue.js to produce
 * a demo-legible spread — roughly 3 red / 4 amber / 5 green during daytime
 * hours. If you retune MODEL in lib/fatigue.js, re-check the spread with
 * `curl -H "x-viewer-role: director" localhost:3000/api/roster`.
 *
 * Note that the board gets redder overnight: the circadian term adds up to 18
 * points between 02:00 and 06:00 regardless of sleep. That is the model working
 * correctly, and it is worth mentioning in the demo if you present at an odd
 * hour — "the same roster is a different risk picture at 3am" is the point.
 */
const SLEEP_PATTERNS = {
  // Post-call short sleep + a night rotation. Reproduces the observed
  // post-call (~4.98h) vs non-post-call (~6.68h) gap.
  "post-call-night-rotation": [4.3, 4.9, 5.2, 7.1, 6.8, 7.4, 7.2],
  // Never catastrophic on any single night, but a severe cumulative debt.
  "chronic-debt": [4.4, 4.1, 4.7, 4.5, 4.9, 5.1, 4.6],
  // Sleeping near-adequately, but carrying a very heavy operative load.
  "heavy-load": [6.0, 6.2, 5.9, 6.3, 6.1, 6.4, 6.0],
  // A resident bumping against the 80-hour cap.
  "duty-hour-edge": [4.8, 5.5, 5.0, 6.2, 5.9, 6.4, 5.7],
  // Chronically an hour short. The population this product is really for —
  // nobody would ever flag them, and they are never fully recovered.
  "mild-deficit": [5.9, 6.2, 5.8, 6.4, 6.1, 6.5, 6.2],
  "well-rested": [7.6, 7.4, 7.8, 7.2, 7.9, 7.5, 7.7],
};

/** Which CPT codes each specialty draws from when generating cases. */
const SPECIALTY_CPTS = PROCEDURES.reduce((acc, p) => {
  (acc[p.specialty] ??= []).push(p.cpt);
  return acc;
}, {});

/**
 * Build the full synthetic dataset.
 * @param {Date} now Anchor instant — everything is generated relative to this.
 */
export function buildSeedData(now = new Date()) {
  const rand = rng(20260919);
  const base = now.getTime();

  const surgeons = SURGEON_PROFILES.map((p, i) => ({
    id: i + 1,
    name: p.name,
    email: `${p.name.replace(/^Dr\.\s*/, "").toLowerCase().replace(/\s+/g, ".")}@example.invalid`,
    phone: null,
    pronouns: "they/them", // synthetic records; never inferred from a name
    specialty: p.specialty,
    subspecialties: p.subspecialties,
    years_experience: p.years_experience,
    role: p.role,
    credentials: p.credentials,
    bio: `${p.specialty} at the synthetic demo hospital. ${p.years_experience} years in practice.`,
    baseline_sleep_hrs: p.baseline_sleep_hrs,
    on_call: p.on_call,
    availability_notes: p.on_call ? "On the acute rota this week." : null,
    visibility: defaultVisibility(),
    opted_in: true,
    created_at: new Date(base - 30 * DAY).toISOString(),
    _pattern: p.pattern, // internal, stripped before it leaves the store
  }));

  const sleep_logs = [];
  const shifts = [];
  const cases = [];
  const events = [];

  let sleepId = 1;
  let shiftId = 1;
  let caseId = 1;
  let eventId = 1;

  for (const s of surgeons) {
    const pattern = SLEEP_PATTERNS[s._pattern] ?? SLEEP_PATTERNS["well-rested"];

    // --- sleep logs: last 7 nights -----------------------------------------
    for (let d = 0; d < 7; d += 1) {
      const logDate = new Date(base - d * DAY);
      const hours = pattern[d] + (rand() - 0.5) * 0.3;

      // A wake time makes the continuous-wakefulness term meaningful instead of
      // being inferred. Night-rotation people wake mid-afternoon.
      const wake = new Date(logDate);
      const isNightPattern = s._pattern === "post-call-night-rotation" && d < 3;
      wake.setHours(isNightPattern ? 14 : 6, Math.floor(rand() * 50), 0, 0);

      sleep_logs.push({
        id: sleepId++,
        surgeon_id: s.id,
        log_date: logDate.toISOString().slice(0, 10),
        hours_slept: round1(hours),
        wake_time: wake.toISOString(),
        // Recovery score stands in for what a WHOOP/Oura integration would
        // supply. Correlated with sleep but not identical — recovery is not
        // just duration.
        recovery_score: Math.round(clamp(hours * 11 + (rand() - 0.5) * 12, 5, 99)),
        source: d === 0 ? "manual" : "synthetic-wearable",
      });
    }

    // --- shifts: 5 days back, 3 days forward -------------------------------
    for (let d = -5; d <= 3; d += 1) {
      const dayStart = new Date(base + d * DAY);

      const isNight =
        (s._pattern === "post-call-night-rotation" && d >= -3 && d <= -1) ||
        (s._pattern === "chronic-debt" && (d === -2 || d === -1)) ||
        (s._pattern === "duty-hour-edge" && (d === -4 || d === -1 || d === 2)) ||
        (s.on_call && d === 1);

      // The duty-hour-edge resident works nearly every day — that's the point.
      const worksToday = s._pattern === "duty-hour-edge" ? d !== -2 : rand() > 0.28;
      if (!worksToday) continue;

      const start = new Date(dayStart);
      start.setHours(isNight ? 19 : 7, 0, 0, 0);
      const lengthHrs = isNight ? 13 : s._pattern === "duty-hour-edge" ? 13 : 10;

      shifts.push({
        id: shiftId++,
        surgeon_id: s.id,
        start_time: start.toISOString(),
        end_time: new Date(start.getTime() + lengthHrs * HOUR).toISOString(),
        is_night: isNight,
      });
    }

    // --- cases: 4 past (rated) + 2-3 upcoming ------------------------------
    const cptPool = SPECIALTY_CPTS[s.specialty] ?? SPECIALTY_CPTS["General Surgery"];
    const caseCount = s._pattern === "heavy-load" ? 9 : 6;

    for (let n = 0; n < caseCount; n += 1) {
      const isPast = n < Math.ceil(caseCount * 0.65);

      // Snap to a plausible OR start hour (07:00-17:00), then verify the result
      // actually landed on the correct side of `now`. Setting the hour after
      // choosing the day can flip a "past" case into the future (or vice versa)
      // depending on what time of day the seed runs — which would put cases
      // marked `scheduled` in the past and break the upcoming-cases view.
      let scheduled;
      if (isPast) {
        if (s._pattern === "heavy-load" && n < 3) {
          // Heavy-load surgeons need real load inside the trailing 24h window,
          // otherwise the operative-workload term never fires and the profile
          // is indistinguishable from a well-rested one.
          scheduled = new Date(base - (3 + n * 5 + rand() * 3) * HOUR);
        } else {
          scheduled = new Date(base - (1 + Math.floor(rand() * 5)) * DAY);
          scheduled.setHours(7 + Math.floor(rand() * 10), rand() > 0.5 ? 30 : 0, 0, 0);
          if (scheduled.getTime() >= base) scheduled = new Date(base - (3 + rand() * 5) * HOUR);
        }
      } else {
        scheduled = new Date(base + Math.floor(rand() * 3) * DAY);
        scheduled.setHours(7 + Math.floor(rand() * 10), rand() > 0.5 ? 30 : 0, 0, 0);
        if (scheduled.getTime() <= base) scheduled = new Date(base + (2 + rand() * 10) * HOUR);
      }

      const cpt = cptPool[Math.floor(rand() * cptPool.length)];
      const proc = getProcedureByCpt(cpt);
      const isEmergent = rand() > 0.82;

      // A couple of deliberately gnarly named cases so the LLM classifier and
      // the modifier detector have something to chew on in the demo.
      const name =
        !isPast && n === caseCount - 1 && s.specialty === "Cardiothoracic Surgery"
          ? "Redo aortic valve replacement with root enlargement"
          : isEmergent
            ? `Emergent ${proc.name.toLowerCase()}`
            : proc.name;

      const scored = scoreCase({
        cpt,
        procedure_name: name,
        rvu: proc.work_rvu,
        duration_hrs: proc.typical_duration_hrs,
        is_emergent: isEmergent,
      });

      cases.push({
        id: caseId++,
        surgeon_id: s.id,
        procedure_name: name,
        cpt,
        specialty: proc.specialty,
        rvu: proc.work_rvu,
        duration_hrs: round1(proc.typical_duration_hrs * (0.85 + rand() * 0.4)),
        is_emergent: isEmergent,
        scheduled_at: scheduled.toISOString(),
        status: isPast ? "completed" : "scheduled",
        // Perceived exertion exists only for completed cases — you cannot rate
        // a case you have not done. Heavy-load surgeons rate higher, which is
        // what gives the personal calibration something to learn from.
        perceived_exertion: isPast
          ? Math.round(
              clamp(
                1 + (scored.objective_score / 100) * 9 + (s._pattern === "heavy-load" ? 1.5 : 0) + (rand() - 0.5) * 2,
                1,
                10,
              ),
            )
          : null,
        complexity_score: scored.objective_score,
        complexity_tier: scored.objective_tier,
        fatigue_load: scored.fatigue_load,
        created_at: new Date(base - 7 * DAY).toISOString(),
      });
    }

    // --- calendar events: the non-clinical commitments duty hours ignore ----
    const eventTemplates = [
      { kind: "clinic", title: "Outpatient clinic", hour: 13, length: 4, visibility: "care_team" },
      { kind: "admin", title: "M&M conference", hour: 7, length: 1.5, visibility: "care_team" },
      { kind: "academic", title: "Resident teaching", hour: 16, length: 1, visibility: "care_team" },
      // The whole point of the privacy model: this one is schedulable-around
      // but not readable by anyone but the surgeon.
      { kind: "personal", title: "Personal commitment", hour: 18, length: 2, visibility: "private" },
    ];

    for (const tpl of eventTemplates) {
      if (rand() > 0.6) continue;
      const d = Math.floor(rand() * 4) - 1;
      const start = new Date(base + d * DAY);
      start.setHours(tpl.hour, 0, 0, 0);

      events.push({
        id: eventId++,
        surgeon_id: s.id,
        kind: tpl.kind,
        title: tpl.title,
        start_time: start.toISOString(),
        end_time: new Date(start.getTime() + tpl.length * HOUR).toISOString(),
        visibility: tpl.visibility,
        counts_toward_duty_hours: tpl.kind !== "personal",
      });
    }
  }

  // Strip the internal pattern marker so it never leaks through the API.
  const cleanSurgeons = surgeons.map(({ _pattern, ...rest }) => rest);

  return {
    surgeons: cleanSurgeons,
    sleep_logs,
    shifts,
    cases,
    events,
    fatigue_scores: [],
    assignment_suggestions: [],
    audit_log: [],
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
