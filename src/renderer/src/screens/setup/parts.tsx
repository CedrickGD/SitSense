// Small building blocks of the posture-setup flow (ui-v3.md §7). Local to setup: they
// are tuned to the setup background and its large coaching type.

import { memo, useEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import type { ViewKind } from '@shared/posture'
import CameraFeed from '@renderer/components/CameraFeed'
import { Icon } from '@renderer/components/icons'
import { Chip } from '@renderer/components/primitives'
import type { Breakpoint } from '@renderer/lib/hooks'
import { VIEW_CHIP, type ProbeTone, type RowKind } from './copy'

/** Local keyframes (main.css is shared); every use is behind motion-safe:. */
export const SETUP_KEYFRAMES = `
@keyframes ss-fade { from { opacity: 0; transform: translateY(3px) } to { opacity: 1; transform: none } }
@keyframes ss-pulse { 0% { box-shadow: 0 0 0 0 rgb(147 201 162 / 0.55) } 100% { box-shadow: 0 0 0 7px rgb(147 201 162 / 0) } }
@keyframes ss-drain { from { stroke-dashoffset: var(--ss-from) } to { stroke-dashoffset: var(--ss-c) } }
@keyframes ss-draw { from { stroke-dashoffset: 1 } to { stroke-dashoffset: 0 } }
@keyframes ss-reveal { from { opacity: 0; transform: translateY(6px) scale(0.96) } to { opacity: 1; transform: none } }
@keyframes ss-sheet { from { opacity: 0; transform: translateY(8px) scale(0.985) } to { opacity: 1; transform: none } }
@keyframes ss-nudge { 0%, 100% { transform: translateX(0) } 50% { transform: translateX(-2.5px) } }
`

// ───────────────────────────── layout ─────────────────────────────

/**
 * The setup body (§7.1): a 12-column grid, the camera in cols 1–7 (1–6 compact), the
 * coach panel in the rest. The panel has no card background — big type on the setup bg.
 */
export function SetupColumns({
  bp,
  left,
  right,
  center
}: {
  bp: Breakpoint
  left: ReactNode
  right: ReactNode
  /** center the composition vertically (short steps); default: fill the height */
  center?: boolean
}): JSX.Element {
  const compact = bp === 'compact'
  return (
    <div
      className={`grid h-full grid-cols-12 ${center ? 'content-center items-start' : ''} ${
        compact ? 'gap-x-6 gap-y-4 px-6 pt-2 pb-6' : 'gap-x-8 gap-y-4 px-8 pt-4 pb-8'
      }`}
    >
      <div className={`flex min-w-0 flex-col ${compact ? 'col-span-6 gap-4' : 'col-span-7 gap-4'}`}>{left}</div>
      <div className={`flex min-w-0 flex-col ${compact ? 'col-span-6' : 'col-span-5 pl-2'}`}>{right}</div>
    </div>
  )
}

/** "STEP 2 OF 3" */
export function StepEyebrow({ n }: { n: 1 | 2 | 3 }): JSX.Element {
  return (
    <p className="type-micro text-text-faint">
      Step {n} of 3
    </p>
  )
}

// ───────────────────────────── camera ─────────────────────────────

/**
 * The live preview, always with the Lines overlay (no switcher), plus the view chip at
 * the bottom left (§7.1). Memoised: the setup state changes many times a second.
 */
export const SetupCamera = memo(function SetupCamera({ view }: { view: ViewKind | null }): JSX.Element {
  return (
    <section aria-label="Camera preview" className="relative w-full shrink-0">
      <CameraFeed showAway={false} overlayStyle="skeleton" />
      {view && (
        <div className="pointer-events-none absolute bottom-3 left-3" key={view}>
          <Chip tone="glass" size="md" icon="camera" className="motion-safe:animate-[fadeIn_150ms_ease-out]">
            {VIEW_CHIP[view]}
          </Chip>
        </div>
      )}
    </section>
  )
})

// ───────────────────────────── status marks ─────────────────────────────

/** The 20 px checklist mark (§7.3); a row that turns good pulses once in sage. */
export function RowMark({ kind }: { kind: RowKind }): JSX.Element {
  const base = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full'
  switch (kind) {
    case 'good':
      return (
        <span aria-hidden key="good" className={`${base} bg-sage/20 text-sage motion-safe:animate-[ss-pulse_300ms_ease-out]`}>
          <Icon name="check" size={14} strokeWidth={2.2} />
        </span>
      )
    case 'adjust':
      return (
        <span aria-hidden key="adjust" className={`${base} text-amber motion-safe:animate-[fadeIn_150ms_ease-out]`}>
          <svg width="20" height="20" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10 2.8a7.2 7.2 0 010 14.4z" fill="currentColor" />
          </svg>
        </span>
      )
    case 'unverified':
      return (
        <span aria-hidden key="unverified" className={`${base} text-amber ring-[1.5px] ring-amber/80 ring-inset motion-safe:animate-[fadeIn_150ms_ease-out]`}>
          <svg width="20" height="20" viewBox="0 0 20 20">
            <path d="M10 5.6v5.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="10" cy="14" r="1.1" fill="currentColor" />
          </svg>
        </span>
      )
    case 'na':
      return (
        <span aria-hidden key="na" className={`${base} text-text-faint`}>
          <Icon name="minus" size={14} />
        </span>
      )
    default:
      return (
        <span aria-hidden key="pending" className={`${base} text-text-faint`}>
          <svg width="20" height="20" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 3" />
          </svg>
        </span>
      )
  }
}

/** Step 1's row marks. */
export function ProbeMark({ tone }: { tone: ProbeTone }): JSX.Element {
  switch (tone) {
    case 'good':
      return <RowMark kind="good" />
    case 'warn':
      return <RowMark kind="unverified" />
    case 'info':
      return (
        <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center text-text-dim">
          <Icon name="info" size={18} />
        </span>
      )
    default:
      return <RowMark kind="pending" />
  }
}

// ───────────────────────────── progress ring ─────────────────────────────

/** 56 px progress ring: sage fill (holding/capturing), an empty track, or the amber drain. */
export function ProgressRing({
  value,
  size = 56,
  label,
  drainFrom,
  children
}: {
  value: number
  size?: number
  label?: string
  /** draw the amber drain from this fill instead of the value (break back to coaching) */
  drainFrom?: number
  children?: ReactNode
}): JSX.Element {
  const stroke = 4
  const r = (size - stroke) / 2 - 1
  const c = 2 * Math.PI * r
  const v = Math.min(1, Math.max(0, value))
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        role={label ? 'progressbar' : undefined}
        aria-hidden={label ? undefined : true}
        aria-label={label}
        aria-valuemin={label ? 0 : undefined}
        aria-valuemax={label ? 100 : undefined}
        aria-valuenow={label ? Math.round(v * 100) : undefined}
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth={stroke} />
        {drainFrom !== undefined ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--color-amber)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c}
            className="motion-safe:animate-[ss-drain_300ms_ease-in_forwards]"
            style={{ '--ss-from': `${c * (1 - drainFrom)}`, '--ss-c': `${c}` } as CSSProperties}
          />
        ) : (
          v > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="var(--color-sage)"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - v)}
              className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-150 motion-safe:ease-linear"
            />
          )
        )}
      </svg>
      {children && <span className="absolute inset-0 flex items-center justify-center">{children}</span>}
    </span>
  )
}

