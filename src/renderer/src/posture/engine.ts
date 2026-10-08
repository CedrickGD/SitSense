// Posture engine v2 (docs/specs/detection.md §5, §6, §8, §9).
//
// Per frame: features (with the baseline's gravity) → presence → scale outlier
// gate → per-sub-metric deviations from the baseline → median-3 + EMA smoothing
// → staged severity (max over available sub-metrics) → episode machines →
// snapshot + alerts. Fully deterministic in (frame, tMs) — no wall clock, no
// MediaPipe.

import {
  ISSUES,
  type CalibrationBaseline,
  type IssueId,
  type IssueSnapshot,
  type PostureAlert,
  type PostureReadout,
  type PostureSnapshot,
  type PresenceState,
  type Stage,
  type Vec3
} from '@shared/posture'
import {
  AWAY_ENTER_S,
  AWAY_EXIT_DECAY,
  AWAY_EXIT_S,
  AWAY_FULL_RESET_S,
  DT_CAP_S,
  DWELL_FACTOR,
  HEAD_TURN_HOLD,
  LAT_MAX_YAW,
  LAT_GATE_HYST,
  LAT_YAW_SLACK,
  NECK_DROP_MAX_YAW,
  PITCH_ONLY_DWELL_MULT,
  PRESENCE_TRACK_GAP_S,
  PRESENCE_TRACK_JUMP_M,
  PRESENCE_TRACK_TURN_MAX,
  RECLINE_CRANE_GAIN,
  RECAL_D_MAX,
  RECAL_D_MIN,
  RECAL_SUGGEST_S,
  SHOULDER_CAMERA_MAX_YAW,
  STAGES,
  SUB_STALE_S,
  SWIVEL_HOLD,
  TAU_GATE_S,
  TAU_METRIC_S,
  TAU_SCALE_S
} from './constants'
import { EpisodeMachine, type EpisodeConfig } from './episodeMachine'
import { extractFeaturesChecked, type ExtractOptions } from './features'
import { MetricSmoother, ScaleOutlierGate } from './smoothing'
import { effThreshold, recThreshold } from './stage'
import type { Frame, FrameReject, PostureBaseline, PostureFeatures } from './types'
import { angleDeg, dot, neg, norm, reject, scale, sub, unit } from './vec'

export interface EngineIssueSettings {
  enabled: boolean
  /** σ ∈ [0.5, 2]; thresholds divide by it */
  sensitivity: number
  notifyStages: [boolean, boolean, boolean]
}

export interface EngineSettings {
  issues: Record<IssueId, EngineIssueSettings>
  dwellSeconds: number
  cooldownMinutes: number
  escalation: boolean
}

/** Every sub-metric of §5. Lateral ones are signed (+ = toward the person's left). */
export const SUB_METRICS = {
  sink: ['trunkFwd', 'drop', 'torso', 'recline'],
  headForward: ['neck', 'neckDrop', 'pitch'],
  lean: ['trunkLat', 'neckLat', 'shoulderTilt', 'headRoll'],
  tooClose: ['forward']
} as const satisfies { [I in IssueId]: ReadonlyArray<keyof (typeof STAGES)[I]> }

export type SubMetricId = (typeof SUB_METRICS)[IssueId][number]
type RawSubs = Partial<Record<SubMetricId, number>>

const ALL_SUBS: SubMetricId[] = ISSUES.flatMap((i) => [...SUB_METRICS[i]]) as SubMetricId[]
const SIGNED: ReadonlySet<SubMetricId> = new Set<SubMetricId>(['trunkLat', 'neckLat', 'shoulderTilt', 'headRoll'])
const ALL_STAGES: [boolean, boolean, boolean] = [true, true, true]

function bases(issue: IssueId, sub: SubMetricId): readonly [number, number, number] {
  return (STAGES[issue] as Record<string, readonly [number, number, number]>)[sub]
}

