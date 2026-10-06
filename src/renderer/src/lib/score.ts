// The live posture score 0–100 (docs/specs/ui-v3.md §3.4.1). Pure; unit-tested in
// __tests__/score.test.ts. The hook that feeds it from the store is lib/useLiveScore.ts.

import { ISSUES, type IssueId, type IssueSnapshot, type PostureSnapshot, type Stage } from '@shared/posture'

/** How much each issue weighs in the score. */
export const SCORE_WEIGHTS: Record<IssueId, number> = {
  sink: 1.0,
  headForward: 1.0,
  lean: 0.7,
  tooClose: 0.6
}

/** Continuous severity cap (stage 3 + up to half a stage beyond it). */
export const MAX_SEVERITY = 3.5

/** EMA time constant for the displayed score, ms. */
export const SCORE_TAU_MS = 2000

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Continuous severity of one sensitivity-scaled sub-metric value `v` against its
 * thresholds T1 < T2 < T3: 0 at v ≤ 0, v/T1 up to T1, then +1 per threshold band, and
 * up to +0.5 beyond T3. (The engine's optional `IssueSnapshot.level` is the max of this
 * over an issue's sub-metrics.)
 */
export function levelFromThresholds(v: number, t: readonly [number, number, number]): number {
  const [t1, t2, t3] = t
  if (!Number.isFinite(v) || v <= 0) return 0
  if (v <= t1) return v / t1
  if (v <= t2) return 1 + (v - t1) / (t2 - t1)
  if (v <= t3) return 2 + (v - t2) / (t3 - t2)
  return 3 + Math.min(0.5, (v - t3) / (t3 - t2))
}

/** s ∈ [0, 3.5]: the engine's continuous `level` when present, else the integer stage. */
export function issueSeverity(issue: Pick<IssueSnapshot, 'stage'> & { level?: number }): number {
  const level = issue.level
  if (typeof level === 'number' && Number.isFinite(level)) return clamp(level, 0, MAX_SEVERITY)
  return clamp(issue.stage, 0, MAX_SEVERITY)
}

/** p = w · (14·s + 4·s²) — with w = 1: s 0.5 → 8, 1 → 18, 2 → 44, 3 → 78. */
export function issuePenalty(severity: number, weight = 1): number {
  const s = clamp(severity, 0, MAX_SEVERITY)
  return weight * (14 * s + 4 * s * s)
}

/**
 * The undelayed score from the current issues: the worst issue counts fully, the others
 * half. Disabled issues (`enabled[id] === false`) are ignored.
 */
export function rawScore(
  issues: Record<IssueId, Pick<IssueSnapshot, 'stage'> & { level?: number }>,
  enabled: Partial<Record<IssueId, boolean>> = {}
): number {
  let sum = 0
  let max = 0
  for (const id of ISSUES) {
    if (enabled[id] === false) continue
    const issue = issues[id]
    if (!issue) continue
    const p = issuePenalty(issueSeverity(issue), SCORE_WEIGHTS[id])
    sum += p
    max = Math.max(max, p)
  }
  const total = max + 0.5 * (sum - max)
  return clamp(100 - total, 0, 100)
}

/**
 * True while the engine has suspended every detector because the view is far off the
 * setup distance (`PostureSnapshot.suspended`, docs/specs/detection.md §Recalibration
 * hint). Every issue then reads stage 0, so nothing may treat it as good posture. Read
 * loosely: the field is optional and older snapshots don't carry it.
 */
export function isSuspended(snapshot: unknown): boolean {
  return !!snapshot && typeof snapshot === 'object' && (snapshot as { suspended?: unknown }).suspended === true
}

/**
 * The posture-mode overlay color while nothing is judged (detectors suspended): neutral,
 * never the sage that means "good".
 */
export const NOT_JUDGED_COLOR = 'var(--color-slate-cool)'

export interface ScoreGate {
  paused?: boolean
  cameraError?: unknown
  /** detection running (false while starting or stopped) */
  running?: boolean
  /** a saved baseline that doesn't apply to this camera (no posture judged) */
  baselineMismatch?: boolean
}

/**
 * The score for a snapshot, or null when there is nothing honest to score: no snapshot,
 * not set up, away, paused, camera trouble, detection not running, or every detector
 * suspended (view far off the setup distance: the stage-0 issues are not a judgment).
 */
export function postureScore(
  snapshot: PostureSnapshot | null | undefined,
  enabled: Partial<Record<IssueId, boolean>> = {},
  gate: ScoreGate = {}
): number | null {
  if (!snapshot || !snapshot.calibrated || snapshot.presence === 'away' || isSuspended(snapshot)) return null
  if (gate.paused || gate.cameraError || gate.running === false || gate.baselineMismatch) return null
  return rawScore(snapshot.issues, enabled)
}

// ───────────────────────────── bands ─────────────────────────────

export type ScoreBand = 'aligned' | 'drifting' | 'strained' | 'poor'

/** ≥ 85 aligned · 65–84 drifting · 40–64 strained · < 40 poor (on the rounded score). */
export function scoreBand(score: number | null | undefined): ScoreBand | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null
  const s = Math.round(score)
  if (s >= 85) return 'aligned'
  if (s >= 65) return 'drifting'
  if (s >= 40) return 'strained'
  return 'poor'
}

export const BAND_COLOR: Record<ScoreBand, string> = {
  aligned: 'var(--color-sage)',
  drifting: 'var(--color-amber)',
  strained: 'var(--color-ember)',
  poor: 'var(--color-coral)'
}

/** The stage a band corresponds to (for stage-colored bits next to the score). */
export const BAND_STAGE: Record<ScoreBand, Stage> = { aligned: 0, drifting: 1, strained: 2, poor: 3 }

/** Ring / number color for a score; null scores are faint. */
export function scoreColor(score: number | null | undefined): string {
  const band = scoreBand(score)
  return band ? BAND_COLOR[band] : 'var(--color-text-faint)'
}

// ───────────────────────────── display smoothing ─────────────────────────────

/**
 * EMA with time constant τ (display += (raw − display)·(1 − e^(−Δt/τ))). Reseeds to the
 * raw value when the score comes back from null; null in → null out.
 */
export class ScoreSmoother {
  private value: number | null = null
  private at = 0

  constructor(private readonly tauMs = SCORE_TAU_MS) {}

  update(raw: number | null, nowMs: number): number | null {
    if (raw === null || !Number.isFinite(raw)) {
      this.value = null
      return null
    }
    if (this.value === null) {
      this.value = raw
    } else {
      const dt = Math.max(0, nowMs - this.at)
      this.value += (raw - this.value) * (1 - Math.exp(-dt / this.tauMs))
    }
    this.at = nowMs
    return this.value
  }

  get current(): number | null {
    return this.value
  }
}
