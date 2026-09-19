import React, { useMemo } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
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

function Tip({ active, payload }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const band = bandFor(p.score)
  const state = p.asleep ? 'Asleep' : p.onDuty ? 'On duty' : 'Off duty'
  return (
    <div className="border border-line-strong bg-surface px-2.5 py-2 text-[12px] rounded-[4px]">
      <div className="text-ink-3">
        {fmtDayShort(p.t)} {fmtTime(p.t)}
      </div>
      <div className="mt-1 tnum text-[15px] font-semibold text-ink">
        {p.score.toFixed(0)}
        <span className="ml-1 text-[12px] font-normal text-ink-3">effectiveness</span>
      </div>
      <div className="mt-0.5 text-ink-2">
        {band.label} &middot; {state}
      </div>
    </div>
  )
}

/**
 * One series, so no legend box: the panel title names it. Status is carried by
 * the horizontal band tints and repeated in the tooltip text.
 */
export default function AlertnessChart({
  samples,
  now,
  sleepWindows = [],
  cases = [],
  height = 240,
}) {
  const data = useMemo(() => samples.map((s) => ({ ...s })), [samples])

  // Step from local midnight, not from an epoch multiple, so a tick always
  // lands on 00:00 and the day label has somewhere to go.
  const ticks = useMemo(() => {
    if (!data.length) return []
    const first = data[0].t
    const last = data[data.length - 1].t
    const out = []
    for (let t = startOfDay(first); t <= last; t += 6 * HOUR) {
      if (t >= first) out.push(t)
    }
    return out
  }, [data])

  if (!data.length) return null

  const domain = [data[0].t, data[data.length - 1].t]

  // Start the axis at 35 so the risk band does not swamp the plot, but drop
  // the floor if the curve actually goes lower.
  const lowest = data.reduce((m, d) => Math.min(m, d.score), Y_FLOOR)
  const Y_MIN = Math.floor(Math.min(Y_FLOOR, lowest - 3) / 5) * 5

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
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

          {sleepWindows.map((w, i) => (
            <ReferenceArea
              key={`sleep-${i}`}
              x1={Math.max(w.start, domain[0])}
              x2={Math.min(w.end, domain[1])}
              y1={Y_MIN}
              y2={Y_MAX}
              fill="url(#sleep-hatch)"
              fillOpacity={0.5}
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
            content={<Tip />}
            cursor={{ stroke: 'var(--color-ink-3)', strokeWidth: 1 }}
          />

          <Line
            type="monotone"
            dataKey="score"
            stroke="var(--color-accent)"
            strokeWidth={2}
            dot={false}
            activeDot={{
              r: 4,
              fill: 'var(--color-accent)',
              stroke: 'var(--color-surface)',
              strokeWidth: 2,
            }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function ChartKey() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-[12px] text-ink-2 border-t border-line">
      {[
        ['var(--color-ok-soft)', `Fit, ${BANDS.fit.min}+`],
        ['var(--color-warn-soft)', `Caution, ${BANDS.caution.min}-${BANDS.fit.min - 1}`],
        ['var(--color-risk-soft)', `High risk, under ${BANDS.caution.min}`],
      ].map(([color, label]) => (
        <li key={label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-4 rounded-[2px] border border-line-strong"
            style={{ background: color }}
          />
          {label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-3 w-4 rounded-[2px] border border-line-strong"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, #cfcfca 0 2px, var(--color-sunken) 2px 6px)',
          }}
        />
        Sleep
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-4 rounded-[2px]"
          style={{ background: 'var(--color-accent)' }}
        />
        Scheduled case
      </li>
    </ul>
  )
}
