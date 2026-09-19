/**
 * UI ADAPTER — translates the backend store into the shapes the Vite frontend
 * in src/ already consumes.
 * ===========================================================================
 *
 * The frontend (src/) and the API (app/api/) were built on two branches against
 * two different vocabularies:
 *
 *     backend                          frontend
 *     -------------------------------  ----------------------------------
 *     surgeon.id = 3 (number)          surgeon.id = "s3" (string)
 *     sleep_logs[].hours_slept +       sleepLog[].start / .end (epoch ms)
 *       .wake_time
 *     shifts[].start_time/.end_time    duty[].start / .end / .kind
 *     events[].title                   commitments[].label
 *     cases[].procedure_name +         cases[].procedure / .start / .end /
 *       .scheduled_at + .duration_hrs    .durationMin / .complexity / .acuity
 *
 * Rather than rewrite either side under time pressure, this module is the seam.
 * It is the ONLY place the two vocabularies meet, so there is exactly one file
 * to change if either side moves.
 *
 * `s${id}` rather than a bare number is deliberate: the frontend uses surgeon
 * ids as React keys and as object keys in the projection map, and a numeric key
 * there silently reorders on iteration.
 */

import { objectiveComplexity } from "./complexity.js";

const HOUR = 3600000;

export const toUiId = (id) => `s${id}`;
export const fromUiId = (uiId) => Number(String(uiId).replace(/^s/, ""));

/** The frontend keys chronotype off habitual bed/wake hours; the backend stores
 *  a nightly baseline. Recover a plausible window from the wake times we have. */
function habitualSleep(surgeon, sleepLogs) {
  const baseline = surgeon.baseline_sleep_hrs ?? 7.5;
  const wakes = sleepLogs
    .map((l) => (l.wake_time ? new Date(l.wake_time) : null))
    .filter(Boolean)
    .map((d) => d.getHours() + d.getMinutes() / 60);

  const wakeHour = wakes.length
    ? Number((wakes.reduce((a, b) => a + b, 0) / wakes.length).toFixed(1))
    : 6.5;
  const bedHour = Number((((wakeHour - baseline) % 24) + 24).toFixed(1)) % 24;
  return { bedHour, wakeHour };
}

function chronotypeFor({ bedHour }) {
  // Wrap first: a 00:30 bedtime is a late chronotype, not an early one, and
  // comparing the raw hour puts it below every threshold.
  const wrapped = bedHour < 12 ? bedHour + 24 : bedHour;
  if (wrapped >= 23.5) return "late";
  if (wrapped <= 22.5) return "early";
  return "neutral";
}

/**
 * Sleep episode. The backend records a wake time and a duration; the frontend
 * simulates over intervals, so the start is derived backwards from the wake.
 */
function toSleepEpisode(log) {
  const end = log.wake_time
    ? new Date(log.wake_time).getTime()
    : new Date(`${log.log_date}T06:30:00`).getTime();
  const hours = Number(log.hours_slept ?? 0);
  return {
    start: end - hours * HOUR,
    end,
    // Recovery score is the closest thing the backend has to sleep quality.
    // Falling back to 0.8 rather than 0 matters: 0 reads as a catastrophic
    // night to the simulator, not as "unknown".
    quality: log.recovery_score != null ? log.recovery_score / 100 : 0.8,
    source: log.source === "manual" ? "self-report" : "wearable",
  };
}

const ACUITY = (c) => (c.is_emergent ? "emergent" : c.status === "in_progress" ? "urgent" : "elective");

/** Backend complexity tiers -> the frontend's 1-5 integer scale. */
const TIER_TO_SCALE = { routine: 1, moderate: 2, complex: 4, critical: 5 };

function complexityScale(row) {
  const scored = objectiveComplexity({
    cpt: row.cpt ?? row.cpt_code,
    procedure_name: row.procedure_name,
    duration_hrs: row.duration_hrs,
    is_emergent: row.is_emergent,
  });
  const tier = scored?.tier ?? scored?.complexity_tier;
  if (tier && TIER_TO_SCALE[tier]) return TIER_TO_SCALE[tier];
  // No catalog match: fall back to duration, which is the single best proxy.
  const hrs = Number(row.duration_hrs ?? 2);
  return hrs >= 7 ? 5 : hrs >= 5 ? 4 : hrs >= 3 ? 3 : hrs >= 1.5 ? 2 : 1;
}

