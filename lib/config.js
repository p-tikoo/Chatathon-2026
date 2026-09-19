/**
 * Central runtime configuration.
 *
 * Design rule for this whole backend: EVERY external dependency is optional.
 * No API key, no database, no problem — the app degrades to a deterministic
 * model over an in-memory synthetic dataset and every endpoint still returns
 * a valid response. This is deliberate: a live demo that hard-fails because a
 * free-tier quota ran out is a lost pitch.
 *
 * See .env.example for how to sign up for each service.
 */

const env = process.env;

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true" || String(value) === "1";
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

// --- Database ---------------------------------------------------------------
export const SUPABASE_URL = env.SUPABASE_URL || "";
export const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";

/** True when both Supabase credentials are present. Otherwise: in-memory store. */
export const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

// --- LLM --------------------------------------------------------------------
/** "gemini" | "anthropic" | "none" */
export const LLM_PROVIDER = (env.LLM_PROVIDER || "gemini").toLowerCase();

export const GEMINI_API_KEY = env.GEMINI_API_KEY || "";
export const GEMINI_MODEL = env.GEMINI_MODEL || "gemini-2.5-flash";

export const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY || "";
export const ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || "claude-opus-5";

/** True only when the selected provider actually has a usable credential. */
export const LLM_ENABLED =
  (LLM_PROVIDER === "gemini" && Boolean(GEMINI_API_KEY)) ||
  (LLM_PROVIDER === "anthropic" && Boolean(ANTHROPIC_API_KEY));

// --- Behaviour --------------------------------------------------------------
export const REQUIRE_REAL_AUTH = bool(env.REQUIRE_REAL_AUTH, false);
export const FATIGUE_CACHE_TTL_SECONDS = int(env.FATIGUE_CACHE_TTL_SECONDS, 120);

/** Hard ceiling on a single LLM call, in ms. Keeps the demo responsive. */
export const LLM_TIMEOUT_MS = int(env.LLM_TIMEOUT_MS, 20000);

/**
 * Everything in this system is synthetic unless a real hospital feed is wired
 * in. Surfaced on every response envelope so the demo can never accidentally
 * imply it is showing real patient or clinician data.
 */
export const DATA_PROVENANCE = USE_SUPABASE
  ? "synthetic-seeded-database"
  : "synthetic-in-memory";

export function describeRuntime() {
  return {
    store: USE_SUPABASE ? "supabase" : "in-memory-mock",
    llm_provider: LLM_PROVIDER,
    llm_enabled: LLM_ENABLED,
    llm_model:
      LLM_PROVIDER === "gemini"
        ? GEMINI_MODEL
        : LLM_PROVIDER === "anthropic"
          ? ANTHROPIC_MODEL
          : null,
    data_provenance: DATA_PROVENANCE,
    scoring_mode: LLM_ENABLED ? "llm-with-deterministic-fallback" : "deterministic-only",
  };
}
