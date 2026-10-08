// History (docs/specs/ui-v3.md §5): "How did I do?" — Day and Week views.
// Data: window.sitsense.getStatsRange(90) (+ getTodayStats for today's minute timeline).
// Maths in screens/history/history.ts (unit-tested); charts in screens/history/charts.tsx.

import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { STREAK_MIN_TRACKED_MINUTES, type DaySummary } from '@shared/stats'
import { useAppStore } from '@renderer/state/store'
import { TopBarContent } from '@renderer/components/AppShell'
import { Banner, Button, Card, CardHeader, EmptyState, SegmentedControl, Skeleton, StatTile } from '@renderer/components/primitives'
import { fmtDate, fmtMinutes, plural } from '@renderer/lib/format'
import { useNow, useWindowWidth } from '@renderer/lib/hooks'
import {
  addDays,
  alignedPct,
  anyTracked,
  bestWorstHours,
  buildTimeline,
  dayFor,
  dayKpis,
  DEFAULT_BREAK_MINUTES,
  hh,
  hourCells,
  issueRows,
  previousKeys,
  sittingStretches,
  streakKpi,
  sumDays,
  todayKey as keyOfToday,
  weekKeys,
  weekKpis,
  weekLabel,
  type Kpi
} from './history/history'
import {
  BandLegend,
  DaysChart,
  daySpan,
  HeatGrid,
  HeatStrip,
  HourlyTimeline,
  IssueBars,
  MinuteTimeline,
  StageLegend,
  TimelineLegend
} from './history/charts'
import DateNav, { canStep, stepDate } from './history/DateNav'
import { useHistoryData } from './history/useHistoryData'

/** Bottom-row cards sit side by side once the content column is this wide. */
const TWO_COL = '@[880px]:grid-cols-2'
/**
 * Day view: the bottom row takes the window's spare height (the hour bars use it), but only
 * up to the cap — on a tall window the bars would tower and By issue would be mostly empty
 * card. Past the cap the page simply ends (single column stacks and scrolls: no cap there).
 */
const BOTTOM_ROW = `grid flex-1 gap-4 ${TWO_COL} @[880px]:max-h-[440px]`
/** Week view: the week × hour grid has a fixed size, so the row keeps its natural height. */
const BOTTOM_ROW_WEEK = `grid gap-4 ${TWO_COL}`

