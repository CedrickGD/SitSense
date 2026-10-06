// Live screen view-model (docs/specs/ui-v3.md §3). Pure functions only — everything the
// Live cards show is derived here so it can be unit-tested (__tests__/liveModel.test.ts).
// The UI renders what detection reports; nothing here makes its own posture judgment.

import {
  ISSUE_LABELS,
  ISSUES,
  type CameraError,
  type IssueId,
  type PostureReadout,
  type PostureSnapshot,
  type Stage,
  type StatMinute
} from '@shared/posture'
import { BREAK_AWAY_MINUTES, type SittingState } from '@shared/ipc'
import type { Landmark } from '@renderer/posture/types'
import { isSeen } from '@renderer/detection/pose-geometry'
import { STAGES } from '@renderer/posture/constants'
import { fmtMinutes, plural } from '@renderer/lib/format'
import { isSuspended } from '@renderer/lib/score'

const round = (v: number): number => Math.round(Math.abs(v))

// ───────────────────────────── status (Posture card, Zone A) ─────────────────────────────

export type StatusKind =
  | 'good'
  | 'issue'
  | 'paused'
  | 'away'
  | 'setup'
  | 'camera'
  | 'starting'
  | 'mismatch'
  | 'restarting'
  | 'unseen'
  | 'changed'

export interface StatusInput {
  paused: boolean
  running: boolean
  cameraError: CameraError
  detectorError: 'model' | 'inference' | null
  calibrated: boolean
  mismatch: boolean
  /** `suspended`: every detector paused (view far off the setup distance; optional engine field) */
  snapshot: (Pick<PostureSnapshot, 'presence' | 'issues' | 'readout'> & { suspended?: boolean }) | null
}

export interface StatusView {
  kind: StatusKind
  /** the h2 status word */
  word: string
  /** the worst active issue (kind 'issue') */
  worst: { issue: IssueId; stage: Stage } | null
}

/** The worst active issue (highest stage; ties keep ISSUES order), or null. */
export function worstIssue(issues: Record<IssueId, { stage: Stage }>): { issue: IssueId; stage: Stage } | null {
  let best: { issue: IssueId; stage: Stage } | null = null
  for (const id of ISSUES) {
    const s = issues[id]?.stage ?? 0
    if (s > 0 && (best === null || s > best.stage)) best = { issue: id, stage: s }
  }
  return best
}

/**
 * The status word (§3.4 Zone A). Order matters: a frozen snapshot is kept while paused or
 * after a camera failure, so those win over anything the snapshot says (audit).
 */
export function statusView(i: StatusInput): StatusView {
  const v = (kind: StatusKind, word: string): StatusView => ({ kind, word, worst: null })
  if (i.paused) return v('paused', 'Paused')
  if (i.cameraError || i.detectorError === 'model') return v('camera', 'Camera off')
  // based on the saved settings, not the snapshot: no frame yet ≠ not set up (audit)
  if (!i.calibrated) return v('setup', 'Not set up')
  if (i.mismatch) return v('mismatch', 'New camera')
  if (i.detectorError === 'inference') return v('restarting', 'Restarting…')
  if (!i.running || !i.snapshot) return v('starting', 'Starting…')
  if (i.snapshot.presence === 'away') return v('away', 'Away')
  // the engine forces every stage to 0 while its detectors are suspended: nothing is
  // judged, so this must never fall through to "Good"
  if (isSuspended(i.snapshot)) return v('changed', 'View changed')
  const worst = worstIssue(i.snapshot.issues)
  if (worst) return { kind: 'issue', word: ISSUE_LABELS[worst.issue], worst }
  // in view, but nothing measurable right now (every readout value stale or missing):
  // never show "Good" for a posture nobody could measure
  const r = i.snapshot.readout
  if (r && ![r.neckFwd, r.trunkFwd, r.drop, r.forward, r.lateral].some((x) => typeof x === 'number' && Number.isFinite(x))) {
    return v('unseen', 'Not in view')
  }
  return v('good', 'Good')
}

/** Live issue duration: `42s`, `2m 10s`, then `1h 05m` (§3.4 "for 2m 10s"). */
export function fmtLiveDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return fmtMinutes(m)
}

