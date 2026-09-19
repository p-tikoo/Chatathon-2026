/**
 * SUPABASE CLIENT
 * ============================================================================
 * HOW TO SET UP SUPABASE (free tier, no credit card):
 *   1. https://supabase.com/dashboard -> sign in with GitHub.
 *   2. "New project". Name it, generate + SAVE a database password, pick the
 *      nearest region. Provisioning takes ~2 minutes.
 *   3. SQL Editor (left sidebar) -> paste scripts/schema.sql -> Run.
 *   4. Project Settings -> API. Copy:
 *        Project URL      -> SUPABASE_URL
 *        service_role key -> SUPABASE_SERVICE_ROLE_KEY
 *   5. Put both in .env.local, then populate the tables:  npm run seed
 *   6. Restart `npm run dev`.
 *
 * ⚠️  THE SERVICE ROLE KEY IS AN ADMIN KEY. It bypasses Row Level Security
 *     entirely. It is safe here ONLY because these API routes are server-side
 *     and enforce access control themselves (lib/privacy.js). It must never be
 *     exposed to the browser: no NEXT_PUBLIC_ prefix, no imports from client
 *     components, no committing it. If it leaks, rotate it immediately in the
 *     Supabase dashboard.
 *
 *     Production shape: use the anon key + Supabase Auth + Row Level Security
 *     policies that mirror lib/privacy.js, so the database enforces the privacy
 *     rules even if an API route has a bug. See BACKEND.md.
 * ============================================================================
 */

import { createClient } from "@supabase/supabase-js";
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, USE_SUPABASE } from "./config.js";

let client = null;

export function getSupabase() {
  if (!USE_SUPABASE) return null;
  if (client) return client;

  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      // Server-side only: no session to persist, no token to refresh.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return client;
}

/** Unwrap a Supabase response, throwing a readable error on failure. */
export function unwrap({ data, error }, context) {
  if (error) {
    const e = new Error(`Supabase ${context} failed: ${error.message}`);
    e.cause = error;
    throw e;
  }
  return data;
}
