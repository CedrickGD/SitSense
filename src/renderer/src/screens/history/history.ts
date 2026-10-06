// History maths (docs/specs/ui-v3.md §5.3). Pure, unit-tested in __tests__/history.test.ts.
// Lives next to the page (the spec names lib/history.ts; lib/** belongs to the foundation).
//
// Inputs: DaySummary / StatsRange from window.sitsense.getStatsRange (shared/stats.ts) and,
// for today only, the per-minute log from getTodayStats (the only minute-level data main
// exposes). Every output is display-ready: no NaN, no negative durations, "—" for nothing.

import { ISSUES, type IssueId, type StatMinute } from '@shared/posture'
import { BREAK_AWAY_MINUTES } from '@shared/ipc'
import { STREAK_MIN_ALIGNED_SHARE, emptyDay, localDateKey, type DaySummary, type HourBucket, type StageMinutes } from '@shared/stats'
import { DASH, MINUS, fmtClock, fmtCount, fmtMinutes, parseDateKey, plural } from '@renderer/lib/format'
import { scoreBand, type ScoreBand } from '@renderer/lib/score'

/** Below this many active minutes the aligned share isn't shown (§5.3). */
export const MIN_ACTIVE_FOR_PCT = 5
/** Best/worst hour needs this many active minutes in the hour (§5.1). */
export const MIN_ACTIVE_FOR_HOUR_RANK = 15
/** Break length L in minutes (shared BREAK_AWAY_MINUTES, the tracker's own value; §5.3). */
export const DEFAULT_BREAK_MINUTES = BREAK_AWAY_MINUTES

export type StatState = StatMinute['s']
export type StageNo = 1 | 2 | 3

// ───────────────────────────── dates ─────────────────────────────

/** `key` shifted by `n` calendar days (DST-safe: computed at local noon). */
export function addDays(key: string, n: number): string {
  const d = parseDateKey(key)
  if (!d) return key
  return localDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12))
}

/** Monday of the week containing `key` (weeks start on Monday, locale-independent). */
export function weekStart(key: string): string {
  const d = parseDateKey(key)
  if (!d) return key
  const offset = (d.getDay() + 6) % 7 // Mon 0 … Sun 6
  return addDays(key, -offset)
}

/** The 7 keys Monday … Sunday of the week containing `key`. */
export function weekKeys(key: string): string[] {
  const mon = weekStart(key)
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i))
}

const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' })
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

const dayMonth = (d: Date): string => `${d.getDate()} ${monthFmt.format(d).replace(/\.$/, '')}`

