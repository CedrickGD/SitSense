import type { CalibrationBaseline } from '@shared/posture'
import { K_SH_PER_EAR, LM, R_EYE_FALLBACK, V_LM } from './constants'
import type { Frame, FrameGeometry, Landmark, Point, RawMetrics } from './types'

const mid = (a: Landmark, b: Landmark): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const dist = (a: Landmark, b: Landmark): number => Math.hypot(a.x - b.x, a.y - b.y)
const lineAngleDeg = (a: Landmark, b: Landmark): number =>
  (Math.atan2(a.y - b.y, a.x - b.x) * 180) / Math.PI

/** Wrap an angle delta into (−180, 180]. */
export function wrapDeg(d: number): number {
  const w = ((d + 180) % 360 + 360) % 360 - 180
  return w === -180 ? 180 : w
}

const EMPTY_GEOMETRY: FrameGeometry = {
  groups: { shoulders: false, ears: false, eyes: false, head: false },
  good: false,
  shMid: null,
  earMid: null,
  eyeMid: null,
  headMid: null,
  nose: null,
  sSh: null,
  sEar: null,
  sEye: null,
  headAngleDeg: null,
  headAngleSource: null,
  eyeAngleDeg: null,
  shAngleDeg: null
}

/** Per-frame primitives (docs/specs/detection.md §1). */
export function computeGeometry(frame: Frame, vThresh: number = V_LM): FrameGeometry {
  if (!frame || frame.length <= LM.rightShoulder) return EMPTY_GEOMETRY
  const usable = (i: number): boolean => (frame[i].visibility ?? 0) >= vThresh

  const shoulders = usable(LM.leftShoulder) && usable(LM.rightShoulder)
  const ears = usable(LM.leftEar) && usable(LM.rightEar)
  const eyes = usable(LM.leftEyeOuter) && usable(LM.rightEyeOuter)
  const head = usable(LM.nose) && (ears || eyes)

  const earMid = ears ? mid(frame[LM.leftEar], frame[LM.rightEar]) : null
  const eyeMid = eyes ? mid(frame[LM.leftEyeOuter], frame[LM.rightEyeOuter]) : null

  return {
    groups: { shoulders, ears, eyes, head },
    good: head || shoulders,
    shMid: shoulders ? mid(frame[LM.leftShoulder], frame[LM.rightShoulder]) : null,
    earMid,
    eyeMid,
    headMid: head ? (earMid ?? eyeMid) : null,
    nose: usable(LM.nose) ? { x: frame[LM.nose].x, y: frame[LM.nose].y } : null,
    sSh: shoulders ? dist(frame[LM.leftShoulder], frame[LM.rightShoulder]) : null,
    sEar: ears ? dist(frame[LM.leftEar], frame[LM.rightEar]) : null,
    sEye: eyes ? dist(frame[LM.leftEyeOuter], frame[LM.rightEyeOuter]) : null,
    headAngleDeg: ears
      ? lineAngleDeg(frame[LM.leftEar], frame[LM.rightEar])
      : eyes
        ? lineAngleDeg(frame[LM.leftEyeOuter], frame[LM.rightEyeOuter])
        : null,
    headAngleSource: ears ? 'ears' : eyes ? 'eyes' : null,
    eyeAngleDeg: eyes ? lineAngleDeg(frame[LM.leftEyeOuter], frame[LM.rightEyeOuter]) : null,
    shAngleDeg: shoulders ? lineAngleDeg(frame[LM.leftShoulder], frame[LM.rightShoulder]) : null
  }
}

/**
 * Unified scale s(t): shoulder width, falling back to ear/eye width scaled by
 * the calibrated ratios so all fallbacks express the same physical quantity.
 */
export function computeUnifiedScale(geo: FrameGeometry, baseline: CalibrationBaseline): number | null {
  if (geo.sSh !== null) return geo.sSh
  if (geo.sEar !== null) return geo.sEar * (baseline.REar ?? K_SH_PER_EAR)
  if (geo.sEye !== null) return geo.sEye * (baseline.REye ?? R_EYE_FALLBACK)
  return null
}

