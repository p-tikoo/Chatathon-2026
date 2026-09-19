# Theatre scheduling, fatigue-aware

A scheduling front end for an operating department that treats surgeon alertness
as a first-class scheduling constraint. Two views over one codebase, switched
with the "View as" control in the header. No login.

All data is synthetic. Every surgeon, case, shift and sleep record is
fabricated, and the app says so on every screen.

## Running it

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173.

The frontend expects the API on `http://127.0.0.1:8000`, proxied through
`/api` (see `vite.config.js`). **If the backend is not up, the app falls back to
an equivalent model running in the browser** so it stays demonstrable. The
header shows which is live: "Service connected" or "Local model". Fallback state
is in memory only and resets on reload.

## The views

**Surgeon** — current effectiveness score and band, the 48-hour predicted
curve against logged sleep and rostered duty, a breakdown of what is moving the
number, a sleep log form, upcoming cases each scored at its own low point, and a
"flag me" control that raises an advisory or a stand-down.

**OR director** — the department as a fatigue heatmap across 48 hours in
two-hour blocks, counts of who stays fit and who bottoms out, self-reported
flags, a list of cases in the next 24 hours the model would change, and a
ranked assignment panel with the reasoning and a one-click reassign.

**Registration** — specialty and grade, habitual sleep window and chronotype,
the standing weekly roster, other commitments that compete with rest, and hard
limits. This is the baseline the model works from before any sleep is logged.

## The model

`src/lib/fatigue.js`. The core is the two-process model of sleep regulation:

- **Process S**, homeostatic sleep pressure, rising toward 1 while awake with a
  time constant of 18.2h and dissipating during sleep with a time constant of
  4.2h, scaled by sleep quality.
- **Process C**, the circadian alertness rhythm: a 24h cosine with its peak in
  the late afternoon, shifted by chronotype, plus a 12h harmonic that produces
  the early-afternoon dip.

`effectiveness = 100 * (1.1 - 0.42*S + 0.115*C)`, then reduced by four things
the core does not cover: chronic sleep debt over a rolling 7 days, time on task
beyond 8 continuous hours, sleep inertia in the 30 minutes after waking, and
cumulative night-shift load.

Band thresholds follow the convention used in fatigue-risk management, where
effectiveness of 77 and 65 are treated as roughly equivalent to blood alcohol
concentrations of 0.05% and 0.08%.

Calibration, for a rested surgeon on a 06:00 wake: 99 at 14:00, 85 at 22:00, 70
at 02:00. A night-adapted surgeon with proper day sleep reads 88 at 03:00, which
is the point of modelling adaptation rather than clock time. Sustained
wakefulness puts the two-process core at 68 by 21h awake, against the
Dawson & Reid figure of 65.

This is a demo implementation of a published approach. It is not a validated
clinical instrument and nothing here should be used to make real rostering
decisions.

### Assignment suggestions

`src/lib/assign.js` ranks every credentialled surgeon for a case by predicted
effectiveness at the *low point of the operative window*, not at its start.
Hard rules (wrong specialty, double-booking, a competing commitment, an active
stand-down, passing 16h continuous duty) remove a candidate. Soft scoring
handles the rest: an effectiveness floor that rises with case complexity, a
penalty for being called in, a penalty for time already on duty, and a penalty
for being woken from projected sleep. Every candidate carries its reasons.

## API contract

The frontend calls these. Timestamps may be epoch milliseconds or ISO strings;
both are accepted and normalised on the way in.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/roster` | | `{ surgeons, cases, generatedAt }` |
| POST | `/assess-fatigue` | `{ surgeonId, at?, horizonHours? }` | `{ surgeonId, score, band, drivers[], curve[] }` |
| POST | `/suggest-assignment` | `{ caseId }` | `{ caseId, recommendation, current, candidates[], ineligible[] }` |
| POST | `/sleep-log` | `{ surgeonId, start, end, quality, source }` | `{ ok, surgeon }` |
| POST | `/flag` | `{ surgeonId, reason, severity }` | `{ ok, surgeon }` |
| DELETE | `/flag/{surgeonId}` | | `{ ok, surgeon }` |
| POST | `/register` | profile | `{ ok, surgeon }` |
| POST | `/assign` | `{ caseId, surgeonId }` | `{ ok, case }` |

`recommendation` is one of `keep`, `consider`, `reassign`, `assign`.
`severity` is `advisory` or `stand-down`. `quality` is 0 to 1.

Shapes the roster is expected to use:

```
Surgeon  { id, name, specialty, role, chronotype: 'early'|'neutral'|'late',
           habitualSleep: { bedHour, wakeHour },   // floats, 24h clock
           duty: [{ start, end, kind }],
           sleepLog: [{ start, end, quality, source }],
           commitments: [{ label, start, end }],
           flags: [{ at, reason, severity }] }

Case     { id, room, specialty, procedure, start, end, durationMin,
           complexity: 1-5, acuity: 'elective'|'urgent'|'emergent',
           surgeonId }
```

Note that the director's heatmap is currently computed in the browser from the
roster, while the assessment and suggestion panels go through the endpoints.
Once the backend is serving, a batch assessment endpoint would let the heatmap
use the same source and remove any chance of the two disagreeing.

## Layout

```
src/lib/fatigue.js    two-process model, bands, projection
src/lib/assign.js     candidate ranking and eligibility
src/lib/seed.js       synthetic roster: 15 surgeons, ~45 cases
src/lib/api.js        API client and local fallback
src/lib/store.jsx     app state, 15-minute model grid
src/components/       chart, heatmap, case list, forms
src/views/            surgeon, director, registration
```