/** Why the gauges aren't shown (Zone B placeholder), or null when they are. */
export type GaugeGate = 'paused' | 'camera' | 'setup' | 'mismatch' | 'changed' | 'waiting' | 'restarting' | 'starting' | null

export function gaugeGate(kind: StatusKind): GaugeGate {
  switch (kind) {
    case 'good':
    case 'issue':
      return null
    case 'paused':
      return 'paused'
    case 'camera':
      return 'camera'
    case 'setup':
      return 'setup'
    case 'mismatch':
      return 'mismatch'
    case 'changed':
      return 'changed'
    case 'restarting':
      return 'restarting'
    case 'away':
    case 'unseen':
      return 'waiting'
    default:
      return 'starting'
  }
}

export const GAUGE_GATE_COPY: Record<Exclude<GaugeGate, null>, string> = {
  paused: 'Paused — gauges resume with monitoring.',
  camera: 'The camera is off, so nothing is measured right now.',
  setup: 'Set up your posture to see live measurements.',
  mismatch: 'This camera is new — set up again to see live measurements.',
  changed: 'Your view changed a lot since setup — redo setup to measure again.',
  waiting: 'Waiting for you to sit in view.',
  restarting: 'Detection is restarting — back in a moment.',
  starting: 'Starting the camera…'
}

// ───────────────────────────── gauges (Zone B) ─────────────────────────────

export type GaugeKey = 'head' | 'back' | 'lean' | 'distance'

export interface GaugeModel {
  key: GaugeKey
  issue: IssueId
  label: string
  /** position on the track (display units); null = can't measure */
  value: number | null
  valueText: string
  range: [number, number]
  ticks: [number, number, number]
  twoSided: boolean
  unavailableReason: string
}

const div = (t: readonly [number, number, number], sigma: number): [number, number, number] => {
  const s = Number.isFinite(sigma) && sigma > 0 ? sigma : 1
  return [t[0] / s, t[1] / s, t[2] / s]
}

export function headText(v: number): string {
  if (Math.abs(v) < 1) return 'level with baseline'
  return v > 0 ? `+${round(v)}° forward` : `${round(v)}° back`
}

export function backAngleText(v: number): string {
  if (Math.abs(v) < 1) return 'level'
  return v > 0 ? `${round(v)}° forward` : `${round(v)}° reclined`
}

export function sittingHeightText(cm: number): string {
  if (Math.abs(cm) < 1) return 'same'
  return cm > 0 ? `${round(cm)} cm lower` : `${round(cm)} cm higher`
}

/** + = toward the person's own left. */
export function leanText(v: number): string {
  if (Math.abs(v) < 1) return 'centered'
  return `${round(v)}° to your ${v > 0 ? 'left' : 'right'}`
}

export function distanceText(cm: number): string {
  if (Math.abs(cm) < 1) return 'same'
  return cm > 0 ? `${round(cm)} cm closer` : `${round(cm)} cm farther`
}

const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * The four gauge rows, always in this order (§3.4 table). Ticks are the engine's stage
 * thresholds divided by the issue's sensitivity σ, so the zones match when alerts fire.
 */
