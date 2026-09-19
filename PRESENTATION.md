# Pre-flight checklist + presentation playbook

Two parts: **everything still needed before you present**, and **everything to say when you do**.

---

# PART 1 — What we still need

## 1.1 Blocking — do these or the demo suffers

| # | Task | Time | Why it's blocking |
|---|---|---|---|
| **1** | **Get a Gemini API key and test all four AI paths** | 15 min | **Zero successful LLM calls have ever happened.** The plumbing is tested, the request shape is confirmed valid, but no real response has ever been parsed. If it's broken you need to know now, not on stage. |
| **2** | **Build the director board UI** | 60–90 min | This is the demo. Without it you're showing JSON. |
| **3** | **Deploy to Vercel and confirm the live URL works** | 15 min | Submission requires a working repo/URL. Do it early, redeploy often. |
| **4** | **Rehearse the demo out loud, timed, on the deployed URL** | 20 min | Everything always breaks the first time you say it aloud. |

### Task 1 in detail — do this first

```bash
# 1. https://aistudio.google.com/apikey  ->  Create API key  (free, no card, ~60s)
# 2. echo 'GEMINI_API_KEY=AIza...' >> .env.local
# 3. npm run dev
# 4. Test all four AI paths:

curl -X POST -H "x-viewer-role: director" -H "Content-Type: application/json" \
  -d '{"sort_by":"mismatch"}' localhost:3000/api/schedule/organize   # AI action plan

curl -X POST -H "x-viewer-role: director" -H "Content-Type: application/json" \
  -d '{"procedure_name":"redo aortic root replacement with elephant trunk"}' \
  localhost:3000/api/procedures/classify                            # free text -> CPT/RVU

curl -X POST -H "x-viewer-role: self" -H "x-viewer-id: 1" -H "Content-Type: application/json" \
  -d '{"surgeon_id":1}' localhost:3000/api/fatigue                   # fatigue narrative

curl -X POST -H "x-viewer-role: director" -H "Content-Type: application/json" \
  -d '{"case_id":1}' localhost:3000/api/assign                       # assignment reasoning
```

**Check `method` in each response.** You want `"llm-assisted"`. If you see
`"deterministic-fallback"`, read `llm_status.message` — it will tell you exactly what failed.

Everything still returns a valid answer if the LLM fails, so a bad key degrades the demo
rather than killing it. But you want the AI narrative working, because it's the differentiator.

## 1.2 Should do if time allows

| Task | Time | Notes |
|---|---|---|
| Surgeon-facing view | 45 min | **Cut this before the director board** if you're behind. |
| Wire up Supabase | 20 min | ⚠️ **That code has never executed.** Static-checked only. If short on time, skip it — the in-memory store works and is tested. "Synthetic, clearly labelled" is what the guide asks for anyway. |
| Replace RVU catalog with real CMS data | 20 min | [CMS PFS Relative Value Files](https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files) — free CSV. Turns the weakest claim into a strong one. |
| Seed one unassigned emergent case | 5 min | Makes the "unassigned sorts to top" behaviour visible in the demo. |

## 1.3 Explicitly NOT doing — and say so

Real authentication · Postgres Row Level Security · WHOOP/Oura ingestion · FHIR/Epic
integration · model validation against outcome data.

Naming these as roadmap scores better than hiding them. The guide rewards distinguishing
built from planned.

## 1.4 APIs — what to sign up for

**Only Gemini is required.** Full instructions in `.env.example`.

