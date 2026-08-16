import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'

// ---------- Button ----------

interface ButtonProps {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  disabled?: boolean
  className?: string
  title?: string
}

const BUTTON_STYLES: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-sage text-ink font-medium hover:brightness-110',
  secondary: 'bg-card text-text ring-1 ring-white/8 hover:bg-hairline/40',
  ghost: 'text-text-dim hover:text-text hover:bg-white/5',
  danger: 'text-coral hover:bg-coral/10'
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  className = '',
  title
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`titlebar-no-drag rounded-[10px] px-3.5 py-2 text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:ring-offset-2 focus-visible:ring-offset-ink focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 ${BUTTON_STYLES[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

// ---------- Toggle ----------

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
}

export function Toggle({ checked, onChange, disabled, label }: ToggleProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[22px] w-[40px] shrink-0 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:ring-offset-2 focus-visible:ring-offset-ink focus-visible:outline-none disabled:opacity-40 ${
        checked ? 'bg-sage' : 'bg-hairline'
      }`}
    >
      <span
        className={`absolute top-[3px] h-4 w-4 rounded-full transition-all ${
          checked ? 'left-[21px] bg-ink' : 'left-[3px] bg-text-dim'
        }`}
      />
    </button>
  )
}

// ---------- Slider ----------

interface SliderProps {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  disabled?: boolean
  format?: (v: number) => string
}

export function Slider({ value, min, max, step, onChange, disabled, format }: SliderProps): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider-sage h-1 w-full min-w-24 cursor-pointer appearance-none rounded-full bg-hairline disabled:opacity-40"
      />
      {format && <span className="w-14 shrink-0 text-right font-mono text-xs text-text-dim">{format(value)}</span>}
    </div>
  )
}

// ---------- SegmentedControl ----------

interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string; color?: string }[]
  value: T | null
  onChange: (v: T) => void
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange
}: SegmentedControlProps<T>): JSX.Element {
  return (
    <div className="inline-flex rounded-[10px] bg-ink p-0.5 ring-1 ring-white/8">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded-lg px-3 py-1.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none ${
              active ? 'bg-card text-text ring-1 ring-white/8' : 'text-text-dim hover:text-text'
            }`}
            style={active && o.color ? { color: o.color } : undefined}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------- Menu (portal-free dropdown) ----------

interface MenuProps {
  trigger: ReactNode
  items: { label: string; onClick: () => void }[]
  align?: 'left' | 'right'
}

export function Menu({ trigger, items, align = 'left' }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div
          className={`absolute z-50 mt-1 min-w-40 rounded-[10px] bg-card p-1 shadow-lg ring-1 ring-white/8 motion-safe:animate-[menuIn_150ms_ease-out] ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
              className="block w-full rounded-lg px-3 py-1.5 text-left text-[13px] text-text hover:bg-white/5"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- StagePill ----------

export function StagePill({ label, color }: { label: string; color: string }): JSX.Element {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)` }}
    >
      {label}
    </span>
  )
}

// ---------- EmptyState ----------

interface EmptyStateProps {
  icon: ReactNode
  headline: string
  body: string
  actions?: ReactNode
}

export function EmptyState({ icon, headline, body, actions }: EmptyStateProps): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-text-faint">{icon}</div>
      <h2 className="font-display text-2xl font-semibold tracking-tight text-text">{headline}</h2>
      <p className="max-w-sm text-[13px] leading-relaxed text-text-dim">{body}</p>
      {actions && <div className="mt-2 flex gap-2">{actions}</div>}
    </div>
  )
}
