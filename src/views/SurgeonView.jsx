import React, { useMemo, useState } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { useStore } from '../lib/store.jsx'
import { sleepTimeline, lowestDuring, bandFor } from '../lib/fatigue.js'
import { HOUR, fmtDayShort, fmtDuration, fmtTime, relTime } from '../lib/time.js'
import AlertnessChart, { ChartKey } from '../components/AlertnessChart.jsx'
import CaseList from '../components/CaseList.jsx'
import DriverBreakdown from '../components/DriverBreakdown.jsx'
import SleepLogForm from '../components/SleepLogForm.jsx'
import {
  BAND_STYLE,
  Button,
  EmptyState,
  Field,
  Panel,
  PanelHeader,
  RiskPill,
  Select,
  Stat,
  Textarea,
} from '../components/ui.jsx'

function FlagControl({ surgeon, onRaise, onClear }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [severity, setSeverity] = useState('advisory')
  const [busy, setBusy] = useState(false)
  const active = (surgeon.flags ?? []).slice(-1)[0]

  if (active) {
    return (
      <div className="px-4 py-4">
        <div className="flex items-start gap-2 rounded-[4px] border border-risk/40 bg-risk-soft px-3 py-2.5">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-risk" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-risk">
              {active.severity === 'stand-down'
                ? 'Stand-down raised'
                : 'Advisory raised'}
            </p>
            <p className="mt-0.5 text-[13px] text-ink-2">{active.reason}</p>
            <p className="mt-1 text-[12px] text-ink-3">
              Sent to the OR director {relTime(active.at)}. You are excluded from new
              assignments while this is active.
            </p>
          </div>
        </div>
        <Button className="mt-3" onClick={() => onClear({ surgeonId: surgeon.id })}>
          <X size={13} aria-hidden="true" />
          Withdraw flag
        </Button>
      </div>
    )
  }

  if (!open) {
    return (
      <div className="px-4 py-4">
        <p className="text-[13px] text-ink-2">
          If you do not think you are safe to operate, say so. The director sees it
          immediately and the scheduler stops offering you new cases.
        </p>
        <Button variant="danger" className="mt-3" onClick={() => setOpen(true)}>
          <TriangleAlert size={13} aria-hidden="true" />
          Flag me as fatigued
        </Button>
      </div>
    )
  }

  return (
    <form
      className="px-4 py-4"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          await onRaise({ surgeonId: surgeon.id, reason: reason.trim(), severity })
          setOpen(false)
          setReason('')
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="grid gap-3">
        <Field label="What is the concern?" htmlFor="flag-reason">
          <Textarea
            id="flag-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Third night in a row, and I have a long resection listed at 08:00."
            required
          />
        </Field>
        <Field
          label="Level"
          htmlFor="flag-severity"
          hint="A stand-down removes you from the assignment pool for 12 hours."
        >
          <Select
            id="flag-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
          >
            <option value="advisory">Advisory, avoid high-complexity cases</option>
            <option value="stand-down">Stand-down, not safe to operate</option>
          </Select>
        </Field>
      </div>
      <div className="mt-3 flex gap-2">
        <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
          {busy ? 'Sending' : 'Send to director'}
        </Button>
        <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export default function SurgeonView({ surgeonId }) {
  const store = useStore()
  const { now, projections } = store
  const surgeon = store.surgeon(surgeonId)
  const projection = projections[surgeonId]

  const cases = useMemo(
    () =>
      store
        .casesFor(surgeonId)
        .filter((c) => c.end > now && c.start < now + 48 * HOUR),
    [store, surgeonId, now]
  )

  const sleepWindows = useMemo(
    () => (surgeon ? sleepTimeline(surgeon, now - 12 * HOUR, now + 48 * HOUR) : []),
    [surgeon, now]
  )

  const todayShift = useMemo(() => {
    if (!surgeon) return null
    const upcoming = (surgeon.duty ?? [])
      .filter((b) => b.end > now)
      .sort((a, b) => a.start - b.start)[0]
    return upcoming ?? null
  }, [surgeon, now])

  if (!surgeon || !projection) return <EmptyState>Loading.</EmptyState>

  const { assessment, curve } = projection
  const style = BAND_STYLE[assessment.band.key]
  const activeFlag = (surgeon.flags ?? []).slice(-1)[0] ?? null
  const nextCase = cases[0]
  const nextCaseLow = nextCase ? lowestDuring(curve, nextCase.start, nextCase.end) : null

  const worstAhead = lowestDuring(curve, now, now + 24 * HOUR)

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div className="grid content-start gap-4">
        <Panel>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <h1 className="text-[18px] font-semibold text-ink">{surgeon.name}</h1>
              <p className="text-[13px] text-ink-3">
                {surgeon.role} · {surgeon.specialty}
              </p>
            </div>
            <div className="flex flex-col items-end">
              <div className="flex items-center gap-1.5">
                {assessment.asleep ? (
                  <span className="rounded-[3px] border border-line px-1.5 py-0.5 text-[12px] text-ink-2">
                    Asleep
                  </span>
                ) : null}
                <RiskPill band={assessment.band} />
              </div>
              <p className="mt-1 max-w-[280px] text-right text-[12px] text-ink-3">
                {activeFlag
                  ? activeFlag.severity === 'stand-down'
                    ? 'You have stood yourself down. The scheduler is not offering you new cases.'
                    : 'Your advisory is with the director.'
                  : assessment.asleep
                    ? 'Logged asleep. This is the score the model expects once you are up and past sleep inertia.'
                    : assessment.band.note}
              </p>
            </div>
          </div>

          <dl className="grid grid-cols-2 divide-x divide-line sm:grid-cols-4">
            <Stat
              label="Effectiveness"
              value={Math.round(assessment.score)}
              unit="/ 100"
              tone={style.text}
              hint={assessment.asleep ? 'Currently logged asleep' : 'Right now'}
            />
            <Stat
              label="Awake"
              value={assessment.hoursAwake.toFixed(1)}
              unit="h"
              hint="Since last recorded sleep"
            />
            <Stat
              label="Sleep debt"
              value={assessment.sleepDebt.toFixed(1)}
              unit="h"
              hint="Rolling 7 days"
            />
            <Stat
              label="On shift"
              value={assessment.timeOnTask > 0 ? assessment.timeOnTask.toFixed(1) : '—'}
              unit={assessment.timeOnTask > 0 ? 'h' : ''}
              hint={assessment.timeOnTask > 0 ? 'Continuous duty' : 'Off duty'}
            />
          </dl>

          {todayShift ? (
            <p className="border-t border-line px-4 py-2.5 text-[13px] text-ink-2">
              <span className="font-medium text-ink">{todayShift.kind}</span>{' '}
              {fmtDayShort(todayShift.start)} {fmtTime(todayShift.start)}–
              {fmtTime(todayShift.end)}
              <span className="text-ink-3">
                {' '}
                · {fmtDuration((todayShift.end - todayShift.start) / HOUR)} ·{' '}
                {todayShift.start > now
                  ? `starts ${relTime(todayShift.start, now)}`
                  : `ends ${relTime(todayShift.end, now)}`}
              </span>
            </p>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader
            title="Predicted effectiveness"
            meta="Next 48 hours, against your logged sleep and rostered duty"
          />
          <div className="px-2 pt-3">
            <AlertnessChart
              samples={curve}
              now={now}
              sleepWindows={sleepWindows}
              cases={cases}
              height={250}
            />
          </div>
          <ChartKey />
          {worstAhead ? (
            <p className="border-t border-line px-4 py-2.5 text-[13px] text-ink-2">
              Lowest point in the next 24 hours:{' '}
              <span className="tnum font-medium text-ink">
                {worstAhead.score.toFixed(0)}
              </span>{' '}
              at {fmtDayShort(worstAhead.t)} {fmtTime(worstAhead.t)} (
              {bandFor(worstAhead.score).label.toLowerCase()}).
            </p>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader
            title="Upcoming cases"
            meta={
              nextCaseLow
                ? `Next case at ${fmtTime(nextCase.start)}, predicted ${nextCaseLow.score.toFixed(0)} at its low point`
                : undefined
            }
          />
          <CaseList cases={cases} samples={curve} now={now} />
        </Panel>
      </div>

      <div className="grid content-start gap-4">
        <Panel>
          <PanelHeader title="Log sleep" meta="Updates the model immediately" />
          <SleepLogForm surgeon={surgeon} now={now} onSubmit={store.logSleep} />
        </Panel>

        <Panel>
          <PanelHeader title="Why this score" meta="Contribution to the number above" />
          <DriverBreakdown drivers={assessment.drivers} />
        </Panel>

        <Panel>
          <PanelHeader title="Raise a concern" />
          <FlagControl
            surgeon={surgeon}
            onRaise={store.raiseFlag}
            onClear={store.clearFlag}
          />
        </Panel>

        <Panel>
          <PanelHeader title="Recent sleep" meta="Last five records" />
          {surgeon.sleepLog.length ? (
            <ul className="divide-y divide-line">
              {surgeon.sleepLog
                .slice(-5)
                .reverse()
                .map((s, i) => (
                  <li
                    key={i}
                    className="flex items-baseline justify-between gap-3 px-4 py-2.5"
                  >
                    <span className="text-[13px] text-ink">
                      {fmtDayShort(s.start)} {fmtTime(s.start)}–{fmtTime(s.end)}
                    </span>
                    <span className="text-[12px] text-ink-3">
                      {fmtDuration((s.end - s.start) / HOUR)} · {s.source ?? 'self-report'}
                      {s.displaced ? ' · displaced by duty' : ''}
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <EmptyState>No sleep recorded yet.</EmptyState>
          )}
        </Panel>
      </div>
    </div>
  )
}
