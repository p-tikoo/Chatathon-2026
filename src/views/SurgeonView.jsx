import React, { useMemo, useState } from 'react'
import { ChevronRight, TriangleAlert, X } from 'lucide-react'
import { useStore } from '../lib/store.jsx'
import {
  bandFor,
  lowestDuring,
  sleepTimeline,
  spreadHours,
  withSpread,
} from '../lib/fatigue.js'
import { HOUR, fmtDayShort, fmtDuration, fmtTime } from '../lib/time.js'
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
  Select,
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
        <div className="flex items-start gap-2 rounded-control border border-risk/40 bg-risk-soft px-3 py-2.5">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-risk" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-risk">
              {active.severity === 'stand-down' ? 'Stand-down raised' : 'Advisory raised'}
            </p>
            <p className="mt-0.5 text-sm text-ink-2">{active.reason}</p>
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
        <Button variant="danger" onClick={() => setOpen(true)}>
          <TriangleAlert size={13} aria-hidden="true" />
          Flag me as fatigued
        </Button>
        <p className="mt-2 text-meta text-ink-3">
          Notifies the director and stops new case offers.
        </p>
      </div>
    )
  }

  return (
    <form
      className="grid gap-3 px-4 py-4"
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
      <Field label="What is the concern" htmlFor="flag-reason">
        <Textarea
          id="flag-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Third night in a row, and I have a long resection listed at 08:00."
          required
        />
      </Field>
      <Field label="Level" htmlFor="flag-severity">
        <Select
          id="flag-severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
        >
          <option value="advisory">Advisory, avoid high-complexity cases</option>
          <option value="stand-down">Stand-down, not safe to operate</option>
        </Select>
      </Field>
      <div className="flex gap-2">
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

function statusNote(assessment, activeFlag) {
  if (activeFlag) {
    return activeFlag.severity === 'stand-down'
      ? 'You have stood yourself down. New cases are not being offered.'
      : 'Your advisory is with the director.'
  }
  if (assessment.asleep) {
    return 'Logged asleep. This is the score the model expects once you are up.'
  }
  return assessment.band.note
}

function hourLabel(hour) {
  const h = ((Math.floor(hour) % 24) + 24) % 24
  const m = Math.round((hour - Math.floor(hour)) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function Metric({ label, value, unit }) {
  return (
    <div className="px-4 py-2.5">
      <dt className="text-meta text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-lead text-ink">
        <span className="tnum font-medium">{value}</span>
        {unit ? <span className="ml-0.5 text-sm text-ink-3">{unit}</span> : null}
      </dd>
    </div>
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

  // The forward half of the curve rests on sleep that has not happened, so it
  // carries the range implied by getting less or more of it.
  const curve = useMemo(
    () => (surgeon && projection ? withSpread(surgeon, projection.curve) : []),
    [surgeon, projection]
  )

  const todayShift = useMemo(() => {
    if (!surgeon) return null
    const upcoming = (surgeon.duty ?? [])
      .filter((b) => b.end > now)
      .sort((a, b) => a.start - b.start)[0]
    return upcoming ?? null
  }, [surgeon, now])

  if (!surgeon || !projection) return <EmptyState>Loading.</EmptyState>

  const { assessment } = projection
  const style = BAND_STYLE[assessment.band.key]
  const activeFlag = (surgeon.flags ?? []).slice(-1)[0] ?? null
  const worstAhead = lowestDuring(curve, now, now + 24 * HOUR)
  const recentSleep = surgeon.sleepLog.slice(-3).reverse()
  const sleep = spreadHours(surgeon)

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
      <div className="grid content-start gap-4">
        <Panel>
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
            <div>
              <h1 className="text-h1 font-semibold text-ink">{surgeon.name}</h1>
              <p className="mt-0.5 text-sm text-ink-3">
                {surgeon.role} · {surgeon.specialty}
              </p>
            </div>
            {assessment.asleep ? (
              <span className="rounded-[4px] border border-line bg-sunken px-2 py-0.5 text-meta text-ink-2">
                Asleep
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-5">
            <p className="flex items-baseline gap-1.5">
              <span className={`tnum text-hero font-semibold ${style.text}`}>
                {Math.round(assessment.score)}
              </span>
              <span className="text-sm text-ink-3">/ 100</span>
            </p>
            <div className="min-w-0 max-w-[36ch]">
              <p className={`text-h2 font-medium ${style.text}`}>{assessment.band.label}</p>
              <p className="mt-0.5 text-sm text-ink-2">
                {statusNote(assessment, activeFlag)}
              </p>
            </div>
          </div>

          <dl className="grid grid-cols-3 divide-x divide-line border-t border-line">
            <Metric label="Awake" value={assessment.hoursAwake.toFixed(1)} unit="h" />
            <Metric label="Sleep debt" value={assessment.sleepDebt.toFixed(1)} unit="h" />
            <Metric
              label="On shift"
              value={assessment.timeOnTask > 0 ? assessment.timeOnTask.toFixed(1) : '—'}
              unit={assessment.timeOnTask > 0 ? 'h' : ''}
            />
          </dl>

          {todayShift ? (
            <p className="border-t border-line px-4 py-2.5 text-sm text-ink-2">
              <span className="font-medium text-ink">{todayShift.kind}</span>{' '}
              {fmtDayShort(todayShift.start)} {fmtTime(todayShift.start)}–
              {fmtTime(todayShift.end)}
              <span className="text-ink-3">
                {' · '}
                {fmtDuration((todayShift.end - todayShift.start) / HOUR)}
              </span>
            </p>
          ) : null}

          <details className="group border-t border-line">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-sm text-ink-2 transition-colors duration-150 hover:bg-sunken [&::-webkit-details-marker]:hidden">
              <ChevronRight
                size={14}
                aria-hidden="true"
                className="text-ink-3 transition-transform duration-150 group-open:rotate-90"
              />
              Why this score
            </summary>
            <DriverBreakdown drivers={assessment.drivers} />
          </details>
        </Panel>

        <Panel>
          <PanelHeader
            title="Next 48 hours"
            meta={
              worstAhead
                ? `Projected low ${worstAhead.score.toFixed(0)} at ${fmtDayShort(worstAhead.t)} ${fmtTime(worstAhead.t)}, ${bandFor(worstAhead.score).label.toLowerCase()}`
                : undefined
            }
          />
          <div className="px-2 pt-3 pb-1">
            <AlertnessChart
              samples={curve}
              now={now}
              sleepWindows={sleepWindows}
              cases={cases}
              height={210}
            />
          </div>
          <ChartKey spread />
          <p className="border-t border-line px-4 py-2.5 text-sm text-ink-3">
            Up to <span className="text-ink-2">now</span> the curve is integrated from
            the sleep you logged. After it, the model assumes you sleep{' '}
            {hourLabel(surgeon.habitualSleep.bedHour)}–
            {hourLabel(surgeon.habitualSleep.wakeHour)} on nights you are not rostered,
            keeps the duty already on the roster, and adds no new cases. The shaded
            range is what changes if you get {fmtDuration(sleep.low)} instead of{' '}
            {fmtDuration(sleep.high)}.
          </p>
        </Panel>

        <Panel>
          <PanelHeader
            title="Upcoming cases"
            meta={cases.length ? `${cases.length} in the next 48 hours` : undefined}
          />
          <CaseList cases={cases} samples={curve} now={now} compact />
        </Panel>
      </div>

      <div className="grid content-start gap-4">
        <Panel>
          <PanelHeader title="Log sleep" />
          <SleepLogForm surgeon={surgeon} now={now} onSubmit={store.logSleep} />
          {recentSleep.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {recentSleep.map((s, i) => (
                <li
                  key={i}
                  className="flex items-baseline justify-between gap-3 px-4 py-2 text-sm"
                >
                  <span className="tnum text-ink">
                    {fmtDayShort(s.start)} {fmtTime(s.start)}–{fmtTime(s.end)}
                  </span>
                  <span className="tnum text-meta text-ink-3">
                    {fmtDuration((s.end - s.start) / HOUR)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader title="Raise a concern" />
          <FlagControl
            surgeon={surgeon}
            onRaise={store.raiseFlag}
            onClear={store.clearFlag}
          />
        </Panel>
      </div>
    </div>
  )
}