// ───────────────────────────── hooks ─────────────────────────────

/**
 * The value once it has held for `ms` (§7.3: the instruction only changes after the new
 * one held for 0.6 s — no flicker). The first value shows at once; `immediate` values
 * (e.g. the hold copy) skip the wait.
 */
export function useSettled<T>(value: T, ms: number, immediate = false): T {
  const [shown, setShown] = useState(value)
  useEffect(() => {
    if (Object.is(value, shown)) return
    if (immediate) {
      setShown(value)
      return
    }
    const t = setTimeout(() => setShown(value), ms)
    return () => clearTimeout(t)
  }, [value, shown, ms, immediate])
  return shown
}

/** True `ms` after `since` (a timestamp) — re-renders once when it flips. */
export function useElapsed(since: number | null, ms: number): boolean {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    const left = since + ms - Date.now()
    if (left <= 0) return
    const t = setTimeout(() => setNow(Date.now()), left + 20)
    return () => clearTimeout(t)
  }, [since, ms])
  return since !== null && Math.max(now, Date.now()) - since >= ms
}

/** When a hold/capture breaks back to coaching, briefly drain the ring in amber (300 ms). */
export function useDrain(phase: string, progress: number): { from: number; key: number } | null {
  const last = useRef({ phase, progress })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [drain, setDrain] = useState<{ from: number; key: number } | null>(null)

  useEffect(() => {
    const prev = last.current
    last.current = { phase, progress }
    const running = phase === 'holding' || phase === 'capturing'
    const wasRunning = prev.phase === 'holding' || prev.phase === 'capturing'
    if (running) {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setDrain(null)
      return
    }
    if (!wasRunning || (phase !== 'coaching' && phase !== 'searching')) return
    setDrain({ from: Math.max(0.05, prev.progress), key: Date.now() })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setDrain(null)
    }, 700)
  }, [phase, progress])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return drain
}
