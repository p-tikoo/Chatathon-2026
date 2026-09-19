import React, { useEffect, useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { fmtDayShort, fmtDuration, fmtTime } from '../lib/time.js'
import { Button, EmptyState, Panel, PanelHeader, RiskPill } from './ui.jsx'

const HEADLINE = {
  reassign: 'Reassignment recommended',
  consider: 'A better-rested option is available',
  assign: 'No surgeon assigned',
  keep: 'Current assignment holds',
}

function CandidateRow({ c, onPick, busy, isBest }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-ink">{c.name}</span>
          <span className="text-[12px] text-ink-3">{c.role}</span>
          {isBest ? (
            <span className="rounded-[3px] border border-accent/40 bg-accent-soft px-1.5 py-px text-[11px] font-medium text-accent-ink">
              Top ranked
            </span>
          ) : null}
          {c.isCurrent ? (
            <span className="rounded-[3px] border border-line px-1.5 py-px text-[11px] text-ink-2">
              Currently assigned
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {c.band ? <RiskPill band={c.band} score={c.predicted} size="sm" /> : null}
          {onPick && !c.isCurrent ? (
            <Button onClick={() => onPick(c.surgeonId)} disabled={busy}>
              Assign
              <ArrowRight size={13} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>

      <ul className="mt-1.5 space-y-0.5">
        {c.reasons.map((r, i) => (
          <li key={i} className="text-[12px] text-ink-2">
            {r}
          </li>
        ))}
        {c.blockers.map((b, i) => (
          <li key={`b-${i}`} className="text-[12px] text-risk">
            {b}
          </li>
        ))}
      </ul>
    </li>
  )
}

export default function SuggestionPanel({ caseId, suggest, onReassign }) {
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    if (!caseId) {
      setResult(null)
      return
    }
    suggest(caseId).then((r) => {
      if (live) setResult(r)
    })
    return () => {
      live = false
    }
  }, [caseId, suggest])

  if (!caseId) {
    return (
      <Panel>
        <PanelHeader title="Assignment review" />
        <EmptyState>
          Select a case from the list to see who the model would put in the room.
        </EmptyState>
      </Panel>
    )
  }

  if (!result) {
    return (
      <Panel>
        <PanelHeader title="Assignment review" />
        <EmptyState>Working through the roster.</EmptyState>
      </Panel>
    )
  }

  const c = result.case
  const best = result.candidates[0]
  const tone =
    result.recommendation === 'reassign' || result.recommendation === 'assign'
      ? 'border-risk/40 bg-risk-soft text-risk'
      : result.recommendation === 'consider'
        ? 'border-warn/40 bg-warn-soft text-warn'
        : 'border-ok/40 bg-ok-soft text-ok'

  async function pick(surgeonId) {
    setBusy(true)
    try {
      await onReassign({ caseId, surgeonId })
      const next = await suggest(caseId)
      setResult(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel>
      <PanelHeader
        title="Assignment review"
        meta={`${c.id} · ${c.room} · ${fmtDayShort(c.start)} ${fmtTime(c.start)} · ${fmtDuration(c.durationMin / 60)}`}
      />

      <div className="border-b border-line px-4 py-3">
        <p className="text-[15px] text-ink">{c.procedure}</p>
        <p className="mt-0.5 text-[12px] text-ink-3">
          {c.specialty} · complexity {c.complexity} · effectiveness floor {result.floor}
        </p>
        <p
          className={`mt-2 inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-1 text-[13px] font-medium ${tone}`}
        >
          {result.recommendation === 'keep' ? (
            <Check size={14} aria-hidden="true" />
          ) : null}
          {HEADLINE[result.recommendation]}
        </p>
      </div>

      {result.current ? (
        <div className="border-b border-line">
          <h3 className="px-4 pt-3 text-[12px] font-semibold uppercase tracking-wide text-ink-3">
            Currently assigned
          </h3>
          <ul>
            <CandidateRow c={result.current} isBest={false} />
          </ul>
        </div>
      ) : null}

      <div>
        <h3 className="px-4 pt-3 text-[12px] font-semibold uppercase tracking-wide text-ink-3">
          Eligible, ranked
        </h3>
        {result.candidates.length ? (
          <ul className="divide-y divide-line">
            {result.candidates
              .filter((x) => !x.isCurrent)
              .slice(0, 4)
              .map((x) => (
                <CandidateRow
                  key={x.surgeonId}
                  c={x}
                  onPick={pick}
                  busy={busy}
                  isBest={best && x.surgeonId === best.surgeonId}
                />
              ))}
          </ul>
        ) : (
          <EmptyState>
            No credentialled surgeon clears the eligibility rules for this window.
          </EmptyState>
        )}
      </div>

      {result.ineligible.length ? (
        <details className="border-t border-line">
          <summary className="cursor-pointer px-4 py-2.5 text-[12px] text-ink-2 hover:bg-sunken">
            {result.ineligible.length} ruled out in {c.specialty}
          </summary>
          <ul className="divide-y divide-line border-t border-line">
            {result.ineligible.map((x) => (
              <CandidateRow key={x.surgeonId} c={x} isBest={false} />
            ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  )
}