/** Severity restricted to the enabled stages; thresholds are linear (base / σ). */
function stageWithin(
  value: number,
  b: readonly [number, number, number],
  sigma: number,
  mode: 'trigger' | 'recovery',
  enabled: readonly [boolean, boolean, boolean]
): Stage {
  const thr = mode === 'trigger' ? effThreshold : recThreshold
  let stage: Stage = 0
  for (let k = 0; k < 3; k++) if (enabled[k] && value >= thr(b[k], sigma, 'linear')) stage = (k + 1) as Stage
  return stage
}

/**
 * What the baseline's neckLat was measured against (older baselines did not say: their
 * neckLat was trunk-referenced exactly when the trunk's lean was measured too).
 */
export const baselineNeckLatRef = (b: CalibrationBaseline): 'trunk' | 'gravity' =>
  b.neckLatRef ?? (b.trunkLat !== null ? 'trunk' : 'gravity')

/**
 * The extraction options that measure a frame the way the baseline was measured: its
 * gravity, its forward (orientation fallback and the body frame in a head + one
 * shoulder view), and its use of the hips (hips ignored during setup — hidden or judged
 * hallucinated — stay ignored, so every body reference matches the baseline's). Presence is
 * held to the baseline's gravity when its pitch was measured, and to a depth bound relative
 * to the baseline's own distance (ExtractOptions.baselinePpm).
 */
export const extractOptionsFor = (b: CalibrationBaseline): ExtractOptions => ({
  up: b.up,
  upSource: b.upSource,
  forwardHint: b.forward,
  hips: b.trunkFwd !== null,
  gravityKnown: baselinePitchKnown(b),
  baselinePpm: b.ppm
})

/**
 * The baseline's camera pitch was measured, so the presence check may hold a frame to its
 * gravity (ExtractOptions.gravityKnown): thigh gravity, or a hip line (its perspective, or —
 * facing the camera — refined by the captured trunk). In the simulator both are within ~11°
 * of the truth. Camera-only gravity is not: without a trunk it keeps the pitch it assumed
 * (20° off from a camera looking up at the user), and the trunk refinement of a turned body
 * recovers only ~cos(yaw) of the pitch (23–30° off at 60° yaw).
 */
export const baselinePitchKnown = (b: CalibrationBaseline): boolean => b.upSource !== 'camera'

/**
 * Raw per-frame deviations from the baseline (§5). Positive = worse, except the
 * signed lateral ones. `ppmSmoothed` rescales positions to the smoothed scale.
 * `f` must be extracted with extractOptionsFor(b). Exported for tests and diagnostics.
 *
 * Holds (a sub-metric is left out, so the smoother keeps its last value):
 * - an unknown camera tilt leaks into gravity-referenced angles as the body swivels
 *   (≈ tilt·(cos ψ − 1) sagittally, asin(sin tilt · sin ψ) laterally). While the body is
 *   swiveled > SWIVEL_HOLD from the baseline, the lateral gravity-referenced ones
 *   (shoulderTilt, gravity-referenced neckLat) are held for every gravity source, and
 *   the sagittal ones (trunkFwd, neck, neckDrop, pitch) unless gravity came from the
 *   thighs. Head pitch is also held without thigh gravity while the head is turned
 *   > HEAD_TURN_HOLD.
 * - with only one ear in the frame and the head turned (or the nose hidden), every
 *   head metric is held: the neck vector rides on that ear.
 */
