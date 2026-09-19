import React from 'react'
import { bandFor, lowestDuring } from '../lib/fatigue.js'
import { fmtDayShort, fmtDuration, fmtTime, relTime } from '../lib/time.js'
import { EmptyState, RiskPill } from './ui.jsx'

const ACUITY_STYLE = {
  elective: 'text-ink-3 border-line',
  urgent: 'text-warn border-warn/40 bg-warn-soft',
  emergent: 'text-risk border-risk/40 bg-risk-soft',
}

export default function CaseList({
  cases,
  samples,
  now,
  onSelectCase,
  selectedCaseId,
  compact = false,
}) {
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
              {...(interactive ? { type: 'button', onClick: () => onSelectCase(c.id) } : {})}
              className={`grid w-full grid-cols-[72px_1fr_auto] items-baseline gap-3 px-4 py-3 text-left transition-colors duration-150 ${
                interactive ? 'hover:bg-sunken' : ''
              } ${selectedCaseId === c.id ? 'bg-accent-soft' : ''}`}
            >
              <div className="tnum text-sm text-ink-2">
                <span className="text-lead font-medium text-ink">{fmtTime(c.start)}</span>
                <span className="block text-meta text-ink-3">{fmtDayShort(c.start)}</span>
              </div>

              <div className="min-w-0">
                <p className="text-body text-ink">{c.procedure}</p>
                {compact ? (
                  <p className="mt-0.5 text-meta text-ink-3">
                    {c.room} · {fmtDuration(c.durationMin / 60)}
                    {c.start > now ? ` · ${relTime(c.start, now)}` : ''}
                  </p>
                ) : (
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-3">
                    <span>{c.room}</span>
                    <span aria-hidden="true">&middot;</span>
                    <span>{fmtDuration(c.durationMin / 60)}</span>
                    <span aria-hidden="true">&middot;</span>
                    <span>Complexity {c.complexity}</span>
                    <span
                      className={`rounded-[4px] border px-1 text-micro capitalize ${ACUITY_STYLE[c.acuity]}`}
                    >
                      {c.acuity}
                    </span>
                  </p>
                )}
              </div>

              <div className="flex flex-col items-end gap-1">
                {band ? <RiskPill band={band} score={low.score} size="sm" /> : null}
                {!compact ? (
                  <span className="text-micro text-ink-3">{relTime(c.start, now)}</span>
                ) : null}
              </div>
            </Tag>
          </li>
        )
      })}
    </ul>
  )
}
