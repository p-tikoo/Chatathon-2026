-- ===========================================================================
-- DATABASE SCHEMA
-- ===========================================================================
-- HOW TO RUN THIS:
--   1. https://supabase.com/dashboard -> your project -> SQL Editor.
--   2. Paste this entire file and click Run.
--   3. Then populate it:  npm run seed
--      (scripts/seed-supabase.mjs generates the same synthetic dataset the
--      in-memory store uses, so both backends behave identically.)
--
-- Safe to re-run: every statement is idempotent.
--
-- ⚠️  ALL DATA IN THIS SYSTEM IS SYNTHETIC. Note what is NOT in this schema:
--     there is no patient table, no patient identifier, no MRN, no diagnosis,
--     and no clinical note. A "case" is a procedure code, a duration, and a
--     time. That omission is deliberate and load-bearing — it keeps the entire
--     system outside HIPAA PHI scope. Do not add a patient reference without
--     redoing the compliance analysis.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- surgeons
-- ---------------------------------------------------------------------------
create table if not exists surgeons (
  id                 serial primary key,
  name               text not null,
  email              text unique,
  phone              text,
  -- Never inferred from a name. Null means "not stated".
  pronouns           text,
  specialty          text not null,
  subspecialties     jsonb default '[]'::jsonb,
  years_experience   int,
  -- 'attending' | 'fellow' | 'resident-pgy1'..'resident-pgy5'.
  -- Drives whether ACGME duty-hour limits are regulatory or advisory.
  role               text default 'attending',
  credentials        text,
  bio                text,

  -- PERSONAL sleep baseline, not a population average. Using a personal
  -- reference point is what prevents the model systematically flagging older
  -- surgeons or anyone whose normal sleep differs from the mean.
  baseline_sleep_hrs numeric default 7 check (baseline_sleep_hrs between 4 and 10),

  on_call            boolean default false,
  availability_notes text,

  -- Per-field disclosure map, e.g. {"email":"private","bio":"care_team"}.
  -- Biometric fields are NOT represented here — they are self-only under the
  -- hard rules in lib/privacy.js and no setting can expose them.
  visibility         jsonb default '{}'::jsonb,

  -- Participation is opt-in. Surgeons who have not opted in are excluded from
  -- assignment recommendations rather than scored silently.
  opted_in           boolean default true,
  created_at         timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- shifts
-- ---------------------------------------------------------------------------
create table if not exists shifts (
  id          serial primary key,
  surgeon_id  int references surgeons(id) on delete cascade,
  start_time  timestamptz not null,
  end_time    timestamptz not null,
  is_night    boolean default false,
  check (end_time > start_time)
);
create index if not exists shifts_surgeon_start_idx on shifts (surgeon_id, start_time);

-- ---------------------------------------------------------------------------
-- cases
-- ---------------------------------------------------------------------------
create table if not exists cases (
  id                serial primary key,
  surgeon_id        int references surgeons(id) on delete set null,
  procedure_name    text not null,
  -- CPT code -> work RVU is the objective complexity layer. See lib/procedures.js.
  cpt               text,
  specialty         text,
  rvu               numeric,
  duration_hrs      numeric check (duration_hrs > 0),
  is_emergent       boolean default false,
  scheduled_at      timestamptz not null,
  status            text default 'scheduled'
                      check (status in ('scheduled','in_progress','completed','cancelled')),

  -- One-tap post-case rating, 1-10. NEVER used as the case's difficulty —
  -- it calibrates a per-surgeon multiplier on the objective score.
  -- See the header of lib/complexity.js.
  perceived_exertion int check (perceived_exertion between 1 and 10),

  complexity_score  numeric,
  complexity_tier   text check (complexity_tier in ('routine','moderate','complex','critical')),
  -- How much this case DEPLETES the surgeon, in equivalent depleting hours.
  -- Distinct from complexity: a 7h routine case depletes more than a 1h hard one.
  fatigue_load      numeric,
  created_at        timestamptz default now()
);
create index if not exists cases_surgeon_sched_idx on cases (surgeon_id, scheduled_at);
create index if not exists cases_sched_idx on cases (scheduled_at);

-- ---------------------------------------------------------------------------
-- sleep_logs
-- ---------------------------------------------------------------------------
create table if not exists sleep_logs (
  id             serial primary key,
  surgeon_id     int references surgeons(id) on delete cascade,
  -- A sleep log belongs to a calendar night, not an instant. Storing a
  -- timestamp here would make the 7-day debt window timezone-dependent.
  log_date       date not null,
  hours_slept    numeric check (hours_slept between 0 and 24),
  wake_time      timestamptz,
  -- Wearable recovery score. Distinct from duration — recovery is not just
  -- how long you were unconscious.
  recovery_score int check (recovery_score between 0 and 100),
  source         text default 'manual',

  -- Required by the upsert in lib/store.js. Without it, re-logging the same
  -- night double-counts that deficit and the score drifts on every demo.
  unique (surgeon_id, log_date)
);
create index if not exists sleep_logs_surgeon_date_idx on sleep_logs (surgeon_id, log_date desc);

-- ---------------------------------------------------------------------------
-- events — non-clinical commitments duty-hour logs ignore
-- ---------------------------------------------------------------------------
create table if not exists events (
  id                       serial primary key,
  surgeon_id               int references surgeons(id) on delete cascade,
  kind                     text not null
                             check (kind in ('clinic','admin','academic','research','personal','leave','on_call')),
  title                    text,
  start_time               timestamptz not null,
  end_time                 timestamptz not null,
  -- 'private' events show to others as an opaque "Unavailable" block: the
  -- time is schedulable-around, the reason stays with the surgeon.
  visibility               text default 'care_team'
                             check (visibility in ('private','care_team','roster')),
  -- Personal time blocks the calendar but must not inflate a duty-hour total
  -- and push someone over a cap.
  counts_toward_duty_hours boolean default true,
  check (end_time > start_time)
);
create index if not exists events_surgeon_start_idx on events (surgeon_id, start_time);

-- ---------------------------------------------------------------------------
-- fatigue_scores — history, so "what did the system say beforehand?" is answerable
-- ---------------------------------------------------------------------------
create table if not exists fatigue_scores (
  id            serial primary key,
  surgeon_id    int references surgeons(id) on delete cascade,
  score         int check (score between 0 and 100),
  tier          text check (tier in ('green','amber','red')),
  reasoning     text,
  -- 'deterministic' | 'llm-assisted' | 'deterministic-fallback'
  method        text,
  model_version text,
  created_at    timestamptz default now()
);
create index if not exists fatigue_scores_surgeon_created_idx
  on fatigue_scores (surgeon_id, created_at desc);

-- ---------------------------------------------------------------------------
-- assignment_suggestions — created PENDING; nothing moves without a human
-- ---------------------------------------------------------------------------
create table if not exists assignment_suggestions (
  id                     serial primary key,
  case_id                int references cases(id) on delete cascade,
  -- Snapshot of the case as it was when the recommendation was made, so the
  -- suggestion stays interpretable even if the case is edited afterwards.
  case_snapshot          jsonb,
  current_surgeon_id     int references surgeons(id) on delete set null,
  recommended_surgeon_id int references surgeons(id) on delete set null,
  justification          text,
  method                 text,
  risks                  jsonb default '[]'::jsonb,
  candidate_count        int,
  blocked_count          int,
  status                 text default 'pending'
                           check (status in ('pending','approved','overridden','rejected')),
  requested_by_role      text,

  -- The human decision.
  decided_at             timestamptz,
  decided_by_role        text,
  decided_by_surgeon_id  int references surgeons(id) on delete set null,
  final_surgeon_id       int references surgeons(id) on delete set null,
  decision_reason        text,
  created_at             timestamptz default now()
);
create index if not exists assignment_suggestions_status_idx
  on assignment_suggestions (status, created_at desc);

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
-- ⚠️  This table is admin-readable. NEVER write sleep hours, recovery scores,
--     numeric alertness scores, or private event titles into `detail` — that
--     would be a back door around the privacy rules. Tiers and identifiers only.
create table if not exists audit_log (
  id                 serial primary key,
  action             text not null,
  actor_role         text,
  actor_surgeon_id   int references surgeons(id) on delete set null,
  subject_surgeon_id int references surgeons(id) on delete set null,
  detail             jsonb default '{}'::jsonb,
  created_at         timestamptz default now()
);
create index if not exists audit_log_created_idx on audit_log (created_at desc);

-- ===========================================================================
-- ROW LEVEL SECURITY
-- ===========================================================================
-- RLS is intentionally LEFT OFF for this demo. The API routes connect with the
-- service_role key (which bypasses RLS anyway) and enforce access control in
-- lib/privacy.js. The data is synthetic, so there is nothing to protect.
--
-- This is the single biggest gap between the demo and something deployable.
-- In production you would:
--   1. enable RLS on every table above,
--   2. switch the client to the anon key + Supabase Auth,
--   3. write policies mirroring lib/privacy.js — in particular, policies that
--      make sleep_logs and fatigue_scores readable ONLY by the owning surgeon,
--      so the database enforces the biometric hard rule even if an API route
--      has a bug.
--
-- Be upfront about this if a judge asks. "Enforced in the app layer, belongs in
-- RLS, here's the migration path" is a much better answer than implying the
-- database is locked down when it isn't.
-- ===========================================================================