export function gaugeModels(
  readout: PostureReadout | null | undefined,
  sensitivity: Partial<Record<IssueId, number>> = {}
): GaugeModel[] {
  const r = readout ?? null
  const sig = (id: IssueId): number => sensitivity[id] ?? 1
  const neck = fin(r?.neckFwd) ? r!.neckFwd! : null
  const trunk = fin(r?.trunkFwd) ? r!.trunkFwd! : null
  const drop = fin(r?.drop) ? r!.drop! : null
  const lat = fin(r?.lateral) ? r!.lateral! : null
  // the side-lean value falls back to the neck tilt when the hips aren't usable; its
  // stages differ from the trunk's, so the zones must follow the source (optional engine field)
  const latFromNeck = (r as (PostureReadout & { lateralFrom?: 'trunk' | 'neck' }) | null)?.lateralFrom === 'neck'
  const fwd = fin(r?.forward) ? r!.forward! : null

  const back: GaugeModel =
    trunk !== null || drop === null
      ? {
          key: 'back',
          issue: 'sink',
          label: 'Back angle',
          value: trunk,
          valueText: trunk === null ? '' : backAngleText(trunk),
          range: [-10, 32],
          ticks: div(STAGES.sink.trunkFwd, sig('sink')),
          twoSided: false,
          unavailableReason: "Your hips aren't in view, so the back angle can't be measured from here."
        }
      : {
          key: 'back',
          issue: 'sink',
          label: 'Sitting height',
          value: drop,
          valueText: sittingHeightText(drop),
          range: [-5, 18],
          ticks: div(STAGES.sink.drop, sig('sink')),
          twoSided: false,
          unavailableReason: "Your hips aren't in view."
        }

  return [
    {
      key: 'head',
      issue: 'headForward',
      label: 'Head position',
      value: neck,
      valueText: neck === null ? '' : headText(neck),
      range: [-10, 32],
      ticks: div(STAGES.headForward.neck, sig('headForward')),
      twoSided: false,
      unavailableReason: "Your head and shoulders aren't both in view right now."
    },
    back,
    {
      key: 'lean',
      issue: 'lean',
      label: 'Side lean',
      // the track reads like the mirrored preview: your left is on the left
      value: lat === null ? null : -lat,
      valueText: lat === null ? '' : leanText(lat),
      // ±25 for the neck so its 22° severe tick stays on the track
      range: latFromNeck ? [-25, 25] : [-20, 20],
      ticks: div(latFromNeck ? STAGES.lean.neckLat : STAGES.lean.trunkLat, sig('lean')),
      twoSided: true,
      unavailableReason: "SitSense can't see enough of your shoulders from this angle."
    },
    {
      key: 'distance',
      issue: 'tooClose',
      label: 'Screen distance',
      value: fwd,
      valueText: fwd === null ? '' : distanceText(fwd),
      range: [-15, 22],
      ticks: div(STAGES.tooClose.forward, sig('tooClose')),
      twoSided: false,
      unavailableReason: "Distance can't be measured from this angle right now."
    }
  ]
}

// ───────────────────────────── tracking chip (§3.2.1) ─────────────────────────────

export type TrackingLevel = 'looking' | 'full' | 'upper' | 'changed'

export const TRACKING_COPY: Record<TrackingLevel, { text: string; short: string; tip: string }> = {
  looking: {
    text: 'Looking for you…',
    short: 'Looking…',
    tip: 'Sit in view of the camera — your head and one shoulder are enough to start.'
  },
  full: {
    text: 'Seeing head, shoulders & hips',
    short: 'Full view',
    tip: 'Full tracking: neck, back angle, side lean and distance are all measured.'
  },
  upper: {
    text: 'Seeing head & shoulders',
    short: 'Head & shoulders',
    tip: "Your hips aren't in view, so your back angle is estimated from how far you sink. Tilt the camera down a little or sit back for full tracking."
  },
  changed: {
    text: 'View changed',
    short: 'View changed',
    tip: 'Your camera or seat moved a lot since setup. Readings may be off — redo posture setup.'
  }
}

/** What the camera sees in a raw pose (before a baseline exists): null = nobody. */
export function poseTracking(image: readonly Landmark[] | null | undefined): 'full' | 'upper' | null {
  if (!image || image.length < 25) return null
  const head = isSeen(image[0]) || isSeen(image[7]) || isSeen(image[8])
  const shoulder = isSeen(image[11]) || isSeen(image[12])
  if (!head || !shoulder) return null
  return isSeen(image[23]) || isSeen(image[24]) ? 'full' : 'upper'
}

/**
 * The tracking level. With a baseline it comes from the engine's readout (what is
 * really measured); before setup, from which landmarks the camera sees.
 */
export function trackingLevel(
  snapshot: Pick<PostureSnapshot, 'presence' | 'recalibrationSuggested' | 'readout'> | null,
  pose: 'full' | 'upper' | null
): TrackingLevel {
  if (!snapshot || snapshot.presence === 'away') return pose ?? 'looking'
  if (snapshot.recalibrationSuggested) return 'changed'
  const r = snapshot.readout
  if (r) {
    if (fin(r.trunkFwd)) return 'full'
    if (fin(r.neckFwd)) return 'upper'
  }
  return pose ?? 'looking'
}