export default function HistoryScreen(): JSX.Element {
  const view = useAppStore((s) => s.historyView)
  const setView = useAppStore((s) => s.setHistoryView)
  const setRoute = useAppStore((s) => s.setRoute)
  const openSetup = useAppStore((s) => s.openSetup)
  const settingsLoaded = useAppStore((s) => s.settings !== null)
  const calibrated = useAppStore((s) => !!s.settings?.calibration)
  const everyMinutes = useAppStore((s) => s.settings?.breaks?.intervalMinutes ?? 50)
  const compact = useWindowWidth() < 1000

  const now = useNow(60_000)
  const today = keyOfToday(now)
  const [date, setDate] = useState(today)
  // the day rolled over while the page was open and "today" was selected → follow it
  const [lastToday, setLastToday] = useState(today)
  if (lastToday !== today) {
    setLastToday(today)
    if (date === lastToday) setDate(today)
  }

  const { range, today: todayLog, loading, error, reload } = useHistoryData()
  const byDate = useMemo(() => new Map((range?.days ?? []).map((d) => [d.date, d])), [range])
  // the first day with data — getStatsRange returns every day of the window, tracked or not
  const earliest = range?.days.find((d) => d.trackedMinutes > 0)?.date ?? today
  const hasAny = range ? anyTracked(range.days) : false

  // ← / → step the date (not while typing or inside a radio group / dialog)
  useEffect(() => {
    if (!hasAny) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="radiogroup"], [role="dialog"], [role="menu"], [role="slider"]')) return
      if (useAppStore.getState().setupFlow.open) return
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      if (!canStep(view, date, today, earliest, dir)) return
      e.preventDefault()
      setDate(stepDate(view, date, today, earliest, dir))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasAny, view, date, today, earliest])

  const pickDay = (key: string): void => {
    setDate(key)
    setView('day')
  }

  return (
    <div className="@container flex flex-1 flex-col gap-4">
      <TopBarContent>
        {hasAny && (
          <>
            <SegmentedControl
              size="sm"
              ariaLabel="History range"
              value={view}
              onChange={setView}
              options={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' }
              ]}
            />
            <span aria-hidden className="mx-1.5 h-4 w-px bg-white/[0.08]" />
            <DateNav view={view} date={date} today={today} earliest={earliest} byDate={byDate} onChange={setDate} compact={compact} />
          </>
        )}
      </TopBarContent>

      {settingsLoaded && hasAny && !calibrated && (
        <Banner
          tone="slate"
          icon="setup"
          actions={
            <Button size="sm" variant="secondary" icon="setup" onClick={() => openSetup('history')}>
              Set up posture
            </Button>
          }
        >
          History only counts time after posture setup.
        </Banner>
      )}

      {loading ? (
        <HistorySkeleton />
      ) : error ? (
        <Card className="flex flex-1 items-center justify-center">
          <EmptyState
            icon="alert"
            headline="Couldn't load your history."
            body="The history files on this PC couldn't be read just now. Try again in a moment."
            secondary={
              <Button variant="secondary" icon="refresh" onClick={reload}>
                Retry
              </Button>
            }
          />
        </Card>
      ) : (!hasAny || !range) && settingsLoaded && !calibrated ? (
        <Card className="flex flex-1 items-center justify-center">
          <EmptyState
            className="[&_p]:max-w-[54ch]"
            icon="setup"
            headline="Set up posture to start your history"
            body="SitSense only logs time once it knows your good posture. Setup takes about a minute."
            primary={
              <Button variant="primary" icon="setup" onClick={() => openSetup('history')}>
                Set up posture
              </Button>
            }
          />
        </Card>
      ) : !hasAny || !range ? (
        <Card className="flex flex-1 items-center justify-center">
          <EmptyState
            className="[&_p]:max-w-[54ch]"
            icon="history"
            headline="Your history starts today"
            body="SitSense logs one tiny line per minute — good, slouching, away. Come back after a few hours at your desk."
            secondary={
              <Button variant="ghost" icon="live" onClick={() => setRoute('live')}>
                Go to Live
              </Button>
            }
          />
        </Card>
      ) : view === 'day' ? (
        <DayView
          day={dayFor(byDate, date)}
          previous={previousKeys(date).map((k) => dayFor(byDate, k))}
          minuteLog={date === today && todayLog?.date === today ? todayLog.minutes : null}
          isToday={date === today}
          everyMinutes={everyMinutes}
          streak={streakKpi(range.streak)}
        />
      ) : (
        <WeekView
          days={weekKeys(date).map((k) => dayFor(byDate, k))}
          previousWeek={weekKeys(addDays(date, -7)).map((k) => dayFor(byDate, k))}
          today={today}
          streak={streakKpi(range.streak)}
          onPickDay={pickDay}
        />
      )}
    </div>
  )
}

// ───────────────────────────── KPI row ─────────────────────────────

const KPI_SPAN = ['col-span-2', 'col-span-2', 'col-span-2', 'col-span-3', 'col-span-3']

/** "8h 03m" → numbers at h2, units smaller and dimmer (keeps wide totals inside the tile). */
function KpiValue({ text }: { text: string }): JSX.Element {
  const parts = text.match(/\d[\d.,]*|[^\d]+/g) ?? [text]
  return (
    <span>
      <span className="sr-only">{text}</span>
      {parts.map((p, i) =>
        /^\d/.test(p) || p === '—' ? (
          <span key={i} aria-hidden>
            {p}
          </span>
        ) : (
          <span key={i} aria-hidden className="text-[0.62em] font-medium tracking-normal text-text-dim">
            {p}
          </span>
        )
      )}
    </span>
  )
}

function KpiRow({ tiles }: { tiles: { eyebrow: string; kpi: Kpi; info?: string }[] }): JSX.Element {
  return (
    <div className="grid grid-cols-6 gap-4 @[720px]:grid-cols-5">
      {tiles.map((t, i) => (
        <StatTile
          key={t.eyebrow}
          eyebrow={t.eyebrow}
          value={<KpiValue text={t.kpi.value} />}
          sub={t.kpi.sub || ' '}
          subTone={t.kpi.tone}
          muted={t.kpi.muted}
          className={`${KPI_SPAN[i]} @[720px]:col-span-1`}
        />
      ))}
    </div>
  )
}

/** A card whose body is dimmed on a day without data (the header stays readable). */
function ChartCard({
  eyebrow,
  action,
  muted,
  children,
  footer,
  className = ''
}: {
  eyebrow: string
  action?: ReactNode
  muted?: boolean
  children: ReactNode
  footer?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <Card className={`flex min-w-0 flex-col ${className}`} aria-label={eyebrow.toLowerCase()}>
      <CardHeader eyebrow={eyebrow} action={action} />
      <div className={`flex flex-1 flex-col transition-opacity duration-150 ${muted ? 'opacity-45' : ''}`}>{children}</div>
      {footer && <div className="mt-4 border-t border-white/[0.06] pt-3">{footer}</div>}
    </Card>
  )
}

