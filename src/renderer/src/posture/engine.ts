import {
  ISSUES,
  type CalibrationBaseline,
  type IssueId,
  type IssueSnapshot,
  type PostureAlert,
  type PostureSnapshot,
  type PresenceState,
  type Stage
} from '@shared/posture'
import {
  AWAY_ENTER_S,
  AWAY_EXIT_S,
  AWAY_FULL_RESET_S,
  DT_CAP_S,
  DWELL_FACTOR,
  PITCH_ONLY_DWELL_MULT,
  RECAL_D_MAX,
  RECAL_D_MIN,
  RECAL_SUGGEST_S,
  SINK_D_MAX,
  SINK_D_MIN,
  TAU_METRIC_S,
  TAU_SCALE_S,
  THRESHOLDS
} from './constants'
import { EpisodeMachine, type EpisodeConfig } from './episodeMachine'
import { computeGeometry, computeRawMetrics } from './metrics'
import { MetricSmoother, ScaleOutlierGate } from './smoothing'
import { effThreshold, recThreshold, type ThresholdKind } from './stage'
import type { Frame, RawMetrics } from './types'

export interface EngineIssueSettings {
  enabled: boolean
  sensitivity: number
  notifyStages: [boolean, boolean, boolean]
}

export interface EngineSettings {
  issues: Record<IssueId, EngineIssueSettings>
  dwellSeconds: number
  cooldownMinutes: number
  escalation: boolean
}

const METRIC_KEYS = [
  'sink',
  'fwdGap',
  'fwdFace',
  'fwdPitch',
  'leanRoll',
  'leanTilt',
  'leanLateral',
  'leanSigned'
] as const
type MetricKey = (typeof METRIC_KEYS)[number]

/** Severity restricted to the user-enabled stages (docs/specs/detection.md §6). */
function stageWithin(
  value: number,
  bases: readonly [number, number, number],
  sigma: number,
  kind: ThresholdKind,
  mode: 'trigger' | 'recovery',
  enabled: readonly [boolean, boolean, boolean]
): Stage {
  const thr = mode === 'trigger' ? effThreshold : recThreshold
  let stage: Stage = 0
  for (let k = 0; k < 3; k++) {
    if (enabled[k] && value >= thr(bases[k], sigma, kind)) stage = (k + 1) as Stage
  }
  return stage
}

const ALL_STAGES: [boolean, boolean, boolean] = [true, true, true]

interface SubMetric {
  key: MetricKey
  bases: readonly [number, number, number]
  kind: ThresholdKind
}

const HEAD_FWD_SUBS: SubMetric[] = [
  { key: 'fwdGap', bases: THRESHOLDS.fwdGap, kind: 'linear' },
  { key: 'fwdFace', bases: THRESHOLDS.fwdFace, kind: 'linear' },
  { key: 'fwdPitch', bases: THRESHOLDS.fwdPitch, kind: 'linear' }
]
const LEAN_SUBS: SubMetric[] = [
  { key: 'leanRoll', bases: THRESHOLDS.leanRoll, kind: 'linear' },
  { key: 'leanTilt', bases: THRESHOLDS.leanTilt, kind: 'linear' },
  { key: 'leanLateral', bases: THRESHOLDS.leanLateral, kind: 'linear' }
]

/**
 * The per-frame pipeline (docs/specs/detection.md §9): geometry → presence →
 * outlier gate → smoothing → severity → episode machines → snapshot + alerts.
 * Fully deterministic in (frame, tMs) — no wall clock, no MediaPipe.
 */
export class PostureEngine {
  private baseline: CalibrationBaseline | null
  private settings: EngineSettings

  private smoothers = new Map<MetricKey, MetricSmoother>()
  private scaleSmoother = new MetricSmoother(TAU_SCALE_S)
  private gate = new ScaleOutlierGate()
  private machines = {} as Record<IssueId, EpisodeMachine>
  private pitchOnly = false

  private lastT: number | null = null
  private presence: PresenceState = 'active'
  private badMs = 0
  private goodMs = 0
  private awayStartT: number | null = null

  private recalOutMs = 0
  private recalSuggested = false

  constructor(baseline: CalibrationBaseline | null, settings: EngineSettings) {
    this.baseline = baseline
    this.settings = settings
    for (const key of METRIC_KEYS) this.smoothers.set(key, new MetricSmoother(TAU_METRIC_S))
    for (const issue of ISSUES) this.machines[issue] = new EpisodeMachine(issue, this.machineCfg(issue))
  }

  get presenceState(): PresenceState {
    return this.presence
  }

  setBaseline(baseline: CalibrationBaseline | null): void {
    this.baseline = baseline
    this.resetTransientState(true)
  }

