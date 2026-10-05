// Shared building blocks for the v3 UI (docs/specs/ui-v3.md §1, §8, §9).
// Every page builds from these; they own the craft rules (heights, states, focus rings,
// motion behind motion-safe) so screens don't re-invent them.

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type InputHTMLAttributes,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import type { Stage } from '@shared/posture'
import { STAGE_COLOR } from '@renderer/lib/ui'
import { scoreColor } from '@renderer/lib/score'
import { fmtScore } from '@renderer/lib/format'
import { Icon, type IconName } from './icons'

// ───────────────────────────── shared class recipes ─────────────────────────────

/** Surface the focus ring sits on (its offset color must match, §8.1). */
export type RingSurface = 'ink' | 'surface' | 'card' | 'card-2' | 'setup'

const RING_OFFSET: Record<RingSurface, string> = {
  ink: 'focus-visible:ring-offset-ink',
  surface: 'focus-visible:ring-offset-surface',
  card: 'focus-visible:ring-offset-card',
  'card-2': 'focus-visible:ring-offset-card-2',
  setup: 'focus-visible:ring-offset-setup-bg'
}

/** The standard focus ring (ring-2 sage/70 + offset 2 in the color beneath). */
export function focusRing(on: RingSurface = 'ink'): string {
  return `focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:ring-offset-2 ${RING_OFFSET[on]} focus-visible:outline-none`
}

/** Focus ring without offset (inside dense controls: segments, list rows). */
export const FOCUS_INSET = 'focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none'

/** Text inputs and selects (32 px): card-2, ring white/8 → hairline-strong on hover → sage on focus. */
export const FIELD_CLASS =
  'h-8 rounded-[10px] bg-card-2 px-3 text-[13px] text-text ring-1 ring-white/8 transition-colors duration-150 placeholder:text-text-faint enabled:hover:ring-hairline-strong focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40'

/** e1 card recipe as classes (for elements that can't use <Card>). */
export const CARD_CLASS = 'surface-card'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// ───────────────────────────── Spinner / Skeleton / dots ─────────────────────────────

/** 14 px inline spinner (loading buttons, inline waits). */
export function Spinner({ size = 14, className = '' }: { size?: number; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full border-2 border-current border-t-transparent opacity-80 motion-safe:animate-[spin_0.8s_linear_infinite] ${className}`}
      style={{ width: size, height: size }}
    />
  )
}

/** Layout-shaped loading block (no spinners for layouts, §8.5). */
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }): JSX.Element {
  return (
    <div
      aria-hidden
      className={`rounded-xl bg-white/[0.04] motion-safe:animate-[shimmer_1.4s_ease-in-out_infinite] ${className}`}
      style={style}
    />
  )
}

/** Coach "thinking" dots: 3 × 6 px, 1.2 s loop staggered 150 ms (static under reduced motion). */
export function ThinkingDots({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span aria-hidden className={`inline-flex items-center gap-1 text-sage ${className}`}>
      {[0, 150, 300].map((d) => (
        <span
          key={d}
          className="h-1.5 w-1.5 rounded-full bg-current opacity-60 motion-safe:animate-[thinkingDot_1.2s_ease-in-out_infinite]"
          style={{ animationDelay: `${d}ms` }}
        />
      ))}
    </span>
  )
}

/** A status dot; `pulse` = the 2 s soft monitoring pulse. */
export function StatusDot({
  color,
  pulse = false,
  size = 8,
  className = ''
}: {
  color: string
  pulse?: boolean
  size?: number
  className?: string
}): JSX.Element {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full ${pulse ? 'motion-safe:animate-[softPulse_2s_ease-in-out_infinite]' : ''} ${className}`}
      style={{ width: size, height: size, backgroundColor: color }}
    />
  )
}

// ───────────────────────────── floating placement (tooltips, popovers, menus) ─────────────────────────────

export type Placement = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'

interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

const OPPOSITE: Record<Placement, Placement> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

/**
 * Where to put a w×h floating box next to an anchor: the preferred side, flipped to the
 * opposite side when it doesn't fit (and the opposite does), then clamped 6 px inside the
 * viewport. Pure (unit-tested).
 */
export function placeFloating(
  anchor: RectLike,
  w: number,
  h: number,
  placement: Placement,
  align: Align,
  gap: number,
  vw: number,
  vh: number
): { left: number; top: number; placement: Placement } {
  const m = 6
  const fits: Record<Placement, boolean> = {
    top: anchor.top - gap - h >= m,
    bottom: anchor.bottom + gap + h <= vh - m,
    right: anchor.right + gap + w <= vw - m,
    left: anchor.left - gap - w >= m
  }
  let p = placement
  if (!fits[p] && fits[OPPOSITE[p]]) p = OPPOSITE[p]
  let left: number
  let top: number
  if (p === 'top' || p === 'bottom') {
    top = p === 'top' ? anchor.top - gap - h : anchor.bottom + gap
    left = align === 'start' ? anchor.left : align === 'end' ? anchor.right - w : anchor.left + anchor.width / 2 - w / 2
  } else {
    left = p === 'right' ? anchor.right + gap : anchor.left - gap - w
    top = align === 'start' ? anchor.top : align === 'end' ? anchor.bottom - h : anchor.top + anchor.height / 2 - h / 2
  }
  return { left: clamp(left, m, Math.max(m, vw - w - m)), top: clamp(top, m, Math.max(m, vh - h - m)), placement: p }
}

interface FloatingProps {
  anchor: RectLike
  placement: Placement
  align: Align
  gap?: number
  className?: string
  children: ReactNode
  id?: string
  role?: string
  ariaLabel?: string
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void
  floatingRef?: RefObject<HTMLDivElement | null>
  /** let the pointer pass through (tooltips) */
  passThrough?: boolean
}

/** A fixed-position box in a portal, measured then placed (hidden until placed). */
function Floating({
  anchor,
  placement,
  align,
  gap = 6,
  className = '',
  children,
  id,
  role,
  ariaLabel,
  onKeyDown,
  floatingRef,
  passThrough
}: FloatingProps): JSX.Element {
  const localRef = useRef<HTMLDivElement>(null)
  const ref = floatingRef ?? localRef
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos(placeFloating(anchor, r.width, r.height, placement, align, gap, window.innerWidth, window.innerHeight))
  }, [anchor, placement, align, gap, ref])
  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`fixed z-[100] ${passThrough ? 'pointer-events-none' : ''} ${pos ? 'motion-safe:animate-[menuIn_120ms_ease-out]' : ''} ${className}`}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body
  )
}

// ───────────────────────────── Tooltip ─────────────────────────────

