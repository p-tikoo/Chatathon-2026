#!/usr/bin/env node
/**
 * SEED SUPABASE
 * ===========================================================================
 *   npm run seed
 *
 * Generates the same synthetic dataset the in-memory store uses (lib/seed.js)
 * and inserts it into Supabase, so both backends behave identically and the
 * demo looks the same whether or not a database is configured.
 *
 * PREREQUISITES:
 *   1. Run scripts/schema.sql in the Supabase SQL Editor first.
 *   2. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.
 *      (See .env.example for how to sign up and where to find both.)
 *
 * This script DELETES all existing rows before inserting. It is meant for a
 * demo database with synthetic data and nothing else. It refuses to run
 * without --force if the surgeons table already has rows, so you cannot wipe
 * something by accident.
 * ===========================================================================
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { buildSeedData } from "../lib/seed.js";

// --- Load .env.local manually -----------------------------------------------
// Node's --env-file flag would work, but requiring it in the npm script means
// one more thing to get wrong at 2am. Parse it ourselves.
function loadEnv(path) {
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (value && !process.env[key]) process.env[key] = value;
    }
  } catch {
    // No .env.local — fall back to whatever is already in the environment.
  }
}
loadEnv(new URL("../.env.local", import.meta.url).pathname);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const force = process.argv.includes("--force");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(`
✗ Missing Supabase credentials.

  Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local, then re-run.
  See .env.example for signup instructions.

  You do NOT need Supabase to run the app — without it the backend uses an
  in-memory store seeded with this same dataset. Just run: npm run dev
`);
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Children first — foreign keys point at surgeons.
const TABLES_IN_DELETE_ORDER = [
  "audit_log",
  "assignment_suggestions",
  "fatigue_scores",
  "events",
  "sleep_logs",
  "cases",
  "shifts",
  "surgeons",
];

async function main() {
  console.log(`→ Supabase: ${SUPABASE_URL}`);

  // --- Guard against wiping a non-empty database --------------------------
  const { count, error: countError } = await sb
    .from("surgeons")
    .select("*", { count: "exact", head: true });

  if (countError) {
    console.error(`
✗ Could not read the surgeons table: ${countError.message}

  The most likely cause is that the schema hasn't been created yet.
  Open the Supabase SQL Editor, paste scripts/schema.sql, and click Run.
`);
    process.exit(1);
  }

  if (count > 0 && !force) {
    console.error(`
✗ The surgeons table already has ${count} row(s).

  Re-run with --force to DELETE ALL EXISTING DATA and reseed:
      npm run seed -- --force
`);
    process.exit(1);
  }

  if (count > 0) {
    console.log(`→ Clearing ${TABLES_IN_DELETE_ORDER.length} tables (--force)...`);
    for (const table of TABLES_IN_DELETE_ORDER) {
      const { error } = await sb.from(table).delete().gte("id", 0);
      if (error) console.warn(`  ! ${table}: ${error.message}`);
    }
  }

  // --- Generate ------------------------------------------------------------
  const data = buildSeedData(new Date());
  console.log(
    `→ Generated ${data.surgeons.length} surgeons, ${data.shifts.length} shifts, ` +
      `${data.cases.length} cases, ${data.sleep_logs.length} sleep logs, ${data.events.length} events`,
  );

  // Insert surgeons first, then remap child foreign keys onto the real serial
  // IDs Postgres assigns — the seed's IDs are 1..12 but the sequence may not
  // start there on a reseed.
  const surgeonRows = data.surgeons.map(({ id, ...rest }) => rest);
  const { data: inserted, error: sErr } = await sb
    .from("surgeons")
    .insert(surgeonRows)
    .select("id, email");

  if (sErr) {
    console.error(`✗ Failed to insert surgeons: ${sErr.message}`);
    process.exit(1);
  }

  // Seed order is preserved by the insert, so index N maps to seed id N+1.
  const idMap = new Map(data.surgeons.map((s, i) => [s.id, inserted[i].id]));
  const remap = (rows) =>
    rows.map(({ id, ...rest }) => ({ ...rest, surgeon_id: idMap.get(rest.surgeon_id) }));

  for (const [table, rows] of [
    ["shifts", data.shifts],
    ["cases", data.cases],
    ["sleep_logs", data.sleep_logs],
    ["events", data.events],
  ]) {
    if (rows.length === 0) continue;
    const { error } = await sb.from(table).insert(remap(rows));
    if (error) {
      console.error(`✗ Failed to insert ${table}: ${error.message}`);
      process.exit(1);
    }
    console.log(`  ✓ ${table}: ${rows.length} rows`);
  }

  console.log(`
✓ Seeded successfully.

  All data is synthetic — no real surgeon, patient, or hospital is represented.

  Next:  npm run dev   then open  http://localhost:3000/api/health
`);
}

main().catch((error) => {
  console.error("✗ Unexpected error:", error);
  process.exit(1);
});
