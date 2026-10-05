// "What your coach sees" (docs/specs/ui-v3.md §4.5). Pure: builds the AiChatContext that
// goes out with each message, and the one-line previews the context panel shows — from
// the SAME inputs, so the panel always shows exactly what is sent. Text only, never an image.

import type { AiChatContext, AiChatLiveContext, AiConnection } from '@shared/ai'
import type { SittingState } from '@shared/ipc'
import { ISSUES, type CalibrationBaseline, type IssueId, type PostureSnapshot, type Stage } from '@shared/posture'
import type { DaySummary, StatsRange } from '@shared/stats'
import { fmtAngle, fmtMinutes, fmtPercent, fmtRelative, plural } from '@renderer/lib/format'
import { ISSUE_SHORT, STAGE_LABEL, VIEW_LABEL } from '@renderer/lib/ui'
import type { CoachContextToggles } from './types'

export interface CoachContextInputs {
  /** latest posture snapshot (frozen while paused — gated by `paused` / `live`) */
  snapshot: PostureSnapshot | null
  /** monitoring is paused: live numbers are never shared */
  paused: boolean
  /** detection is running with a working camera (useMonitoring().live) */
  live: boolean
  calibrated: boolean
  sitting: SittingState | null
  /** getStatsRange(7) — oldest first, the last day is today */
  range: StatsRange | null
  baseline: CalibrationBaseline | null
  /** issues the user turned off in Settings are not reported */
  enabledIssues?: Partial<Record<IssueId, boolean>>
  now: number
}

const round = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v)
const round1 = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10

/** Why the live row can't share anything right now (null = it can). */
export function liveUnavailable(i: Pick<CoachContextInputs, 'paused' | 'live' | 'snapshot'>): string | null {
  if (i.paused) return 'Paused — live numbers aren’t shared'
  if (!i.live || !i.snapshot) return 'Camera off — nothing to share'
  return null
}

/** The issues the user watches, worst first (stage > 0 only). */
function activeIssues(snapshot: PostureSnapshot, enabled?: Partial<Record<IssueId, boolean>>): { id: IssueId; stage: Stage }[] {
  return ISSUES.filter((id) => enabled?.[id] !== false)
    .map((id) => ({ id, stage: snapshot.issues[id]?.stage ?? 0 }))
    .filter((x) => x.stage > 0)
    .sort((a, b) => b.stage - a.stage)
}

export function buildLiveContext(i: CoachContextInputs): AiChatLiveContext | undefined {
  if (liveUnavailable(i) !== null || !i.snapshot) return undefined
  const s = i.snapshot
  const live: AiChatLiveContext = { presence: s.presence, calibrated: i.calibrated }
  if (s.presence === 'active') {
    if (s.readout) {
      live.view = s.readout.view
      live.neckFwdDeg = round(s.readout.neckFwd)
      live.trunkFwdDeg = round(s.readout.trunkFwd)
    }
    if (i.calibrated) {
      const issues: Partial<Record<IssueId, Stage>> = {}
      for (const id of ISSUES) if (i.enabledIssues?.[id] !== false) issues[id] = s.issues[id]?.stage ?? 0
      live.issues = issues
      const act = activeIssues(s, i.enabledIssues)
      live.worstStage = act[0]?.stage ?? 0
    }
  }
  if (i.sitting && i.sitting.sittingSince !== null && Number.isFinite(i.sitting.sittingMinutes)) {
    live.sittingMinutes = Math.max(0, Math.round(i.sitting.sittingMinutes))
  }
  return live
}

/** Today's DaySummary from a range (the last day), or null. */
export function todayOf(range: StatsRange | null): DaySummary | null {
  const d = range?.days[range.days.length - 1]
  return d ?? null
}

export function buildContext(i: CoachContextInputs, t: CoachContextToggles): AiChatContext | undefined {
  const ctx: AiChatContext = {}
  if (t.live) {
    const live = buildLiveContext(i)
    if (live) ctx.live = live
  }
  if (t.today && i.range) {
    const d = todayOf(i.range)
    if (d && d.hasData) {
      const byIssue: Partial<Record<IssueId, number>> = {}
      for (const id of ISSUES) if ((d.minutesByIssue[id] ?? 0) > 0) byIssue[id] = Math.round(d.minutesByIssue[id])
      ctx.today = {
        trackedMinutes: Math.round(d.trackedMinutes),
        goodMinutes: Math.round(d.goodMinutes),
        awayMinutes: Math.round(d.awayMinutes),
        minutesByIssue: byIssue,
        alertsCount: d.alertsCount,
        breaksTaken: d.breaksTaken
      }
    }
    const withData = i.range.days.filter((x) => x.hasData)
    if (withData.length > 0) {
      const tracked = withData.reduce((a, x) => a + x.trackedMinutes, 0)
      const good = withData.reduce((a, x) => a + x.goodMinutes, 0)
      ctx.history = {
        days: i.range.days.length,
        alignedShare: tracked > 0 ? Math.round((good / tracked) * 100) / 100 : null,
        streakDays: i.range.streak.current
      }
    }
  }
  if (t.baseline && i.baseline) {
    const b = i.baseline
    ctx.baseline = {
      capturedAt: b.capturedAt,
      view: b.view.kind,
      verified: b.verified,
      neckFwdDeg: round1(b.neckFwd),
      trunkFwdDeg: round1(b.trunkFwd),
      headPitchDeg: round1(b.headPitch)
    }
  }
  return Object.keys(ctx).length ? ctx : undefined
}

