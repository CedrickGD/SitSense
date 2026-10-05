// History charts (docs/specs/ui-v3.md §5): the day timeline, the by-hour heat strip, the
// week × hour heat grid, the by-issue stacked bars and the week's days chart.
// Inline SVG / plain elements only; colors come from the stage palette and the score bands.
// (Page-local stand-ins for the spec's components/Timeline, HeatStrip, HeatGrid, StackedBar.)

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { DaySummary, HourBucket, StageMinutes } from '@shared/stats'
import { Tooltip, focusRing } from '@renderer/components/primitives'
import { BAND_COLOR } from '@renderer/lib/score'
import { DASH, fmtClock, fmtDate, fmtMinutes, parseDateKey } from '@renderer/lib/format'
import {
  alignedPct,
  bestWorstHours,
  hh,
  hourCells,
  hourRange,
  hourTicks,
  hourTooltip,
  ISSUE_SHORT,
  pctBand,
  segmentLabel,
  stageSplitText,
  stageTotals,
  weekdayShort,
  type HourCell,
  type IssueRow,
  type SegmentKind,
  type TimelineSegment
} from './history'

// ───────────────────────────── palette ─────────────────────────────

export const SEG_COLOR: Record<Exclude<SegmentKind, 'idle' | 'break'>, string> = {
  good: 'var(--color-sage-deep)',
  slight: 'var(--color-amber)',
  clear: 'var(--color-ember)',
  severe: 'var(--color-coral)'
}

const STAGE_FILL: readonly string[] = [SEG_COLOR.slight, SEG_COLOR.clear, SEG_COLOR.severe]

/** "off posture" when the stage isn't known (past days are only summarized per hour) */
const OFF_COLOR = 'color-mix(in srgb, var(--color-ember) 80%, var(--color-card))'

// ───────────────────────────── helpers ─────────────────────────────

function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => setW(entries[0]?.contentRect.width ?? 0))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** Legend swatch (12 px). `dotted` = away / paused; `faint` = an hour column's untracked rest. */
function Swatch({ color, dotted, faint, label }: { color?: string; dotted?: boolean; faint?: boolean; label: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 type-caption text-text-dim">
      {dotted ? (
        <span aria-hidden className="inline-flex h-3 w-3 items-center">
          <span className="w-full border-t-2 border-dotted border-text-faint" />
        </span>
      ) : faint ? (
        <span aria-hidden className="h-3 w-3 rounded-[3px] bg-white/[0.05] ring-1 ring-white/[0.08] ring-inset" />
      ) : (
        <span aria-hidden className="h-3 w-3 rounded-[3px]" style={{ backgroundColor: color }} />
      )}
      {label}
    </span>
  )
}

export function TimelineLegend({ hourly }: { hourly?: boolean }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <Swatch color={SEG_COLOR.good} label="good" />
      {hourly ? (
        <Swatch color={OFF_COLOR} label="off posture" />
      ) : (
        <>
          <Swatch color={SEG_COLOR.slight} label="slight" />
          <Swatch color={SEG_COLOR.clear} label="clear" />
          <Swatch color={SEG_COLOR.severe} label="severe" />
        </>
      )}
      {hourly ? <Swatch faint label="not tracked" /> : <Swatch dotted label="away / paused" />}
    </div>
  )
}

export function StageLegend(): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <Swatch color={SEG_COLOR.slight} label="slight" />
      <Swatch color={SEG_COLOR.clear} label="clear" />
      <Swatch color={SEG_COLOR.severe} label="severe" />
    </div>
  )
}

/** A hover readout positioned over a chart (pointer-only; the chart has an aria-label). */
function HoverTip({ x, width, text }: { x: number; width: number; text: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    setW(ref.current?.getBoundingClientRect().width ?? 0)
  }, [text])
  const left = Math.max(0, Math.min(width - w, x - w / 2))
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute bottom-full z-10 mb-2 whitespace-nowrap surface-popover rounded-[10px] px-2.5 py-1.5 type-caption text-text motion-safe:animate-[menuIn_120ms_ease-out]"
      style={{ left, visibility: w ? 'visible' : 'hidden' }}
    >
      {text}
    </div>
  )
}

