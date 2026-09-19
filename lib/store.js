/**
 * DATA ACCESS LAYER
 * ============================================================================
 * One interface, two implementations:
 *
 *   SUPABASE   when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
 *   IN-MEMORY  otherwise — seeded from lib/seed.js
 *
 * The in-memory store is not a toy. It is a deliberate decision: it means
 * `git clone && npm install && npm run dev` produces a working, fully populated
 * backend with zero setup, so the frontend branches are never blocked waiting
 * for a database, and a demo can't die because a free-tier project was paused.
 *
 * In-memory data resets whenever the server restarts, and on Vercel each
 * serverless instance has its own copy — fine for a demo, not for anything
 * else. Wire up Supabase before you rely on writes persisting.
 *
 * Every route uses `await getStore()` and never touches Supabase directly, so
 * swapping the backing store is invisible above this line.
 * ============================================================================
 */

import { USE_SUPABASE } from "./config.js";
import { buildSeedData } from "./seed.js";
import { getSupabase, unwrap } from "./supabase.js";

const DAY = 86400000;

// ---------------------------------------------------------------------------
// IN-MEMORY STORE
// ---------------------------------------------------------------------------

/**
 * Cached on globalThis so Next.js hot-reload in dev doesn't wipe the dataset on
 * every file save — otherwise you'd lose any sleep log you entered while
 * building the frontend.
 */
function memoryDb() {
  if (!globalThis.__ORFATIGUE_DB__) {
    const data = buildSeedData(new Date());
    globalThis.__ORFATIGUE_DB__ = {
      ...data,
      _nextId: {
        surgeons: data.surgeons.length + 1,
        sleep_logs: data.sleep_logs.length + 1,
        shifts: data.shifts.length + 1,
        cases: data.cases.length + 1,
        events: data.events.length + 1,
        fatigue_scores: 1,
        assignment_suggestions: 1,
        audit_log: 1,
      },
    };
  }
  return globalThis.__ORFATIGUE_DB__;
}

function nextId(db, table) {
  const id = db._nextId[table];
  db._nextId[table] = id + 1;
  return id;
}

function inWindow(value, from, to) {
  if (!from && !to) return true;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return false;
  if (from && t < new Date(from).getTime()) return false;
  if (to && t > new Date(to).getTime()) return false;
  return true;
}