export function computeDeviations(
  f: PostureFeatures,
  b: CalibrationBaseline,
  opts: {
    ppmSmoothed?: number | null
    /** smoothed swivel / view yaw for the gates (default: this frame's) */
    swivelDeg?: number | null
    yawDeg?: number | null
    /** lateral gate decided by the caller (the engine's hysteresis on the smoothed yaw); default: yaw < LAT_MAX_YAW */
    lateralOk?: boolean
    /** smoothed head yaw relative to the body (default: this frame's) */
    headYawDeg?: number | null
  } = {}
): { subs: RawSubs; swivelDeg: number } {
  const subs: RawSubs = {}
  const U = f.up
  const fwd0 = unit(reject(b.forward, U)) ?? b.forward
  const frameSwivel = angleDeg(f.forward, fwd0)
  const swivelDeg = opts.swivelDeg ?? frameSwivel
  const yawDeg = opts.yawDeg ?? f.view.yawDeg
  const lateralOk = opts.lateralOk ?? yawDeg < LAT_MAX_YAW
  const swiveled = swivelDeg > SWIVEL_HOLD
  // without thigh gravity, sagittal angles carry an unknown camera tilt that a swivel changes
  const sagittalHeld = swiveled && b.upSource !== 'body'

  // positions: rescale to the smoothed scale (anchor ∝ 1/ppm)
  let anchor = f.anchor
  if (anchor && f.ppm && opts.ppmSmoothed) anchor = scale(anchor, f.ppm / opts.ppmSmoothed)

  // With only one ear in the frame, the neck vector rides on that ear, which a head turn
  // moves forward/back (±7.5 cm·sin yaw): every neck-based metric is held then.
  // (no head yaw at all = the nose is hidden: the head is turned away)
  const headYaw = opts.headYawDeg ?? f.headYaw
  const headTurned = headYaw === null || Math.abs(headYaw) > HEAD_TURN_HOLD
  const headTurnedOneEar = !f.earsBoth && headTurned
  const headHeld = headTurnedOneEar || sagittalHeld

  // sink
  if (!sagittalHeld && f.trunkFwd !== null && b.trunkFwd !== null) subs.trunkFwd = f.trunkFwd - b.trunkFwd
  if (anchor) subs.drop = dot(sub(anchor, b.anchor), neg(U)) * 100
  if (f.torsoLen !== null && b.torsoLen !== null && b.torsoLen > 0) subs.torso = 1 - f.torsoLen / b.torsoLen
  // recline-slump ("lying in the chair"): the trunk reclined since the baseline AND the neck
  // craned forward on it to keep the eyes on the screen. The neck-on-trunk change is
  // gravity-free; the recline is a deviation of the trunk's lean, held with it. Leaning back
  // with the head going along, or a forward head without a recline, scores ~0
  if (!headHeld && f.trunkFwd !== null && b.trunkFwd !== null) {
    const recline = b.trunkFwd - f.trunkFwd
    // like with like: the gravity-free neck-on-trunk angle when the baseline has it (older
    // baselines: the same difference of the baseline-gravity angles, where a constant tilt cancels)
    const n0 = (b as PostureBaseline).neckOnTrunk
    const crane =
      typeof n0 === 'number' && typeof f.neckOnTrunk === 'number'
        ? f.neckOnTrunk - n0
        : f.neckFwd - f.trunkFwd - (b.neckFwd - b.trunkFwd)
    subs.recline = Math.min(recline, RECLINE_CRANE_GAIN * crane)
  }

  // head forward
  if (!headHeld) subs.neck = f.neckFwd - b.neckFwd
  if (
    !headHeld &&
    f.neckH !== null &&
    b.neckH !== null &&
    b.neckH > 0 &&
    f.view.yawDeg < NECK_DROP_MAX_YAW &&
    b.view.yawDeg < NECK_DROP_MAX_YAW
  ) {
    subs.neckDrop = 1 - f.neckH / b.neckH
  }
  // an unknown camera tilt also leaks into head pitch as the head turns (no thigh gravity)
  const pitchHeld = headHeld || (b.upSource !== 'body' && headTurned)
  if (!pitchHeld && f.headPitch !== null && b.headPitch !== null) subs.pitch = f.headPitch - b.headPitch

  // lean (signed, + = toward the person's left)
  if (lateralOk && f.trunkLat !== null && b.trunkLat !== null) subs.trunkLat = f.trunkLat - b.trunkLat
  // neckLat: only like minus like (trunk-relative vs gravity-referenced). The
  // trunk-relative one is gravity-free; the gravity-referenced one is held on a swivel
  if (lateralOk && f.neckLat !== null && b.neckLat !== null && f.neckLatRef === baselineNeckLatRef(b)) {
    if (!(f.neckLatRef === 'gravity' && swiveled)) subs.neckLat = f.neckLat - b.neckLat
  }
  // shoulderTilt / headRollRel are "+ = left side higher", which is a tilt toward
  // the RIGHT — negate so every lean sub-metric reads "+ = toward the left"
  const shoulderOk = lateralOk && (b.upSource !== 'camera' || yawDeg <= SHOULDER_CAMERA_MAX_YAW)
  if (shoulderOk && f.shoulderTilt !== null && b.shoulderTilt !== null && !swiveled) {
    subs.shoulderTilt = -(f.shoulderTilt - b.shoulderTilt)
  }
  if (lateralOk && f.headRollRel !== null && b.headRollRel !== null) subs.headRoll = -(f.headRollRel - b.headRollRel)

  // too close
  if (anchor) subs.forward = dot(sub(anchor, b.anchor), fwd0) * 100

  return { subs, swivelDeg: frameSwivel }
}