/** Hour labels above a strip spanning [from, to) epoch minutes. */
function TickRow({ from, to, width }: { from: number; to: number; width: number }): JSX.Element {
  const span = Math.max(1, to - from)
  const max = Math.max(2, Math.floor(width / 34))
  const ticks = hourTicks(from, to, max)
  return (
    <div aria-hidden className="relative mb-1.5 h-4">
      {ticks.map((t) => {
        const pct = ((t.m - from) / span) * 100
        return (
          <span
            key={t.m}
            className="absolute top-0 -translate-x-1/2 font-mono text-[11px] leading-4 text-text-faint tabular-nums"
            style={{ left: `clamp(8px, ${pct}%, calc(100% - 8px))` }}
          >
            {t.label}
          </span>
        )
      })}
    </div>
  )
}

/** Faint hour gridlines inside a strip. */
function TickLines({ from, to, width }: { from: number; to: number; width: number }): JSX.Element {
  const span = Math.max(1, to - from)
  const ticks = hourTicks(from, to, Math.max(2, Math.floor(width / 34)))
  return (
    <>
      {ticks.map((t) => (
        <span
          key={t.m}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-ink/35"
          style={{ left: `${((t.m - from) / span) * 100}%` }}
        />
      ))}
    </>
  )
}

// ───────────────────────────── minute timeline (today) ─────────────────────────────

const STRIP_H = 28

export function MinuteTimeline({ segments, label }: { segments: TimelineSegment[]; label: string }): JSX.Element {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<{ x: number; seg: TimelineSegment } | null>(null)
  const from = segments[0].from
  const to = segments[segments.length - 1].to
  const span = Math.max(1, to - from)

  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(r.width - 0.001, e.clientX - r.left))
    const m = from + Math.floor((x / r.width) * span)
    const seg = segments.find((s) => m >= s.from && m < s.to)
    setHover(seg ? { x, seg } : null)
  }

  return (
    <div>
      <TickRow from={from} to={to} width={width} />
      <div className="relative">
        <div
          ref={ref}
          role="img"
          aria-label={label}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          className="relative overflow-hidden rounded-md bg-white/[0.025] motion-safe:origin-left motion-safe:animate-[growIn_400ms_ease-out]"
          style={{ height: STRIP_H }}
        >
          <svg width="100%" height={STRIP_H} viewBox={`0 0 ${span} ${STRIP_H}`} preserveAspectRatio="none" aria-hidden className="block">
            {segments.map((s) =>
              s.kind === 'idle' || s.kind === 'break' ? (
                <line
                  key={s.from}
                  x1={s.from - from}
                  x2={s.to - from}
                  y1={STRIP_H / 2}
                  y2={STRIP_H / 2}
                  stroke="var(--color-text-faint)"
                  strokeWidth={2}
                  strokeDasharray="1 4"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <rect key={s.from} x={s.from - from} y={0} width={s.to - s.from} height={STRIP_H} fill={SEG_COLOR[s.kind]} />
              )
            )}
            {hover && (
              <rect
                x={hover.seg.from - from}
                y={0}
                width={hover.seg.to - hover.seg.from}
                height={STRIP_H}
                fill="rgb(255 255 255 / 0.12)"
              />
            )}
          </svg>
          <TickLines from={from} to={to} width={width} />
          {/* labeled breaks, when wide enough */}
          {segments
            .filter((s) => s.kind === 'break' && ((s.to - s.from) / span) * width >= 44)
            .map((s) => {
              const n = s.to - s.from
              const text = (n / span) * width >= 96 ? `break · ${fmtMinutes(n)}` : `${n}m`
              return (
                <span
                  key={`b${s.from}`}
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 flex items-center justify-center"
                  style={{ left: `${((s.from - from) / span) * 100}%`, width: `${(n / span) * 100}%` }}
                >
                  <span className="rounded-full bg-card px-2 type-caption whitespace-nowrap text-text-dim">{text}</span>
                </span>
              )
            })}
        </div>
        {hover && <HoverTip x={hover.x} width={width} text={segmentLabel(hover.seg)} />}
      </div>
    </div>
  )
}

// ───────────────────────────── hourly timeline (past days) ─────────────────────────────

const HOURLY_H = 56

/** Smallest label step (in hours) that keeps hour labels ~34 px apart. */
function labelStep(width: number, n: number): number {
  const col = n > 0 ? width / n : 0
  return [1, 2, 3, 4, 6, 12].find((s) => col * s >= 34) ?? 12
}

/**
 * Past days are only summarized per hour, so the order inside an hour is unknown: one column per
 * hour, good stacked under off posture (height = minutes of the 60), the rest left unfilled.
 */