function createMemoryStore() {
  const db = memoryDb();
  const clone = (x) => (x === null || x === undefined ? x : JSON.parse(JSON.stringify(x)));

  return {
    backend: "in-memory",

    surgeons: {
      async list() {
        return clone(db.surgeons);
      },
      async get(id) {
        return clone(db.surgeons.find((s) => s.id === Number(id)) ?? null);
      },
      async create(data) {
        const row = { id: nextId(db, "surgeons"), created_at: new Date().toISOString(), ...data };
        db.surgeons.push(row);
        return clone(row);
      },
      async update(id, patch) {
        const row = db.surgeons.find((s) => s.id === Number(id));
        if (!row) return null;
        Object.assign(row, patch);
        return clone(row);
      },
    },

    sleepLogs: {
      async listForSurgeon(surgeonId, { days = 7 } = {}) {
        const cutoff = Date.now() - days * DAY;
        return clone(
          db.sleep_logs
            .filter(
              (l) => l.surgeon_id === Number(surgeonId) && new Date(l.log_date).getTime() >= cutoff,
            )
            .sort((a, b) => new Date(b.log_date) - new Date(a.log_date)),
        );
      },
      async create(data) {
        // One log per surgeon per date — a second POST for the same day is an
        // update, not a duplicate. Without this the 7-day debt calculation
        // double-counts every time the demo re-enters a night.
        const existing = db.sleep_logs.find(
          (l) => l.surgeon_id === data.surgeon_id && l.log_date === data.log_date,
        );
        if (existing) {
          Object.assign(existing, data);
          return clone(existing);
        }
        const row = { id: nextId(db, "sleep_logs"), ...data };
        db.sleep_logs.push(row);
        return clone(row);
      },
    },

    shifts: {
      async list({ surgeonId = null, from = null, to = null } = {}) {
        return clone(
          db.shifts.filter(
            (s) =>
              (surgeonId === null || s.surgeon_id === Number(surgeonId)) &&
              (from === null && to === null ? true : inWindow(s.start_time, from, to)),
          ),
        );
      },
    },

    cases: {
      async list({ surgeonId = null, from = null, to = null, status = null } = {}) {
        return clone(
          db.cases
            .filter(
              (c) =>
                (surgeonId === null || c.surgeon_id === Number(surgeonId)) &&
                (status === null || c.status === status) &&
                (from === null && to === null ? true : inWindow(c.scheduled_at, from, to)),
            )
            .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)),
        );
      },
      async get(id) {
        return clone(db.cases.find((c) => c.id === Number(id)) ?? null);
      },
      async create(data) {
        const row = { id: nextId(db, "cases"), created_at: new Date().toISOString(), ...data };
        db.cases.push(row);
        return clone(row);
      },
      async update(id, patch) {
        const row = db.cases.find((c) => c.id === Number(id));
        if (!row) return null;
        Object.assign(row, patch);
        return clone(row);
      },
    },

    events: {
      async list({ surgeonId = null, from = null, to = null } = {}) {
        return clone(
          db.events
            .filter(
              (e) =>
                (surgeonId === null || e.surgeon_id === Number(surgeonId)) &&
                (from === null && to === null ? true : inWindow(e.start_time, from, to)),
            )
            .sort((a, b) => new Date(a.start_time) - new Date(b.start_time)),
        );
      },
      async create(data) {
        const row = { id: nextId(db, "events"), ...data };
        db.events.push(row);
        return clone(row);
      },
      async remove(id) {
        const i = db.events.findIndex((e) => e.id === Number(id));
        if (i === -1) return false;
        db.events.splice(i, 1);
        return true;
      },
    },

    fatigueScores: {
      async latest(surgeonId) {
        return clone(
          db.fatigue_scores
            .filter((f) => f.surgeon_id === Number(surgeonId))
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] ?? null,
        );
      },
      async create(data) {
        const row = {
          id: nextId(db, "fatigue_scores"),
          created_at: new Date().toISOString(),
          ...data,
        };
        db.fatigue_scores.push(row);
        // Keep only the last 50 per surgeon so a long demo doesn't grow forever.
        const mine = db.fatigue_scores.filter((f) => f.surgeon_id === row.surgeon_id);
        if (mine.length > 50) {
          const drop = new Set(mine.slice(0, mine.length - 50).map((f) => f.id));
          db.fatigue_scores = db.fatigue_scores.filter((f) => !drop.has(f.id));
        }
        return clone(row);
      },
    },

    suggestions: {
      async list({ status = null } = {}) {
        return clone(
          db.assignment_suggestions
            .filter((s) => status === null || s.status === status)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
        );
      },
      async get(id) {
        return clone(db.assignment_suggestions.find((s) => s.id === Number(id)) ?? null);
      },
      async create(data) {
        const row = {
          id: nextId(db, "assignment_suggestions"),
          created_at: new Date().toISOString(),
          status: "pending",
          ...data,
        };
        db.assignment_suggestions.push(row);
        return clone(row);
      },
      async update(id, patch) {
        const row = db.assignment_suggestions.find((s) => s.id === Number(id));
        if (!row) return null;
        Object.assign(row, patch);
        return clone(row);
      },
    },

    audit: {
      async record(entry) {
        const row = {
          id: nextId(db, "audit_log"),
          created_at: new Date().toISOString(),
          ...entry,
        };
        db.audit_log.push(row);
        if (db.audit_log.length > 500) db.audit_log.shift();
        return clone(row);
      },
      async list({ limit = 100 } = {}) {
        return clone(db.audit_log.slice(-limit).reverse());
      },
    },
  };
}

// ---------------------------------------------------------------------------
// SUPABASE STORE
// ---------------------------------------------------------------------------