type AnyProps = Record<string, unknown> & {
  onMouseEnter?: (e: ReactMouseEvent<HTMLElement>) => void
  onMouseLeave?: (e: ReactMouseEvent<HTMLElement>) => void
  onFocus?: (e: ReactFocusEvent<HTMLElement>) => void
  onBlur?: (e: ReactFocusEvent<HTMLElement>) => void
  onPointerDown?: (e: ReactMouseEvent<HTMLElement>) => void
  onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void
  'aria-describedby'?: string
}

interface TooltipProps {
  /** short text (≤ 260 px wide); null/'' = no tooltip */
  content: ReactNode
  /** ONE element that accepts mouse/focus handlers (a button, a span with tabIndex…) */
  children: ReactElement
  placement?: Placement
  align?: Align
  /** ms before showing (300 by default; the compact rail uses 120) */
  delay?: number
  disabled?: boolean
}

/**
 * e3 tooltip (§8.1): caption text, 300 ms delay, 120 ms fade, max 260 px, above by
 * default and flipped when it would clip. Shows on hover and keyboard focus, hides on
 * Escape / press. No wrapper element: the handlers are cloned onto the child.
 * Note: disabled <button>s get no mouse events — wrap them in a <span tabIndex={0}>.
 */
export function Tooltip({ content, children, placement = 'top', align = 'center', delay = 300, disabled }: TooltipProps): JSX.Element {
  const [anchor, setAnchor] = useState<RectLike | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()
  const clear = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clear, [])
  // the bubble is placed once from the anchor's rect: hide it when the layout moves
  // (window resize, or any scroll — capture phase catches scrolling ancestors too)
  const shown = anchor !== null
  useEffect(() => {
    if (!shown) return
    const onMove = (): void => {
      clear()
      setAnchor(null)
    }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [shown])
  const show = (el: HTMLElement): void => {
    clear()
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect()
      setAnchor({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })
    }, delay)
  }
  const hide = (): void => {
    clear()
    setAnchor(null)
  }
  const active = !disabled && content !== null && content !== undefined && content !== ''
  if (!isValidElement(children)) return <>{children}</>
  const p = children.props as AnyProps
  const child = cloneElement(children as ReactElement<AnyProps>, {
    onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => {
      p.onMouseEnter?.(e)
      if (active) show(e.currentTarget)
    },
    onMouseLeave: (e: ReactMouseEvent<HTMLElement>) => {
      p.onMouseLeave?.(e)
      hide()
    },
    onFocus: (e: ReactFocusEvent<HTMLElement>) => {
      p.onFocus?.(e)
      if (active && e.currentTarget.matches(':focus-visible')) show(e.currentTarget)
    },
    onBlur: (e: ReactFocusEvent<HTMLElement>) => {
      p.onBlur?.(e)
      hide()
    },
    onPointerDown: (e: ReactMouseEvent<HTMLElement>) => {
      p.onPointerDown?.(e)
      hide()
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      p.onKeyDown?.(e)
      if (e.key === 'Escape' && anchor) hide()
    },
    'aria-describedby': anchor && active ? [p['aria-describedby'], id].filter(Boolean).join(' ') : p['aria-describedby']
  })
  return (
    <>
      {child}
      {anchor && active && (
        <Floating anchor={anchor} placement={placement} align={align} gap={8} id={id} role="tooltip" passThrough className="max-w-[260px]">
          <div className="surface-popover rounded-[10px] px-2.5 py-1.5 type-caption text-text">{content}</div>
        </Floating>
      )}
    </>
  )
}

// ───────────────────────────── Button ─────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  children?: ReactNode
  variant?: ButtonVariant
  /** heights 28 / 32 / 40 — `lg` only in setup and empty states */
  size?: ButtonSize
  /** leading icon */
  icon?: IconName
  /** trailing icon (e.g. 'arrow-right', 'chevron-down') */
  iconRight?: IconName
  type?: 'button' | 'submit'
  ref?: Ref<HTMLButtonElement>
  /**
   * Unavailable while an action runs, but still focusable (aria-disabled): a focused
   * button that turned `disabled` would drop keyboard focus to the page.
   */
  pending?: boolean
  /** loading: keeps its width, shows a spinner before the label, ignores clicks (pass the "-ing" label) */
  loading?: boolean
  /** the surface the button sits on (focus-ring offset color) */
  ringOn?: RingSurface
}

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-sage text-ink font-semibold enabled:hover:brightness-110 enabled:active:brightness-95',
  secondary: 'bg-card-2 text-text font-medium ring-1 ring-hairline enabled:hover:ring-hairline-strong enabled:hover:bg-[#332d25]',
  ghost: 'text-text-dim font-medium enabled:hover:text-text enabled:hover:bg-white/[0.05]',
  danger: 'text-coral font-medium enabled:hover:bg-coral/10'
}

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-[12px]',
  md: 'h-8 gap-2 px-3.5 text-[13px]',
  lg: 'h-10 gap-2 px-5 text-[14px]'
}

/** Extra props (aria-*, id, title, ref, …) pass through to the <button>. */
export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  className = '',
  type = 'button',
  ref,
  pending,
  loading,
  ringOn = 'ink',
  onClick,
  ...rest
}: ButtonProps): JSX.Element {
  const busy = pending || loading
  const iconSize = size === 'lg' ? 18 : 16
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-disabled={busy || rest['aria-disabled'] || undefined}
      aria-busy={loading || undefined}
      onClick={(e) => {
        if (busy) {
          e.preventDefault() // also keeps a submit button from submitting
          return
        }
        onClick?.(e)
      }}
      className={`titlebar-no-drag inline-flex shrink-0 items-center justify-center rounded-[10px] whitespace-nowrap transition-[color,background-color,box-shadow,filter,transform] duration-150 ease-out motion-safe:enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${focusRing(ringOn)} ${busy ? 'cursor-default opacity-60' : ''} ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${className}`}
    >
      {loading ? <Spinner size={iconSize - 2} /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight && <Icon name={iconRight} size={iconSize} />}
    </button>
  )
}

// ───────────────────────────── IconButton ─────────────────────────────

export type IconButtonVariant = 'ghost' | 'secondary' | 'glass' | 'danger'

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> & {
  icon: IconName
  /** accessible name AND tooltip text (always required) */
  label: string
  /** 28 (camera, inline) · 32 (default) · 40 (rail) · 44 (window controls) */
  size?: 28 | 32 | 40 | 44
  variant?: IconButtonVariant
  /** tooltip: true = the label (default), a string = custom text, false = none */
  tooltip?: boolean | string
  tooltipPlacement?: Placement
  tooltipDelay?: number
  /** toggled / pressed look (sage-soft) */
  active?: boolean
  ref?: Ref<HTMLButtonElement>
  ringOn?: RingSurface
  /** extra content drawn over the icon (e.g. a status dot) */
  overlay?: ReactNode
}

