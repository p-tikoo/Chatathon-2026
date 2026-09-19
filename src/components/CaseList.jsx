import React from 'react'
import { bandFor, lowestDuring } from '../lib/fatigue.js'
import { fmtDayShort, fmtDuration, fmtTime, relTime } from '../lib/time.js'
import { EmptyState, RiskPill } from './ui.jsx'

const ACUITY_STYLE = {
  elective: 'text-ink-3 border-line',
  urgent: 'text-warn border-warn/40 bg-warn-soft',
  emergent: 'text-risk border-risk/40 bg-risk-soft',
}

export default function CaseList({ cases, samples, now, onSelectCase, selectedCaseId }) {
  if (!cases.length) {
    return <EmptyState>No cases scheduled in the next 48 hours.</EmptyState>
  }

  return (
    <ul className="divide-y divide-line">
      {cases.map((c) => {
        const low = samples ? lowestDuring(samples, c.start, c.end) : null
        const band = low ? bandFor(low.score) : null
        const interactive = Boolean(onSelectCase)
        const Tag = interactive ? 'button' : 'div'

        return (
          <li key={c.id}>
            <Tag
              {...(interactive
                ? { type: 'button', onClick: () => onSelectCase(c.id) }
                : {})}
              className={`grid w-full grid-cols-[86px_1fr_auto] items-start gap-3 px-4 py-3 text-left transition-colors duration-150 ${
                interactive ? 'hover:bg-sunken' : ''
              } ${selectedCaseId === c.id ? 'bg-accent-soft' : ''}`}
            >
              <div className="tnum text-[13px] text-ink-2">
                <div className="font-medium text-ink">{fmtTime(c.start)}</div>
                <div className="text-[12px] text-ink-3">{fmtDayShort(c.start)}</div>
              </div>

              <div className="min-w-0">
                <p className="text-[14px] text-ink">{c.procedure}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
                  <span>{c.room}</span>
                  <span aria-hidden="true">&middot;</span>
                  <span>{fmtDuration(c.durationMin / 60)}</span>
                  <span aria-hidden="true">&middot;</span>
                  <span>Complexity {c.complexity}</span>
                  <span
                    className={`rounded-[3px] border px-1 text-[11px] capitalize ${ACUITY_STYLE[c.acuity]}`}
                  >
                    {c.acuity}
                  </span>
                </p>
              </div>

              <div className="flex flex-col items-end gap-1">
                {band ? <RiskPill band={band} score={low.score} size="sm" /> : null}
                <span className="text-[11px] text-ink-3">{relTime(c.start, now)}</span>
              </div>
            </Tag>
          </li>
        )
      })}
    </ul>
  )
}