const caption = (text: ReactNode): JSX.Element => <span className="type-caption text-text-faint">{text}</span>
const mono = (text: ReactNode): JSX.Element => <span className="type-value text-[12px] text-text-faint">{text}</span>

// ───────────────────────────── Day view ─────────────────────────────

function DayView({
  day,
  previous,
  minuteLog,
  isToday,
  everyMinutes,
  streak
}: {
  day: DaySummary
  previous: DaySummary[]
  minuteLog: Parameters<typeof buildTimeline>[0] | null
  isToday: boolean
  everyMinutes: number
  streak: Kpi
}): JSX.Element {
  const segments = useMemo(() => (minuteLog ? buildTimeline(minuteLog, DEFAULT_BREAK_MINUTES) : null), [minuteLog])
  const stretches = useMemo(() => (segments && segments.length > 0 ? sittingStretches(segments) : null), [segments])
  const k = dayKpis({ day, previous, stretches, everyMinutes, isToday })
  const muted = day.trackedMinutes === 0
  const rows = issueRows(day)
  const offTotal = rows.reduce((n, r) => n + r.total, 0)
  const cells = useMemo(() => hourCells(day.hourly), [day.hourly])
  const { best, worst } = bestWorstHours(cells)
  const minuteMode = !!segments && segments.length > 0
  const name = fmtDate(day.date)

  const timelineLabel = `Posture timeline for ${name}, ${daySpan(day)}: ${fmtMinutes(day.goodMinutes)} good, ${fmtMinutes(
    day.trackedMinutes - day.goodMinutes
  )} off posture, ${plural(day.breaksTaken, 'break')}.`

  return (
    <div className="flex flex-1 flex-col gap-4">
      <KpiRow
        tiles={[
          { eyebrow: 'Aligned', kpi: k.aligned },
          { eyebrow: 'Sitting', kpi: k.sitting },
          { eyebrow: 'Breaks', kpi: k.breaks },
          { eyebrow: 'Nudges', kpi: k.nudges },
          { eyebrow: 'Streak', kpi: streak }
        ]}
      />

      <ChartCard
        eyebrow="Timeline"
        action={!muted ? mono(minuteMode ? daySpan(day) : `${plural(day.breaksTaken, 'break')} · ${plural(day.alertsCount, 'nudge')}`) : undefined}
        footer={
          !muted ? (
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <TimelineLegend hourly={!minuteMode} />
              {!minuteMode && caption('Shown hour by hour for past days.')}
            </div>
          ) : undefined
        }
      >
        {muted ? (
          <div className="flex min-h-[72px] items-center justify-center rounded-xl border border-dashed border-white/[0.08] px-4">
            <p className="type-body text-text-dim">
              {isToday ? 'Nothing tracked yet today — your day fills in while SitSense watches.' : `Nothing tracked on ${name}.`}
            </p>
          </div>
        ) : minuteMode && segments ? (
          <MinuteTimeline segments={segments} label={timelineLabel} />
        ) : (
          <HourlyTimeline day={day} label={timelineLabel} />
        )}
      </ChartCard>

      <div className={BOTTOM_ROW}>
        <ChartCard
          eyebrow="By issue"
          muted={muted}
          action={!muted ? mono(offTotal > 0 ? `${fmtMinutes(offTotal)} off` : 'all good') : undefined}
          footer={<StageLegend />}
        >
          <IssueBars rows={rows} />
        </ChartCard>
        <ChartCard
          eyebrow="By hour"
          muted={muted}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <BandLegend />
              {best !== null ? (
                <span className="type-caption text-text-dim">
                  best hour <span className="type-value text-[12px] text-sage">{`${hh(best)}–${hh(best + 1)}`}</span>
                  {worst !== null && (
                    <>
                      {' · '}worst <span className="type-value text-[12px] text-amber">{`${hh(worst)}–${hh(worst + 1)}`}</span>
                    </>
                  )}
                </span>
              ) : (
                !muted && caption('Best and worst hours show after 15 min in an hour.')
              )}
            </div>
          }
        >
          <div className="flex flex-1 flex-col">
            <HeatStrip hourly={day.hourly} />
          </div>
        </ChartCard>
      </div>
    </div>
  )
}