const ICON_BUTTON_VARIANT: Record<IconButtonVariant, string> = {
  ghost: 'text-text-dim enabled:hover:text-text enabled:hover:bg-white/[0.06]',
  secondary: 'bg-card-2 text-text-dim ring-1 ring-hairline enabled:hover:text-text enabled:hover:ring-hairline-strong',
  glass: 'surface-glass text-text enabled:hover:bg-[rgb(23_21_18/0.85)]',
  danger: 'text-text-dim enabled:hover:bg-coral/80 enabled:hover:text-ink'
}

/** Icon-only button: always an aria-label and a tooltip (§1.5, §8.1). */
export function IconButton({
  icon,
  label,
  size = 32,
  variant = 'ghost',
  tooltip = true,
  tooltipPlacement = 'top',
  tooltipDelay,
  active,
  ref,
  ringOn = 'ink',
  overlay,
  className = '',
  ...rest
}: IconButtonProps): JSX.Element {
  const iconSize = size <= 28 ? 16 : size >= 40 ? 20 : 18
  const radius = size >= 44 ? 'rounded-none' : size >= 40 ? 'rounded-xl' : 'rounded-[10px]'
  const button = (
    <button
      {...rest}
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={`titlebar-no-drag relative inline-flex shrink-0 items-center justify-center transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${size >= 44 ? FOCUS_INSET : focusRing(ringOn)} ${radius} ${
        active ? 'bg-sage-soft text-sage' : ICON_BUTTON_VARIANT[variant]
      } ${className}`}
      style={{ width: size, height: size }}
    >
      <Icon name={icon} size={iconSize} />
      {overlay}
    </button>
  )
  if (tooltip === false) return button
  return (
    <Tooltip content={tooltip === true ? label : tooltip} placement={tooltipPlacement} delay={tooltipDelay}>
      {button}
    </Tooltip>
  )
}

// ───────────────────────────── LinkButton ─────────────────────────────

/** A sage text link-button ("History →", "Turn on"). */
export function LinkButton({
  children,
  onClick,
  arrow = false,
  tone = 'sage',
  className = '',
  ringOn = 'card',
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  children: ReactNode
  /** trailing → arrow */
  arrow?: boolean
  tone?: 'sage' | 'dim'
  ringOn?: RingSurface
}): JSX.Element {
  return (
    <button
      {...rest}
      type="button"
      onClick={onClick}
      className={`titlebar-no-drag inline-flex items-center gap-1 rounded-md text-[12px] font-medium underline-offset-2 transition-colors duration-150 enabled:hover:underline disabled:cursor-not-allowed disabled:opacity-40 ${focusRing(ringOn)} ${
        tone === 'sage' ? 'text-sage' : 'text-text-dim enabled:hover:text-text'
      } ${className}`}
    >
      {children}
      {arrow && <Icon name="arrow-right" size={14} />}
    </button>
  )
}

// ───────────────────────────── Toggle ─────────────────────────────

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  /** unavailable while a change is saved, but keeps keyboard focus (see Button `pending`) */
  pending?: boolean
  /** accessible name */
  label?: string
  /** id of the element that describes the setting (its sub-text) */
  describedBy?: string
  id?: string
  ringOn?: RingSurface
}

/** 20×36 switch. */
export function Toggle({ checked, onChange, disabled, pending, label, describedBy, id, ringOn = 'card' }: ToggleProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={pending || undefined}
      disabled={disabled}
      onClick={() => {
        if (!pending) onChange(!checked)
      }}
      className={`titlebar-no-drag relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing(ringOn)} ${pending ? 'cursor-default opacity-60' : ''} ${
        checked ? 'bg-sage' : 'bg-hairline-strong'
      }`}
    >
      <span
        className={`absolute top-[3px] h-3.5 w-3.5 rounded-full shadow-[0_1px_2px_rgb(0_0_0/0.35)] motion-safe:transition-all motion-safe:duration-150 ${
          checked ? 'left-[19px] bg-ink' : 'left-[3px] bg-text-dim'
        }`}
      />
    </button>
  )
}

// ───────────────────────────── Slider ─────────────────────────────

interface SliderProps {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  disabled?: boolean
  /** value text shown on the right (Plex Mono), e.g. v => `${v} s` */
  format?: (v: number) => string
  /** accessible name, e.g. "Slouching sensitivity" */
  ariaLabel?: string
  /** spoken value, e.g. "Balanced"; defaults to format(value) */
  valueText?: (v: number) => string
  describedBy?: string
  /** draw a notch per step (stepped sliders with ≤ 12 steps) */
  notches?: boolean
  /** labels under the two ends, e.g. "Relaxed" / "Strict" */
  startLabel?: string
  endLabel?: string
  id?: string
}

/** 20 px hit area, 4 px track, sage fill up to the thumb (§1.5). */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  format,
  ariaLabel,
  valueText,
  describedBy,
  notches,
  startLabel,
  endLabel,
  id
}: SliderProps): JSX.Element {
  const spoken = valueText ? valueText(value) : format ? format(value) : undefined
  const pct = max > min ? ((clamp(value, min, max) - min) / (max - min)) * 100 : 0
  const steps = step > 0 ? Math.round((max - min) / step) : 0
  const showNotches = notches && steps > 0 && steps <= 12
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <div className="relative min-w-24 flex-1">
          {showNotches && (
            <div aria-hidden className="pointer-events-none absolute inset-x-[7px] top-1/2 flex -translate-y-1/2 justify-between">
              {Array.from({ length: steps + 1 }, (_, i) => (
                <span key={i} className={`h-2 w-0.5 rounded-full ${(i / steps) * 100 <= pct ? 'bg-sage/50' : 'bg-hairline-strong'}`} />
              ))}
            </div>
          )}
          <input
            type="range"
            id={id}
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            aria-label={ariaLabel}
            aria-valuetext={spoken}
            aria-describedby={describedBy}
            onChange={(e) => onChange(Number(e.target.value))}
            className="slider-sage titlebar-no-drag relative block w-full cursor-pointer appearance-none disabled:cursor-not-allowed disabled:opacity-40"
            style={{ '--fill': `${pct}%` } as CSSProperties}
          />
        </div>
        {format && (
          <span aria-hidden className="w-14 shrink-0 text-right type-value text-text-dim">
            {format(value)}
          </span>
        )}
      </div>
      {(startLabel || endLabel) && (
        <div aria-hidden className={`flex justify-between type-caption text-text-faint ${format ? 'pr-[68px]' : ''}`}>
          <span>{startLabel}</span>
          <span>{endLabel}</span>
        </div>
      )}
    </div>
  )
}