/** `28 Sep – 4 Oct` for the week containing `key`. */
export function weekLabel(key: string): string {
  const keys = weekKeys(key)
  const a = parseDateKey(keys[0])
  const b = parseDateKey(keys[6])
  if (!a || !b) return DASH
  if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${dayMonth(b)}`
  return `${dayMonth(a)} – ${dayMonth(b)}`
}

/** `Mon` (localized short weekday, no trailing dot). */
export function weekdayShort(key: string): string {
  const d = parseDateKey(key)
  return d ? weekdayFmt.format(d).replace(/\.$/, '') : DASH
}

/** Two-digit hour label: `08`. */
export const hh = (h: number): string => String(((h % 24) + 24) % 24).padStart(2, '0')

/** `14:00–15:00` */
export const hourRange = (h: number): string => `${hh(h)}:00–${hh(h + 1)}:00`

// ───────────────────────────── shares ─────────────────────────────

/** Aligned % (0–100, rounded) = good / active; null when active < 5 (§5.3). */
export function alignedPct(good: number, active: number): number | null {
  if (!Number.isFinite(good) || !Number.isFinite(active) || active < MIN_ACTIVE_FOR_PCT) return null
  return Math.round((Math.max(0, Math.min(good, active)) / active) * 100)
}

/** Band color key for an aligned % (same bands as the score, §3.4.1). */
export const pctBand = (pct: number | null): ScoreBand | null => scoreBand(pct)

/** Minutes per stage summed over every issue: [slight, clear, severe]. */
export function stageTotals(day: Pick<DaySummary, 'minutesByIssueStage'>): StageMinutes {
  const out: StageMinutes = [0, 0, 0]
  for (const id of ISSUES) {
    const s = day.minutesByIssueStage[id]
    if (!s) continue
    for (let i = 0; i < 3; i++) out[i] += s[i] || 0
  }
  return out
}

/** Several days added up (a week). `hasData` = any day had a file. */
export function sumDays(days: readonly DaySummary[], date = 'sum'): DaySummary {
  const out = emptyDay(date)
  for (const d of days) {
    out.hasData ||= d.hasData
    out.trackedMinutes += d.trackedMinutes
    out.goodMinutes += d.goodMinutes
    out.awayMinutes += d.awayMinutes
    out.pausedMinutes += d.pausedMinutes
    out.alertsCount += d.alertsCount
    out.breaksTaken += d.breaksTaken
    for (const id of ISSUES) {
      out.minutesByIssue[id] += d.minutesByIssue[id] || 0
      for (let i = 0; i < 3; i++) out.minutesByIssueStage[id][i] += d.minutesByIssueStage[id]?.[i] || 0
    }
    for (let h = 0; h < 24; h++) {
      out.hourly[h].good += d.hourly[h]?.good || 0
      out.hourly[h].bad += d.hourly[h]?.bad || 0
    }
    if (d.firstActive !== null && (out.firstActive === null || d.firstActive < out.firstActive)) out.firstActive = d.firstActive
    if (d.lastActive !== null && (out.lastActive === null || d.lastActive > out.lastActive)) out.lastActive = d.lastActive
  }
  return out
}

/** Pooled aligned share of several days (good / active over all of them), or null. */
export function pooledPct(days: readonly Pick<DaySummary, 'goodMinutes' | 'trackedMinutes'>[]): number | null {
  let good = 0
  let active = 0
  for (const d of days) {
    good += d.goodMinutes
    active += d.trackedMinutes
  }
  return alignedPct(good, active)
}

export type DeltaTone = 'good' | 'warn' | 'faint'

/** `+6 vs avg` (sage when better, amber when worse, faint within ±2). */
export function pctDelta(current: number | null, reference: number | null, suffix: string): { text: string; tone: DeltaTone } | null {
  if (current === null || reference === null) return null
  const diff = Math.round(current) - Math.round(reference)
  const tone: DeltaTone = Math.abs(diff) <= 2 ? 'faint' : diff > 0 ? 'good' : 'warn'
  if (diff === 0) return { text: `same as ${suffix}`, tone }
  return { text: `${diff > 0 ? '+' : MINUS}${Math.abs(diff)} vs ${suffix}`, tone }
}

// ───────────────────────────── by issue ─────────────────────────────

export interface IssueRow {
  issue: IssueId
  total: number
  stages: StageMinutes
}

/** One row per issue (all four, even at 0), sorted by minutes, descending (stable). */
export function issueRows(day: Pick<DaySummary, 'minutesByIssueStage'>): IssueRow[] {
  return ISSUES.map((issue) => {
    const s = day.minutesByIssueStage[issue] ?? [0, 0, 0]
    const stages: StageMinutes = [s[0] || 0, s[1] || 0, s[2] || 0]
    return { issue, stages, total: stages[0] + stages[1] + stages[2] }
  }).sort((a, b) => b.total - a.total)
}

/** `slight 18 · clear 10 · severe 3 min` */
export function stageSplitText(s: StageMinutes): string {
  return `slight ${fmtCount(s[0])} · clear ${fmtCount(s[1])} · severe ${fmtCount(s[2])} min`
}

// ───────────────────────────── by hour ─────────────────────────────

export interface HourCell {
  hour: number
  active: number
  good: number
  pct: number | null
  band: ScoreBand | null
  /** 0.35 + 0.65·min(1, active/30); 0 when no data */
  opacity: number
  hasData: boolean
}

/** 24 heat cells from hourly buckets (§5.1 By hour). */
export function hourCells(hourly: readonly HourBucket[]): HourCell[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const b = hourly[hour] ?? { good: 0, bad: 0 }
    const good = Math.max(0, b.good || 0)
    const active = good + Math.max(0, b.bad || 0)
    // an hour with a few active minutes still shows its color (pct needs ≥ 5 — below that, by share)
    const pct = active > 0 ? Math.round((good / active) * 100) : null
    return {
      hour,
      active,
      good,
      pct,
      band: pctBand(pct),
      opacity: active > 0 ? 0.35 + 0.65 * Math.min(1, active / 30) : 0,
      hasData: active > 0
    }
  })
}

/** `14:00–15:00 · 74% aligned · 48 min tracked` / `14:00–15:00 · nothing tracked` */
export function hourTooltip(c: HourCell): string {
  if (!c.hasData) return `${hourRange(c.hour)} · nothing tracked`
  return `${hourRange(c.hour)} · ${c.pct}% aligned · ${fmtMinutes(c.active)} tracked`
}

/** Best and worst hour by aligned share (only hours with ≥ 15 active minutes); null when none / same. */
export function bestWorstHours(cells: readonly HourCell[], minActive = MIN_ACTIVE_FOR_HOUR_RANK): { best: number | null; worst: number | null } {
  const ranked = cells.filter((c) => c.active >= minActive && c.pct !== null)
  if (ranked.length === 0) return { best: null, worst: null }
  let best = ranked[0]
  let worst = ranked[0]
  for (const c of ranked) {
    if ((c.pct as number) > (best.pct as number)) best = c
    if ((c.pct as number) < (worst.pct as number)) worst = c
  }
  if (ranked.length < 2 || best.pct === worst.pct) return { best: best.hour, worst: null }
  return { best: best.hour, worst: worst.hour }
}

// ───────────────────────────── minute timeline (today) ─────────────────────────────

export type SegmentKind = 'good' | 'slight' | 'clear' | 'severe' | 'idle' | 'break'

export interface TimelineSegment {
  /** epoch minute, inclusive */
  from: number
  /** epoch minute, exclusive */
  to: number
  kind: SegmentKind
  /** for issue segments: the issue */
  issue?: IssueId
  /** for idle: what the gap was (away, paused, or nothing logged) */
  idle?: 'away' | 'paused' | 'none' | 'mixed'
}

export const isActiveState = (s: StatState | undefined): boolean => !!s && s !== 'away' && s !== 'paused'

const ISSUE_STATE = /^(sink|headForward|lean|tooClose):([123])$/

function kindOf(s: StatState | undefined): { kind: SegmentKind; issue?: IssueId; idle?: TimelineSegment['idle'] } {
  if (s === 'good') return { kind: 'good' }
  if (s === 'away' || s === 'paused') return { kind: 'idle', idle: s }
  const m = s ? ISSUE_STATE.exec(s) : null
  if (!m) return { kind: 'idle', idle: 'none' }
  return { kind: (['slight', 'clear', 'severe'] as const)[Number(m[2]) - 1], issue: m[1] as IssueId }
}

/** Last entry per epoch minute (junk skipped), sorted ascending. */
export function normalizeMinutes(minutes: readonly StatMinute[] | null | undefined): StatMinute[] {
  const by = new Map<number, StatState>()
  for (const e of minutes ?? []) {
    if (!e || typeof e.m !== 'number' || !Number.isFinite(e.m) || typeof e.s !== 'string') continue
    by.set(Math.floor(e.m), e.s)
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([m, s]) => ({ m, s }))
}

/**
 * The day's timeline from its first to its last active minute: consecutive minutes with
 * the same state merge; a run of non-active minutes (away, paused or nothing logged) of at
 * least `breakMinutes` between two active minutes is a `break`, shorter ones are `idle`.
 */
export function buildTimeline(minutes: readonly StatMinute[] | null | undefined, breakMinutes = DEFAULT_BREAK_MINUTES): TimelineSegment[] {
  const list = normalizeMinutes(minutes)
  const active = list.filter((e) => isActiveState(e.s))
  if (active.length === 0) return []
  const first = active[0].m
  const last = active[active.length - 1].m
  const at = new Map(list.map((e) => [e.m, e.s]))
  const out: TimelineSegment[] = []
  let cur: TimelineSegment | null = null
  let curState: string | null = null
  for (let m = first; m <= last; m++) {
    const s = at.get(m)
    const k = kindOf(s)
    const key = k.kind === 'idle' ? 'idle' : (s as string)
    if (cur && curState === key) {
      cur.to = m + 1
      if (k.kind === 'idle' && cur.idle !== k.idle) cur.idle = 'mixed'
      continue
    }
    cur = { from: m, to: m + 1, kind: k.kind, ...(k.issue ? { issue: k.issue } : {}), ...(k.idle ? { idle: k.idle } : {}) }
    curState = key
    out.push(cur)
  }
  for (const seg of out) if (seg.kind === 'idle' && seg.to - seg.from >= breakMinutes) seg.kind = 'break'
  return out
}

/**
 * Sitting stretches (wall-clock minutes from the first active minute after a break to
 * the last active minute before the next one) — the input is a buildTimeline() result.
 */
export function sittingStretches(segments: readonly TimelineSegment[]): number[] {
  const out: number[] = []
  let start: number | null = null
  let end = 0
  for (const s of segments) {
    if (s.kind === 'break') {
      if (start !== null) out.push(end - start)
      start = null
      continue
    }
    if (s.kind === 'idle') continue
    if (start === null) start = s.from
    end = s.to
  }
  if (start !== null) out.push(end - start)
  return out
}

/** Stretches longer than 2 × the break interval (§5.3 "long stretch"). */
export const longStretchCount = (stretches: readonly number[], everyMinutes: number): number =>
  stretches.filter((n) => n > 2 * Math.max(1, everyMinutes)).length

/** Hour ticks (epoch minutes on the full hour) inside [from, to), thinned to at most `max`. */
export function hourTicks(from: number, to: number, max = 12): { m: number; label: string }[] {
  if (!(to > from)) return []
  const ticks: number[] = []
  // full local hours: step through hours of the local clock (handles :30 offset zones)
  const startD = new Date(from * 60_000)
  startD.setMinutes(0, 0, 0)
  for (let t = startD.getTime(); t < to * 60_000; t += 3_600_000) {
    const m = Math.round(t / 60_000)
    if (m >= from) ticks.push(m)
  }
  const step = Math.max(1, Math.ceil(ticks.length / Math.max(1, max)))
  return ticks.filter((_, i) => i % step === 0).map((m) => ({ m, label: hh(new Date(m * 60_000).getHours()) }))
}

const STAGE_WORD: Record<'slight' | 'clear' | 'severe', string> = { slight: 'slight', clear: 'clear', severe: 'severe' }

export const ISSUE_SHORT: Record<IssueId, string> = {
  sink: 'Slouching',
  headForward: 'Head forward',
  lean: 'Leaning',
  tooClose: 'Too close'
}

/** `09:12–09:40 · Good posture · 28 min` */
export function segmentLabel(s: TimelineSegment): string {
  const span = `${fmtClock(s.from * 60_000)}–${fmtClock(s.to * 60_000)}`
  const len = fmtMinutes(s.to - s.from)
  let what: string
  if (s.kind === 'good') what = 'Good posture'
  else if (s.kind === 'break') what = 'Break'
  else if (s.kind === 'idle') what = s.idle === 'paused' ? 'Paused' : s.idle === 'away' ? 'Away' : 'Not tracked'
  else what = `${s.issue ? ISSUE_SHORT[s.issue] : 'Off posture'} (${STAGE_WORD[s.kind]})`
  return `${span} · ${what} · ${len}`
}

// ───────────────────────────── KPI tiles ─────────────────────────────

export interface Kpi {
  value: string
  sub: string
  tone: DeltaTone | 'dim'
  muted: boolean
}

export interface DayKpiInput {
  day: DaySummary
  /** the 7 days before it (for the Aligned delta) */
  previous: readonly DaySummary[]
  /** today's per-minute stretches, when known (null = past day / not loaded) */
  stretches: readonly number[] | null
  everyMinutes: number
  isToday: boolean
}

export interface StreakLike {
  current: number
  best: number
}

const rateText = (minutes: number, count: number): string => fmtMinutes(Math.max(1, Math.round(minutes / count)))

/** The five Day-view tiles: aligned, sitting, breaks, nudges (streak is range-wide). */
export function dayKpis({ day, previous, stretches, everyMinutes, isToday }: DayKpiInput): Record<'aligned' | 'sitting' | 'breaks' | 'nudges', Kpi> {
  const muted = day.trackedMinutes === 0
  const pct = alignedPct(day.goodMinutes, day.trackedMinutes)
  const delta = pctDelta(pct, pooledPct(previous), 'avg')
  const aligned: Kpi =
    pct === null
      ? { value: DASH, sub: day.trackedMinutes > 0 ? 'too little to tell' : '', tone: 'faint', muted: true }
      : { value: `${pct}%`, sub: delta?.text ?? 'no average yet', tone: delta?.tone ?? 'faint', muted }

  let sittingSub = ''
  if (!muted) {
    if (stretches) {
      const long = longStretchCount(stretches, everyMinutes)
      sittingSub = long === 0 ? 'no long stretches' : plural(long, 'long stretch', 'long stretches')
    } else if (day.firstActive !== null && day.lastActive !== null) {
      sittingSub = `${fmtClock(day.firstActive)}–${fmtClock(day.lastActive + 60_000)}`
    }
  }
  const sitting: Kpi = { value: muted ? DASH : fmtMinutes(day.trackedMinutes), sub: sittingSub, tone: 'dim', muted }

  const breaks: Kpi = muted
    ? { value: DASH, sub: '', tone: 'dim', muted }
    : {
        value: fmtCount(day.breaksTaken),
        sub: day.breaksTaken > 0 ? `every ${rateText(day.trackedMinutes, day.breaksTaken + 1)}` : isToday ? 'none yet' : 'none',
        tone: day.breaksTaken > 0 ? 'dim' : 'faint',
        muted
      }

  const nudges = nudgesKpi(day.alertsCount, day.trackedMinutes, pct, muted)
  return { aligned, sitting, breaks, nudges }
}

/**
 * The Nudges tile. The count only covers toasts that were actually shown, so zero can also
 * mean "notifications off / filtered out". "None needed" is therefore judged from the posture
 * itself (the streak's good-day bar), never from the count alone.
 */
function nudgesKpi(count: number, trackedMinutes: number, pct: number | null, muted: boolean): Kpi {
  if (muted) return { value: DASH, sub: '', tone: 'dim', muted }
  if (count > 0) return { value: fmtCount(count), sub: perHour(count, trackedMinutes), tone: 'dim', muted }
  const calm = pct !== null && pct >= STREAK_MIN_ALIGNED_SHARE * 100
  return { value: fmtCount(count), sub: calm ? 'none needed' : 'none', tone: calm ? 'good' : 'faint', muted }
}

/** The Week-view tiles: week totals; Aligned vs the previous week. */
export function weekKpis(week: readonly DaySummary[], previousWeek: readonly DaySummary[]): Record<'aligned' | 'sitting' | 'breaks' | 'nudges', Kpi> {
  const sum = sumDays(week)
  const muted = sum.trackedMinutes === 0
  const pct = alignedPct(sum.goodMinutes, sum.trackedMinutes)
  const delta = pctDelta(pct, pooledPct(previousWeek), 'last week')
  const daysSat = week.filter((d) => d.trackedMinutes > 0).length
  return {
    aligned:
      pct === null
        ? { value: DASH, sub: sum.trackedMinutes > 0 ? 'too little to tell' : '', tone: 'faint', muted: true }
        : { value: `${pct}%`, sub: delta?.text ?? 'first week tracked', tone: delta?.tone ?? 'faint', muted },
    sitting: {
      value: muted ? DASH : fmtMinutes(sum.trackedMinutes),
      sub: muted ? '' : `${fmtMinutes(Math.round(sum.trackedMinutes / Math.max(1, daysSat)))} a day`,
      tone: 'dim',
      muted
    },
    breaks: muted
      ? { value: DASH, sub: '', tone: 'dim', muted }
      : {
          value: fmtCount(sum.breaksTaken),
          sub: sum.breaksTaken > 0 ? `every ${rateText(sum.trackedMinutes, sum.breaksTaken + daysSat)}` : 'none',
          tone: sum.breaksTaken > 0 ? 'dim' : 'faint',
          muted
        },
    nudges: nudgesKpi(sum.alertsCount, sum.trackedMinutes, pct, muted)
  }
}

/** `3 days` / `best 9` */
export function streakKpi(streak: StreakLike | null | undefined): Kpi {
  if (!streak) return { value: DASH, sub: '', tone: 'dim', muted: true }
  return {
    value: plural(streak.current, 'day'),
    sub: streak.best > 0 ? `best ${fmtCount(streak.best)}` : 'no good day yet',
    tone: streak.current > 0 ? 'good' : 'faint',
    muted: streak.current === 0 && streak.best === 0
  }
}

// ───────────────────────────── lookups ─────────────────────────────

/** A day from the range by key, or an empty one (outside the range / no file). */
export function dayFor(byDate: ReadonlyMap<string, DaySummary>, key: string): DaySummary {
  return byDate.get(key) ?? emptyDay(key)
}

/** true when anything at all was ever tracked. */
export const anyTracked = (days: readonly DaySummary[]): boolean => days.some((d) => d.trackedMinutes > 0)

/** The keys for the 7 days before `key` (oldest first). */
export const previousKeys = (key: string, n = 7): string[] => Array.from({ length: n }, (_, i) => addDays(key, i - n))

/** Today's key now (local). */
export const todayKey = (now: number | Date = Date.now()): string => localDateKey(now instanceof Date ? now : new Date(now))

/** `2 per hour`, or `1 every 1h 20m` below one an hour — nudges over tracked sitting, no decimals. */
export function perHour(count: number, minutes: number): string {
  if (!(count > 0) || !(minutes > 0)) return DASH
  const rate = count / (minutes / 60)
  if (rate >= 1) return `${Math.round(rate)} per hour`
  return `1 every ${fmtMinutes(Math.round(minutes / count))}`
}