export function toUiCase(row) {
  const start = new Date(row.scheduled_at).getTime();
  const durationMin = Math.round(Number(row.duration_hrs ?? 2) * 60);
  return {
    id: `C-${String(row.id).padStart(3, "0")}`,
    caseId: row.id, // kept so write-backs can find the real row
    // The backend has no OR assignment; rooms are presentational only and are
    // derived deterministically so they don't shuffle between refreshes.
    room: `OR ${(row.id % 6) + 1}`,
    specialty: row.specialty ?? "General Surgery",
    procedure: row.procedure_name,
    cpt: row.cpt_code ?? null,
    start,
    end: start + durationMin * 60000,
    durationMin,
    complexity: complexityScale(row),
    acuity: ACUITY(row),
    status: row.status,
    surgeonId: row.surgeon_id == null ? null : toUiId(row.surgeon_id),
  };
}

/**
 * Build the whole dataset the frontend store expects.
 *
 * One pass over each table rather than per-surgeon queries: 12 surgeons x 4
 * tables of round trips is the difference between a dashboard that loads and
 * one that visibly stutters on every refresh.
 */
export async function buildUiDataset(store, { now = Date.now() } = {}) {
  const windowFrom = new Date(now - 8 * 24 * HOUR);
  const windowTo = new Date(now + 5 * 24 * HOUR);

  const [surgeonRows, shiftRows, caseRows, eventRows] = await Promise.all([
    store.surgeons.list(),
    store.shifts.list({ from: windowFrom, to: windowTo }),
    store.cases.list({ from: windowFrom, to: windowTo }),
    store.events.list({ from: windowFrom, to: windowTo }),
  ]);

  const sleepByS = new Map();
  await Promise.all(
    surgeonRows.map(async (s) => {
      sleepByS.set(s.id, await store.sleepLogs.listForSurgeon(s.id, { days: 8 }));
    }),
  );

  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.surgeon_id)) m.set(r.surgeon_id, []);
      m.get(r.surgeon_id).push(r);
    }
    return m;
  };
  const shiftsByS = group(shiftRows);
  const eventsByS = group(eventRows);

  const surgeons = surgeonRows.map((s) => {
    const logs = sleepByS.get(s.id) ?? [];
    const habits = habitualSleep(s, logs);

    return {
      id: toUiId(s.id),
      backendId: s.id,
      name: s.name,
      specialty: s.specialty,
      role: s.role === "resident" || s.role === "fellow" ? "Fellow" : "Attending",
      credentials: s.credentials ?? null,
      pronouns: s.pronouns ?? "they/them",
      onCall: Boolean(s.on_call),
      yearsExperience: s.years_experience ?? null,
      habitualSleep: habits,
      chronotype: chronotypeFor(habits),
      duty: (shiftsByS.get(s.id) ?? [])
        .map((sh) => ({
          start: new Date(sh.start_time).getTime(),
          end: new Date(sh.end_time).getTime(),
          kind: sh.is_night ? "Night float" : "Operating list",
        }))
        .sort((a, b) => a.start - b.start),
      sleepLog: logs
        .map(toSleepEpisode)
        .filter((e) => e.end > e.start)
        .sort((a, b) => a.start - b.start),
      commitments: (eventsByS.get(s.id) ?? []).map((e) => ({
        label: e.visibility === "private" ? "Personal commitment" : e.title,
        kind: e.kind,
        start: new Date(e.start_time).getTime(),
        end: new Date(e.end_time).getTime(),
      })),
      flags: [],
      registered: true,
    };
  });

  const cases = caseRows
    .filter((c) => c.status !== "cancelled")
    .map(toUiCase)
    .sort((a, b) => a.start - b.start);

  return { surgeons, cases, generatedAt: now };
}