// ───────────────────────────── Segmented control ─────────────────────────────

export interface SegmentOption<T extends string> {
  value: T
  label: string
  icon?: IconName
  /** stage tint for the selected segment (e.g. STAGE_COLOR[2]); default sage */
  color?: string
  /** tooltip */
  title?: string
  /** small second line (Plex Mono), e.g. "10 fps" */
  sub?: string
  disabled?: boolean
}

interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[]
  value: T | null
  onChange: (v: T) => void
  /** accessible name of the group, e.g. "Overlay style" */
  ariaLabel?: string
  describedBy?: string
  disabled?: boolean
  /** 28 (camera, chips) · 32 (default) */
  size?: 'sm' | 'md'
  /** 'glass' = over the camera */
  tone?: 'default' | 'glass'
  /** stretch segments to fill the width */
  fullWidth?: boolean
  /** show icons only (label becomes the tooltip / accessible name) */
  iconOnly?: boolean
}

/**
 * A radio group: arrow keys move (and select) between segments, only the selected
 * segment is in the Tab order, and assistive tech hears which one is checked. Selected
 * segment: sage-soft + sage text (§1.5).
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  describedBy,
  disabled,
  size = 'md',
  tone = 'default',
  fullWidth,
  iconOnly
}: SegmentedControlProps<T>): JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const activeIndex = options.findIndex((o) => o.value === value)
  const tabStop = activeIndex >= 0 ? activeIndex : 0

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number): void => {
    const n = options.length
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % n
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + n) % n
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    if (next === null) return
    e.preventDefault()
    // skip disabled segments
    for (let k = 0; k < n && options[next].disabled; k++) next = (next + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 + n : 1)) % n
    refs.current[next]?.focus()
    onChange(options[next].value)
  }

  const hasSub = options.some((o) => o.sub)
  const h = hasSub ? '' : size === 'sm' ? 'h-7' : 'h-8'
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      className={`titlebar-no-drag ${fullWidth ? 'flex' : 'inline-flex'} gap-0.5 rounded-[10px] p-0.5 ${h} ${
        tone === 'glass' ? 'surface-glass' : 'bg-ink/60 ring-1 ring-white/8'
      } ${disabled ? 'opacity-40' : ''}`}
    >
      {options.map((o, i) => {
        const active = o.value === value
        const tinted = active && o.color
        const button = (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={iconOnly ? o.label : undefined}
            tabIndex={i === tabStop ? 0 : -1}
            /* no native title: a segment with a title is wrapped in <Tooltip> below, and two tooltips would show */
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg transition-colors duration-150 disabled:cursor-not-allowed ${FOCUS_INSET} ${
              fullWidth ? 'flex-1' : ''
            } ${hasSub ? 'flex-col gap-0 px-3 py-1.5' : size === 'sm' ? 'px-2.5 text-[12px]' : 'px-3 text-[13px]'} ${
              active
                ? tinted
                  ? 'font-medium'
                  : 'bg-sage-soft font-medium text-sage'
                : tone === 'glass'
                  ? 'text-text/80 enabled:hover:text-text enabled:hover:bg-white/[0.06]'
                  : 'text-text-dim enabled:hover:text-text enabled:hover:bg-white/[0.04]'
            }`}
            style={tinted ? { color: o.color, backgroundColor: `color-mix(in srgb, ${o.color} 14%, transparent)` } : undefined}
          >
            <span className="inline-flex items-center gap-1.5">
              {o.icon && <Icon name={o.icon} size={size === 'sm' ? 14 : 16} />}
              {!iconOnly && <span className="truncate">{o.label}</span>}
            </span>
            {o.sub && <span className="type-value text-[11px] leading-4 opacity-80">{o.sub}</span>}
          </button>
        )
        return iconOnly || o.title ? (
          <Tooltip key={o.value} content={o.title ?? o.label} placement="top">
            {button}
          </Tooltip>
        ) : (
          button
        )
      })}
    </div>
  )
}

/** v3 name for SegmentedControl (also used for tabs like Day | Week). */
export const Segmented = SegmentedControl

// ───────────────────────────── Popover / Menu / Confirm ─────────────────────────────

interface PopoverProps {
  open: boolean
  /** 'escape' refocuses the anchor itself */
  onClose: (reason: 'escape' | 'outside' | 'resize' | 'select') => void
  /** the element the popover hangs from (usually its trigger) */
  anchorRef: RefObject<HTMLElement | null>
  placement?: Placement
  align?: Align
  children: ReactNode
  className?: string
  role?: 'menu' | 'dialog' | 'listbox'
  ariaLabel?: string
  id?: string
  /** focus the first focusable element inside when opened (default true) */
  autoFocus?: boolean
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void
}

/**
 * e3 popover in a portal (never clipped by scroll containers): flips when there's no room,
 * closes on outside press, Escape (focus returns to the anchor), resize, window blur.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  placement = 'bottom',
  align = 'start',
  children,
  className = '',
  role = 'dialog',
  ariaLabel,
  id,
  autoFocus = true,
  onKeyDown
}: PopoverProps): JSX.Element | null {
  const floatingRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<RectLike | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const r = anchorRef.current?.getBoundingClientRect()
    if (r) setAnchor({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })
  }, [open, anchorRef])

  useEffect(() => {
    if (!open || !anchor) return
    if (autoFocus) {
      floatingRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"], button:not([disabled]), input, textarea, select, [tabindex="0"]')
        ?.focus()
    }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!floatingRef.current?.contains(t) && !anchorRef.current?.contains(t)) onCloseRef.current('outside')
    }
    const onResize = (): void => onCloseRef.current('resize')
    const onScroll = (e: Event): void => {
      if (!floatingRef.current?.contains(e.target as Node)) onCloseRef.current('resize')
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onResize)
    }
  }, [open, anchor, anchorRef, autoFocus])

  if (!open || !anchor) return null
  return (
    <Floating
      anchor={anchor}
      placement={placement}
      align={align}
      floatingRef={floatingRef}
      role={role}
      ariaLabel={ariaLabel}
      id={id}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (e.defaultPrevented) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose('escape')
          anchorRef.current?.focus()
        } else if (e.key === 'Tab' && role === 'menu') {
          e.preventDefault()
          onClose('escape')
          anchorRef.current?.focus()
        }
      }}
      className={`surface-popover p-1 ${className}`}
    >
      {children}
    </Floating>
  )
}

export interface MenuItem {
  label: string
  onClick: () => void
  icon?: IconName
  danger?: boolean
  disabled?: boolean
}

interface MenuProps {
  /** usually a <Button> / <IconButton>; it receives aria-haspopup / aria-expanded / aria-controls */
  trigger: ReactNode
  items: MenuItem[]
  /** horizontal alignment to the trigger (left = start) */
  align?: 'left' | 'right'
  /** which side to open on (flips automatically when there's no room) */
  placement?: Placement
  ariaLabel?: string
}

/**
 * Menu button. Click / Enter / Space / ↓ opens it and focuses the first item;
 * ↑ ↓ Home End move between items; Escape or Tab closes it and returns focus to the
 * trigger; a press outside closes it. Rendered in a portal (never clipped).
 */
export function Menu({ trigger, items, align = 'left', placement = 'bottom', ariaLabel }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const menuId = useId()

  const focusTrigger = (): void => {
    anchorRef.current?.querySelector<HTMLElement>('button, [tabindex]')?.focus()
  }

  // opened by mouse or keyboard: focus the first item once the portal has rendered, so
  // the arrow keys and Esc work immediately (Esc then returns focus to the trigger)
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      document
        .getElementById(menuId)
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
        ?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [open, menuId])

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const list = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'))
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    let next: number | null = null
    if (e.key === 'ArrowDown') next = (i + 1) % list.length
    else if (e.key === 'ArrowUp') next = (i - 1 + list.length) % list.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = list.length - 1
    if (next !== null) {
      e.preventDefault()
      list[next]?.focus()
    }
  }

  const triggerNode = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<Record<string, unknown>>, {
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined
      })
    : trigger

  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {triggerNode}
      </span>
      <Popover
        open={open}
        onClose={(reason) => {
          setOpen(false)
          if (reason === 'escape') focusTrigger()
        }}
        anchorRef={anchorRef}
        placement={placement}
        align={align === 'right' ? 'end' : 'start'}
        role="menu"
        ariaLabel={ariaLabel}
        id={menuId}
        onKeyDown={onMenuKeyDown}
        className="min-w-44"
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            onClick={() => {
              setOpen(false)
              focusTrigger()
              item.onClick()
            }}
            className={`flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-150 enabled:hover:bg-white/[0.06] focus-visible:bg-white/[0.08] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
              item.danger ? 'text-coral' : 'text-text'
            }`}
          >
            {item.icon && <Icon name={item.icon} size={16} className={item.danger ? '' : 'text-text-dim'} />}
            {item.label}
          </button>
        ))}
      </Popover>
    </>
  )
}

interface ConfirmPopoverProps {
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement | null>
  /** "Clear the whole conversation? This can't be undone." */
  message: string
  confirmLabel: string
  cancelLabel?: string
  /** coral confirm (default) — otherwise primary */
  danger?: boolean
  onConfirm: () => void
  placement?: Placement
  align?: Align
}

/** e3 confirm popover: a sentence, then [Confirm] [Cancel]. Cancel is focused first. */
export function ConfirmPopover({
  open,
  onClose,
  anchorRef,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  placement = 'bottom',
  align = 'end'
}: ConfirmPopoverProps): JSX.Element {
  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} placement={placement} align={align} role="dialog" ariaLabel={message} autoFocus={false}>
      <div className="flex w-64 flex-col gap-3 p-2">
        <p className="type-body text-text">{message}</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" ringOn="card-2" onClick={onClose} autoFocus>
            {cancelLabel}
          </Button>
          <Button
            size="sm"
            variant={danger ? 'secondary' : 'primary'}
            ringOn="card-2"
            className={danger ? 'text-coral!' : ''}
            onClick={() => {
              onClose()
              onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Popover>
  )
}

/** A button that asks first (danger actions: Clear chat, Delete history, Reset…). */
export function ConfirmButton({
  message,
  confirmLabel,
  onConfirm,
  danger = true,
  placement,
  align,
  ...button
}: Omit<ButtonProps, 'onClick' | 'ref'> & {
  message: string
  confirmLabel: string
  onConfirm: () => void
  danger?: boolean
  placement?: Placement
  align?: Align
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <Button {...button} ref={ref} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      <ConfirmPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        message={message}
        confirmLabel={confirmLabel}
        danger={danger}
        onConfirm={onConfirm}
        placement={placement}
        align={align}
      />
    </>
  )
}

// ───────────────────────────── Card ─────────────────────────────

interface CardProps {
  children: ReactNode
  className?: string
  /** padding 16 instead of 20 (gauges, KPI tiles) */
  dense?: boolean
  /** e2 raised instead of e1 */
  raised?: boolean
  /** no padding (the content handles it) */
  flush?: boolean
  as?: 'section' | 'div' | 'article' | 'aside'
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  style?: CSSProperties
}

/** e1 card (bg-card, radius 16, hairline ring, inner top highlight). */
export function Card({ children, className = '', dense, raised, flush, as = 'section', style, ...aria }: CardProps): JSX.Element {
  const Tag = as
  return (
    <Tag {...aria} style={style} className={`${raised ? 'surface-raised' : 'surface-card'} ${flush ? '' : dense ? 'p-4' : 'p-5'} ${className}`}>
      {children}
    </Tag>
  )
}

interface CardHeaderProps {
  /** 16 px icon in text-faint */
  icon?: IconName
  /** small caps label ("TODAY") — or use `title` */
  eyebrow?: string
  title?: ReactNode
  /** info-icon tooltip next to the label */
  info?: string
  /** right-aligned action (ghost sm button / link) */
  action?: ReactNode
  /** id for the heading (aria-labelledby on the card) */
  id?: string
  className?: string
}

/** Card header row (§1.4): icon · eyebrow/title · info … action. 12 px to the body. */
export function CardHeader({ icon, eyebrow, title, info, action, id, className = '' }: CardHeaderProps): JSX.Element {
  return (
    <div className={`mb-3 flex min-h-6 items-center gap-2 ${className}`}>
      {icon && <Icon name={icon} size={16} className="text-text-faint" />}
      <h2 id={id} className={eyebrow ? 'type-micro text-text-faint' : 'type-title text-text'}>
        {eyebrow ?? title}
      </h2>
      {info && (
        <Tooltip content={info}>
          <span tabIndex={0} aria-label={info} className={`inline-flex rounded-full text-text-faint hover:text-text-dim ${focusRing('card')}`}>
            <Icon name="info" size={14} />
          </span>
        </Tooltip>
      )}
      {action && <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  )
}

/** Eyebrow label outside cards (section titles in a grid, "STEP 2 OF 3"). */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <p className={`type-micro text-text-faint ${className}`}>{children}</p>
}

/** Hairline divider inside a card (16 px between groups). */
export function Divider({ className = '' }: { className?: string }): JSX.Element {
  return <hr className={`my-4 border-0 border-t border-white/[0.06] ${className}`} />
}

// ───────────────────────────── Chips, badges, pills ─────────────────────────────

export type ChipTone = 'neutral' | 'sage' | 'amber' | 'ember' | 'coral' | 'slate' | 'glass' | 'outline-amber'

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: 'bg-white/[0.05] text-text-dim',
  sage: 'bg-sage-soft text-sage',
  amber: 'bg-amber/12 text-amber',
  ember: 'bg-ember/12 text-ember',
  coral: 'bg-coral/12 text-coral',
  slate: 'bg-slate-cool/12 text-slate-cool',
  glass: 'surface-glass text-text',
  'outline-amber': 'text-amber ring-1 ring-amber/60'
}

interface ChipProps {
  children: ReactNode
  tone?: ChipTone
  icon?: IconName
  /** a colored dot before the text */
  dot?: string
  /** pulse the dot (monitoring) */
  pulse?: boolean
  /** 22 px (sm) · 26 px (md, camera chips) */
  size?: 'sm' | 'md'
  /** makes it a button */
  onClick?: () => void
  className?: string
  ariaLabel?: string
}

/** Fully round chip: status, verdict, context toggles, camera glass chips. */
export function Chip({ children, tone = 'neutral', icon, dot, pulse, size = 'sm', onClick, className = '', ariaLabel }: ChipProps): JSX.Element {
  const cls = `titlebar-no-drag inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full whitespace-nowrap type-caption ${
    size === 'md' ? 'h-[26px] px-2.5' : 'h-[22px] px-2'
  } ${CHIP_TONE[tone]} ${className}`
  const inner = (
    <>
      {dot && <StatusDot color={dot} pulse={pulse} size={7} />}
      {icon && <Icon name={icon} size={14} />}
      <span className="min-w-0 truncate">{children}</span>
    </>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-label={ariaLabel} className={`${cls} transition-[filter] duration-150 hover:brightness-125 ${focusRing('card')}`}>
        {inner}
      </button>
    )
  }
  return (
    <span className={cls} aria-label={ariaLabel}>
      {inner}
    </span>
  )
}

/** Small round nav badge (18 px, micro): "AI". */
export function Badge({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <span className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white/5 px-1.5 type-micro text-[10px] text-text-faint ${className}`}>
      {children}
    </span>
  )
}

