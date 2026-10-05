import type { IssueId, PostureReadout, Stage, StatMinute, ViewKind } from '@shared/posture'

/** Single source of the stage → color mapping (spec: same 4 colors everywhere). */
export const STAGE_COLOR: Record<Stage, string> = {
  0: 'var(--color-sage)',
  1: 'var(--color-amber)',
  2: 'var(--color-ember)',
  3: 'var(--color-coral)'
}

export const STAGE_LABEL: Record<Stage, string> = {
  0: 'fine',
  1: 'slight',
  2: 'clear',
  3: 'severe'
}

export const ISSUE_SHORT: Record<IssueId, string> = {
  sink: 'Slouching',
  headForward: 'Head forward',
  lean: 'Leaning',
  tooClose: 'Too close'
}

export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** A good-posture streak in whole minutes, as the spec writes it: "47 min", "1 h 5 min", "2 h". */
export function formatStreak(minutes: number): string {
  const n = Math.max(0, Math.floor(minutes))
  if (n < 60) return `${n} min`
  const h = Math.floor(n / 60)
  const m = n % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export function formatCountdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatClock(epochMinute: number): string {
  const d = new Date(epochMinute * 60_000)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ───────────────────────────── dashboard helpers (pure, unit-tested) ─────────────────────────────

export const VIEW_LABEL: Record<ViewKind, string> = {
  front: 'Front view',
  angled: 'Angled view',
  side: 'Side view'
}

export type ReadoutKey = 'neckFwd' | 'trunkFwd' | 'forward' | 'lateral' | 'drop'

export interface ReadoutItem {
  key: ReadoutKey
  /** short label, e.g. "Neck" */
  label: string
  /** formatted deviation from the baseline, e.g. "+4°", "3 cm closer" */
  value: string
  /** stage of the issue this value feeds (colors the value) */
  stage: Stage
  issue: IssueId
}

/** Default order when nothing is flagged: the values people understand fastest first. */
const READOUT_ORDER: readonly { key: ReadoutKey; label: string; issue: IssueId }[] = [
  { key: 'neckFwd', label: 'Neck', issue: 'headForward' },
  { key: 'trunkFwd', label: 'Trunk', issue: 'sink' },
  { key: 'forward', label: 'Distance', issue: 'tooClose' },
  { key: 'lateral', label: 'Side lean', issue: 'lean' },
  { key: 'drop', label: 'Height', issue: 'sink' }
]

const MINUS = '\u2212'

function signedDeg(v: number): string {
  const r = Math.round(Math.abs(v))
  if (r === 0) return '0°'
  return `${v > 0 ? '+' : MINUS}${r}°`
}

function formatReadoutValue(key: ReadoutKey, v: number): string {
  const r = Math.round(Math.abs(v))
  switch (key) {
    case 'neckFwd':
    case 'trunkFwd':
      return signedDeg(v)
    case 'forward':
      return r === 0 ? 'same' : `${r} cm ${v > 0 ? 'closer' : 'farther'}`
    case 'drop':
      return r === 0 ? 'same' : `${r} cm ${v > 0 ? 'lower' : 'higher'}`
    case 'lateral':
      // + = toward the person's own left (which is also the left of the mirrored preview)
      return r === 0 ? '0°' : `${r}° ${v > 0 ? 'left' : 'right'}`
  }
}

/**
 * Up to `max` live values versus the baseline for "What SitSense sees": unavailable
 * values are skipped, flagged values (higher issue stage) come first, then the default
 * order (neck, trunk, distance, side lean, height).
 */
export function readoutItems(
  readout: PostureReadout,
  issues: Record<IssueId, { stage: Stage }>,
  max = 3
): ReadoutItem[] {
  const items: ReadoutItem[] = []
  for (const r of READOUT_ORDER) {
    const v = readout[r.key]
    if (v === null || v === undefined || !Number.isFinite(v)) continue
    items.push({ key: r.key, label: r.label, value: formatReadoutValue(r.key, v), stage: issues[r.issue].stage, issue: r.issue })
  }
  // Array.prototype.sort is stable: equal stages keep READOUT_ORDER
  return items.sort((a, b) => b.stage - a.stage).slice(0, max)
}

/**
 * One short line for a failed Ask AI request. Errors that came back from the model
 * (`fromModel`) point to Settings → AI models unless they already do.
 */
export function aiErrorLine(message: string, fromModel: boolean): string {
  let m = message.trim().replace(/[.\s]+$/, '')
  const single = /^AI review failed — ([^:]+): (.+)$/.exec(m)
  if (single) m = `Couldn't reach ${single[1]}: ${single[2].replace(/[.\s]+$/, '')}`
  if (!m) m = 'The AI check failed'
  if (fromModel && !/Settings/.test(m)) m += ' — check Settings → AI models'
  return `${m}.`
}

/** The message mentions Settings, so a link there helps. */
export function mentionsSettings(message: string): boolean {
  return /Settings/.test(message)
}

// ───────────────────────────── Today strip ─────────────────────────────

export interface TimelineRun {
  from: number
  to: number
  state: StatMinute['s']
}

const isActive = (s: StatMinute['s']): boolean => s !== 'away' && s !== 'paused'

/** Merge consecutive equal minutes; minutes the app wasn't running become 'paused' gaps of real width. */
export function mergeRuns(minutes: readonly StatMinute[]): TimelineRun[] {
  const runs: TimelineRun[] = []
  const push = (from: number, to: number, state: StatMinute['s']): void => {
    const tail = runs[runs.length - 1]
    if (tail && tail.state === state && from - tail.to <= 1) tail.to = Math.max(tail.to, to)
    else runs.push({ from, to, state })
  }
  for (const m of minutes) {
    const tail = runs[runs.length - 1]
    if (tail && m.m - tail.to > 1) push(tail.to + 1, m.m - 1, 'paused')
    push(m.m, m.m, m.s)
  }
  return runs
}

export interface TodaySummary {
  runs: TimelineRun[]
  /** first minute with tracked posture (leading away/paused minutes are skipped) */
  first: number
  last: number
  goodMin: number
  badMin: number
  /** share of tracked minutes in good posture, 0–100 */
  pct: number
}

/**
 * The Today strip's numbers. The timeline starts at the first tracked minute (good or an
 * issue), not at the first logged one, so a morning of away/paused time doesn't squash
 * the real day. null when nothing was tracked yet (never "100% aligned" on no data).
 */
export function summarizeToday(minutes: readonly StatMinute[]): TodaySummary | null {
  const start = minutes.findIndex((m) => isActive(m.s))
  if (start < 0) return null
  const span = minutes.slice(start)
  let goodMin = 0
  let badMin = 0
  for (const m of span) {
    if (m.s === 'good') goodMin++
    else if (isActive(m.s)) badMin++
  }
  return {
    runs: mergeRuns(span),
    first: span[0].m,
    last: span[span.length - 1].m,
    goodMin,
    badMin,
    pct: Math.round((goodMin / (goodMin + badMin)) * 100)
  }
}

/**
 * Minutes of good posture in a row up to now ("47 min in good posture"); 0 when the
 * latest logged minute isn't good or is older than a minute.
 */
export function goodStreakMinutes(minutes: readonly StatMinute[], nowMinute: number): number {
  let i = minutes.length - 1
  if (i < 0 || minutes[i].s !== 'good' || nowMinute - minutes[i].m > 1) return 0
  let n = 1
  while (i > 0 && minutes[i - 1].s === 'good' && minutes[i].m - minutes[i - 1].m === 1) {
    n++
    i--
  }
  return n
}