// ───────────────────────────── Today card (§3.5) ─────────────────────────────

export interface IssueShare {
  issue: IssueId
  minutes: number
  /** the worst stage logged for it today (1..3) */
  stage: 1 | 2 | 3
}

/** Today's off minutes by issue, most first (issues with none are left out). */
export function offByIssue(minutes: readonly StatMinute[]): IssueShare[] {
  const acc = new Map<IssueId, IssueShare>()
  for (const m of minutes) {
    const [id, st] = m.s.split(':')
    if (st === undefined) continue
    const issue = id as IssueId
    const stage = Math.min(3, Math.max(1, Number(st) || 1)) as 1 | 2 | 3
    const cur = acc.get(issue)
    if (cur) {
      cur.minutes++
      if (stage > cur.stage) cur.stage = stage
    } else acc.set(issue, { issue, minutes: 1, stage })
  }
  return [...acc.values()].sort((a, b) => b.minutes - a.minutes)
}

/** Longest run of consecutive good minutes (minutes must be consecutive epoch minutes). */
export function bestGoodStretch(minutes: readonly StatMinute[]): number {
  let best = 0
  let run = 0
  let prev: number | null = null
  for (const m of minutes) {
    if (m.s === 'good') {
      run = prev !== null && m.m - prev === 1 && run > 0 ? run + 1 : 1
      best = Math.max(best, run)
    } else {
      run = 0
    }
    prev = m.m
  }
  return best
}

/** Full-hour tick positions (0..1) across [first, last+1) minutes, only when the span is ≥ 3 h. */
export function hourTicks(firstMinute: number, lastMinute: number, tzOffsetMin = new Date(firstMinute * 60_000).getTimezoneOffset()): number[] {
  const span = lastMinute - firstMinute + 1
  if (!(span >= 180)) return []
  const out: number[] = []
  // local minute-of-day aligned hours: (m - offset) % 60 === 0  (getTimezoneOffset is UTC − local)
  const localFirst = firstMinute - tzOffsetMin
  let h = Math.ceil(localFirst / 60) * 60
  if (h === localFirst) h += 60
  for (; h < localFirst + span; h += 60) out.push((h - localFirst) / span)
  return out
}

// ───────────────────────────── Sitting card (§3.5) ─────────────────────────────

export interface SittingView {
  /** h2 value, e.g. "38 min"; "—" when no stretch is under way */
  value: string
  /** a sitting stretch is under way (the "in your chair" suffix applies) */
  sittingNow: boolean
  /** 0..1 (≥ 1 when due) toward the next break; null when breaks are off */
  progress: number | null
  tone: 'sage' | 'amber' | 'due' | 'off'
  /** the caption line */
  line: string
  /** footer */
  footer: string
  /** show the `Turn on` link (breaks off) */
  offerTurnOn: boolean
}

/** Minutes a break needs (shared BREAK_AWAY_MINUTES; break-tracker.ts ends a stretch after it). */
export const BREAK_LENGTH_MIN = BREAK_AWAY_MINUTES

export function sittingView(
  s: SittingState | null,
  breaks: { enabled: boolean; intervalMinutes: number },
  now: number
): SittingView {
  const breaksToday = s?.breaksToday ?? 0
  const footer = breaksToday === 0 ? 'No breaks yet today' : `${plural(breaksToday, 'break')} today`
  const minutes = s && Number.isFinite(s.sittingMinutes) ? Math.max(0, Math.floor(s.sittingMinutes)) : 0
  // no stretch under way: a dash, never "0 min in your chair"
  const sittingNow = !!s && s.sittingSince !== null
  const value = sittingNow ? fmtMinutes(minutes) : '—'
  if (!breaks.enabled) {
    return { value, sittingNow, progress: null, tone: 'off', line: 'Breaks are off', footer, offerTurnOn: true }
  }
  const every = Math.max(1, breaks.intervalMinutes)
  const progress = minutes / every
  // main owns when the break began, so it survives leaving Live and coming back
  const breakSince = s?.onBreak && s.breakSince != null && Number.isFinite(s.breakSince) ? s.breakSince : null
  const onBreakMin = breakSince !== null ? Math.floor((now - breakSince) / 60_000) : 0
  let line: string
  if (breakSince !== null && onBreakMin >= 1) {
    line = `On a break · ${fmtMinutes(onBreakMin)}`
  } else if (s && s.sittingSince === null && minutes === 0) {
    // nobody in the chair yet (or back from a break): nothing is counting down
    line = 'Starts when you sit down'
  } else {
    let left: number
    if (s?.nextReminderAt != null && Number.isFinite(s.nextReminderAt)) left = Math.round((s.nextReminderAt - now) / 60_000)
    else left = every - minutes
    line = left <= 0 || progress >= 1 ? `Break due now — stand up for ${BREAK_LENGTH_MIN} minutes` : `Next break in ${fmtMinutes(left)}`
  }
  const tone: SittingView['tone'] = progress >= 1 ? 'due' : progress >= 0.8 ? 'amber' : 'sage'
  return { value, sittingNow, progress, tone, line, footer, offerTurnOn: false }
}