// ───────────────────────────── previews (what the panel shows) ─────────────────────────────

export interface ContextPreview {
  /** the row has something to share right now */
  available: boolean
  /** 1–2 short lines (numbers are rendered in Plex Mono by the panel) */
  lines: string[]
}

export function livePreview(i: CoachContextInputs): ContextPreview {
  const why = liveUnavailable(i)
  if (why || !i.snapshot) return { available: false, lines: [why ?? 'Camera off — nothing to share'] }
  const s = i.snapshot
  if (s.presence !== 'active') return { available: true, lines: ['Away from the desk'] }
  if (!i.calibrated) return { available: true, lines: ['In view · posture not set up yet'] }
  const act = activeIssues(s, i.enabledIssues)
  const status = act.length === 0 ? 'Aligned' : `${ISSUE_SHORT[act[0].id]} · ${STAGE_LABEL[act[0].stage]}`
  const nums: string[] = []
  const neck = round(s.readout?.neckFwd)
  const trunk = round(s.readout?.trunkFwd)
  if (neck !== null) nums.push(`Neck ${fmtAngle(neck, { signed: true })}`)
  if (trunk !== null) nums.push(`Back ${fmtAngle(trunk, { signed: true })}`)
  const first = [status, ...nums].join(' · ')
  const second: string[] = []
  if (s.readout) second.push(VIEW_LABEL[s.readout.view])
  if (i.sitting && i.sitting.sittingSince !== null && i.sitting.sittingMinutes >= 1) second.push(`sitting ${fmtMinutes(i.sitting.sittingMinutes)}`)
  return { available: true, lines: second.length ? [first, second.join(' · ')] : [first] }
}

export function todayPreview(i: CoachContextInputs): ContextPreview {
  if (!i.range) return { available: false, lines: ['Loading…'] }
  const d = todayOf(i.range)
  if (!d || !d.hasData || d.trackedMinutes <= 0) {
    const anyData = i.range.days.some((x) => x.hasData && x.trackedMinutes > 0)
    return { available: anyData, lines: [anyData ? 'Nothing tracked today yet · this week’s trend' : 'No history yet'] }
  }
  const share = d.trackedMinutes > 0 ? d.goodMinutes / d.trackedMinutes : null
  const first = `${fmtPercent(share, { share: true })} aligned · ${fmtMinutes(d.trackedMinutes)}`
  const worst = ISSUES.map((id) => ({ id, m: d.minutesByIssue[id] ?? 0 }))
    .filter((x) => x.m > 0)
    .sort((a, b) => b.m - a.m)[0]
  const second: string[] = []
  if (worst) second.push(`${ISSUE_SHORT[worst.id]} ${fmtMinutes(worst.m)}`)
  second.push(plural(d.breaksTaken, 'break'))
  return { available: true, lines: [first, second.join(' · ')] }
}

export function baselinePreview(i: CoachContextInputs): ContextPreview {
  const b = i.baseline
  if (!b) return { available: false, lines: ['Not set up yet'] }
  return {
    available: true,
    lines: [`${VIEW_LABEL[b.view.kind]} · ${b.verified ? 'verified' : 'not verified'}`, `Set up ${fmtRelative(b.capturedAt, i.now)}`]
  }
}

/** A coarse key of the live state; a change between messages adds "Measurements updated". */
export function liveKey(i: CoachContextInputs): string | null {
  const live = buildLiveContext(i)
  if (!live) return null
  return `${live.presence}|${live.view ?? '-'}|${live.worstStage ?? '-'}`
}

// ───────────────────────────── connections ─────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** The connection runs on this computer (Ollama, LM Studio, a local server) — works offline. */
export function isLocalConnection(c: Pick<AiConnection, 'baseUrl'>, presetBaseUrl = ''): boolean {
  const url = c.baseUrl || presetBaseUrl
  if (!url) return false
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}
