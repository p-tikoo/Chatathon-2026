import React, { useMemo } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { BANDS, bandFor } from '../lib/fatigue.js'
import { HOUR, fmtTime, fmtDayShort, startOfDay } from '../lib/time.js'

const Y_FLOOR = 35
const Y_MAX = 100

function Tip({ active, payload, now }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const band = bandFor(p.score)
  const state = p.asleep ? 'Asleep' : p.onDuty ? 'On duty' : 'Off duty'
  const ahead = p.t > now
  const spread = ahead && p.lo != null && p.hi - p.lo >= 1

  return (
    <div className="rounded-control border border-line-strong bg-surface px-2.5 py-2 text-meta">
      <div className="text-ink-3">
        {fmtDayShort(p.t)} {fmtTime(p.t)} · {ahead ? 'projected' : 'measured'}
      </div>
      <div className="tnum mt-1 text-[15px] font-semibold text-ink">
        {p.score.toFixed(0)}
        <span className="ml-1 text-meta font-normal text-ink-3">effectiveness</span>
      </div>
      {spread ? (
        <div className="tnum mt-0.5 text-ink-3">
          {p.lo.toFixed(0)} to {p.hi.toFixed(0)} depending on sleep
        </div>
      ) : null}
      <div className="mt-0.5 text-ink-2">
        {band.label} &middot; {state}
      </div>
    </div>
  )
}

/**
 * Effectiveness over time. Everything left of `now` is integrated from logged
 * sleep and is drawn solid; everything right of it depends on sleep the surgeon
 * has not had yet, so it is dashed and, where the caller supplies lo/hi, banded.
 */