interface IssueEval {
  sevTrigger: Stage
  sevRecovery: Stage
  displayStage: Stage
  available: boolean
  metric: number
  /** signed value of the dominant sub-metric (lean direction) */
  signed: number | null
  pitchOnly: boolean
}

/** One frame of the tracked user: time, shoulder anchor and neck (head − anchor), camera metres. */
interface TrackPoint {
  t: number
  anchor: Vec3
  neck: Vec3
}

/**
 * The per-frame pipeline. Public shape is unchanged from v1:
 * `new PostureEngine(baseline, settings)`, `setBaseline`, `updateSettings`,
 * `processFrame(frame, tMs) → { snapshot, alerts }`, `presenceState`; plus
 * `lastFeatures` (overlay) and `snapshot.readout` (UI).
 */
export class PostureEngine {
  private baseline: CalibrationBaseline | null
  private settings: EngineSettings

  private smoothers = new Map<SubMetricId, MetricSmoother>()
  private scaleSmoother = new MetricSmoother(TAU_SCALE_S)
  private swivelSmoother = new MetricSmoother(TAU_GATE_S)
  private yawSmoother = new MetricSmoother(TAU_GATE_S)
  /** lateral gate state (Schmitt trigger on the smoothed view yaw) */
  private lateralOn = true
  private headYawSmoother = new MetricSmoother(TAU_GATE_S)
  /** last time each sub-metric had a fresh value (stale ones stop driving severity) */
  private freshAt = new Map<SubMetricId, number>()
  private gate = new ScaleOutlierGate()
  private machines = {} as Record<IssueId, EpisodeMachine>
  private pitchOnly = false

  private lastT: number | null = null
  /**
   * starts 'away': nobody counts as present (sitting, judged) until AWAY_EXIT_S of real
   * landmarks — an app launched at login must not open a sitting stretch for an empty chair
   */
  private presence: PresenceState = 'away'
  private badMs = 0
  private goodMs = 0
  private awayStartT: number | null = null

  private recalOutMs = 0
  /** time back in range while the hint is up (it is withdrawn after RECAL_SUGGEST_S) */
  private recalInMs = 0
  private recalSuggested = false

  private features: PostureFeatures | null = null
  private reject: FrameReject | null = 'no-pose'
  /** the tracked user's latest frame (stepTrack), and a run of GOOD frames that may become one */
  private track: TrackPoint | null = null
  private streak: { since: number; last: TrackPoint } | null = null
  private avail: Record<IssueId, boolean> = { sink: false, headForward: false, lean: false, tooClose: false }

  constructor(baseline: CalibrationBaseline | null, settings: EngineSettings) {
    this.baseline = baseline
    this.settings = settings
    for (const key of ALL_SUBS) this.smoothers.set(key, new MetricSmoother(TAU_METRIC_S))
    for (const issue of ISSUES) this.machines[issue] = new EpisodeMachine(issue, this.machineCfg(issue))
  }

  get presenceState(): PresenceState {
    return this.presence
  }

  /** Latest GOOD frame's features (computed with the baseline's gravity when calibrated). */
  get lastFeatures(): PostureFeatures | null {
    return this.features
  }

