// Live › Today card (docs/specs/ui-v3.md §3.5): aligned %, good/off minutes, the day
// timeline and the best stretch · nudges line. With room to spare (a tall window) the
// timeline grows and the card adds where today's off minutes went, by issue.

import { useEffect, useMemo, type JSX } from 'react'
import { useAppStore } from '@renderer/state/store'
import { DASH, fmtClockMinute, fmtMinutes, plural } from '@renderer/lib/format'
import { ISSUE_SHORT, STAGE_COLOR, summarizeToday } from '@renderer/lib/ui'
import { Card, CardHeader, LinkButton, Skeleton } from '@renderer/components/primitives'
import Timeline from './Timeline'
import { bestGoodStretch, hourTicks, offByIssue, type IssueShare } from './liveModel'

/** Aligned % is only honest with a few minutes of data (History §5.3). */
const MIN_ACTIVE_FOR_PCT = 5

/** Height the card needs without the breakdown, and per breakdown row (+ its caption). */
const BASE_PX = 260
const ROW_PX = 22

/** Where today's off minutes went: one quiet bar per issue, scaled to the biggest. */
function OffBreakdown({ shares }: { shares: IssueShare[] }): JSX.Element {
  const max = Math.max(1, ...shares.map((x) => x.minutes))
  return (
    <div className="mt-4 flex flex-col gap-2">
      <p className="type-caption text-text-faint">Where the off minutes went</p>
      <ul className="flex flex-col gap-1.5">
        {shares.map((x) => (
          <li key={x.issue} className="grid grid-cols-[minmax(6rem,auto)_1fr_auto] items-center gap-3">
            <span className="truncate type-caption text-text-dim">{ISSUE_SHORT[x.issue]}</span>
            <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
              <span
                className="block h-full rounded-full"
                style={{ width: `${Math.max(4, (x.minutes / max) * 100)}%`, backgroundColor: STAGE_COLOR[x.stage] }}
              />
            </span>
            <span className="font-mono text-[12px] leading-4 text-text-dim tabular-nums">{fmtMinutes(x.minutes)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * `room`: the height the card gets from the row (0 = unknown); the breakdown shows only
 * as many rows as fit, so it never makes the page scroll.
 */
export default function TodayCard({ timelineHeight = 20, room = 0 }: { timelineHeight?: number; room?: number }): JSX.Element {
  const today = useAppStore((s) => s.today)
  const setRoute = useAppStore((s) => s.setRoute)

  useEffect(() => {
    const load = (): void => {
      window.sitsense
        .getTodayStats()
        .then((t) => useAppStore.setState({ today: t }))
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [])

  const summary = useMemo(() => (today ? summarizeToday(today.minutes) : null), [today])
  const best = useMemo(() => (today ? bestGoodStretch(today.minutes) : 0), [today])
  const ticks = useMemo(() => (summary ? hourTicks(summary.first, summary.last) : []), [summary])
  const allShares = useMemo(() => (today ? offByIssue(today.minutes) : []), [today])
  const shares = allShares.slice(0, Math.max(0, Math.min(4, Math.floor((room - BASE_PX) / ROW_PX))))

  const header = (
    <CardHeader
      eyebrow="Today"
      icon="history"
      action={
        <LinkButton arrow onClick={() => setRoute('history')}>
          History
        </LinkButton>
      }
    />
  )

  if (!today) {
    return (
      <Card dense className="flex h-full flex-col" aria-label="Today">
        {header}
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-3 h-5 w-full" />
        <Skeleton className="mt-3 h-4 w-48" />
      </Card>
    )
  }

  if (!summary) {
    // nothing tracked yet: never claim "100% aligned" on no data (audit)
    return (
      <Card dense className="flex h-full flex-col" aria-label="Today">
        {header}
        <div className="flex flex-1 flex-col justify-center gap-3">
          <div aria-hidden className="h-10 w-full rounded-lg border border-dashed border-hairline-strong/70 bg-white/[0.015]" />
          <p className="max-w-[52ch] type-body text-text-dim">
            Your day fills in here once SitSense has watched you sit for a minute.
          </p>
        </div>
      </Card>
    )
  }

  const active = summary.goodMin + summary.badMin
  const pct = active >= MIN_ACTIVE_FOR_PCT ? `${summary.pct}%` : DASH
  const goodText = fmtMinutes(summary.goodMin)
  const offText = fmtMinutes(summary.badMin)
  const nudges = today.alerts
  const footer = [best > 0 ? `Best stretch ${fmtMinutes(best)}` : null, typeof nudges === 'number' ? plural(nudges, 'nudge') : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <Card dense className="flex h-full min-w-0 flex-col" aria-label="Today">
      {header}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="flex items-baseline gap-1.5">
          <span className="type-h2 text-text">{pct}</span>
          <span className="type-caption text-text-dim">aligned</span>
        </p>
        <p className="type-value text-text-dim">
          {goodText} good · {offText} off
        </p>
      </div>
      <div className="mt-3">
        <Timeline
          runs={summary.runs}
          first={summary.first}
          last={summary.last}
          height={timelineHeight}
          ticks={ticks}
          ariaLabel={`Posture timeline from ${fmtClockMinute(summary.first)} to now: ${goodText} good, ${offText} off.`}
        />
        <div className="mt-1 flex justify-between font-mono text-[12px] leading-4 text-text-faint tabular-nums">
          <span>{fmtClockMinute(summary.first)}</span>
          <span>now</span>
        </div>
      </div>
      {shares.length > 0 && <OffBreakdown shares={shares} />}
      {footer && <p className="mt-auto pt-3 type-caption text-text-dim">{footer}</p>}
    </Card>
  )
}
