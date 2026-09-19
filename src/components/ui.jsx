import React from 'react'

export const BAND_STYLE = {
  fit: {
    text: 'text-ok',
    bg: 'bg-ok-soft',
    border: 'border-ok/35',
    mark: 'var(--color-ok-mark)',
    solid: 'var(--color-ok)',
  },
  caution: {
    text: 'text-warn',
    bg: 'bg-warn-soft',
    border: 'border-warn/35',
    mark: 'var(--color-warn-mark)',
    solid: 'var(--color-warn)',
  },
  risk: {
    text: 'text-risk',
    bg: 'bg-risk-soft',
    border: 'border-risk/35',
    mark: 'var(--color-risk-mark)',
    solid: 'var(--color-risk)',
  },
}

export function Panel({ children, className = '' }) {
  return (
    <section
      className={`border border-line bg-surface rounded-[6px] ${className}`}
    >
      {children}
    </section>
  )
}

export function PanelHeader({ title, meta, action }) {
  return (
    <header className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-3">
      <div>
        <h2 className="text-[13px] font-semibold tracking-wide uppercase text-ink-2">
          {title}
        </h2>
        {meta ? <p className="mt-0.5 text-[13px] text-ink-3">{meta}</p> : null}
      </div>
      {action}
    </header>
  )
}

export function Button({
  children,
  variant = 'default',
  className = '',
  ...props
}) {
  const base =
    'inline-flex items-center gap-1.5 rounded-[4px] border px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 disabled:opacity-45 disabled:cursor-not-allowed'
  const variants = {
    default: 'border-line-strong bg-surface text-ink hover:bg-sunken',
    primary:
      'border-accent bg-accent text-white hover:bg-accent-ink disabled:hover:bg-accent',
    danger: 'border-risk bg-risk text-white hover:brightness-110',
    quiet: 'border-transparent bg-transparent text-ink-2 hover:bg-sunken',
  }
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  )
}

export function RiskPill({ band, score, size = 'md' }) {
  const style = BAND_STYLE[band.key]
  const pad = size === 'sm' ? 'px-1.5 py-px text-[11px]' : 'px-2 py-0.5 text-[12px]'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[3px] border ${style.border} ${style.bg} ${style.text} ${pad} font-medium`}
    >
      <span
        aria-hidden="true"
        className="inline-block size-[7px] rounded-full"
        style={{ background: style.solid }}
      />
      {band.label}
      {score != null ? <span className="tnum opacity-70">{Math.round(score)}</span> : null}
    </span>
  )
}

export function Stat({ label, value, unit, hint, tone }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-[12px] uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-1">
        <span className={`tnum text-[22px] leading-none font-semibold ${tone ?? 'text-ink'}`}>
          {value}
        </span>
        {unit ? <span className="text-[13px] text-ink-3">{unit}</span> : null}
      </dd>
      {hint ? <p className="mt-1 text-[12px] text-ink-3">{hint}</p> : null}
    </div>
  )
}

export function Field({ label, hint, htmlFor, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[12px] text-ink-3">{hint}</p> : null}
    </div>
  )
}

const controlClass =
  'w-full rounded-[4px] border border-line-strong bg-surface px-2.5 py-1.5 text-[14px] text-ink placeholder:text-ink-3 focus:border-accent'

export function Input(props) {
  return <input className={controlClass} {...props} />
}

export function Select({ children, ...props }) {
  return (
    <select className={controlClass} {...props}>
      {children}
    </select>
  )
}

export function Textarea(props) {
  return <textarea className={`${controlClass} resize-y`} rows={3} {...props} />
}

export function EmptyState({ children }) {
  return <p className="px-4 py-6 text-[13px] text-ink-3">{children}</p>
}