  /**
   * Why the last frame was BAD (null when it was GOOD; see FrameReject). 'too-far' and
   * 'not-upright' are a pose that is not the user (a figure on the desk, a poster, someone
   * behind them): the UI should not say it sees the user.
   */
  get frameReject(): FrameReject | null {
    return this.reject
  }

  /** The options frames are measured with: the baseline's (extractOptionsFor), none uncalibrated. */
  get extractOptions(): ExtractOptions {
    return this.baseline ? extractOptionsFor(this.baseline) : {}
  }

  /** Whether each issue had measurable data on the last processed frame. */
  get availability(): Readonly<Record<IssueId, boolean>> {
    return this.avail
  }

  /**
   * The smoothed value of every sub-metric that is currently driving its issue (fresh
   * within SUB_STALE_S), keyed by sub-metric (§5 units; lateral ones signed, + = toward
   * the person's left). For diagnostics and tests.
   */
  get subMetrics(): Partial<Record<SubMetricId, number>> {
    const out: Partial<Record<SubMetricId, number>> = {}
    const now = this.lastT ?? 0
    for (const key of ALL_SUBS) {
      const fresh = this.freshAt.get(key)
      const v = this.smoothers.get(key)!.value
      if (fresh !== undefined && now - fresh <= SUB_STALE_S * 1000 && v !== null) out[key] = v
    }
    return out
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
      if (prev.issues[issue].enabled && !settings.issues[issue].enabled) this.machines[issue].reset(false)
    }
  }

  processFrame(frame: Frame, tMs: number): { snapshot: PostureSnapshot; alerts: PostureAlert[] } {
    // no frames for longer than a full-reset absence (pause, system sleep, camera restart):
    // presence never saw it, so treat it as that absence here — reseed and reset the episodes
    if (this.lastT !== null && tMs - this.lastT > AWAY_FULL_RESET_S * 1000) {
      this.badMs = 0
      this.goodMs = 0
      // nobody has been seen across the gap: presence must be confirmed again
      this.presence = 'away'
      this.awayStartT = this.lastT
      this.resetTransientState(false)
      for (const issue of ISSUES) this.machines[issue].reset(true)
    }
    const dtMs = this.lastT === null ? 0 : Math.min(Math.max(0, tMs - this.lastT), DT_CAP_S * 1000)
    this.lastT = tMs
    const dtS = dtMs / 1000
    const b = this.baseline

    // lateral features a little past the limit: the smoothed-yaw gate in computeDeviations decides
    const opts: ExtractOptions = b ? { ...extractOptionsFor(b), lateralMaxYaw: LAT_MAX_YAW + LAT_YAW_SLACK } : {}
    let checked = extractFeaturesChecked(frame, opts)
    // A measured gravity rejects a flat figure in any orientation, but it goes stale when the
    // webcam is re-aimed (or a baseline is kept for another camera): a user lying back 50° then
    // reads as lying flat. The tracked user (track) stays the user while the pitch-free test
    // still passes; a pose that appears out of nowhere is held to that gravity.
    const tracked = this.trackAlive(tMs) && this.presence === 'active'
    let chained = false
    if (tracked && checked.reject === 'not-upright' && opts.gravityKnown) {
      const loose = extractFeaturesChecked(frame, { ...opts, gravityKnown: false })
      if (loose.features && this.continuesTrack(loose.features, this.track!)) {
        checked = loose
        chained = true
      }
    }
    const f = checked.features
    this.stepTrack(f, tMs, chained)
    this.features = f
    this.reject = checked.reject
    this.stepPresence(f !== null, dtMs, tMs)
    const active = this.presence === 'active'

    let raw: RawSubs = {}
    let frameUsable = false
    if (b !== null && active && f !== null) {
      if (f.ppm === null || this.gate.check(f.ppm)) {
        frameUsable = true
        if (f.ppm !== null) this.scaleSmoother.push(f.ppm, dtS)
        const fwd0 = unit(reject(b.forward, f.up)) ?? b.forward
        this.swivelSmoother.push(angleDeg(f.forward, fwd0), dtS)
        this.yawSmoother.push(f.view.yawDeg, dtS)
        // lateral metrics switch with hysteresis on the smoothed yaw (no flicker at the limit)
        const sy = this.yawSmoother.value ?? f.view.yawDeg
        this.lateralOn = this.lateralOn ? sy < LAT_MAX_YAW + LAT_GATE_HYST : sy < LAT_MAX_YAW - LAT_GATE_HYST
        if (f.headYaw !== null) this.headYawSmoother.push(f.headYaw, dtS)
        raw = computeDeviations(f, b, {
          ppmSmoothed: this.scaleSmoother.value,
          swivelDeg: this.swivelSmoother.value,
          yawDeg: this.yawSmoother.value,
          lateralOk: this.lateralOn,
          headYawDeg: f.headYaw !== null ? this.headYawSmoother.value : null
        }).subs
      }
      // a rejected scale is a tracking glitch: the whole frame is discarded
    }
    if (frameUsable) {
      for (const key of ALL_SUBS) {
        const v = raw[key]
        if (v !== undefined && Number.isFinite(v)) {
          this.smoothers.get(key)!.push(v, dtS)
          this.freshAt.set(key, tMs)
        }
      }
    }

    const D = b !== null && this.scaleSmoother.value !== null ? this.scaleSmoother.value / b.ppm : null
    if (active && D !== null) {
      if (D < RECAL_D_MIN || D > RECAL_D_MAX) {
        this.recalInMs = 0
        this.recalOutMs += dtMs
        if (this.recalOutMs >= RECAL_SUGGEST_S * 1000) this.recalSuggested = true
      } else {
        this.recalOutMs = 0
        if (this.recalSuggested) {
          // back in range as long as it took to raise the hint: the view matches setup again
          // (a camera that really moved keeps D out of range, and the hint up)
          this.recalInMs += dtMs
          if (this.recalInMs >= RECAL_SUGGEST_S * 1000) {
            this.recalSuggested = false
            this.recalInMs = 0
          }
        }
      }
    }
    // once the hint has fired and the view is still far off, all detectors pause
    const driftSuspended = this.recalSuggested && D !== null && (D < RECAL_D_MIN || D > RECAL_D_MAX)

    const alerts: PostureAlert[] = []
    const issues = {} as Record<IssueId, IssueSnapshot>
    for (const issue of ISSUES) {
      const cfg = this.settings.issues[issue]
      const ev = this.evaluateIssue(issue, cfg, frameUsable, tMs)
      this.avail[issue] = ev.available
      const dataAvailable = ev.available && active && b !== null && cfg.enabled && !driftSuspended

      if (issue === 'headForward' && dataAvailable && ev.pitchOnly !== this.pitchOnly) {
        this.pitchOnly = ev.pitchOnly
        this.machines.headForward.updateConfig(this.machineCfg('headForward'))
      }

      const direction: 'left' | 'right' | undefined =
        issue === 'lean' && ev.signed !== null && ev.signed !== 0 ? (ev.signed > 0 ? 'left' : 'right') : undefined

      // while AWAY the machines are frozen entirely
      if (active) {
        const fired = this.machines[issue].step(
          { sevTrigger: ev.sevTrigger, sevRecovery: ev.sevRecovery, dataAvailable },
          tMs
        )
        for (const a of fired) alerts.push(direction ? { ...a, direction } : a)
      }

      issues[issue] = {
        issue,
        stage: cfg.enabled && !driftSuspended ? ev.displayStage : 0,
        activeForMs: cfg.enabled ? this.machines[issue].episodeActiveForMs(tMs) : null,
        metric: ev.metric,
        ...(direction ? { direction } : {})
      }
    }

    const worstStage = Math.max(...ISSUES.map((i) => issues[i].stage)) as Stage
    // `suspended`: every detector is paused (the view is far off the setup distance); the UI
    // (score.ts isSuspended, liveModel statusView), main (stats, tray) and the coach read it
    const snapshot: PostureSnapshot = {
      presence: this.presence,
      issues,
      worstStage,
      calibrated: b !== null,
      recalibrationSuggested: this.recalSuggested,
      suspended: driftSuspended,
      ts: tMs
    }
    const readout = this.readout(f, active)
    if (readout) snapshot.readout = readout
    return { snapshot, alerts }
  }

  private readout(f: PostureFeatures | null, active: boolean): PostureReadout | null {
    if (!this.baseline || !active || !f) return null
    const v = (k: SubMetricId): number | null => {
      const fresh = this.freshAt.get(k)
      return fresh !== undefined && (this.lastT ?? 0) - fresh <= SUB_STALE_S * 1000 ? this.smoothers.get(k)!.value : null
    }
    const trunkLat = v('trunkLat')
    const neckLat = trunkLat === null ? v('neckLat') : null
    return {
      view: f.view.kind,
      neckFwd: v('neck'),
      trunkFwd: v('trunkFwd'),
      drop: v('drop'),
      forward: v('forward'),
      lateral: trunkLat ?? neckLat,
      // the neck tilt has its own stage thresholds: the gauge must follow the source
      lateralFrom: trunkLat === null && neckLat !== null ? 'neck' : 'trunk'
    }
  }

  private evaluateIssue(issue: IssueId, cfg: EngineIssueSettings, frameUsable: boolean, tMs: number): IssueEval {
    const none: IssueEval = {
      sevTrigger: 0,
      sevRecovery: 0,
      displayStage: 0,
      available: false,
      metric: 0,
      signed: null,
      pitchOnly: false
    }
    if (!cfg.enabled || this.baseline === null) return none
    const sigma = cfg.sensitivity
    const en = cfg.notifyStages
    let sevTrigger: Stage = 0
    let sevRecovery: Stage = 0
    let displayStage: Stage = 0
    let metric = 0
    let signed: number | null = null
    let bestRatio = -Infinity
    let anyFresh = false
    // lean direction: consensus of the signed sub-metrics, each in units of its own
    // stage-1 threshold, so one noisy sub-metric cannot flip the side on its own
    let signedSum = 0
    const disp: Partial<Record<SubMetricId, Stage>> = {}
    for (const sub of SUB_METRICS[issue] as readonly SubMetricId[]) {
      // a sub-metric that is unavailable this frame holds its smoothed value (§6),
      // but only briefly: a long-stale value must not keep an episode alive on its own
      const fresh = this.freshAt.get(sub)
      if (fresh === undefined || tMs - fresh > SUB_STALE_S * 1000) continue
      const sv = this.smoothers.get(sub)!.value
      if (sv === null) continue
      anyFresh = true
      const value = SIGNED.has(sub) ? Math.abs(sv) : sv
      const b = bases(issue, sub)
      const t = stageWithin(value, b, sigma, 'trigger', en)
      const r = stageWithin(value, b, sigma, 'recovery', en)
      const d = stageWithin(value, b, sigma, 'trigger', ALL_STAGES)
      disp[sub] = d
      if (t > sevTrigger) sevTrigger = t
      if (r > sevRecovery) sevRecovery = r
      const ratio = value / effThreshold(b[0], sigma, 'linear')
      if (SIGNED.has(sub)) signedSum += sv / effThreshold(b[0], sigma, 'linear')
      if (d > displayStage || (d === displayStage && ratio > bestRatio)) {
        displayStage = Math.max(displayStage, d) as Stage
        bestRatio = ratio
        metric = sv
      }
    }
    if (issue === 'lean' && anyFresh) signed = signedSum
    const pitchOnly =
      issue === 'headForward' && (disp.pitch ?? 0) >= 1 && (disp.neck ?? 0) === 0 && (disp.neckDrop ?? 0) === 0
    return { sevTrigger, sevRecovery, displayStage, available: frameUsable && anyFresh, metric, signed, pitchOnly }
  }

  private machineCfg(issue: IssueId): EpisodeConfig {
    const pitchMult = issue === 'headForward' && this.pitchOnly ? PITCH_ONLY_DWELL_MULT : 1
    return {
      dwellS: this.settings.dwellSeconds * DWELL_FACTOR[issue] * pitchMult,
      cooldownS: this.settings.cooldownMinutes * 60,
      escalation: this.settings.escalation
    }
  }

  /** The track's last frame is at most PRESENCE_TRACK_GAP_S old. */
  private trackAlive(tMs: number): boolean {
    return this.track !== null && tMs - this.track.t <= PRESENCE_TRACK_GAP_S * 1000
  }

  /** The frame's body continues `ref`: shoulders within PRESENCE_TRACK_JUMP_M, neck within PRESENCE_TRACK_TURN_MAX. */
  private continuesTrack(f: PostureFeatures, ref: TrackPoint): boolean {
    if (!f.anchor || !f.head) return false
    return (
      norm(sub(f.anchor, ref.anchor)) <= PRESENCE_TRACK_JUMP_M &&
      angleDeg(sub(f.head, f.anchor), ref.neck) <= PRESENCE_TRACK_TURN_MAX
    )
  }

  /**
   * The tracked user: established by AWAY_EXIT_S of fully GOOD frames that each continue the
   * previous one (what makes the user present in the first place — a figure that slips through
   * on a noisy frame now and then never builds one), then followed by every GOOD frame (also a
   * chained one) that continues it. Lost after PRESENCE_TRACK_GAP_S without such a frame.
   */
  private stepTrack(f: PostureFeatures | null, tMs: number, chained: boolean): void {
    const pt: TrackPoint | null = f?.anchor && f.head ? { t: tMs, anchor: f.anchor, neck: sub(f.head, f.anchor) } : null
    if (this.trackAlive(tMs)) {
      if (pt && (chained || this.continuesTrack(f!, this.track!))) this.track = pt
      return
    }
    this.track = null
    if (!pt || chained) {
      if (this.streak && tMs - this.streak.last.t > PRESENCE_TRACK_GAP_S * 1000) this.streak = null
      return
    }
    const s = this.streak
    if (s && tMs - s.last.t <= PRESENCE_TRACK_GAP_S * 1000 && this.continuesTrack(f!, s.last)) {
      s.last = pt
      if (tMs - s.since >= AWAY_EXIT_S * 1000) {
        this.track = pt
        this.streak = null
      }
    } else {
      this.streak = { since: tMs, last: pt }
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
    } else if (goodFrame) {
      this.goodMs += dtMs
      if (this.goodMs >= AWAY_EXIT_S * 1000) {
        const awayDurMs = tMs - (this.awayStartT ?? tMs)
        this.presence = 'active'
        this.badMs = 0
        this.awayStartT = null
        // fresh eyes after any absence: reseed all smoothing state
        this.resetTransientState(false)
        // the break itself fixed the posture — a fresh episode must earn a fresh dwell
        if (awayDurMs > AWAY_FULL_RESET_S * 1000) for (const issue of ISSUES) this.machines[issue].reset(true)
      }
    } else {
      // detection flickers in poor light: a gap takes back part of the GOOD time, not all of it
      this.goodMs = Math.max(0, this.goodMs - dtMs * AWAY_EXIT_DECAY)
    }
  }

  private resetTransientState(fullEpisodeReset: boolean): void {
    for (const s of this.smoothers.values()) s.reseed()
    this.scaleSmoother.reseed()
    this.swivelSmoother.reseed()
    this.yawSmoother.reseed()
    this.lateralOn = true
    this.headYawSmoother.reseed()
    this.freshAt.clear()
    this.gate.reset()
    this.recalOutMs = 0
    this.recalInMs = 0
    this.pitchOnly = false
    for (const issue of ISSUES) this.machines[issue].updateConfig(this.machineCfg(issue))
    if (fullEpisodeReset) {
      this.recalSuggested = false
      for (const issue of ISSUES) this.machines[issue].reset(true)
    }
  }
}