export default function AlertnessChart({
  samples,
  now,
  sleepWindows = [],
  cases = [],
  height = 240,
}) {
  // A shared point at the split keeps the measured and projected lines joined.
  const rows = useMemo(() => {
    let split = 0
    for (let i = 0; i < samples.length; i += 1) {
      if (samples[i].t <= now) split = i
    }
    return samples.map((s, i) => ({
      ...s,
      measured: i <= split ? s.score : null,
      projected: i >= split ? s.score : null,
      band: i >= split && s.lo != null ? [s.lo, s.hi] : null,
    }))
  }, [samples, now])

  // Step from local midnight, not from an epoch multiple, so a tick always
  // lands on 00:00 and the day label has somewhere to go.
  const ticks = useMemo(() => {
    if (!rows.length) return []
    const first = rows[0].t
    const last = rows[rows.length - 1].t
    const out = []
    for (let t = startOfDay(first); t <= last; t += 6 * HOUR) {
      if (t >= first) out.push(t)
    }
    return out
  }, [rows])

  if (!rows.length) return null

  const domain = [rows[0].t, rows[rows.length - 1].t]

  // Start the axis at 35 so the risk band does not swamp the plot, but drop
  // the floor if the curve actually goes lower.
  const lowest = rows.reduce((m, d) => Math.min(m, d.lo ?? d.score), Y_FLOOR)
  const Y_MIN = Math.floor(Math.min(Y_FLOOR, lowest - 3) / 5) * 5

  const logged = sleepWindows.filter((w) => !w.projected)
  const planned = sleepWindows.filter((w) => w.projected)

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
          <defs>
            <pattern
              id="sleep-hatch"
              width="6"
              height="6"
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
            >
              <rect width="6" height="6" fill="var(--color-sunken)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="#cfcfca" strokeWidth="2" />
            </pattern>
            <pattern
              id="sleep-hatch-planned"
              width="7"
              height="7"
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
            >
              <line x1="0" y1="0" x2="0" y2="7" stroke="#dcdcd6" strokeWidth="2" />
            </pattern>
          </defs>

          {/* Risk bands. Flat tints, lightest at the top. */}
          <ReferenceArea
            y1={BANDS.fit.min}
            y2={Y_MAX}
            fill="var(--color-ok-soft)"
            fillOpacity={0.55}
            ifOverflow="extendDomain"
          />
          <ReferenceArea
            y1={BANDS.caution.min}
            y2={BANDS.fit.min}
            fill="var(--color-warn-soft)"
            fillOpacity={0.55}
          />
          <ReferenceArea
            y1={Y_MIN}
            y2={BANDS.caution.min}
            fill="var(--color-risk-soft)"
            fillOpacity={0.55}
          />

          {logged.map((w, i) => (
            <ReferenceArea
              key={`slept-${i}`}
              x1={Math.max(w.start, domain[0])}
              x2={Math.min(w.end, domain[1])}
              y1={Y_MIN}
              y2={Y_MAX}
              fill="url(#sleep-hatch)"
              fillOpacity={0.5}
            />
          ))}

          {planned.map((w, i) => (
            <ReferenceArea
              key={`planned-${i}`}
              x1={Math.max(w.start, domain[0])}
              x2={Math.min(w.end, domain[1])}
              y1={Y_MIN}
              y2={Y_MAX}
              fill="url(#sleep-hatch-planned)"
              fillOpacity={0.9}
              stroke="var(--color-line-strong)"
              strokeDasharray="2 3"
            />
          ))}

          {/* Scheduled cases as a ribbon along the floor of the plot. */}
          {cases.map((c) => (
            <ReferenceArea
              key={c.id}
              x1={Math.max(c.start, domain[0])}
              x2={Math.min(c.end, domain[1])}
              y1={Y_MIN}
              y2={Y_MIN + 4}
              fill="var(--color-accent)"
              fillOpacity={0.85}
            />
          ))}

          <CartesianGrid vertical={false} stroke="#e6e6e2" strokeWidth={1} />

          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={domain}
            ticks={ticks}
            tickFormatter={(t) =>
              new Date(t).getHours() === 0 ? fmtDayShort(t) : fmtTime(t)
            }
            tick={{ fill: 'var(--color-ink-3)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: '#d3d3ce' }}
            minTickGap={16}
          />
          <YAxis
            domain={[Y_MIN, Y_MAX]}
            ticks={[BANDS.caution.min, BANDS.fit.min, Y_MAX]}
            tick={{ fill: 'var(--color-ink-3)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={44}
          />

          <ReferenceLine
            y={BANDS.fit.min}
            stroke="var(--color-ok-mark)"
            strokeDasharray="3 3"
            strokeWidth={1}
          />
          <ReferenceLine
            y={BANDS.caution.min}
            stroke="var(--color-risk-mark)"
            strokeDasharray="3 3"
            strokeWidth={1}
          />

          <Area
            dataKey="band"
            stroke="none"
            fill="var(--color-accent)"
            fillOpacity={0.14}
            connectNulls={false}
            isAnimationActive={false}
            activeDot={false}
            legendType="none"
          />

          <ReferenceLine
            x={now}
            stroke="var(--color-ink)"
            strokeWidth={1}
            label={{
              value: 'now',
              position: 'insideTopLeft',
              fill: 'var(--color-ink-2)',
              fontSize: 11,
            }}
          />

          <Tooltip
            content={<Tip now={now} />}
            cursor={{ stroke: 'var(--color-ink-3)', strokeWidth: 1 }}
          />

          <Line
            type="monotone"
            dataKey="measured"
            stroke="var(--color-accent)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            activeDot={{
              r: 4,
              fill: 'var(--color-accent)',
              stroke: 'var(--color-surface)',
              strokeWidth: 2,
            }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="projected"
            stroke="var(--color-accent)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            connectNulls={false}
            activeDot={{
              r: 4,
              fill: 'var(--color-accent)',
              stroke: 'var(--color-surface)',
              strokeWidth: 2,
            }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function LineSwatch({ dashed = false }) {
  return (
    <svg width="16" height="8" aria-hidden="true" className="block shrink-0">
      <line
        x1="0"
        y1="4"
        x2="16"
        y2="4"
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeDasharray={dashed ? '5 4' : undefined}
      />
    </svg>
  )
}

/** Hatch drawn as lines rather than a pattern fill, so one swatch is one node. */
function HatchSwatch({ line, background, dashed = false }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 overflow-hidden rounded-[2px] border border-line-strong ${
        dashed ? 'border-dashed' : ''
      }`}
    >
      <svg width="16" height="11" className="block">
        {background ? <rect width="16" height="11" fill={background} /> : null}
        <g stroke={line} strokeWidth="2">
          <line x1="-4" y1="13" x2="9" y2="-2" />
          <line x1="1" y1="13" x2="14" y2="-2" />
          <line x1="6" y1="13" x2="19" y2="-2" />
        </g>
      </svg>
    </span>
  )
}

export function ChartKey({ spread = false }) {
  const items = [
    [<LineSwatch key="m" />, 'Measured'],
    [<LineSwatch key="p" dashed />, spread ? 'Projected, with range' : 'Projected'],
    [
      <HatchSwatch key="s" line="#cfcfca" background="var(--color-sunken)" />,
      'Sleep logged',
    ],
    [<HatchSwatch key="a" line="#dcdcd6" dashed />, 'Sleep assumed'],
    [
      <span
        key="c"
        aria-hidden="true"
        className="inline-block h-2 w-4 shrink-0 rounded-[2px]"
        style={{ background: 'var(--color-accent)' }}
      />,
      'Scheduled case',
    ],
  ]

  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-4 py-2.5 text-meta text-ink-2">
      {items.map(([swatch, label]) => (
        <li key={label} className="flex items-center gap-1.5">
          {swatch}
          {label}
        </li>
      ))}
    </ul>
  )
}