| Service | Required | Cost | Link |
|---|---|---|---|
| **Gemini** | **Yes** | Free, no card | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Vercel | To deploy | Free Hobby | [vercel.com/signup](https://vercel.com/signup) |
| Supabase | No | Free | [supabase.com/dashboard](https://supabase.com/dashboard) |
| Anthropic | No (alternate) | Paid after trial | [console.anthropic.com](https://console.anthropic.com/) |
| WHOOP | No (roadmap) | Needs membership | [developer.whoop.com](https://developer.whoop.com/) |

⚠️ **Vercel does not read `.env.local`.** Add every variable in the dashboard before the
first deploy, and redeploy if you add any afterwards.

## 1.5 Submission checklist

- [ ] Repo opens in an **incognito window** while signed out
- [ ] Vercel build is green, live URL loads
- [ ] `npm run smoke` passes (79 checks)
- [ ] No API keys committed — `.env.local` is gitignored, `.env.example` has empty values
- [ ] Google Form: team name, all Northeastern emails, track, title, summary, AI used, repo URL
- [ ] **Submit before the last commit.** Don't wait.

---

# PART 2 — The presentation

**Five minutes.** This is a guide, not a script to read aloud. Say it in your own words —
but the specific numbers matter, so keep those exact.

## 2.0 The one-sentence version

> Hospitals schedule surgeons by hours worked. Hours worked is a bad proxy for fatigue —
> and surgeons, patients, and hospitals all pay for that gap.

## 2.1 — The gap (30 seconds)

Open with the contradiction. It's the strongest thing you have.

> "There's a study out of Ontario that found surgical complication rates were basically
> identical whether or not the surgeon had worked overnight — 22.2% versus 22.4%. That got
> used to argue fatigue doesn't matter.
>
> But that study never measured how much sleep those surgeons actually got. It used
> 'worked overnight' as a stand-in for 'sleep-deprived.' An hour-long procedure at midnight
> followed by a late start isn't sleep deprivation.
>
> When researchers measured actual sleep opportunity instead, a very different number
> appeared: under six hours, complication rates were **170% higher**.
>
> So the literature isn't contradictory. **The measurement is broken.** And hospital
> scheduling systems use that exact same broken measurement — hours, not recovery."

**Why open here:** it reframes messy evidence as your reason to exist, and it inoculates you
against the judge who's read the Ontario study.

## 2.2 — The evidence (45 seconds)

Four numbers. Don't add more.

| Number | What it is |
|---|---|
| **60%** | Trauma surgeon burnout — highest of any surgical specialty. Meta-analysis, 19 studies, 4,634 surgeons. |
| **2.5×** | Greater odds of being involved in a medical error among surgeons with high burnout. Emotional exhaustion alone: 1.7×. |
| **170%** | Higher complication rate at ≤6 hours of sleep opportunity. |
| **4.98 vs 6.68** | Hours slept post-call vs non-post-call. 60 attending surgeons, 362 observed cases. |

Supporting, if asked: urology burnout 49.5%, general surgery 43.8% (AMA 2025, ~19,000
physicians). Simulator studies show 11–32% reductions in technical performance under sleep loss.

Land it on the stakeholder, not the statistic:

> "This hurts everyone at once. The surgeon burns out and leaves. The patient carries
> elevated risk. The hospital eats malpractice exposure and turnover cost. And the
> department lead is making staffing calls on gut feel, because nobody has given them data."

## 2.3 — Live demo (2 min 30 — the bulk of your time)

Six beats. Practice the transitions, not the words.

### Beat 1 — "Is this real?" (15s)

Open `/api/health` first.

> "Everything you're about to see is synthetic and labelled as synthetic. The API says so
> itself — it reports its own configuration rather than asking you to trust a slide. There
> is no patient data anywhere in this system, by design."

**Why:** this is the first thing judges want to know. Answer it before they ask.

### Beat 2 — The board, sorted by risk (45s) ⭐ **the core moment**

Open the director board, default sort.

> "This is every surgery in the department over the next week — 26 cases. It's sorted by
> demand-versus-capacity mismatch, and the top result is this:
>
> **An emergent mitral valve replacement. Cognitive load 88 out of 100 — extreme. Assigned
> to a surgeon projected at 40 out of 100 alertness at that exact hour.**
>
> Here's why that case matters: **every existing system is blind to it.** It's short. It's
> inside duty-hour limits. Nobody's rota flags it. And it is the most dangerous thing on
> this board."

Then the key conceptual line:

> "Sorting by complexity tells you which cases are hard. Sorting by fatigue tells you who's
> tired. **Neither one finds that case.** You only find it by multiplying the two — a
> demanding case meeting a depleted surgeon. That's the number this board sorts on."

### Beat 3 — Re-sort by cognitive load (30s)

Switch the sort axis. The ranking changes completely.

> "This is the axis that doesn't exist in any duty-hour system: **how mind-burning a case
> is**, as opposed to how long it takes. A seven-hour routine hip revision and a
> ninety-minute redo aneurysm clipping are nowhere near each other here — but to a duty-hour
> log, an hour is an hour.
>
> We estimate six dimensions from **SURG-TLX**, the validated surgical workload instrument.
> For this case the drivers are situational stress at 100, time pressure at 92, technical
> complexity at 89."

### Beat 4 — Structural flags (20s)

> "The system also catches things no per-case score can see. On this board: a **double
> booking**. A resident at **49 hours of continuous scheduled duty** — that's an ACGME
> violation, checked automatically. And **cognitive stacking** — two extreme cases scheduled
> closer together than the recovery tail of the first one. Cognitive depletion outlasts the
> case, so two back-to-back is worse than the two scores suggest."

### Beat 5 — AI recommends, human decides (30s)

Trigger an assignment, show the justification, approve it.

> "Here the AI recommends who should take this case, and justifies it with the actual
> numbers — not 'this surgeon is well rested,' but 'green tier, 1.2 depleting hours in the
> last 24 versus 7.8 for the current assignee.'
>
> And then **a human approves it.** The case was never reassigned automatically. There is
> exactly one code path in this entire system that changes who's operating, and it requires
> a person. An override requires a written reason."

### Beat 6 — Privacy, live (20s) ⭐ **the moment that wins the ethics points**

Same endpoint, twice, different viewer role.

> "Same endpoint. As the surgeon: full score, full reasoning, all their sleep data.
>
> As the OR director: **a colour. That's it.** No score, no reasoning, no sleep, no
> biometrics. And that's not a setting anyone can change — not the director, not an admin,
> not even the surgeon. The API will not serve it."

## 2.4 — Ethics (45 seconds)

Lead with the failure mode, not the principle. It's more convincing.

> "Every workplace fatigue system fails the same way: the data becomes a performance
> management tool. The moment a surgeon believes a red score can cost them cases or income,
> they stop reporting honestly — and you've rebuilt the exact self-report culture you were
> replacing, except now it has a veneer of objectivity.
>
> So the guarantee has to be structural, not cultural:
>
> - **Leadership sees tiers, never data.** Enforced in code, not policy.
> - **Non-punitive by design.** A red score triggers schedule support. Never lost cases, never lost income.
> - **Advisory, never autonomous.** The AI recommends. A human decides. Always.
> - **Personal baselines, not population norms** — deviation from *your own* normal. A
>   population-average model would systematically flag older surgeons and anyone whose
>   physiology differs from the mean. That's a bias we designed out.
> - **Nothing identifying reaches the AI.** Surgeons are S1, S2. Cases are REF-1, REF-2.
> - **Not a medical device.** It supports scheduling. It does not diagnose."

## 2.5 — Built vs. planned (30 seconds)

The guide specifically rewards this. Be exact.

> "**Working right now:** four scoring models, sixteen API endpoints, the organizing engine
> with six sort axes, ACGME duty-hour checking, the full privacy layer, and an AI action
> plan — with a deterministic fallback on every single AI path, so nothing here can break
> because a rate limit was hit.
>
> **Synthetic and labelled:** all surgeon and case data.
>
> **Roadmap:** WHOOP integration for real recovery data, FHIR/Epic for real case feeds,
> and validating our model coefficients against actual outcome data."

---

# PART 3 — Q&A prep

Judges will ask these. Rehearse the answers.

### "Where does the AI actually help? Isn't this a chatbot wrapper?"

> "Four places: organizing the board into an action plan, assignment reasoning, mapping
> free-text procedures to CPT codes, and fatigue narratives.
>
> But the more useful answer is where we deliberately **didn't** use it. The AI does not
> invent the fatigue score and does not do the sorting. Sorting is something code does
> correctly and identically every time. And a model that generates a score from scratch
> isn't reproducible, isn't auditable, and can hallucinate someone into green — which is a
> patient-safety failure that's completely avoidable.
>
> So the deterministic model owns every number. The AI can adjust a score by at most ±12
> points, with a stated reason, and we clamp it server-side. If it names a surgeon who isn't
> on the eligible list, we detect it and throw the answer away."

### "What's actually working versus simulated?"

> "Working: all scoring, sorting, flagging, duty-hour checking, privacy enforcement, and the
> AI layer. Simulated: the surgeon and case data — 12 synthetic surgeons, clearly labelled,
> no patient data anywhere. Not built: wearable ingestion and Epic integration."

### "How accurate is your fatigue model?" *(the hard one — answer honestly)*

> "It's evidence-informed, not evidence-validated, and I want to be precise about that.
>
> The structure is a real two-process model — the same framework aviation and trucking use
> for fatigue risk management. The empirical anchors are real: the six-hour threshold, the
> seventeen-hours-awake impairment finding.
>
> But we chose the coefficients ourselves to reproduce the direction and rough magnitude of
> those findings. They aren't fitted to outcome data. Validating them would need a
> prospective study, and that's the honest roadmap."

**Do not** claim it's validated. A clinician judge will catch it instantly and you lose the room.

### "Where do the RVU numbers come from?"

> "RVUs are real — every CPT code carries a work RVU under the Medicare fee schedule, and
> it's the health system's own standardized estimate of how demanding a procedure is. We're
> not inventing a difficulty scale; we're reusing the one that already exists in every
> hospital's billing system.
>
> Our catalog of 33 procedures is hand-entered and approximate — correct relative ordering,
> not billing-grade. Swapping it for the free CMS data file is about twenty lines."

### "Isn't difficulty subjective?"

> "That's exactly the problem we designed around, and the answer is that we never ask a
> surgeon how hard a case was.
>
> The base is objective — RVU, duration, emergency status. Then after a case the surgeon taps
> a 1–10 rating, and we use that as a **calibration signal**, never as the difficulty. It
> teaches us how far this specific surgeon runs from what the RVU predicts. A subjective
> input used for calibration is useful; used as the measurement it's just noise. And it's
> shrunk by sample size, so two ratings can't produce a confident conclusion about a person."

### "What stops a hospital using this to discipline people?"

> "Structurally, the API won't serve leadership the data — they get a colour. There's no
> setting that changes it. Biometric fields are self-only in code.
>
> Beyond that it's a deployment contract, and we'd say so plainly: this only works if it's
> opt-in and non-punitive. Any hospital that penalizes a red score will get gamed within a
> month, and they'll be back to self-report with extra steps."

### "What about HIPAA?"

> "There is no patient data in the system at all — no patient table, no identifier, no
> diagnosis. A case is a procedure code, a duration, and a time. That omission is deliberate
> and it keeps the whole system outside PHI scope.
>
> Surgeon sleep data is sensitive but it isn't PHI in this context. For a real deployment
> you'd need encryption at rest, retention policies, and Row Level Security in the database
> rather than the app layer — that's on the roadmap and we know exactly where it goes."

### "Why does the schedule change if I reload at 3am?"

> "Because it should. The circadian term adds up to 18 points between 2 and 6am regardless
> of how much anyone slept. The same roster is a genuinely different risk picture overnight,
> and that's the point — a system that returns the same answer at 3am as at 3pm isn't
> modelling fatigue."

---

# PART 4 — Things NOT to say

| ❌ Don't say | ✅ Say instead |
|---|---|
| "Our model is validated" | "Evidence-informed, structured on a validated framework. Validating the coefficients is the roadmap." |
| "We use real hospital data" | "Synthetic, clearly labelled. No patient data anywhere by design." |
| "The AI decides who operates" | "The AI recommends. A human approves. Always." |
| "It detects fatigue" | "It estimates fatigue risk for scheduling support. It's not a medical device and doesn't diagnose." |
| "These are the exact RVUs" | "Approximate, correct relative ordering. The real CMS file is a twenty-line swap." |
| "It prevents complications" | "It targets the window where complication rates ran 170% higher." |
| Naming a real hospital or surgeon | Keep everything fictional. |

**Impact claim, stated conservatively — use this wording:**

> "If fatigue-aware assignment moves even a fraction of high-acuity cases out of
> sub-six-hour-sleep windows, it's targeting the population where complication rates ran
> 170% higher. For the hospital, that's reduced malpractice exposure and a retention lever
> against the 60% burnout figure that drives surgeons out of the specialty."

---

# Appendix — demo numbers

From the current seed. **Regenerate and re-check before presenting** — case times are
relative to when the server starts, so exact values shift.

```
Roster:  12 surgeons — 3 red, 4 amber, 5 green, 4 on call, 1 duty-hour violation
Board:   26 cases — 4 light / 14 moderate / 4 heavy / 4 extreme mind-burn

Top by mismatch:
  62.6  cog 88.3 extreme   Emergent mitral valve replacement    Dr. Wei Chen   [amber, projected 40]
  60.3  cog 83.4 extreme   Ascending aorta + root replacement   Dr. Wei Chen   [amber, projected 41]
  54.4  cog 60.4 heavy     Emergent lumbar laminectomy          Dr. Marchetti  [red,   projected 31]

Critical flags: 2 demand-capacity mismatches, 1 ACGME violation (49h continuous), 1 double booking
```

Refresh them with:

```bash
curl -H "x-viewer-role: director" \
  "localhost:3000/api/schedule/organize?sort_by=mismatch" | head -c 2000
```

Full technical detail, architecture, and limitations: **[BACKEND.md](BACKEND.md)**.