/** Stage pill: `slight` / `clear` / `severe` in the stage color. */
export function StagePill({ label, color }: { label: string; color: string }): JSX.Element {
  return (
    <span
      className="inline-flex h-[22px] items-center rounded-full px-2 type-caption font-medium"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)` }}
    >
      {label}
    </span>
  )
}

/** Keyboard key (About › shortcuts). */
export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-card-2 px-1.5 font-mono text-[12px] text-text-dim ring-1 ring-hairline-strong">
      {children}
    </kbd>
  )
}

// ───────────────────────────── ScoreRing ─────────────────────────────

interface ScoreRingProps {
  /** 0–100, null = no score (— and an empty arc) */
  value: number | null
  /** px: 112 (Live), 88 (compact), 40 (chat check card) */
  size?: number
  /** stroke px (10 by default; scaled down for small rings) */
  stroke?: number
  /** the number in the center (default: size ≥ 64) */
  showValue?: boolean
  /** "/100" under the number (default: size ≥ 88) */
  showCaption?: boolean
  className?: string
}

/** Score ring (§3.4): white/6 track, band-colored arc with round caps, 400 ms ease-out. */
export function ScoreRing({ value, size = 112, stroke, showValue, showCaption, className = '' }: ScoreRingProps): JSX.Element {
  const sw = stroke ?? (size >= 88 ? 10 : size >= 56 ? 7 : 4)
  const r = (size - sw) / 2
  const c = 2 * Math.PI * r
  const v = value === null || !Number.isFinite(value) ? null : clamp(value, 0, 100)
  const color = scoreColor(v)
  const numberVisible = showValue ?? size >= 64
  const captionVisible = showCaption ?? size >= 88
  return (
    <div
      role="img"
      aria-label={v === null ? 'Posture score unavailable' : `Posture score ${Math.round(v)} out of 100`}
      className={`relative inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth={sw} />
        {v !== null && v > 0 && (
          <circle
            className="ss-ring-arc"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - v / 100)}
          />
        )}
      </svg>
      {numberVisible && (
        <div className="relative flex flex-col items-center">
          <span className={size >= 88 ? 'type-score text-text' : 'type-h2 text-text'} style={v === null ? { color: 'var(--color-text-faint)' } : undefined}>
            {fmtScore(v)}
          </span>
          {captionVisible && <span className="mt-0.5 type-caption text-text-faint">/100</span>}
        </div>
      )}
    </div>
  )
}

