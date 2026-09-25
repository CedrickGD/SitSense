import { useEffect, useLayoutEffect, useRef, useState, type AriaAttributes, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// ---------- Button ----------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends AriaAttributes {
  children: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  disabled?: boolean
  className?: string
  title?: string
}

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-sage text-ink font-medium hover:brightness-110',
  secondary: 'bg-card text-text ring-1 ring-white/8 hover:bg-hairline/40',
  ghost: 'text-text-dim hover:text-text hover:bg-white/5',
  danger: 'text-coral hover:bg-coral/10'
}

export function buttonClass(variant: ButtonVariant = 'secondary', className = ''): string {
  return `titlebar-no-drag rounded-[10px] px-3.5 py-2 text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:ring-offset-2 focus-visible:ring-offset-ink focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 ${BUTTON_STYLES[variant]} ${className}`
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  className = '',
  title,
  ...aria
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={buttonClass(variant, className)}
      {...aria}
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
  /** accessible name — a bare slider reads as "slider 2" */
  label: string
  /** spoken value, when the raw number means nothing (e.g. a step index) */
  valueText?: (v: number) => string
}

export function Slider({ value, min, max, step, onChange, disabled, format, label, valueText }: SliderProps): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={valueText ? valueText(value) : format ? format(value) : undefined}
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
  /** names the group for screen readers, e.g. "Nudge me from, Slouching" */
  label: string
}

/** A radio group: one tab stop, arrow keys move the selection. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label
}: SegmentedControlProps<T>): JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selected = options.findIndex((o) => o.value === value)
  const focusable = selected >= 0 ? selected : 0

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!delta) return
    e.preventDefault()
    const next = (Math.max(0, selected) + delta + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="inline-flex rounded-[10px] bg-ink p-0.5 ring-1 ring-white/8">
      {options.map((o, i) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={i === focusable ? 0 : -1}
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

// ---------- Menu ----------

interface MenuProps {
  /** accessible name of the trigger (its visible content may be just "▾") */
  label: string
  trigger: ReactNode
  triggerClassName?: string
  items: { label: string; onClick: () => void }[]
  align?: 'left' | 'right'
}

const MENU_GAP = 4

/**
 * Dropdown rendered in a portal with fixed positioning, so a scrolling or
 * clipped parent can't hide its items; opens upward when there's no room
 * below. Keyboard: arrows/Home/End move, Escape or Tab closes.
 */
export function Menu({ label, trigger, triggerClassName = '', items, align = 'left' }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const close = (focusTrigger: boolean): void => {
    setOpen(false)
    setPos(null)
    if (focusTrigger) triggerRef.current?.focus()
  }

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return
    const t = triggerRef.current.getBoundingClientRect()
    const m = menuRef.current.getBoundingClientRect()
    const below = window.innerHeight - t.bottom
    const top = below >= m.height + MENU_GAP || below >= t.top ? t.bottom + MENU_GAP : t.top - m.height - MENU_GAP
    const left = align === 'right' ? t.right - m.width : t.left
    setPos({ top: Math.max(MENU_GAP, top), left: Math.min(Math.max(MENU_GAP, left), window.innerWidth - m.width - MENU_GAP) })
  }, [open, align])

  // focus only once positioned: a visibility:hidden item can't take focus
  const placed = pos !== null
  useEffect(() => {
    if (open && placed) itemRefs.current[0]?.focus()
  }, [open, placed])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false)
    }
    const onResize = (): void => close(false)
    // Escape must work wherever focus ended up (e.g. still on the trigger)
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      close(true)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement)
    const focus = (i: number): void => itemRefs.current[(i + items.length) % items.length]?.focus()
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'Tab') {
      close(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      focus(current + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focus(current - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focus(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focus(items.length - 1)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className={buttonClass('secondary', triggerClassName)}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKey}
            style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="z-50 min-w-40 rounded-[10px] bg-card p-1 shadow-lg ring-1 ring-white/8 motion-safe:animate-[menuIn_150ms_ease-out]"
          >
            {items.map((item, i) => (
              <button
                key={item.label}
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  close(true)
                  item.onClick()
                }}
                className="block w-full rounded-lg px-3 py-1.5 text-left text-[13px] text-text hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none"
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
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

/**
 * Centered explanation with actions. Shrinks inside a narrow `@container`
 * (the camera frame at the minimum window size) so the actions stay visible.
 */
export function EmptyState({ icon, headline, body, actions }: EmptyStateProps): JSX.Element {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center @max-[32rem]:gap-1.5 @max-[32rem]:p-3"
    >
      <div className="text-text-faint @max-[32rem]:[&>svg]:h-9 @max-[32rem]:[&>svg]:w-9">{icon}</div>
      <h2 className="font-display text-2xl font-semibold tracking-tight text-text @max-[32rem]:text-base">{headline}</h2>
      <p className="max-w-sm text-[13px] leading-relaxed text-text-dim @max-[32rem]:text-xs @max-[32rem]:leading-snug">{body}</p>
      {actions && <div className="mt-2 flex flex-wrap justify-center gap-2 @max-[32rem]:mt-1">{actions}</div>}
    </div>
  )
}