/** Face scale in "ear-distance" terms, eye fallback converted via calibration. */
function faceScale(geo: FrameGeometry, baseline: CalibrationBaseline): number | null {
  if (geo.sEar !== null) return geo.sEar
  if (geo.sEye !== null && baseline.sEar0 !== null && baseline.sEye0 !== null && baseline.sEye0 > 0) {
    return geo.sEye * (baseline.sEar0 / baseline.sEye0)
  }
  return null
}

/**
 * Raw metric values for the current frame (docs/specs/detection.md §5).
 * A metric is left undefined when its required landmarks are unavailable —
 * the engine holds its smoothed value and pauses the issue's timers.
 */
export function computeRawMetrics(geo: FrameGeometry, baseline: CalibrationBaseline): RawMetrics {
  const m: RawMetrics = {}
  const s = computeUnifiedScale(geo, baseline)
  if (s !== null && s > 0) m.scale = s

  // Issue 1 — sinking: weighted vertical drop in baseline shoulder-width units
  const dropSh =
    geo.shMid !== null && baseline.ySh0 !== null ? (geo.shMid.y - baseline.ySh0) / baseline.U0 : null
  const dropHd =
    geo.headMid !== null && baseline.yHd0 !== null ? (geo.headMid.y - baseline.yHd0) / baseline.U0 : null
  if (dropSh !== null && dropHd !== null) m.sink = 0.6 * dropSh + 0.4 * dropHd
  else if (dropSh !== null) m.sink = dropSh
  else if (dropHd !== null) m.sink = dropHd

  // Issue 2 — head-forward: gap shrink, face growth, pitch proxy
  if (geo.shMid !== null && geo.headMid !== null && baseline.h0 !== null && baseline.h0 > 0 && s !== null && s > 0) {
    const h = (geo.shMid.y - geo.headMid.y) / s
    m.fwdGap = (baseline.h0 - h) / baseline.h0
  }
  const sFace = faceScale(geo, baseline)
  if (sFace !== null && geo.sSh !== null && geo.sSh > 0 && baseline.r0 !== null && baseline.r0 > 0) {
    m.fwdFace = sFace / geo.sSh / baseline.r0 - 1
  }
  // pitch is compared against the baseline of the SAME reference line (ears or
  // eyes) — mixing them injects a constant bias larger than the slight threshold
  if (geo.nose !== null) {
    if (geo.earMid !== null && geo.sEar !== null && geo.sEar > 0 && baseline.p0 !== null) {
      m.fwdPitch = (geo.nose.y - geo.earMid.y) / geo.sEar - baseline.p0
    } else if (geo.eyeMid !== null && geo.sEye !== null && geo.sEye > 0 && baseline.pEye0 !== null) {
      // eye-referenced delta, converted into ear-scale units so the Pd
      // thresholds keep their meaning (0.75 ≈ anthropometric eye/ear ratio)
      const toEarUnits =
        baseline.sEye0 !== null && baseline.sEar0 !== null && baseline.sEar0 > 0
          ? baseline.sEye0 / baseline.sEar0
          : 0.75
      m.fwdPitch = ((geo.nose.y - geo.eyeMid.y) / geo.sEye - baseline.pEye0) * toEarUnits
    }
  }

  // Issue 3 — side lean: head roll, shoulder tilt, lateral offset
  if (geo.headAngleDeg !== null) {
    const ref = geo.headAngleSource === 'ears' ? baseline.phiHead0 : baseline.phiEye0
    if (ref !== null) m.leanRoll = Math.abs(wrapDeg(geo.headAngleDeg - ref))
  }
  if (geo.shAngleDeg !== null && baseline.phiSh0 !== null) {
    m.leanTilt = Math.abs(wrapDeg(geo.shAngleDeg - baseline.phiSh0))
  }
  if (geo.headMid !== null && geo.shMid !== null && baseline.o0 !== null && s !== null && s > 0) {
    m.leanSigned = (geo.headMid.x - geo.shMid.x) / s - baseline.o0
    m.leanLateral = Math.abs(m.leanSigned)
  }

  return m
}