// ───────────────────────────── Gauge ─────────────────────────────

export interface GaugeProps {
  /** "Head position" */
  label: string
  /** the reading in display units (° or cm, signed: + = toward the issue); null = can't measure */
  value: number | null
  /** formatted value, e.g. "+4° forward" / "level with baseline" */
  valueText: string
  /** display range [lo, hi] */
  range: [number, number]
  /** stage thresholds T1 < T2 < T3 (already divided by sensitivity); mirrored when twoSided */
  ticks: [number, number, number]
  /** this issue's stage (colors the value and marker) */
  stage: Stage
  /** zones mirror around 0 (side lean) */
  twoSided?: boolean
  /** why it's unavailable (tooltip on "can't see from here"), e.g. "Your hips aren't in view" */
  unavailableReason?: string
  /** the issue is turned off in Settings: "off" + muted track (+ Turn on link) */
  disabled?: boolean
  onTurnOn?: () => void
  /** compact: label + value only, no track */
  hideTrack?: boolean
}

const ZONE_GOOD = 'color-mix(in srgb, var(--color-sage-deep) 40%, transparent)'
const zone = (stage: 1 | 2 | 3): string => `color-mix(in srgb, ${STAGE_COLOR[stage]} 18%, transparent)`

/** One metric gauge row (§3.4 Zone B): label · value, then a 6 px zoned track with a marker. */
export function Gauge({
  label,
  value,
  valueText,
  range,
  ticks,
  stage,
  twoSided,
  unavailableReason,
  disabled,
  onTurnOn,
  hideTrack
}: GaugeProps): JSX.Element {
  const [lo, hi] = range
  const span = hi - lo || 1
  const pos = (v: number): number => ((clamp(v, lo, hi) - lo) / span) * 100
  const [t1, t2, t3] = ticks
  const unavailable = !disabled && (value === null || !Number.isFinite(value))

  const segments: { from: number; to: number; color: string }[] = []
  const add = (a: number, b: number, color: string): void => {
    const from = pos(Math.min(a, b))
    const to = pos(Math.max(a, b))
    if (to > from) segments.push({ from, to, color })
  }
  if (twoSided) {
    add(-t1, t1, ZONE_GOOD)
    add(t1, t2, zone(1))
    add(-t2, -t1, zone(1))
    add(t2, t3, zone(2))
    add(-t3, -t2, zone(2))
    add(t3, hi, zone(3))
    add(lo, -t3, zone(3))
  } else {
    add(lo, t1, ZONE_GOOD)
    add(t1, t2, zone(1))
    add(t2, t3, zone(2))
    add(t3, hi, zone(3))
  }

  const v = value ?? 0
  const outside = !unavailable && !disabled && (v < lo || v > hi)
  const color = STAGE_COLOR[stage]

  const valueNode = disabled ? (
    <span className="type-value text-text-faint">off</span>
  ) : unavailable ? (
    <Tooltip content={unavailableReason}>
      <span tabIndex={unavailableReason ? 0 : -1} className={`rounded type-value text-text-faint ${focusRing('card')}`}>
        can’t see from here
      </span>
    </Tooltip>
  ) : (
    <span className="type-value" style={{ color: stage === 0 ? 'var(--color-text)' : color }}>
      {valueText}
    </span>
  )

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate type-body text-text-dim">{label}</span>
        <span className="flex shrink-0 items-baseline gap-2">
          {valueNode}
          {disabled && onTurnOn && (
            <LinkButton onClick={onTurnOn} className="text-[12px]">
              Turn on
            </LinkButton>
          )}
        </span>
      </div>
      {!hideTrack &&
        (unavailable ? (
          <div aria-hidden className="mx-[5px] mt-[2px] mb-[3px] h-0 border-t border-dashed border-hairline-strong" />
        ) : (
          <div aria-hidden className={`relative mx-[5px] h-1.5 rounded-full bg-white/[0.06] ${disabled ? 'opacity-40' : ''}`}>
            {!disabled &&
              segments.map((s, i) => (
                <span
                  key={i}
                  className="absolute inset-y-0"
                  style={{
                    left: `${s.from}%`,
                    width: `${s.to - s.from}%`,
                    backgroundColor: s.color,
                    borderRadius: s.from <= 0 ? '9999px 0 0 9999px' : s.to >= 100 ? '0 9999px 9999px 0' : undefined
                  }}
                />
              ))}
            {/* your setup = 0 */}
            {lo < 0 && hi > 0 && (
              <span title="your setup" className="absolute -top-[3px] h-3 w-0.5 -translate-x-1/2 rounded-full bg-text-faint" style={{ left: `${pos(0)}%` }} />
            )}
            {!disabled && (
              <span
                className="ss-gauge-marker absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ left: `${pos(v)}%`, backgroundColor: color, boxShadow: '0 0 0 2px var(--color-card)' }}
              >
                {outside && (
                  <svg
                    width="6"
                    height="8"
                    viewBox="0 0 6 8"
                    className={`absolute top-1/2 -translate-y-1/2 ${v > hi ? '-right-[7px]' : '-left-[7px] rotate-180'}`}
                    aria-hidden
                  >
                    <path d="M0 0l6 4-6 4z" fill={color} />
                  </svg>
                )}
              </span>
            )}
          </div>
        ))}
    </div>
  )
}