export function HourlyTimeline({ day, label }: { day: DaySummary; label: string }): JSX.Element {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const h0 = new Date(day.firstActive ?? 0).getHours()
  const h1 = Math.max(h0, new Date(day.lastActive ?? 0).getHours())
  const hours = Array.from({ length: h1 - h0 + 1 }, (_, i) => h0 + i)
  const step = labelStep(width, hours.length)
  const tip = (h: number): string => {
    const b: HourBucket = day.hourly[h] ?? { good: 0, bad: 0 }
    if (b.good + b.bad === 0) return `${hourRange(h)} · nothing tracked`
    return `${hourRange(h)} · ${fmtMinutes(b.good)} good · ${fmtMinutes(b.bad)} off`
  }

  return (
    <div>
      <div ref={ref} role="img" aria-label={label} className="flex gap-[2px]" style={{ height: HOURLY_H }}>
        {hours.map((h) => {
          const b = day.hourly[h] ?? { good: 0, bad: 0 }
          const good = Math.min(60, b.good)
          const bad = Math.min(60 - good, b.bad)
          return (
            <Tooltip key={h} content={tip(h)} delay={80}>
              <span className="group relative flex min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-[4px] bg-white/[0.03]">
                {good > 0 && <span className="w-full shrink-0" style={{ height: `${(good / 60) * 100}%`, backgroundColor: SEG_COLOR.good }} />}
                {bad > 0 && <span className="w-full shrink-0" style={{ height: `${(bad / 60) * 100}%`, backgroundColor: OFF_COLOR }} />}
                <span aria-hidden className="pointer-events-none absolute inset-0 transition-colors duration-150 group-hover:bg-white/[0.08]" />
              </span>
            </Tooltip>
          )
        })}
      </div>
      <div aria-hidden className="mt-1.5 flex gap-[2px]">
        {hours.map((h, i) => (
          <span key={h} className="min-w-0 flex-1 overflow-visible font-mono text-[11px] leading-4 whitespace-nowrap text-text-faint tabular-nums">
            {i % step === 0 ? hh(h) : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

// ───────────────────────────── by hour: heat strip ─────────────────────────────

function cellStyle(c: HourCell): CSSProperties {
  if (!c.hasData || !c.band) return { backgroundColor: 'rgb(255 255 255 / 0.03)' }
  return { backgroundColor: BAND_COLOR[c.band], opacity: c.opacity }
}

const EMPTY_CELL = 'border border-dotted border-white/[0.09]'

/**
 * 24 hour cells (color = aligned band, opacity = activity, §5.1) with a column above each
 * one whose height is the time tracked in that hour — when you sit, and how well.
 * The volume columns grow with the card (min 48 px).
 */
export function HeatStrip({ hourly }: { hourly: readonly HourBucket[] }): JSX.Element {
  const cells = useMemo(() => hourCells(hourly), [hourly])
  return (
    <div className="flex flex-1 flex-col">
      <ul aria-label="Aligned share and time tracked by hour" className="flex flex-1 gap-[3px]">
        {cells.map((c) => (
          <Tooltip key={c.hour} content={hourTooltip(c)} delay={80}>
            <li
              tabIndex={c.hasData ? 0 : -1}
              aria-label={hourTooltip(c)}
              className={`group flex min-w-0 flex-1 flex-col gap-[3px] rounded-[4px] ${focusRing('card')}`}
            >
              <span aria-hidden className="flex min-h-12 flex-1 items-end">
                <span
                  className="w-full rounded-t-[3px] bg-white/[0.09] transition-colors duration-150 group-hover:bg-white/[0.16] group-focus-visible:bg-white/[0.16]"
                  style={{ height: c.hasData ? `max(2px, ${(Math.min(60, c.active) / 60) * 100}%)` : 0 }}
                />
              </span>
              <span aria-hidden className={`h-7 rounded-[4px] ${c.hasData ? '' : EMPTY_CELL}`} style={cellStyle(c)} />
            </li>
          </Tooltip>
        ))}
      </ul>
      <div aria-hidden className="mt-1.5 flex gap-[3px]">
        {cells.map((c) => (
          <span key={c.hour} className="min-w-0 flex-1 overflow-visible font-mono text-[11px] leading-4 whitespace-nowrap text-text-faint tabular-nums">
            {c.hour % 3 === 0 ? hh(c.hour) : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Band legend for the heat cells: aligned · drifting · strained · poor. */
export function BandLegend(): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <Swatch color={BAND_COLOR.aligned} label="85%+" />
      <Swatch color={BAND_COLOR.drifting} label="65–84%" />
      <Swatch color={BAND_COLOR.strained} label="40–64%" />
      <Swatch color={BAND_COLOR.poor} label="under 40%" />
    </div>
  )
}

// ───────────────────────────── week × hour heat grid ─────────────────────────────

/** Screen-reader summary of one week-grid row: `Mo: 8h 03m tracked, best 10–11`. */
function rowSummary(d: DaySummary, cells: readonly HourCell[], future: boolean): string {
  const day = weekdayShort(d.date)
  if (future) return `${day}: later this week`
  if (d.trackedMinutes === 0) return `${day}: nothing tracked`
  const { best } = bestWorstHours(cells)
  return `${day}: ${fmtMinutes(d.trackedMinutes)} tracked${best !== null ? `, best ${hh(best)}–${hh(best + 1)}` : ''}`
}

export function HeatGrid({ days, todayKey, onPickDay }: { days: DaySummary[]; todayKey: string; onPickDay: (key: string) => void }): JSX.Element {
  const rows = useMemo(() => days.map((d) => ({ d, cells: hourCells(d.hourly) })), [days])
  return (
    <div className="flex flex-col gap-[3px]">
      <div aria-hidden className="flex items-center gap-2">
        <span className="w-9 shrink-0" />
        <div className="flex min-w-0 flex-1 gap-[2px]">
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="min-w-0 flex-1 overflow-visible font-mono text-[11px] leading-4 whitespace-nowrap text-text-faint tabular-nums">
              {h % 3 === 0 ? hh(h) : ''}
            </span>
          ))}
        </div>
      </div>
      {rows.map(({ d, cells }) => {
        const isToday = d.date === todayKey
        const future = d.date > todayKey
        return (
          <div key={d.date} className="flex items-center gap-2">
            <button
              type="button"
              disabled={future}
              onClick={() => onPickDay(d.date)}
              aria-label={`Open ${fmtDate(d.date)}`}
              className={`w-9 shrink-0 rounded-md text-left type-caption transition-colors duration-150 enabled:hover:text-text disabled:cursor-default ${focusRing('card')} ${
                isToday ? 'font-medium text-text' : future ? 'text-text-faint/60' : 'text-text-dim'
              }`}
            >
              {weekdayShort(d.date)}
            </button>
            <ul aria-label={rowSummary(d, cells, future)} className="flex min-w-0 flex-1 gap-[2px]">
              {cells.map((c) => {
                const text = `${weekdayShort(d.date)} · ${hourTooltip(c)}`
                return (
                  <Tooltip key={c.hour} content={future ? null : text} delay={80}>
                    <li
                      aria-label={text}
                      className={`h-3.5 min-w-0 flex-1 rounded-[3px] ${c.hasData ? '' : future ? '' : EMPTY_CELL}`}
                      style={future ? { backgroundColor: 'rgb(255 255 255 / 0.015)' } : cellStyle(c)}
                    />
                  </Tooltip>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

// ───────────────────────────── by issue: stacked bars ─────────────────────────────

function StackedBar({ stages, max }: { stages: StageMinutes; max: number }): JSX.Element {
  const total = stages[0] + stages[1] + stages[2]
  const pct = max > 0 ? (total / max) * 100 : 0
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
      {total > 0 && (
        <div
          className="flex h-full overflow-hidden rounded-full motion-safe:origin-left motion-safe:animate-[growIn_400ms_ease-out]"
          style={{ width: `${pct}%`, minWidth: 4 }}
        >
          {stages.map((m, i) =>
            m > 0 ? <span key={i} className="h-full" style={{ width: `${(m / total) * 100}%`, backgroundColor: STAGE_FILL[i] }} /> : null
          )}
        </div>
      )}
    </div>
  )
}

export function IssueBars({ rows }: { rows: IssueRow[] }): JSX.Element {
  const max = Math.max(0, ...rows.map((r) => r.total))
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => {
        const zero = r.total === 0
        const split = stageSplitText(r.stages)
        return (
          <li key={r.issue} className="grid grid-cols-[112px_minmax(0,1fr)_64px] items-center gap-3">
            <span className={`truncate type-body ${zero ? 'text-text-faint' : 'text-text'}`}>{ISSUE_SHORT[r.issue]}</span>
            <Tooltip content={zero ? null : split} delay={120}>
              <span
                role="img"
                tabIndex={zero ? -1 : 0}
                aria-label={`${ISSUE_SHORT[r.issue]}: ${fmtMinutes(r.total)} — ${split}`}
                className={`flex h-6 items-center rounded-md ${focusRing('card')}`}
              >
                <StackedBar stages={r.stages} max={max} />
              </span>
            </Tooltip>
            <span className={`text-right type-value ${zero ? 'text-text-faint' : 'text-text-dim'}`}>{fmtMinutes(r.total)}</span>
          </li>
        )
      })}
    </ul>
  )
}

// ───────────────────────────── week: days chart ─────────────────────────────

const DAYS_H = 112

export function DaysChart({ days, todayKey, onPickDay }: { days: DaySummary[]; todayKey: string; onPickDay: (key: string) => void }): JSX.Element {
  const max = Math.max(1, ...days.map((d) => d.trackedMinutes))
  return (
    <div className="relative">
      {/* baseline */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 h-px bg-white/[0.08]" style={{ top: 28 + DAYS_H }} />
      <ul className="grid grid-cols-7 gap-2">
        {days.map((d) => {
          const future = d.date > todayKey
          const isToday = d.date === todayKey
          const pct = alignedPct(d.goodMinutes, d.trackedMinutes)
          const band = pctBand(pct)
          const has = d.trackedMinutes > 0
          const [slight, clear, severe] = stageTotals(d)
          const segs = [
            { m: d.goodMinutes, c: SEG_COLOR.good },
            { m: slight, c: SEG_COLOR.slight },
            { m: clear, c: SEG_COLOR.clear },
            { m: severe, c: SEG_COLOR.severe }
          ]
          const barH = has ? Math.max(4, (d.trackedMinutes / max) * DAYS_H) : 0
          const date = parseDateKey(d.date)
          const label = future
            ? `${fmtDate(d.date)} — later this week`
            : has
              ? `${fmtDate(d.date)}: ${fmtMinutes(d.trackedMinutes)} tracked, ${pct === null ? 'too little to tell' : `${pct}% aligned`}. Open this day.`
              : `${fmtDate(d.date)}: nothing tracked. Open this day.`
          return (
            <li key={d.date} className="min-w-0">
              <Tooltip content={future ? null : has ? `${fmtDate(d.date)} · ${fmtMinutes(d.trackedMinutes)} · ${pct === null ? DASH : `${pct}% aligned`}` : `${fmtDate(d.date)} · nothing tracked`} delay={150}>
                <button
                  type="button"
                  disabled={future}
                  onClick={() => onPickDay(d.date)}
                  aria-label={label}
                  className={`group flex w-full flex-col items-center rounded-xl pb-2 transition-colors duration-150 enabled:hover:bg-white/[0.03] disabled:cursor-default ${focusRing('card')}`}
                >
                  <span
                    className={`flex h-7 items-center font-mono text-[13px] tabular-nums ${band ? '' : 'text-text-faint'}`}
                    style={band ? { color: BAND_COLOR[band] } : undefined}
                  >
                    {future ? '' : pct === null ? DASH : `${pct}%`}
                  </span>
                  <span className="flex w-full items-end justify-center" style={{ height: DAYS_H }}>
                    {has ? (
                      <span
                        className="flex w-full max-w-10 flex-col-reverse overflow-hidden rounded-t-md rounded-b-[3px] motion-safe:animate-[fadeIn_300ms_ease-out] group-enabled:group-hover:brightness-110"
                        style={{ height: barH }}
                      >
                        {segs.map((s, i) => (s.m > 0 ? <span key={i} style={{ height: `${(s.m / d.trackedMinutes) * 100}%`, backgroundColor: s.c }} /> : null))}
                      </span>
                    ) : !future ? (
                      <span aria-hidden className="mb-0 h-1 w-full max-w-10 border-t-2 border-dotted border-text-faint/70" />
                    ) : null}
                  </span>
                  <span className={`mt-2.5 flex flex-col items-center gap-0.5 ${future ? 'opacity-50' : ''}`}>
                    <span className={`type-caption ${isToday ? 'font-medium text-text' : 'text-text-dim'}`}>{weekdayShort(d.date)}</span>
                    <span className="font-mono text-[11px] leading-4 text-text-faint tabular-nums">{date ? date.getDate() : ''}</span>
                    <span aria-hidden className={`h-0.5 w-5 rounded-full ${isToday ? 'bg-sage' : 'bg-transparent'}`} />
                  </span>
                </button>
              </Tooltip>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Clock span "08:12–17:40" of a day, or "—". */
export function daySpan(d: Pick<DaySummary, 'firstActive' | 'lastActive'>): string {
  if (d.firstActive === null || d.lastActive === null) return DASH
  return `${fmtClock(d.firstActive)}–${fmtClock(d.lastActive + 60_000)}`
}
