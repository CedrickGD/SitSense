// Settings building blocks (docs/specs/ui-v3.md §6.1): the card grid, cards, setting rows
// and the "Saved" fade. Local to Settings — the app-wide primitives live in
// components/primitives.tsx.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import { Card, Slider } from '@renderer/components/primitives'
import { Icon, type IconName } from '@renderer/components/icons'
import { useAppStore } from '@renderer/state/store'

// ───────────────────────────── commit + "Saved" ─────────────────────────────

interface CommitApi {
  /** store a settings patch, then flash "Saved" next to the control `key` */
  commit: (key: string, patch: unknown) => void
  /** current flash token of a control (0 = never saved) */
  token: (key: string) => number
}

const CommitCtx = createContext<CommitApi>({ commit: () => undefined, token: () => 0 })

export function CommitProvider({ children }: { children: ReactNode }): JSX.Element {
  const patchSettings = useAppStore((s) => s.patchSettings)
  const [tokens, setTokens] = useState<Record<string, number>>({})
  const commit = useCallback(
    (key: string, patch: unknown) => {
      void patchSettings(patch).then(
        () => setTokens((t) => ({ ...t, [key]: (t[key] ?? 0) + 1 })),
        () => undefined
      )
    },
    [patchSettings]
  )
  const token = useCallback((key: string) => tokens[key] ?? 0, [tokens])
  const api = useMemo(() => ({ commit, token }), [commit, token])
  return <CommitCtx.Provider value={api}>{children}</CommitCtx.Provider>
}

export const useCommit = (): CommitApi => useContext(CommitCtx)

/**
 * A transient "Saved" (1 s, caption text-faint) after a change was stored. Visual only:
 * the control itself already announces its new state.
 */
export function SavedNote({ token, className = '' }: { token: number; className?: string }): JSX.Element | null {
  const [phase, setPhase] = useState<'off' | 'on' | 'fade'>('off')
  useEffect(() => {
    if (!token) return
    setPhase('on')
    const fade = setTimeout(() => setPhase('fade'), 250)
    const off = setTimeout(() => setPhase('off'), 1250)
    return () => {
      clearTimeout(fade)
      clearTimeout(off)
    }
  }, [token])
  if (phase === 'off') return null
  return (
    <span
      aria-hidden
      className={`pointer-events-none type-caption whitespace-nowrap text-text-faint motion-safe:transition-opacity motion-safe:duration-1000 ${
        phase === 'fade' ? 'motion-safe:opacity-0' : ''
      } ${className}`}
    >
      Saved
    </span>
  )
}

/** The "Saved" note for one commit key. */
export function Saved({ k, className }: { k: string; className?: string }): JSX.Element | null {
  const { token } = useCommit()
  return <SavedNote token={token(k)} className={className} />
}

// ───────────────────────────── grid + cards ─────────────────────────────

export type Span = 4 | 5 | 6 | 7 | 8 | 12

/** Column spans on the 12-col grid, active once the content column is ≥ 600 px wide. */
const SPAN_CLASS: Record<Span, string> = {
  4: '@min-[600px]:col-span-4',
  5: '@min-[600px]:col-span-5',
  6: '@min-[600px]:col-span-6',
  7: '@min-[600px]:col-span-7',
  8: '@min-[600px]:col-span-8',
  12: '@min-[600px]:col-span-12'
}

