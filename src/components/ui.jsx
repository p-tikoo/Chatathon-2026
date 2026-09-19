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
    <section className={`rounded-card border border-line bg-surface ${className}`}>
      {children}
    </section>
  )
}

export function PanelHeader({ title, meta, action }) {
  return (
    <header className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-3">
      <div>
        <h2 className="text-lead font-medium text-ink">{title}</h2>
        {meta ? <p className="mt-0.5 text-sm text-ink-3">{meta}</p> : null}
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
    'inline-flex items-center justify-center gap-1.5 rounded-control border px-3 py-2 text-sm font-medium transition-colors duration-150 disabled:opacity-45 disabled:cursor-not-allowed'
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
  const pad = size === 'sm' ? 'px-1.5 py-px text-micro' : 'px-2 py-0.5 text-meta'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[4px] border ${style.border} ${style.bg} ${style.text} ${pad} font-medium`}
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
      <dt className="text-meta text-ink-3">{label}</dt>
      <dd className="mt-1.5 flex items-baseline gap-1">
        <span className={`tnum text-metric font-semibold ${tone ?? 'text-ink'}`}>
          {value}
        </span>
        {unit ? <span className="text-sm text-ink-3">{unit}</span> : null}
      </dd>
      {hint ? <p className="mt-1 text-meta text-ink-3">{hint}</p> : null}
    </div>
  )
}

const labelClass = 'text-meta font-medium text-ink-2'

/** Without `htmlFor` the label has no single control to point at, so the group
 *  gets a fieldset and legend instead of a dangling label. */
export function Field({ label, hint, htmlFor, children }) {
  if (!htmlFor) {
    return (
      <fieldset className="min-w-0">
        <legend className={`mb-1.5 ${labelClass}`}>{label}</legend>
        {children}
        {hint ? <p className="mt-1.5 text-meta text-ink-3">{hint}</p> : null}
      </fieldset>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className={labelClass}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-meta text-ink-3">{hint}</p> : null}
    </div>
  )
}

const controlClass =
  'w-full rounded-control border border-line-strong bg-surface px-2.5 py-2 text-body text-ink placeholder:text-ink-3 hover:border-ink-3 focus:border-accent transition-colors duration-150'

export function Input({ className = '', ...props }) {
  return <input className={`${controlClass} ${className}`} {...props} />
}

export function Select({ children, className = '', ...props }) {
  return (
    <select className={`${controlClass} ${className}`} {...props}>
      {children}
    </select>
  )
}

export function Textarea({ className = '', ...props }) {
  return <textarea className={`${controlClass} resize-y ${className}`} rows={3} {...props} />
}

/**
 * Radio group rendered as adjacent segments. Real radios underneath, so arrow
 * keys and screen readers work without any extra handling.
 */
export function Segmented({ name, value, onChange, options, columns }) {
  return (
    <div
      className={`grid gap-1.5 ${columns ? '' : 'grid-flow-col auto-cols-fr'}`}
      style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
    >
      {options.map((opt) => {
        const checked = value === opt.value
        return (
          <label key={opt.value} className="block">
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={checked}
              onChange={() => onChange(opt.value)}
              className="peer sr-only"
            />
            <span
              className="block cursor-pointer rounded-control border border-line-strong bg-surface px-2 py-1.5 text-center text-sm text-ink-2 transition-colors duration-150 hover:bg-sunken peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:font-medium peer-checked:text-accent-ink peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
            >
              {opt.label}
              {opt.hint ? (
                <span className="mt-0.5 block text-micro font-normal text-ink-3">
                  {opt.hint}
                </span>
              ) : null}
            </span>
          </label>
        )
      })}
    </div>
  )
}

export function EmptyState({ children }) {
  return <p className="px-4 py-6 text-sm text-ink-3">{children}</p>
}
