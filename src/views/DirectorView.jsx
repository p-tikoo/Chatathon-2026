import React, { useEffect, useMemo, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useStore } from '../lib/store.jsx'
import { api } from '../lib/api.js'
import { bandFor, lowestDuring, sleepTimeline } from '../lib/fatigue.js'
import { HOUR, fmtDayShort, fmtTime, relTime } from '../lib/time.js'
import AlertnessChart, { ChartKey } from '../components/AlertnessChart.jsx'
import DriverBreakdown from '../components/DriverBreakdown.jsx'
import FatigueHeatmap from '../components/FatigueHeatmap.jsx'
import SuggestionPanel from '../components/SuggestionPanel.jsx'
import {
  BAND_STYLE,
  Button,
  EmptyState,
  Panel,
  PanelHeader,
  RiskPill,
  Stat,
} from '../components/ui.jsx'

const RECOMMENDATION_LABEL = {
  reassign: 'Reassign',
  assign: 'Unassigned',
  consider: 'Consider',
}

function AttentionList({ items, onSelect, selectedCaseId }) {
  if (!items.length) {
    return (
      <EmptyState>
        Every case in the next 24 hours has a surgeon the model would keep.
      </EmptyState>
    )
  }
  return (
    <ul className="divide-y divide-line">
      {items.map((s) => {
        const tone =
          s.recommendation === 'consider'
            ? 'border-warn/40 bg-warn-soft text-warn'
            : 'border-risk/40 bg-risk-soft text-risk'
        return (
          <li key={s.caseId}>
            <button
              type="button"
              onClick={() => onSelect(s.caseId)}
              className={`grid w-full grid-cols-[82px_1fr_auto] items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-sunken ${
                selectedCaseId === s.caseId ? 'bg-accent-soft' : ''
              }`}
            >
              <span className="tnum text-[13px]">
                <span className="block font-medium text-ink">{fmtTime(s.case.start)}</span>
                <span className="block text-[12px] text-ink-3">
                  {fmtDayShort(s.case.start)}
                </span>
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] text-ink">{s.case.procedure}</span>
                <span className="block text-[12px] text-ink-3">
                  {s.case.room} · {s.case.id} ·{' '}
                  {s.current ? s.current.name : 'no surgeon assigned'}
                  {s.current?.predicted != null
                    ? ` · predicted ${s.current.predicted.toFixed(0)}`
                    : ''}
                  {s.current?.blockers?.length ? ` · ${s.current.blockers[0]}` : ''}
                </span>
              </span>
              <span
                className={`rounded-[3px] border px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
              >
                {RECOMMENDATION_LABEL[s.recommendation]}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export default function DirectorView() {
  const store = useStore()
  const { now, data, projections, horizonHours } = store
  const [selectedSurgeonId, setSelectedSurgeonId] = useState(null)
  const [selectedCaseId, setSelectedCaseId] = useState(null)
  const [attention, setAttention] = useState([])
  const [scanning, setScanning] = useState(true)

  const surgeons = data?.surgeons ?? []

  // Counted across the next 24 hours, not at this instant. Mid-afternoon is
  // the best the roster ever looks; what a director schedules against is where
  // each surgeon bottoms out before tomorrow.
  const counts = useMemo(() => {
    const out = { fit: 0, caution: 0, risk: 0 }
    for (const s of surgeons) {
      const samples = projections[s.id]?.curve
      if (!samples) continue
      const low = lowestDuring(samples, now, now + 24 * HOUR)
      if (low) out[bandFor(low.score).key] += 1
    }
    return out
  }, [surgeons, projections, now])

  const flagged = useMemo(
    () => surgeons.filter((s) => (s.flags ?? []).length > 0),
    [surgeons]
  )

  // Scan the next 24h for cases the model would change. Runs through the same
  // endpoint the panel uses, one call per case.
  useEffect(() => {
    let live = true
    if (!data) return
    setScanning(true)
    const upcoming = data.cases.filter(
      (c) => c.start > now && c.start < now + 24 * HOUR
    )
    Promise.all(upcoming.map((c) => api.suggestAssignment({ caseId: c.id })))
      .then((results) => {
        if (!live) return
        const flaggedCases = results
          .filter((r) => r && r.recommendation !== 'keep')
          .sort((a, b) => {
            const order = { reassign: 0, assign: 1, consider: 2 }
            const d = order[a.recommendation] - order[b.recommendation]
            if (d !== 0) return d
            return (a.current?.predicted ?? 0) - (b.current?.predicted ?? 0)
          })
        setAttention(flaggedCases)
        setScanning(false)
      })
      .catch(() => live && setScanning(false))
    return () => {
      live = false
    }
  }, [data, now])

  const selected = selectedSurgeonId ? store.surgeon(selectedSurgeonId) : null
  const selectedProjection = selectedSurgeonId ? projections[selectedSurgeonId] : null

  const selectedSleep = useMemo(
    () => (selected ? sleepTimeline(selected, now - 12 * HOUR, now + 48 * HOUR) : []),
    [selected, now]
  )
  const selectedCases = useMemo(
    () => (selectedSurgeonId ? store.casesFor(selectedSurgeonId) : []),
    [store, selectedSurgeonId]
  )

  if (!data) return <EmptyState>Loading the roster.</EmptyState>

  return (
    <div className="grid gap-4">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h1 className="text-[18px] font-semibold text-ink">Department roster</h1>
            <p className="text-[13px] text-ink-3">
              {surgeons.length} surgeons · next {horizonHours} hours · updated{' '}
              {fmtTime(now)}
            </p>
          </div>
          <Button onClick={store.refresh}>Refresh</Button>
        </div>

        <dl className="grid grid-cols-2 divide-x divide-line sm:grid-cols-5">
          <Stat
            label="Stay fit"
            value={counts.fit}
            tone={BAND_STYLE.fit.text}
            hint="Never below 77 in 24h"
          />
          <Stat
            label="Dip to caution"
            value={counts.caution}
            tone={BAND_STYLE.caution.text}
            hint="Bottom out 65 to 76"
          />
          <Stat
            label="Dip to high risk"
            value={counts.risk}
            tone={BAND_STYLE.risk.text}
            hint="Bottom out under 65"
          />
          <Stat
            label="Self-flagged"
            value={flagged.length}
            tone={flagged.length ? BAND_STYLE.risk.text : undefined}
            hint="Raised by the surgeon"
          />
          <Stat
            label="Cases to action"
            value={scanning ? '—' : attention.length}
            hint="Next 24 hours"
          />
        </dl>

        {flagged.length ? (
          <ul className="divide-y divide-line border-t border-line">
            {flagged.map((s) => {
              const f = s.flags[s.flags.length - 1]
              return (
                <li key={s.id} className="flex items-start gap-2 px-4 py-2.5">
                  <TriangleAlert
                    size={15}
                    className="mt-0.5 shrink-0 text-risk"
                    aria-hidden="true"
                  />
                  <p className="text-[13px] text-ink-2">
                    <button
                      type="button"
                      className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
                      onClick={() => setSelectedSurgeonId(s.id)}
                    >
                      {s.name}
                    </button>{' '}
                    raised {f.severity === 'stand-down' ? 'a stand-down' : 'an advisory'}{' '}
                    {relTime(f.at, now)}: {f.reason}
                  </p>
                </li>
              )
            })}
          </ul>
        ) : null}
      </Panel>

      <Panel>
        <PanelHeader
          title="Fatigue heatmap"
          meta="Select a surgeon for their curve and the reasons behind it"
        />
        <FatigueHeatmap
          surgeons={surgeons}
          projections={projections}
          now={now}
          horizonHours={horizonHours}
          selectedId={selectedSurgeonId}
          onSelect={(id) => setSelectedSurgeonId(id === selectedSurgeonId ? null : id)}
        />
      </Panel>

      {selected && selectedProjection ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
          <Panel>
            <PanelHeader
              title={selected.name}
              meta={`${selected.role} · ${selected.specialty} · ${selectedCases.length} cases assigned`}
              action={
                <RiskPill
                  band={selectedProjection.assessment.band}
                  score={selectedProjection.assessment.score}
                />
              }
            />
            <div className="px-2 pt-3">
              <AlertnessChart
                samples={selectedProjection.curve}
                now={now}
                sleepWindows={selectedSleep}
                cases={selectedCases}
                height={220}
              />
            </div>
            <ChartKey />
          </Panel>
          <Panel>
            <PanelHeader title="Why this score" />
            <DriverBreakdown drivers={selectedProjection.assessment.drivers} />
          </Panel>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,1fr)]">
        <Panel>
          <PanelHeader
            title="Needs attention"
            meta={
              scanning
                ? 'Scanning the next 24 hours'
                : `${attention.length} cases in the next 24 hours the model would change`
            }
          />
          {scanning ? (
            <EmptyState>Running the roster against every scheduled case.</EmptyState>
          ) : (
            <AttentionList
              items={attention}
              onSelect={setSelectedCaseId}
              selectedCaseId={selectedCaseId}
            />
          )}
        </Panel>

        <SuggestionPanel
          caseId={selectedCaseId}
          suggest={store.suggest}
          onReassign={store.reassign}
        />
      </div>
    </div>
  )
}