function createSupabaseStore() {
  const sb = getSupabase();

  return {
    backend: "supabase",

    surgeons: {
      async list() {
        return unwrap(await sb.from("surgeons").select("*").order("id"), "surgeons.list") ?? [];
      },
      async get(id) {
        return unwrap(
          await sb.from("surgeons").select("*").eq("id", Number(id)).maybeSingle(),
          "surgeons.get",
        );
      },
      async create(data) {
        return unwrap(
          await sb.from("surgeons").insert(data).select().single(),
          "surgeons.create",
        );
      },
      async update(id, patch) {
        return unwrap(
          await sb.from("surgeons").update(patch).eq("id", Number(id)).select().maybeSingle(),
          "surgeons.update",
        );
      },
    },

    sleepLogs: {
      async listForSurgeon(surgeonId, { days = 7 } = {}) {
        const cutoff = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
        return (
          unwrap(
            await sb
              .from("sleep_logs")
              .select("*")
              .eq("surgeon_id", Number(surgeonId))
              .gte("log_date", cutoff)
              .order("log_date", { ascending: false }),
            "sleepLogs.list",
          ) ?? []
        );
      },
      async create(data) {
        // Requires the UNIQUE (surgeon_id, log_date) constraint from schema.sql.
        return unwrap(
          await sb
            .from("sleep_logs")
            .upsert(data, { onConflict: "surgeon_id,log_date" })
            .select()
            .single(),
          "sleepLogs.create",
        );
      },
    },

    shifts: {
      async list({ surgeonId = null, from = null, to = null } = {}) {
        let q = sb.from("shifts").select("*");
        if (surgeonId !== null) q = q.eq("surgeon_id", Number(surgeonId));
        if (from) q = q.gte("start_time", new Date(from).toISOString());
        if (to) q = q.lte("start_time", new Date(to).toISOString());
        return unwrap(await q.order("start_time"), "shifts.list") ?? [];
      },
    },

    cases: {
      async list({ surgeonId = null, from = null, to = null, status = null } = {}) {
        let q = sb.from("cases").select("*");
        if (surgeonId !== null) q = q.eq("surgeon_id", Number(surgeonId));
        if (status !== null) q = q.eq("status", status);
        if (from) q = q.gte("scheduled_at", new Date(from).toISOString());
        if (to) q = q.lte("scheduled_at", new Date(to).toISOString());
        return unwrap(await q.order("scheduled_at"), "cases.list") ?? [];
      },
      async get(id) {
        return unwrap(
          await sb.from("cases").select("*").eq("id", Number(id)).maybeSingle(),
          "cases.get",
        );
      },
      async create(data) {
        return unwrap(await sb.from("cases").insert(data).select().single(), "cases.create");
      },
      async update(id, patch) {
        return unwrap(
          await sb.from("cases").update(patch).eq("id", Number(id)).select().maybeSingle(),
          "cases.update",
        );
      },
    },

    events: {
      async list({ surgeonId = null, from = null, to = null } = {}) {
        let q = sb.from("events").select("*");
        if (surgeonId !== null) q = q.eq("surgeon_id", Number(surgeonId));
        if (from) q = q.gte("start_time", new Date(from).toISOString());
        if (to) q = q.lte("start_time", new Date(to).toISOString());
        return unwrap(await q.order("start_time"), "events.list") ?? [];
      },
      async create(data) {
        return unwrap(await sb.from("events").insert(data).select().single(), "events.create");
      },
      async remove(id) {
        unwrap(await sb.from("events").delete().eq("id", Number(id)), "events.remove");
        return true;
      },
    },

    fatigueScores: {
      async latest(surgeonId) {
        return unwrap(
          await sb
            .from("fatigue_scores")
            .select("*")
            .eq("surgeon_id", Number(surgeonId))
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          "fatigueScores.latest",
        );
      },
      async create(data) {
        return unwrap(
          await sb.from("fatigue_scores").insert(data).select().single(),
          "fatigueScores.create",
        );
      },
    },

    suggestions: {
      async list({ status = null } = {}) {
        let q = sb.from("assignment_suggestions").select("*");
        if (status !== null) q = q.eq("status", status);
        return unwrap(await q.order("created_at", { ascending: false }), "suggestions.list") ?? [];
      },
      async get(id) {
        return unwrap(
          await sb.from("assignment_suggestions").select("*").eq("id", Number(id)).maybeSingle(),
          "suggestions.get",
        );
      },
      async create(data) {
        return unwrap(
          await sb.from("assignment_suggestions").insert({ status: "pending", ...data }).select().single(),
          "suggestions.create",
        );
      },
      async update(id, patch) {
        return unwrap(
          await sb
            .from("assignment_suggestions")
            .update(patch)
            .eq("id", Number(id))
            .select()
            .maybeSingle(),
          "suggestions.update",
        );
      },
    },

    audit: {
      async record(entry) {
        return unwrap(await sb.from("audit_log").insert(entry).select().single(), "audit.record");
      },
      async list({ limit = 100 } = {}) {
        return (
          unwrap(
            await sb
              .from("audit_log")
              .select("*")
              .order("created_at", { ascending: false })
              .limit(limit),
            "audit.list",
          ) ?? []
        );
      },
    },
  };
}

// ---------------------------------------------------------------------------

let cached = null;

/** Get the active store. Safe to call on every request. */
export async function getStore() {
  if (cached) return cached;
  cached = USE_SUPABASE ? createSupabaseStore() : createMemoryStore();
  return cached;
}

/** Test/demo helper: wipe the in-memory dataset and regenerate it. */
export function resetMemoryStore() {
  delete globalThis.__ORFATIGUE_DB__;
  if (!USE_SUPABASE) cached = null;
}