  updateSettings(settings: EngineSettings): void {
    const prev = this.settings
    this.settings = settings
    for (const issue of ISSUES) {
      this.machines[issue].updateConfig(this.machineCfg(issue))
      if (prev.issues[issue].enabled && !settings.issues[issue].enabled) {
        this.machines[issue].reset(false)
      }
    }
  }

  processFrame(frame: Frame, tMs: number): { snapshot: PostureSnapshot; alerts: PostureAlert[] } {
    // cap Δt so a stall/sleep gap contributes at most DT_CAP to any accumulator
    const dtMs = this.lastT === null ? 0 : Math.min(Math.max(0, tMs - this.lastT), DT_CAP_S * 1000)
    this.lastT = tMs
    const dtS = dtMs / 1000

    const geo = computeGeometry(frame)
    this.stepPresence(geo.good, dtMs, tMs)
    const active = this.presence === 'active'

    let raw: RawMetrics = {}
    let frameUsable = false
    if (this.baseline !== null && active && geo.good) {
      raw = computeRawMetrics(geo, this.baseline)
      if (raw.scale !== undefined) {
        if (this.gate.check(raw.scale)) {
          frameUsable = true
          this.scaleSmoother.push(raw.scale, dtS)
        }
        // rejected scale = tracking glitch: discard the whole frame
      }
    }

    const D =
      this.baseline !== null && this.scaleSmoother.value !== null
        ? this.scaleSmoother.value / this.baseline.U0
        : null

    if (frameUsable) {
      const sinkGated = D === null || D < SINK_D_MIN || D > SINK_D_MAX
      for (const key of METRIC_KEYS) {
        // sink is held (not smoothed) outside the distance gate — geometry is
        // ambiguous there and the EMA must not ingest it
        if (key === 'sink' && sinkGated) continue
        const v = raw[key]
        if (v !== undefined) this.smoothers.get(key)!.push(v, dtS)
      }
    }

    // recalibration hint: view drifted far outside the calibrated distance
    if (active && D !== null) {
      if (D < RECAL_D_MIN || D > RECAL_D_MAX) {
        this.recalOutMs += dtMs
        if (this.recalOutMs >= RECAL_SUGGEST_S * 1000) this.recalSuggested = true
      } else {
        this.recalOutMs = 0
      }
    }
    // once the hint has fired and the view is still far off, all detectors are
    // suspended — alerts against a bogus baseline are worse than silence
    const driftSuspended = this.recalSuggested && D !== null && (D < RECAL_D_MIN || D > RECAL_D_MAX)

    const alerts: PostureAlert[] = []
    const issues = {} as Record<IssueId, IssueSnapshot>
    const leanSigned = this.smoothers.get('leanSigned')!.value
    const direction: 'left' | 'right' | undefined =
      leanSigned === null ? undefined : leanSigned > 0 ? 'left' : 'right'

    for (const issue of ISSUES) {
      const cfg = this.settings.issues[issue]
      const evalr = this.evaluateIssue(issue, cfg, raw, frameUsable, D)
      const dataAvailable =
        evalr.available && active && this.baseline !== null && cfg.enabled && !driftSuspended

      // face-only pitch tracking is slow-mode: looking down briefly is normal
      if (issue === 'headForward' && dataAvailable && evalr.pitchOnly !== this.pitchOnly) {
        this.pitchOnly = evalr.pitchOnly
        this.machines.headForward.updateConfig(this.machineCfg('headForward'))
      }

      // while AWAY the machines are frozen entirely — the spec's data-loss
      // reset applies only to visibility gaps while the user is present
      if (active) {
        const fired = this.machines[issue].step(
          { sevTrigger: evalr.sevTrigger, sevRecovery: evalr.sevRecovery, dataAvailable },
          tMs
        )
        for (const a of fired) alerts.push(issue === 'lean' && direction ? { ...a, direction } : a)
      }

      issues[issue] = {
        issue,
        stage: cfg.enabled ? evalr.displayStage : 0,
        activeForMs: cfg.enabled ? this.machines[issue].episodeActiveForMs(tMs) : null,
        metric: evalr.metric,
        ...(issue === 'lean' && direction ? { direction } : {})
      }
    }

    const worstStage = Math.max(...ISSUES.map((i) => issues[i].stage)) as Stage

    return {
      snapshot: {
        presence: this.presence,
        issues,
        worstStage,
        calibrated: this.baseline !== null,
        recalibrationSuggested: this.recalSuggested,
        ts: tMs
      },
      alerts
    }
  }