/** v3 inventory name (§9). */
export const MetricGauge = Gauge

// ───────────────────────────── StatTile / ProgressBar ─────────────────────────────

export type StatTone = 'good' | 'warn' | 'faint' | 'dim'

const STAT_TONE: Record<StatTone, string> = {
  good: 'text-sage',
  warn: 'text-amber',
  faint: 'text-text-faint',
  dim: 'text-text-dim'
}

interface StatTileProps {
  /** "ALIGNED" */
  eyebrow: string
  /** "82%" — h2, Bricolage, tabular numbers */
  value: ReactNode
  /** "+6 vs avg" */
  sub?: ReactNode
  subTone?: StatTone
  icon?: IconName
  /** skeleton while loading */
  loading?: boolean
  /** a day with no data: value "—", dimmed */
  muted?: boolean
  className?: string
}

/** KPI tile (History, §5.1): e1 dense, 96 px. */
export function StatTile({ eyebrow, value, sub, subTone = 'dim', icon, loading, muted, className = '' }: StatTileProps): JSX.Element {
  return (
    <Card dense as="div" className={`flex min-h-24 min-w-0 flex-col justify-between gap-1 ${className}`}>
      <div className="flex items-center gap-1.5">
        {icon && <Icon name={icon} size={14} className="text-text-faint" />}
        <p className="truncate type-micro text-text-faint">{eyebrow}</p>
      </div>
      {loading ? (
        <>
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-3.5 w-24" />
        </>
      ) : (
        <>
          <p className={`truncate type-h2 ${muted ? 'text-text-faint' : 'text-text'}`}>{value}</p>
          <p className={`min-h-4 truncate type-caption ${muted ? 'text-text-faint' : STAT_TONE[subTone]}`}>{sub}</p>
        </>
      )}
    </Card>
  )
}

/** v3 inventory name (§9). */
export const KpiTile = StatTile

/** A rounded progress bar (Sitting card): 0..1 (values > 1 fill fully). */
export function ProgressBar({
  value,
  color = 'var(--color-sage)',
  height = 8,
  pulse,
  label,
  className = ''
}: {
  value: number
  color?: string
  height?: number
  pulse?: boolean
  /** accessible name, e.g. "Sitting time toward the next break" */
  label?: string
  className?: string
}): JSX.Element {
  const v = Number.isFinite(value) ? clamp(value, 0, 1) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      className={`w-full overflow-hidden rounded-full bg-white/[0.06] ${className}`}
      style={{ height }}
    >
      <div
        className={`h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500 ${pulse ? 'motion-safe:animate-[softPulse_2s_ease-in-out_infinite]' : ''}`}
        style={{ width: `${v * 100}%`, backgroundColor: color }}
      />
    </div>
  )
}

// ───────────────────────────── Stepper ─────────────────────────────

/**
 * Setup stepper (§7.1): 24 px nodes — done = sage fill + check, current = sage ring +
 * number, upcoming = white/10 ring + faint number — joined by 48 px hairlines (sage when passed).
 */