// ───────────────────────────── Week view ─────────────────────────────

function WeekView({
  days,
  previousWeek,
  today,
  streak,
  onPickDay
}: {
  days: DaySummary[]
  previousWeek: DaySummary[]
  today: string
  streak: Kpi
  onPickDay: (key: string) => void
}): JSX.Element {
  const k = weekKpis(days, previousWeek)
  const sum = useMemo(() => sumDays(days), [days])
  const muted = sum.trackedMinutes === 0
  const rows = issueRows(sum)
  const offTotal = rows.reduce((n, r) => n + r.total, 0)
  // a few minutes at 100% must not beat a full day: only days long enough to count for the streak
  const ranked = days
    .filter((d) => d.trackedMinutes >= STREAK_MIN_TRACKED_MINUTES)
    .map((d) => ({ d, pct: alignedPct(d.goodMinutes, d.trackedMinutes) ?? 0 }))
    .sort((a, b) => b.pct - a.pct || b.d.trackedMinutes - a.d.trackedMinutes)
  const bestDay = ranked.length > 1 ? ranked[0].d : null
  const emptyText = weekKeys(days[0].date).includes(today) ? 'Nothing tracked this week yet.' : `Nothing tracked ${weekLabel(days[0].date)}.`

  return (
    <div className="flex flex-1 flex-col gap-4">
      <KpiRow
        tiles={[
          { eyebrow: 'Aligned', kpi: k.aligned },
          { eyebrow: 'Sitting', kpi: k.sitting },
          { eyebrow: 'Breaks', kpi: k.breaks },
          { eyebrow: 'Nudges', kpi: k.nudges },
          { eyebrow: 'Streak', kpi: streak }
        ]}
      />

      <ChartCard
        eyebrow="Days"
        action={bestDay ? caption(<>best day <span className="text-text-dim">{fmtDate(bestDay.date)}</span></>) : undefined}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <StageLegendWithGood />
            </div>
            {caption('Bar height = time tracked. Click a day to open it.')}
          </div>
        }
      >
        {muted ? (
          <div className="relative">
            <DaysChart days={days} todayKey={today} onPickDay={onPickDay} />
            <p className="pointer-events-none absolute inset-x-0 top-16 text-center type-body text-text-dim">{emptyText}</p>
          </div>
        ) : (
          <DaysChart days={days} todayKey={today} onPickDay={onPickDay} />
        )}
      </ChartCard>

      <div className={BOTTOM_ROW_WEEK}>
        <ChartCard
          eyebrow="By issue"
          muted={muted}
          action={!muted ? mono(offTotal > 0 ? `${fmtMinutes(offTotal)} off this week` : 'all good') : undefined}
          footer={<StageLegend />}
        >
          <IssueBars rows={rows} />
        </ChartCard>
        <ChartCard eyebrow="Week × hour" muted={muted} footer={<BandLegend />}>
          <HeatGrid days={days} todayKey={today} onPickDay={onPickDay} />
        </ChartCard>
      </div>
    </div>
  )
}

function StageLegendWithGood(): JSX.Element {
  return (
    <>
      <span className="inline-flex items-center gap-1.5 type-caption text-text-dim">
        <span aria-hidden className="h-3 w-3 rounded-[3px] bg-sage-deep" />
        good
      </span>
      <StageLegend />
    </>
  )
}

// ───────────────────────────── loading ─────────────────────────────

function HistorySkeleton(): JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading your history" className="flex flex-col gap-4">
      <div className="grid grid-cols-6 gap-4 @[720px]:grid-cols-5">
        {KPI_SPAN.map((span, i) => (
          <StatTile key={i} eyebrow={['Aligned', 'Sitting', 'Breaks', 'Nudges', 'Streak'][i]} value="" loading className={`${span} @[720px]:col-span-1`} />
        ))}
      </div>
      <Card>
        <Skeleton className="mb-3 h-3.5 w-20" />
        <Skeleton className="mb-1.5 h-4 w-full opacity-50" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="mt-4 h-3 w-64" />
      </Card>
      <div className={`grid gap-4 ${TWO_COL}`}>
        <Card>
          <Skeleton className="mb-4 h-3.5 w-20" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="mb-3 h-5" style={{ width: `${90 - i * 18}%` }} />
          ))}
        </Card>
        <Card>
          <Skeleton className="mb-4 h-3.5 w-20" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="mt-6 h-3 w-48" />
        </Card>
      </div>
    </div>
  )
}
