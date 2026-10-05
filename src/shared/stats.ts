// History statistics built from the per-minute day files (main/stats.ts).
// Pure functions, shared by main (getStatsRange) and the renderer (custom streaks).

import { ISSUES, type IssueId, type StatMinute, type TodayStats } from './posture'

export const STATS_RANGE_MAX_DAYS = 90

/** Minutes per stage for one issue: [slight, clear, severe]. */
export type StageMinutes = [number, number, number]

export interface HourBucket {
  /** tracked minutes in good posture during this local hour */
  good: number
  /** tracked minutes with any issue during this local hour */
  bad: number
}

export interface DaySummary {
  /** YYYY-MM-DD, local */
  date: string
  /** false = no stats file for that day (all counts 0) */
  hasData: boolean
  /** minutes the user was at the desk and measured: good + every issue minute */
  trackedMinutes: number
  goodMinutes: number
  /** worst-issue minutes, any stage */
  minutesByIssue: Record<IssueId, number>
  minutesByIssueStage: Record<IssueId, StageMinutes>
  awayMinutes: number
  /** paused, not set up yet or not detecting */
  pausedMinutes: number
  /** epoch ms of the first / last tracked minute, null when none */
  firstActive: number | null
  lastActive: number | null
  /** 24 local hours */
  hourly: HourBucket[]
  alertsCount: number
  breaksTaken: number
}

export interface StreakInfo {
  /** consecutive qualifying days ending today (today counts once it qualifies; an unfinished today never breaks it) */
  current: number
  /** longest run inside the requested range */
  best: number
  /** the rule used */
  minAlignedShare: number
  minTrackedMinutes: number
}

export interface StatsRange {
  /** oldest first; one entry per calendar day, including days without data */
  days: DaySummary[]
  streak: StreakInfo
}

/** Default streak rule: ≥ 70 % of at least 30 tracked minutes in good posture. */
export const STREAK_MIN_ALIGNED_SHARE = 0.7
export const STREAK_MIN_TRACKED_MINUTES = 30

const zeroByIssue = <T>(make: () => T): Record<IssueId, T> =>
  Object.fromEntries(ISSUES.map((id) => [id, make()])) as Record<IssueId, T>

export function emptyDay(date: string): DaySummary {
  return {
    date,
    hasData: false,
    trackedMinutes: 0,
    goodMinutes: 0,
    minutesByIssue: zeroByIssue(() => 0),
    minutesByIssueStage: zeroByIssue((): StageMinutes => [0, 0, 0]),
    awayMinutes: 0,
    pausedMinutes: 0,
    firstActive: null,
    lastActive: null,
    hourly: Array.from({ length: 24 }, () => ({ good: 0, bad: 0 })),
    alertsCount: 0,
    breaksTaken: 0
  }
}

const ISSUE_STATE = /^(sink|headForward|lean|tooClose):([123])$/

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

/**
 * Summarize one day file. Tolerates junk entries (skipped) and duplicate minutes
 * (the last one wins), so a hand-edited or half-written file can't skew the totals.
 */
export function summarizeDay(date: string, file: Partial<TodayStats> | null | undefined): DaySummary {
  const out = emptyDay(date)
  if (!file || typeof file !== 'object') return out
  out.hasData = true
  out.alertsCount = count(file.alerts)
  out.breaksTaken = count(file.breaks)
  const byMinute = new Map<number, StatMinute['s']>()
  for (const e of Array.isArray(file.minutes) ? file.minutes : []) {
    if (!e || typeof e !== 'object' || typeof e.m !== 'number' || !Number.isFinite(e.m) || typeof e.s !== 'string') continue
    byMinute.set(Math.floor(e.m), e.s)
  }
  for (const [m, s] of [...byMinute].sort((a, b) => a[0] - b[0])) {
    if (s === 'away') {
      out.awayMinutes++
      continue
    }
    if (s === 'paused') {
      out.pausedMinutes++
      continue
    }
    const hour = new Date(m * 60_000).getHours()
    if (s === 'good') {
      out.goodMinutes++
      out.hourly[hour].good++
    } else {
      const match = ISSUE_STATE.exec(s)
      if (!match) continue
      const issue = match[1] as IssueId
      out.minutesByIssue[issue]++
      out.minutesByIssueStage[issue][Number(match[2]) - 1]++
      out.hourly[hour].bad++
    }
    out.trackedMinutes++
    const t = m * 60_000
    if (out.firstActive === null) out.firstActive = t
    out.lastActive = t
  }
  return out
}

/** good / tracked, or null when nothing was tracked */
export function alignedShare(d: Pick<DaySummary, 'goodMinutes' | 'trackedMinutes'>): number | null {
  return d.trackedMinutes > 0 ? d.goodMinutes / d.trackedMinutes : null
}

/**
 * Consecutive days (oldest-first input, last entry = today) with at least
 * `minTrackedMinutes` tracked and `minAlignedShare` of them good. Today only
 * extends the streak once it qualifies — an unfinished today never breaks it.
 */
export function computeStreak(
  days: readonly Pick<DaySummary, 'goodMinutes' | 'trackedMinutes'>[],
  minAlignedShare = STREAK_MIN_ALIGNED_SHARE,
  minTrackedMinutes = STREAK_MIN_TRACKED_MINUTES
): StreakInfo {
  const ok = days.map((d) => d.trackedMinutes >= minTrackedMinutes && (alignedShare(d) ?? 0) >= minAlignedShare)
  let best = 0
  let run = 0
  for (const q of ok) {
    run = q ? run + 1 : 0
    best = Math.max(best, run)
  }
  let current = 0
  let i = ok.length - 1
  if (i >= 0 && !ok[i]) i-- // today not (yet) qualifying doesn't break the streak
  for (; i >= 0 && ok[i]; i--) current++
  return { current, best, minAlignedShare, minTrackedMinutes }
}

/** YYYY-MM-DD for a local date */
export function localDateKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** the `days` local date keys ending with `today`, oldest first (DST-safe) */
export function lastDateKeys(today: Date, days: number): string[] {
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 12)
    out.push(localDateKey(d))
  }
  return out
}
