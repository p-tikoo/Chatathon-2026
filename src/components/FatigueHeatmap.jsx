import React, { useMemo, useState } from 'react'
import { bandFor } from '../lib/fatigue.js'
import { HOUR, fmtDayShort, fmtTime } from '../lib/time.js'
import { BAND_STYLE, RiskPill } from './ui.jsx'

const BUCKET_H = 2

/**
 * Worst predicted effectiveness inside each 2h bucket.
 *
 * The half hour of sleep inertia after waking is excluded. It is a real dip,
 * and the curve shows it, but it is transient and nobody is operating through
 * it: letting it set the bucket would paint two hours red on the strength of a
 * fifteen-minute sample.
 */
function bucketize(samples, from, buckets) {
  const out = new Array(buckets).fill(null)
  const asleepOnly = new Array(buckets).fill(null)

  for (const s of samples) {
    const i = Math.floor((s.t - from) / (BUCKET_H * HOUR))
    if (i < 0 || i >= buckets) continue

    if (s.asleep) {
      if (!asleepOnly[i]) asleepOnly[i] = s
      continue
    }
    if (s.inertia) continue
    if (!out[i] || s.score < out[i].score) out[i] = s
  }

  // A bucket spent entirely asleep still needs something to render.
  for (let i = 0; i < buckets; i++) {
    if (!out[i] && asleepOnly[i]) out[i] = asleepOnly[i]
  }
  return out
}

function cellStyle(sample) {
  if (!sample) return { background: 'transparent' }
  if (sample.asleep) {
    return {
      background: 'var(--color-sunken)',
      backgroundImage:
        'repeating-linear-gradient(45deg, #dedeD9 0 1px, var(--color-sunken) 1px 5px)',
    }
  }
  const band = bandFor(sample.score)
  if (band.key === 'risk') {
    // Texture as a second channel, so the most consequential state does not
    // rely on hue alone.
    return {
      background: 'var(--color-risk-soft)',
      backgroundImage:
        'repeating-linear-gradient(45deg, var(--color-risk-mark) 0 1.5px, transparent 1.5px 5px)',
    }
  }
  return {
    background:
      band.key === 'fit' ? 'var(--color-ok-soft)' : 'var(--color-warn-soft)',
  }
}

function describe(surgeon, sample) {
  if (!sample) return null
  const band = bandFor(sample.score)
  const state = sample.asleep
    ? 'projected asleep'
    : sample.onDuty
      ? 'on duty'
      : 'off duty'
  return `${surgeon.name} — ${fmtDayShort(sample.t)} ${fmtTime(sample.t)} — ${sample.score.toFixed(0)}, ${band.label.toLowerCase()}, ${state}`
}

export default function FatigueHeatmap({
  surgeons,
  projections,
  now,
  horizonHours = 48,
  selectedId,
  onSelect,
}) {
  const [hover, setHover] = useState(null)

  const from = Math.floor(now / HOUR) * HOUR
  const buckets = Math.round(horizonHours / BUCKET_H)

  const rows = useMemo(
    () =>
      surgeons.map((s) => ({
        surgeon: s,
        cells: bucketize(projections[s.id]?.curve ?? [], from, buckets),
        assessment: projections[s.id]?.assessment,
      })),
    [surgeons, projections, from, buckets]
  )

  const columnLabels = useMemo(() => {
    const out = []
    for (let i = 0; i < buckets; i++) {
      const t = from + i * BUCKET_H * HOUR
      const h = new Date(t).getHours()
      out.push({ i, t, label: h % 6 === 0 ? (h === 0 ? fmtDayShort(t) : `${h}`) : null })
    }
    return out
  }, [from, buckets])

  const gridCols = `minmax(150px, 190px) repeat(${buckets}, minmax(0, 1fr))`

  return (
    <div>
      <div
        className="flex h-6 items-center px-4 text-[12px] text-ink-2"
        aria-live="polite"
      >
        {hover ?? (
          <span className="text-ink-3">
            Worst predicted effectiveness per {BUCKET_H}-hour block. Hover a cell for detail.
          </span>
        )}
      </div>

      <div className="overflow-x-auto px-4 pb-3">
        <div style={{ minWidth: 720 }}>
          <div
            className="grid items-center text-[11px] text-ink-3"
            style={{ gridTemplateColumns: gridCols }}
          >
            <div />
            {columnLabels.map((c) => (
              <div key={c.i} className="tnum pb-1 text-left">
                {c.label}
              </div>
            ))}
          </div>

          {rows.map(({ surgeon, cells, assessment }) => {
            const selected = surgeon.id === selectedId
            const flagged = (surgeon.flags ?? []).length > 0
            return (
              <div
                key={surgeon.id}
                className="grid items-stretch"
                style={{ gridTemplateColumns: gridCols }}
              >
                <button
                  type="button"
                  onClick={() => onSelect?.(surgeon.id)}
                  className={`flex items-center justify-between gap-2 border-y border-l border-line py-1.5 pl-2 pr-2 text-left transition-colors duration-150 ${
                    selected ? 'bg-accent-soft' : 'bg-surface hover:bg-sunken'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-ink">
                      {surgeon.name}
                    </span>
                    <span className="block truncate text-[11px] text-ink-3">
                      {surgeon.specialty}
                    </span>
                  </span>
                  {flagged ? (
                    <span
                      className="shrink-0 rounded-[3px] border border-risk/40 bg-risk-soft px-1 text-[10px] font-semibold uppercase text-risk"
                      title="Self-reported flag"
                    >
                      Flag
                    </span>
                  ) : assessment?.asleep ? (
                    <span
                      className="shrink-0 rounded-[3px] border border-line px-1 text-[10px] text-ink-3"
                      title="Currently asleep. The score is what the model expects on waking."
                    >
                      Asleep
                    </span>
                  ) : assessment ? (
                    <span className="shrink-0">
                      <RiskPill band={assessment.band} size="sm" />
                    </span>
                  ) : null}
                </button>

                {cells.map((sample, i) => (
                  <div
                    key={i}
                    className="h-[30px] border-y border-r border-line"
                    style={cellStyle(sample)}
                    title={describe(surgeon, sample) ?? ''}
                    onMouseEnter={() => setHover(describe(surgeon, sample))}
                    onMouseLeave={() => setHover(null)}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>

      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-4 py-2.5 text-[12px] text-ink-2">
        {[
          ['fit', 'Fit, 77+'],
          ['caution', 'Caution, 65-76'],
          ['risk', 'High risk, under 65'],
        ].map(([key, label]) => (
          <li key={key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-5 rounded-[2px] border border-line-strong"
              style={cellStyle({ score: key === 'fit' ? 90 : key === 'caution' ? 70 : 50 })}
            />
            <span className={BAND_STYLE[key].text}>{label}</span>
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-5 rounded-[2px] border border-line-strong"
            style={cellStyle({ score: 90, asleep: true })}
          />
          Projected asleep
        </li>
      </ul>
    </div>
  )
}