/** 2-col (12-col spans) when the content column allows, 1 column otherwise. 16 px gaps. */
export function SettingsGrid({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid grid-cols-1 items-start gap-4 @min-[600px]:grid-cols-12">{children}</div>
}

interface SettingsCardProps {
  span?: Span
  icon?: IconName
  /** micro eyebrow ("CAMERA") */
  eyebrow?: string
  /** or a title (title 15/600) */
  title?: ReactNode
  /** right-aligned header action */
  action?: ReactNode
  children: ReactNode
  className?: string
  /** span two rows (the tall preview card) */
  rowSpan2?: boolean
  /** stretch to the row height (cards side by side share top and bottom, §8.4) */
  stretch?: boolean
  dense?: boolean
}

export function SettingsCard({
  span = 12,
  icon,
  eyebrow,
  title,
  action,
  children,
  className = '',
  rowSpan2,
  stretch = true,
  dense
}: SettingsCardProps): JSX.Element {
  const headingId = useId()
  return (
    <Card
      aria-labelledby={eyebrow || title ? headingId : undefined}
      dense={dense}
      className={`min-w-0 ${SPAN_CLASS[span]} ${rowSpan2 ? '@min-[600px]:row-span-2' : ''} ${stretch ? 'self-stretch' : ''} flex flex-col ${className}`}
    >
      {(eyebrow || title) && (
        // h3: the page outline is H1 Settings › H2 category › H3 card
        <div className="mb-3 flex min-h-6 items-center gap-2">
          {icon && <Icon name={icon} size={16} className="text-text-faint" />}
          <h3 id={headingId} className={eyebrow ? 'type-micro text-text-faint' : 'type-title text-text'}>
            {eyebrow ?? title}
          </h3>
          {action && <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div>}
        </div>
      )}
      {children}
    </Card>
  )
}

// ───────────────────────────── rows ─────────────────────────────

interface SettingRowProps {
  label: ReactNode
  description?: ReactNode
  /** id for the description (aria-describedby on the control) */
  descriptionId?: string
  control: ReactNode
  /** commit key whose "Saved" shows next to the control */
  savedKey?: string
  /** dims the text (the control disables itself) */
  muted?: boolean
  /** id for the label (aria-labelledby) */
  labelId?: string
}

/** label + description on the left, control on the right (toggles, small selects, buttons). */
export function SettingRow({ label, description, descriptionId, control, savedKey, muted, labelId }: SettingRowProps): JSX.Element {
  return (
    <div className="flex min-h-8 items-center justify-between gap-4">
      <div className={`min-w-0 ${muted ? 'opacity-50' : ''} transition-opacity duration-150`}>
        <p id={labelId} className="type-body font-medium text-text">
          {label}
        </p>
        {description && (
          <p id={descriptionId} className="mt-0.5 max-w-[68ch] type-caption text-text-dim">
            {description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {savedKey && <Saved k={savedKey} />}
        {control}
      </div>
    </div>
  )
}

interface SliderRowProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  /** the value in Plex Mono at the top right */
  format: (v: number) => string
  /** spoken value (defaults to format) */
  valueText?: (v: number) => string
  onCommit: (v: number) => void
  savedKey?: string
  description?: ReactNode
  disabled?: boolean
  notches?: boolean
  startLabel?: string
  endLabel?: string
}

/** Quiet time after the last slider step before it is stored (keyboard, slow drags). */
const SLIDER_SETTLE_MS = 150

/**
 * Label + value on one line, the slider full width beneath. The thumb and value move
 * locally on every step; the value is stored when the drag ends (pointer up / lost
 * capture), when a key is released, or after 150 ms without a change — not once per
 * step, which would re-render Settings and the detector for every notch. A slow round
 * trip never yanks the thumb back mid-drag.
 */
export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  valueText,
  onCommit,
  savedKey,
  description,
  disabled,
  notches,
  startLabel,
  endLabel
}: SliderRowProps): JSX.Element {
  const [draft, setDraft] = useState(value)
  const dragging = useRef(false)
  const pending = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCommitRef = useRef(onCommit)
  const descId = useId()
  useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])
  useEffect(() => {
    if (!dragging.current && pending.current === null) setDraft(value)
  }, [value])

  const flush = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const v = pending.current
    pending.current = null
    if (v !== null) onCommitRef.current(v)
  }, [])
  const endDrag = (): void => {
    dragging.current = false
    flush()
  }
  // a change still waiting when the row unmounts (category switch) is stored, not lost
  useEffect(() => flush, [flush])
  return (
    <div className={`flex flex-col gap-1.5 ${disabled ? 'opacity-50' : ''} transition-opacity duration-150`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="type-body font-medium text-text">{label}</span>
        <span className="flex items-baseline gap-3">
          {savedKey && <Saved k={savedKey} />}
          <span className="type-value text-text">{format(draft)}</span>
        </span>
      </div>
      <div
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyUp={flush}
        onBlur={flush}
      >
        <Slider
          ariaLabel={label}
          value={draft}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          notches={notches}
          startLabel={startLabel}
          endLabel={endLabel}
          valueText={valueText ?? format}
          describedBy={description ? descId : undefined}
          onChange={(v) => {
            setDraft(v)
            pending.current = v
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(flush, SLIDER_SETTLE_MS)
          }}
        />
      </div>
      {description && (
        <p id={descId} className="max-w-[68ch] type-caption text-text-dim">
          {description}
        </p>
      )}
    </div>
  )
}

/** A hairline between groups of rows inside a card (16 px above and below). */
export function GroupDivider(): JSX.Element {
  return <hr className="my-1 border-0 border-t border-white/[0.06]" />
}

/** A caption footer pinned to the card's bottom edge. */
export function CardFooter({ children }: { children: ReactNode }): JSX.Element {
  return <p className="mt-auto pt-4 type-caption text-text-faint">{children}</p>
}