  private evaluateIssue(
    issue: IssueId,
    cfg: EngineIssueSettings,
    raw: RawMetrics,
    frameUsable: boolean,
    D: number | null
  ): {
    sevTrigger: Stage
    sevRecovery: Stage
    displayStage: Stage
    available: boolean
    metric: number
    pitchOnly: boolean
  } {
    const none = { sevTrigger: 0 as Stage, sevRecovery: 0 as Stage, displayStage: 0 as Stage, available: false, metric: 0, pitchOnly: false }
    if (!cfg.enabled || this.baseline === null) return none
    const sigma = cfg.sensitivity
    const en = cfg.notifyStages

    if (issue === 'sink') {
      const value = this.smoothers.get('sink')!.value
      const inDistanceGate = D !== null && D >= SINK_D_MIN && D <= SINK_D_MAX
      const available = frameUsable && raw.sink !== undefined && inDistanceGate
      if (value === null) return none
      return {
        sevTrigger: stageWithin(value, THRESHOLDS.sink, sigma, 'linear', 'trigger', en),
        sevRecovery: stageWithin(value, THRESHOLDS.sink, sigma, 'linear', 'recovery', en),
        displayStage: inDistanceGate
          ? stageWithin(value, THRESHOLDS.sink, sigma, 'linear', 'trigger', ALL_STAGES)
          : 0,
        available,
        metric: value,
        pitchOnly: false
      }
    }

    if (issue === 'tooClose') {
      const available = frameUsable && D !== null
      if (D === null) return none
      return {
        sevTrigger: stageWithin(D, THRESHOLDS.close, sigma, 'ratio', 'trigger', en),
        sevRecovery: stageWithin(D, THRESHOLDS.close, sigma, 'ratio', 'recovery', en),
        displayStage: stageWithin(D, THRESHOLDS.close, sigma, 'ratio', 'trigger', ALL_STAGES),
        available,
        metric: D,
        pitchOnly: false
      }
    }

    // multi-sub-metric issues: severity is the max across available subs
    const subs = issue === 'headForward' ? HEAD_FWD_SUBS : LEAN_SUBS
    let sevTrigger: Stage = 0
    let sevRecovery: Stage = 0
    let displayStage: Stage = 0
    let metric = 0
    let anyRawPresent = false
    for (const sub of subs) {
      const value = this.smoothers.get(sub.key)!.value
      if (raw[sub.key] !== undefined) anyRawPresent = true
      if (value === null) continue
      const t = stageWithin(value, sub.bases, sigma, sub.kind, 'trigger', en)
      const r = stageWithin(value, sub.bases, sigma, sub.kind, 'recovery', en)
      const d = stageWithin(value, sub.bases, sigma, sub.kind, 'trigger', ALL_STAGES)
      if (t > sevTrigger) sevTrigger = t
      if (r > sevRecovery) sevRecovery = r
      if (d > displayStage) {
        displayStage = d
        metric = value
      }
    }
    const pitchOnly =
      issue === 'headForward' &&
      raw.fwdPitch !== undefined &&
      raw.fwdGap === undefined &&
      raw.fwdFace === undefined
    return {
      sevTrigger,
      sevRecovery,
      displayStage,
      available: frameUsable && anyRawPresent,
      metric,
      pitchOnly
    }
  }

  private machineCfg(issue: IssueId): EpisodeConfig {
    const pitchMult = issue === 'headForward' && this.pitchOnly ? PITCH_ONLY_DWELL_MULT : 1
    return {
      dwellS: this.settings.dwellSeconds * DWELL_FACTOR[issue] * pitchMult,
      cooldownS: this.settings.cooldownMinutes * 60,
      escalation: this.settings.escalation
    }
  }

  private stepPresence(goodFrame: boolean, dtMs: number, tMs: number): void {
    if (this.presence === 'active') {
      if (goodFrame) {
        this.badMs = 0
      } else {
        this.badMs += dtMs
        if (this.badMs >= AWAY_ENTER_S * 1000) {
          this.presence = 'away'
          this.awayStartT = tMs - this.badMs
          this.goodMs = 0
        }
      }
    } else {
      if (goodFrame) {
        this.goodMs += dtMs
        if (this.goodMs >= AWAY_EXIT_S * 1000) {
          const awayDurMs = tMs - (this.awayStartT ?? tMs)
          this.presence = 'active'
          this.badMs = 0
          this.awayStartT = null
          // fresh eyes after any absence: reseed all smoothing state
          this.resetTransientState(false)
          if (awayDurMs > AWAY_FULL_RESET_S * 1000) {
            // the break itself fixed the posture — a fresh episode must earn a fresh dwell
            for (const issue of ISSUES) this.machines[issue].reset(true)
          }
        }
      } else {
        this.goodMs = 0
      }
    }
  }

  private resetTransientState(fullEpisodeReset: boolean): void {
    for (const s of this.smoothers.values()) s.reseed()
    this.scaleSmoother.reseed()
    this.gate.reset()
    this.recalOutMs = 0
    if (fullEpisodeReset) {
      this.recalSuggested = false
      for (const issue of ISSUES) this.machines[issue].reset(true)
    }
  }
}