export function Stepper({ steps, current, compact }: { steps: string[]; current: number; compact?: boolean }): JSX.Element {
  return (
    <ol className="flex items-center" aria-label="Setup progress">
      {steps.map((label, i) => {
        const n = i + 1
        const done = n < current
        const now = n === current
        return (
          <li key={label} className="flex items-center" aria-current={now ? 'step' : undefined}>
            {i > 0 && <span aria-hidden className={`mx-2 h-px ${compact ? 'w-6' : 'w-12'} ${n <= current ? 'bg-sage/70' : 'bg-white/10'}`} />}
            <span className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full font-mono text-[12px] ${
                  done ? 'bg-sage text-ink' : now ? 'text-sage ring-2 ring-sage' : 'text-text-faint ring-1 ring-white/10'
                }`}
              >
                {done ? <Icon name="check" size={14} strokeWidth={2.2} /> : n}
              </span>
              <span className={`${compact ? 'sr-only' : ''} type-caption ${now ? 'text-text' : 'text-text-dim'}`}>
                {label}
                {done && <span className="sr-only"> (done)</span>}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// ───────────────────────────── EmptyState / Banner ─────────────────────────────

interface EmptyStateProps {
  /** a 48 px line icon (by name) in a 72 px card-2 circle — or any node */
  icon: IconName | ReactNode
  headline: string
  /** body-lg text-dim, ≤ 2 lines */
  body: ReactNode
  /** primary action (usually <Button variant="primary" size="lg">) */
  primary?: ReactNode
  /** secondary action (ghost) */
  secondary?: ReactNode
  /** legacy: any actions row */
  actions?: ReactNode
  className?: string
}

/** Empty / error state (§8.6): centered in its container with 24 px gaps. */
export function EmptyState({ icon, headline, body, primary, secondary, actions, className = '' }: EmptyStateProps): JSX.Element {
  const iconNode =
    typeof icon === 'string' ? (
      <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-card-2 text-text-dim ring-1 ring-white/[0.06]">
        <Icon name={icon as IconName} size={36} strokeWidth={1.4} />
      </span>
    ) : (
      icon
    )
  const hasActions = primary || secondary || actions
  return (
    <div className={`flex h-full flex-col items-center justify-center gap-6 p-8 text-center ${className}`}>
      {iconNode}
      <div className="flex flex-col items-center gap-2">
        <h2 className="type-h3 text-text">{headline}</h2>
        <p className="max-w-[44ch] type-body-lg text-text-dim">{body}</p>
      </div>
      {hasActions && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {primary}
          {secondary}
          {actions}
        </div>
      )}
    </div>
  )
}

export type BannerTone = 'amber' | 'slate' | 'coral' | 'sage'

const BANNER_ACCENT: Record<BannerTone, string> = {
  amber: 'var(--color-amber)',
  slate: 'var(--color-slate-cool)',
  coral: 'var(--color-coral)',
  sage: 'var(--color-sage)'
}

const BANNER_ICON: Record<BannerTone, IconName> = { amber: 'alert', slate: 'info', coral: 'alert', sage: 'check' }

/** Full-width notice (§3.7): e1 card with a 3 px left accent, one sentence, actions on the right. */
export function Banner({
  tone = 'amber',
  icon,
  children,
  actions,
  onDismiss,
  className = ''
}: {
  tone?: BannerTone
  icon?: IconName
  children: ReactNode
  actions?: ReactNode
  /** shows a close icon button */
  onDismiss?: () => void
  className?: string
}): JSX.Element {
  const accent = BANNER_ACCENT[tone]
  return (
    <div role="status" className={`surface-card relative flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 overflow-hidden py-2.5 pr-3 pl-5 ${className}`}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: accent }} />
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span style={{ color: accent }}>
          <Icon name={icon ?? BANNER_ICON[tone]} size={16} />
        </span>
        <span className="min-w-0 type-body text-text">{children}</span>
      </span>
      {(actions || onDismiss) && (
        <span className="flex shrink-0 items-center gap-1">
          {actions}
          {onDismiss && <IconButton icon="close" label="Dismiss" size={28} onClick={onDismiss} ringOn="card" />}
        </span>
      )}
    </div>
  )
}

// ───────────────────────────── list navigation item (Settings categories) ─────────────────────────────

interface NavListItemProps {
  icon: IconName
  title: string
  /** one line, ellipsis (hidden when compact → tooltip) */
  description?: string
  selected: boolean
  onClick: () => void
  /** title only; the description moves into the tooltip */
  compact?: boolean
  id?: string
  tabIndex?: number
  onKeyDown?: (e: ReactKeyboardEvent<HTMLButtonElement>) => void
  ref?: Ref<HTMLButtonElement>
}

/**
 * Settings category row (§6.1): 56 px (40 compact), radius 12, 20 px icon, title +
 * caption description. Selected: e2 + sage icon + 3 px sage left bar.
 */
export function NavListItem({ icon, title, description, selected, onClick, compact, id, tabIndex, onKeyDown, ref }: NavListItemProps): JSX.Element {
  const button = (
    <button
      ref={ref}
      id={id}
      type="button"
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
      className={`relative flex w-full items-center gap-3 rounded-xl text-left transition-colors duration-150 ${compact ? 'h-10 px-3' : 'h-14 px-3'} ${focusRing('ink')} ${
        selected ? 'surface-raised' : 'hover:bg-white/[0.04]'
      }`}
    >
      {selected && <span aria-hidden className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-full bg-sage" />}
      <Icon name={icon} size={20} className={selected ? 'text-sage' : 'text-text-faint'} />
      <span className="flex min-w-0 flex-col">
        <span className={`truncate text-[14px] leading-5 font-semibold ${selected ? 'text-text' : 'text-text-dim'}`}>{title}</span>
        {!compact && description && <span className="truncate type-caption text-text-dim">{description}</span>}
      </span>
    </button>
  )
  return compact && description ? (
    <Tooltip content={description} placement="right">
      {button}
    </Tooltip>
  ) : (
    button
  )
}

// ───────────────────────────── inputs ─────────────────────────────

/** 32 px text input (FIELD_CLASS). */
export function TextInput({ className = '', ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }): JSX.Element {
  return <input ref={ref} {...rest} className={`${FIELD_CLASS} titlebar-no-drag select-text ${className}`} />
}

interface SelectProps<T extends string> {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; disabled?: boolean }[]
  ariaLabel?: string
  id?: string
  disabled?: boolean
  className?: string
  describedBy?: string
}

/** 32 px native select with the chevron icon. */
export function Select<T extends string>({ value, onChange, options, ariaLabel, id, disabled, className = '', describedBy }: SelectProps<T>): JSX.Element {
  return (
    <span className={`relative inline-flex min-w-0 ${className}`}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value as T)}
        className={`${FIELD_CLASS} titlebar-no-drag w-full min-w-0 cursor-pointer appearance-none truncate pr-8`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" size={16} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-text-dim" />
    </span>
  )
}

// ───────────────────────────── misc hooks for primitives users ─────────────────────────────

/** "Saved" flash token: call `flash()` after a commit; `shown` is true for ~1 s. */
export function useSavedFlash(ms = 1000): { shown: boolean; flash: () => void } {
  const [shown, setShown] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const flash = useCallback(() => {
    setShown(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setShown(false), ms)
  }, [ms])
  return { shown, flash }
}
