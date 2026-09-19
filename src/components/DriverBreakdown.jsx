import React from 'react'

/**
 * What is pushing the score up or down, as a diverging bar around a neutral
 * zero line. Every row is labelled and carries its signed number, so the two
 * hues are never the only thing distinguishing gain from loss.
 */
export default function DriverBreakdown({ drivers }) {
  if (!drivers?.length) return null
  const max = Math.max(...drivers.map((d) => Math.abs(d.points)), 10)

  return (
    <ul className="divide-y divide-line">
      {drivers.map((d) => {
        const pct = (Math.abs(d.points) / max) * 50
        const negative = d.points < 0
        return (
          <li key={d.key} className="grid grid-cols-[1fr_72px_48px] items-center gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <p className="text-[13px] text-ink">{d.label}</p>
              <p className="text-[12px] leading-snug text-ink-3">{d.detail}</p>
            </div>

            <div className="relative h-3" aria-hidden="true">
              <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
              <span
                className="absolute top-0 h-3 rounded-[2px]"
                style={{
                  background: negative
                    ? 'var(--color-risk-mark)'
                    : 'var(--color-ok-mark)',
                  width: `${pct}%`,
                  left: negative ? `${50 - pct}%` : '50%',
                }}
              />
            </div>

            <span
              className={`tnum text-right text-[13px] font-medium ${
                negative ? 'text-risk' : 'text-ok'
              }`}
            >
              {d.points > 0 ? '+' : ''}
              {d.points.toFixed(1)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