// ───────────────────────────── banners (§3.7) ─────────────────────────────

export type LiveBanner = 'mismatch' | 'recalibrate' | 'unverified' | 'fallback' | null

/**
 * Whether a per-baseline dismissal still applies: only to the baseline it was made for
 * (matched by capturedAt), so a new setup re-arms the banner.
 */
export function dismissedForBaseline(dismissedFor: number | null, capturedAt: number | null | undefined): boolean {
  return dismissedFor !== null && typeof capturedAt === 'number' && dismissedFor === capturedAt
}

/** At most one banner, in priority order. */
export function pickBanner(i: {
  mismatch: boolean
  recalibrationSuggested: boolean
  recalibrateDismissed: boolean
  unverified: boolean
  unverifiedDismissed: boolean
  usingFallback: boolean
}): LiveBanner {
  if (i.mismatch) return 'mismatch'
  if (i.recalibrationSuggested && !i.recalibrateDismissed) return 'recalibrate'
  if (i.unverified && !i.unverifiedDismissed) return 'unverified'
  if (i.usingFallback) return 'fallback'
  return null
}

// ───────────────────────────── Coach card (§3.6) ─────────────────────────────

type LooseMessage = { role?: unknown; kind?: unknown; text?: unknown; review?: { summary?: unknown } } | null

/** markdown-lite → one plain line, so a clamped preview reads as plain text */
function plainText(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** an assistant row worth previewing (error rows and notes are skipped), as plain text */
function answerText(m: LooseMessage): string | null {
  if (!m || m.role !== 'assistant' || m.kind === 'error' || m.kind === 'note') return null
  const summary = m.kind === 'check' && typeof m.review?.summary === 'string' ? m.review.summary : null
  const plain = plainText(summary ?? (typeof m.text === 'string' ? m.text : ''))
  return plain || null
}

function questionText(m: LooseMessage): string | null {
  if (!m || m.role !== 'user' || typeof m.text !== 'string') return null
  return plainText(m.text) || null
}

/**
 * The coach's last real answer as plain text for the preview: assistant text or a
 * posture check's summary; error rows and notes are skipped. A loose read on purpose —
 * the message format belongs to Coach.
 */
export function lastAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const a = answerText(messages[i] as LooseMessage)
    if (a) return a
  }
  return null
}

export interface CoachExchange {
  /** the user's question (plain text), or null */
  question: string | null
  /** the coach's reply to it, or null (none yet / while pending) */
  answer: string | null
}

/**
 * The last exchange for the Live card's mini thread. While a reply is pending it is the
 * question just asked (no answer yet); otherwise the last real answer and the question
 * that led to it. Empty when there is no answer to show.
 */
export function lastExchange(messages: unknown, pending: boolean): CoachExchange {
  const none = { question: null, answer: null }
  if (!Array.isArray(messages)) return none
  if (pending) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const q = questionText(messages[i] as LooseMessage)
      if (q) return { question: q, answer: null }
    }
    return none
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const answer = answerText(messages[i] as LooseMessage)
    if (!answer) continue
    for (let j = i - 1; j >= 0; j--) {
      const m = messages[j] as LooseMessage
      if (m?.role === 'assistant' && answerText(m)) break
      const question = questionText(m)
      if (question) return { question, answer }
    }
    return { question: null, answer }
  }
  return none
}
