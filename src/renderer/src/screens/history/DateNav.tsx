// History date navigator (ui-v3 §5.1): ‹ · label (opens a 2-week mini calendar) · ›.

import { useRef, useState, type JSX } from 'react'
import type { DaySummary } from '@shared/stats'
import { IconButton, Popover, Tooltip, focusRing } from '@renderer/components/primitives'
import { Icon } from '@renderer/components/icons'
import { BAND_COLOR } from '@renderer/lib/score'
import { fmtDate, fmtDayLabel, parseDateKey } from '@renderer/lib/format'
import { addDays, alignedPct, pctBand, weekKeys, weekLabel, weekStart, weekdayShort } from './history'
import type { HistoryView } from '@renderer/state/store'

interface DateNavProps {
  view: HistoryView
  date: string
  today: string
  earliest: string
  byDate: ReadonlyMap<string, DaySummary>
  onChange: (key: string) => void
  compact?: boolean
}

export function canStep(view: HistoryView, date: string, today: string, earliest: string, dir: -1 | 1): boolean {
  if (view === 'day') return dir < 0 ? date > earliest : date < today
  return dir < 0 ? weekStart(date) > earliest : weekStart(date) < weekStart(today)
}

/** The date one step back / forward (a day or a week), clamped to [earliest, today]. */
export function stepDate(view: HistoryView, date: string, today: string, earliest: string, dir: -1 | 1): string {
  const next = addDays(date, view === 'day' ? dir : 7 * dir)
  if (next > today) return today
  if (next < earliest) return earliest
  return next
}

/** Narrow windows keep the relative word and drop only the weekday: `Today, 5 Oct` · `Yesterday, 4 Oct` · `Fri 2 Oct`. */
function compactDayLabel(date: string, today: string): string {
  const d = parseDateKey(date)
  if (!d) return fmtDate(date)
  const dayMonth = `${d.getDate()} ${monthShort.format(d).replace(/\.$/, '')}`
  if (date === today) return `Today, ${dayMonth}`
  if (date === addDays(today, -1)) return `Yesterday, ${dayMonth}`
  return fmtDate(date)
}

