# Backend — fatigue-aware surgical scheduling

Branch: `akarsh` · Status: **complete and tested (79/79 smoke checks)** · No frontend on this branch.

---

## 1. Start it in 30 seconds

```bash
npm install
npm run dev
open http://localhost:3000/api/health
```

**No API keys or database required.** With zero configuration the backend runs on an
in-memory synthetic dataset (12 surgeons, ~25 cases, 84 sleep logs) and a deterministic
fatigue model. Every endpoint works. Keys are an upgrade, not a prerequisite.

Verify everything:

```bash
npm run dev      # terminal 1
npm run smoke    # terminal 2 — 79 assertions, ~15s
```

Run `npm run smoke` after every merge to `main`. It checks the privacy rules, which are
the easiest thing to break with a well-meaning refactor and the most expensive thing to
have broken on stage.

---

## 2. API keys — what to sign up for

Everything is optional. Full instructions with links are in **`.env.example`**; this is
the summary.

| Service | Needed for | Cost | Where |
|---|---|---|---|
| **Gemini** | All AI features | Free tier, no card | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → "Create API key" → paste into `GEMINI_API_KEY` |
| **Supabase** | Persistence | Free tier, no card | [supabase.com/dashboard](https://supabase.com/dashboard) → New project → run `scripts/schema.sql` in SQL Editor → `npm run seed` |
| **Vercel** | Hosting | Free Hobby plan | [vercel.com/signup](https://vercel.com/signup) → import repo → **add env vars before deploying** |
| **Anthropic** | Alternate LLM | Paid after trial | [console.anthropic.com](https://console.anthropic.com/) — only if you set `LLM_PROVIDER=anthropic` |
| **WHOOP** | Real recovery data | Needs a membership | [developer.whoop.com](https://developer.whoop.com/) — **roadmap, not implemented** |

```bash
cp .env.example .env.local   # then paste your Gemini key in
```

Three things that will bite you:

- **Vercel does not read `.env.local`.** Add each variable in the Vercel dashboard before
  the first deploy, and redeploy if you add any afterwards.
- **`SUPABASE_SERVICE_ROLE_KEY` is an admin key** that bypasses Row Level Security. Server-side
  only. Never `NEXT_PUBLIC_`, never imported into a component, never committed.
- **Switching LLM providers is one line:** `LLM_PROVIDER=gemini|anthropic|none`.

---

## 3. What's actually built

Everything below runs today.

| Capability | How |
|---|---|
| Objective case complexity | CPT → work RVU catalog, 33 procedures, + duration + emergent + modifiers |
| Cognitive load ("mind-burn") | Six SURG-TLX dimensions estimated ex ante |
| Personal calibration | One-tap 1–10 exertion rating → per-surgeon multiplier, shrunk by sample size |
| Fatigue / alertness score | Two-process model: sleep debt, wakefulness, circadian, night rotations, operative load |
| 48h forward projection | Hourly, powers the heatmap and the alertness curve |
| Demand-vs-capacity mismatch | Case demand × surgeon deficit → the number that sorts the board |
| Schedule organization | 6 sort axes, 6 groupings, structural flag detection, AI action plan |
| Assignment recommendation | Competency → availability → duty-hours → rank → LLM → **human approval** |
| ACGME duty-hour checking | 5 rules; regulatory for trainees, advisory for attendings |
| Field-level privacy | Surgeon-controlled visibility + non-overridable biometric hard rules |
| Audit trail | Every suggestion, decision, and override |
| Deterministic fallback | Every LLM path degrades gracefully; nothing breaks without a key |

**Synthetic and clearly labelled:** all surgeons, shifts, cases, and sleep logs.
**Roadmap, not built:** WHOOP/Oura ingestion, FHIR/Epic integration, real authentication, RLS.

---

## 4. The four models

The core design decision: **these are four separate models, not one score.** Conflating
them is what makes scheduling tools useless.

### `lib/complexity.js` — how hard is this case?

Three layers:

1. **Objective** — work RVU + duration + emergent + modifiers (redo, trauma, pediatric). Zero
   subjectivity: the RVU is the health system's own standardized estimate of procedural
   demand, already in every billing system.
2. **Personal** — the post-case 1–10 rating is *never* used as the difficulty. It calibrates a
   bounded per-surgeon multiplier, shrunk toward neutral by sample size. A subjective input
   used as a calibration signal is useful; the same input used as the measurement is noise.
3. **LLM fill-in** — free text → CPT/RVU/duration when the catalog can't match.

Outputs `fatigue_load` — depletion, not difficulty. A 7h routine case depletes more than a
1h hard one.

### `lib/cognitive.js` — how much will this case burn?

Six **SURG-TLX** dimensions (the validated surgical adaptation of NASA-TLX), estimated
*before* the case from CPT/RVU, duration, urgency, modifiers, and a specialty demand profile.

This is the axis duty-hour systems cannot see. A 7h hip revision and a 90-minute redo
aneurysm clipping are nowhere near each other here, even though the clock says otherwise.

Also produces `cognitive_recovery_hours` — a heavy case leaves a surgeon degraded *after*
it ends, which is why back-to-back extreme cases are worse than the sum of their parts.

### `lib/fatigue.js` — how recovered is this person?

A transparent two-process model (the framework behind aviation/trucking FRMS):

- **Process S** — acute sleep deficit, 7-day cumulative debt, continuous wakefulness
- **Process C** — circadian, with a nadir at 02:00–06:00 and an afternoon dip
- Plus **consecutive night rotations** and **RVU-weighted operative load**

Empirical anchors: the **6-hour** sleep-opportunity threshold is encoded as an explicit
discontinuity (threshold-shaped evidence gets a threshold-shaped term); **17 hours awake**
sets the wakefulness penalty.

Pure arithmetic — no network, no key, no failure mode. This is the insurance policy.

### `lib/organize.js` — where is the problem?

Sorting by complexity tells you which cases are hard. Sorting by fatigue tells you who is
tired. **Neither finds the problem.** The problem is where a high-demand case meets a
low-capacity surgeon, and that's `demandCapacityMismatch` — multiplicative, not additive,
because a brutal case on a rested surgeon is fine and an easy case on an exhausted one is
survivable. The product is what's dangerous.

---

## 5. Where the AI actually does work

Judges will ask this specifically. Be precise.

| # | What | Why an LLM | Fallback |
|---|---|---|---|
| 1 | **Schedule organization** (`/api/schedule/organize`) | Reads the whole scored board and produces a scheduler's action plan — which 3 of 40 cases matter, which 2 problems share a root cause, where a fix breaks something else | Full deterministic board: scored, sorted, flagged |
| 2 | **Assignment reasoning** (`/api/assign`) | Ranks pre-vetted candidates and writes the justification a human will read | Deterministic suitability ranking |
| 3 | **Procedure classification** (`/api/procedures/classify`) | Free text → CPT/RVU/duration. Genuine text-to-structure with no deterministic solution | Catalog lookup; neutral default if unmatched |
| 4 | **Fatigue narrative** (`POST /api/fatigue`) | Turns a component breakdown into a specific, readable explanation | Deterministic reasoning string |

### The design decision worth saying out loud

**The LLM does not invent the score, and it does not do the sorting.**

Sorting is something code does correctly, cheaply, and identically every time — handing it
to a model would be worse on all three counts. And a model that produces a fatigue score
from scratch is not reproducible (same data, different number tomorrow), not auditable
("why is Dr. Okafor amber?" → "the model said so"), and can hallucinate someone into green,
which is a patient-safety failure that is entirely avoidable.

So the deterministic models own every number. The LLM receives them and does what it is
genuinely better at: synthesis, explanation, and judgment over structured data.

It may adjust a fatigue score, but by **at most ±12 points**, only with a stated reason, and
we clamp it server-side. Guardrails that are enforced rather than requested:

- `validateFatigueOutput` — clamps the adjustment, falls back to deterministic prose
- `validateAssignmentOutput` — a hallucinated surgeon is **detected and discarded**, and the
  deterministic ranking is used instead
- `validateOrganizeOutput` — actions referencing a nonexistent case REF are dropped and counted
- `tryGenerateJSON` **never throws** — every caller is structurally forced to have a fallback

---

## 6. Privacy and ethics, as code

Not a policy document — `lib/privacy.js`, enforced on every read.

**Hard rules (not configurable by anyone, including the surgeon and admins):**

- Raw sleep, recovery scores, HRV, numeric alertness scores, fatigue reasoning, and the
  component breakdown are **self-only**.
- Leadership gets a green/amber/red tier and nothing else. `redactFatigue()` strips the rest.
- Nothing identifying is sent to any LLM provider. Surgeons become `S1`, `S2`… and cases
  become `REF-1`, `REF-2`… De-identification is at the prompt boundary, not a policy promise.
- The audit log records tiers and identifiers only — writing biometric values there would be
  a back door around all of the above.

**Surgeon-controlled (the "Hinge-like" part):** every non-biometric field carries a
per-field visibility level — `private` / `leadership` / `care_team` / `roster`. Defaults are
private-leaning: you opt *in* to sharing. Redacted responses report *which* fields were
withheld (names only, never values) so a director knows they're seeing a partial picture by
design rather than wondering if the data is broken.

**Personal commitments** block time without disclosing why. A scheduler sees
`"Unavailable"`. Nobody should have to disclose a therapy appointment or a family court
date to get their schedule respected.

**Advisory by construction.** There is exactly one code path that changes a case's surgeon:
`POST /api/assign/{id}` with a human decision. `PATCH /api/cases/{id}` explicitly *refuses*
`surgeon_id` and points there. Override requires a written reason — over time that log of
where expert judgment diverges from the model is the most valuable data the system collects.

**Why the hard rules must be structural:** the failure mode of every workplace fatigue
system is that the data becomes a performance-management tool. The moment a surgeon believes
a red score can cost them cases or income, they stop reporting honestly — and you've rebuilt
the self-report culture you were replacing, with worse incentives and a veneer of
objectivity. Leadership can't see the data because the API won't serve it. A surgeon can't
be pressured into sharing it because there's no setting that shares it.

**Personal baselines, not population norms** — deviation from *your own* normal. A
population-norm model would systematically flag older surgeons and anyone whose physiology
differs from the mean.

**Not a medical device.** Scheduling decision support. Does not diagnose. Must not be used
to assess fitness to practise. Stated in the API responses, not just the slides.

---

## 7. Endpoints

All reads take `x-viewer-id` and `x-viewer-role` headers (`self` / `colleague` / `director`
/ `admin` / `public`). **Demo-only identity — trivially spoofable, by design**, so the
frontend can ship a "View as…" dropdown instead of a login screen. See `lib/http.js`.

```
GET    /api/health                      runtime config — start here
GET|POST /api/schedule/organize      ★  the AI organizing engine
GET    /api/roster                      director heatmap, 24–48h tiers
GET|POST /api/surgeons                  directory / registration
GET|PATCH /api/surgeons/{id}            profile + privacy settings (self-only edits)
GET|POST /api/sleep                     sleep logging (self-only, hard rule)
GET|POST /api/fatigue                   score + projection; POST runs the LLM narrative
GET|POST /api/cases                     case database; POST auto-resolves complexity
GET|PATCH /api/cases/{id}               detail; PATCH submits the 1–10 exertion rating
GET|POST /api/events                    non-clinical commitments
GET    /api/calendar                    shared calendar, privacy-filtered
GET    /api/procedures                  CPT/RVU catalog
POST   /api/procedures/classify         LLM: free text → CPT/RVU/tier
GET|POST /api/assign                    recommendation → creates a PENDING suggestion
POST   /api/assign/{id}                 approve / override / reject — only reassignment path
GET    /api/audit                       accountability trail
```

### `/api/schedule/organize` — the one to demo

```bash
curl -H "x-viewer-role: director" \
  "localhost:3000/api/schedule/organize?sort_by=mismatch&group_by=surgeon"
```

**Sort axes:** `mismatch` (default) · `cognitive` · `complexity` · `urgency` ·
`chronological` · `balanced`
**Group by:** `none` · `surgeon` · `day` · `specialty` · `mind_burn` · `risk`

`GET` is deterministic and safe to poll. `POST` adds the AI action plan.

Detects structurally, without the LLM: unassigned cases · demand-capacity mismatches ·
double bookings · **cognitive stacking** (two heavy cases closer together than the first
one's recovery tail) · duty-hour breaches.

---

## 8. Demo script

The seeded board reliably produces this. Run `npm run dev` fresh first — the in-memory
store is cached across hot reloads, so a restart is what regenerates it.

1. **`/api/health`** — "everything is synthetic, here's what's real." Answers the judges'
   first question before they ask it.
2. **`/api/schedule/organize?sort_by=mismatch`** — the whole board, worst first. Top result
   is an **emergent mitral valve replacement, cognitive load 88/100 (extreme), on a surgeon
   projected at 40/100 alertness.** That case is invisible to every hours-based system: it's
   short, it's within duty limits, and it's the most dangerous thing on the board.
3. **`?sort_by=cognitive`** — re-sort the same board by mind-burn. Show that the ranking
   changes completely, and show the six SURG-TLX dimensions behind one case.
4. **Flags** — a double-booking, a 49-hour continuous duty ACGME violation, cognitive stacking.
5. **`/api/assign`** → **`POST /api/assign/{id}`** — the AI recommends with justification;
   the human approves. Emphasize: the case was *never* reassigned automatically.
6. **Privacy** — `GET /api/fatigue?surgeon_id=1` as `self`, then as `director`. Same endpoint,
   the director gets a tier and nothing else.

Scoping note if you fall behind: **cut the surgeon-facing view before the director board.**
The board is what makes this a workplace tool rather than another wellness tracker.

---

## 9. Honest limitations

Say these before a judge finds them. Every one is in the source comments too.

- **RVU values are approximate and hand-entered.** Correct relative ordering, not
  authoritative, not billing-suitable. Real fix is a ~20-line import of the free CMS
  Physician Fee Schedule Relative Value Files.
- **The fatigue coefficients are plausible, not validated.** Tuned to reproduce the direction
  and rough magnitude of published findings. *Evidence-informed* is fair; *evidence-based*
  would be false.
- **SURG-TLX is validated; this ex-ante estimation of it is not.** "Structured on a validated
  instrument" is the defensible claim. Fix: collect post-case ratings and fit the weights.
- **No real authentication.** Headers declare identity. Must be replaced by verified sessions.
- **RLS is off.** Privacy is enforced in the app layer. In production these rules belong in
  Postgres Row Level Security so a bug in a route can't leak data. Migration path in
  `scripts/schema.sql`.
- **In-memory store resets on restart**, and each Vercel serverless instance gets its own
  copy. Fine for a demo; wire up Supabase before relying on writes persisting.
- **No Gemini call has completed end-to-end** — no key was available during the build. The
  request *shape* is confirmed: tested against the live API with a deliberately invalid key,
  Google parsed and validated the body and rejected only the credential (`API_KEY_INVALID`),
  which a malformed payload would not do. Untested: response parsing and schema conformance
  on a real 200. Failure handling *is* tested — a bad key returns a fully scored, sorted,
  flagged board with `method: "deterministic-fallback"` and no narrative.
  **Add a key and run `POST /api/schedule/organize` once before the demo.**
- **Counter-evidence exists.** A large Ontario study found near-identical complication rates
  whether or not the surgeon worked overnight. It never measured actual sleep. That critique
  *is* the product thesis — hours worked is a bad proxy — so lead with it rather than hiding it.

---

## 10. File map

```
lib/
  config.js        runtime config; every external dependency is optional
  http.js          response envelopes, errors, demo-only viewer identity
  validate.js      input validation
  procedures.js    CPT/RVU catalog (33 procedures) + modifier detection
  complexity.js    3-layer case difficulty
  cognitive.js     SURG-TLX cognitive load + person-specific profile + mismatch
  fatigue.js       two-process alertness model + 48h projection
  acgme.js         duty-hour rules
  privacy.js       ★ visibility, redaction, de-identification, hard rules
  llm.js           provider-agnostic LLM; never throws
  prompts.js       4 prompts + schemas + output validation
  assessment.js    per-surgeon pipeline
  assignment.js    candidate gating + ranking + recommendation
  organize.js      ★ board scoring, sorting, flag detection
  store.js         Supabase | in-memory
  supabase.js      client
  seed.js          synthetic dataset (deterministic PRNG)
app/api/…          16 route handlers
scripts/
  schema.sql       paste into the Supabase SQL Editor
  seed-supabase.mjs   npm run seed
  smoke.mjs           npm run smoke — 79 assertions
```

Ownership: this branch owns `lib/`, `app/api/`, `scripts/`. `app/page.js`, `app/layout.js`,
and `app/globals.css` are **placeholder stubs** for the frontend branches to replace —
Tailwind v4 is already wired so nobody is blocked on setup.