export default function DateNav({ view, date, today, earliest, byDate, onChange, compact }: DateNavProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const label = view === 'day' ? (compact ? compactDayLabel(date, today) : fmtDayLabel(date)) : weekLabel(date)
  const unit = view === 'day' ? 'day' : 'week'
  const back = canStep(view, date, today, earliest, -1)
  const fwd = canStep(view, date, today, earliest, 1)

  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        icon="chevron-left"
        label={`Previous ${unit}`}
        tooltip={`Previous ${unit} (←)`}
        tooltipPlacement="bottom"
        size={28}
        disabled={!back}
        onClick={() => onChange(stepDate(view, date, today, earliest, -1))}
      />
      <Tooltip content="Pick a day" placement="bottom">
        <button
          ref={anchor}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-[10px] px-2.5 ${compact ? 'min-w-[136px]' : 'min-w-[168px]'} type-body whitespace-nowrap text-text transition-colors duration-150 hover:bg-white/[0.06] ${
            open ? 'bg-white/[0.06]' : ''
          } ${focusRing('ink')}`}
        >
          <Icon name="calendar" size={14} className="text-text-faint" />
          <span>{label}</span>
        </button>
      </Tooltip>
      <IconButton
        icon="chevron-right"
        label={`Next ${unit}`}
        tooltip={`Next ${unit} (→)`}
        tooltipPlacement="bottom"
        size={28}
        disabled={!fwd}
        onClick={() => onChange(stepDate(view, date, today, earliest, 1))}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="bottom" align="end" ariaLabel="Pick a day">
        <MiniCalendar
          view={view}
          date={date}
          today={today}
          earliest={earliest}
          byDate={byDate}
          onPick={(k) => {
            onChange(k)
            setOpen(false)
            anchor.current?.focus()
          }}
        />
      </Popover>
    </div>
  )
}

const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const monthShort = new Intl.DateTimeFormat(undefined, { month: 'short' })

/** `September 2026`, or `Sep – Oct 2026` when the two weeks span two months. */
function calendarTitle(firstKey: string, lastKey: string): string {
  const a = parseDateKey(firstKey)
  const b = parseDateKey(lastKey)
  if (!a || !b) return ''
  if (a.getMonth() === b.getMonth()) return monthYear.format(b)
  const m = (d: Date): string => monthShort.format(d).replace(/\.$/, '')
  return a.getFullYear() === b.getFullYear() ? `${m(a)} – ${m(b)} ${b.getFullYear()}` : `${m(a)} ${a.getFullYear()} – ${m(b)} ${b.getFullYear()}`
}

function MiniCalendar({
  view,
  date,
  today,
  earliest,
  byDate,
  onPick
}: {
  view: HistoryView
  date: string
  today: string
  earliest: string
  byDate: ReadonlyMap<string, DaySummary>
  onPick: (key: string) => void
}): JSX.Element {
  // two weeks: the selected week and the one before it; paged two weeks at a time
  const [lastMonday, setLastMonday] = useState(() => weekStart(date))
  const firstMonday = addDays(lastMonday, -7)
  const weeks = [weekKeys(firstMonday), weekKeys(lastMonday)]
  const canBack = firstMonday > weekStart(earliest)
  const canFwd = lastMonday < weekStart(today)
  const selectedWeek = weekStart(date)
  const title = calendarTitle(firstMonday, addDays(lastMonday, 6))

  return (
    <div className="w-[264px] p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <IconButton icon="chevron-left" label="Earlier" size={28} ringOn="card-2" disabled={!canBack} onClick={() => setLastMonday(addDays(lastMonday, -14))} />
        <span className="type-body font-medium text-text">{title}</span>
        <IconButton icon="chevron-right" label="Later" size={28} ringOn="card-2" disabled={!canFwd} onClick={() => setLastMonday(addDays(lastMonday, 14))} />
      </div>
      <div aria-hidden className="mb-1 grid grid-cols-7 gap-1">
        {weeks[0].map((k) => (
          <span key={k} className="text-center type-micro text-[10px] text-text-faint">
            {weekdayShort(k).slice(0, 2)}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {weeks.map((keys) => {
          const weekSelected = view === 'week' && keys[0] === selectedWeek
          return (
            <div key={keys[0]} className={`grid grid-cols-7 gap-1 rounded-[10px] ${weekSelected ? 'bg-sage-soft' : ''}`}>
              {keys.map((k) => {
                const d = byDate.get(k)
                const disabled = k > today || k < earliest
                const selected = view === 'day' && k === date
                const pct = d ? alignedPct(d.goodMinutes, d.trackedMinutes) : null
                const band = pctBand(pct)
                const tracked = (d?.trackedMinutes ?? 0) > 0
                const num = parseDateKey(k)?.getDate() ?? ''
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={disabled}
                    onClick={() => onPick(k)}
                    aria-label={`${fmtDate(k)}${tracked ? `, ${pct === null ? 'a little tracked' : `${pct}% aligned`}` : ', nothing tracked'}`}
                    aria-current={k === today ? 'date' : undefined}
                    aria-pressed={selected || weekSelected}
                    className={`relative flex h-9 flex-col items-center justify-center rounded-[10px] font-mono text-[12px] tabular-nums transition-colors duration-150 disabled:cursor-default disabled:opacity-35 ${focusRing('card-2')} ${
                      selected ? 'bg-sage-soft text-sage ring-1 ring-sage/50' : 'text-text-dim enabled:hover:bg-white/[0.06] enabled:hover:text-text'
                    } ${k === today ? 'font-semibold text-text' : ''}`}
                  >
                    {num}
                    <span
                      aria-hidden
                      className="mt-0.5 h-1 w-1 rounded-full"
                      style={{ backgroundColor: tracked ? (band ? BAND_COLOR[band] : 'var(--color-text-faint)') : 'transparent' }}
                    />
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      <p className="mt-2 px-1 type-caption text-text-faint">Dots mark days with data, colored by how aligned you were.</p>
    </div>
  )
}
