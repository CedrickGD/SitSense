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
  // a face-only baseline (U0 derived from the ears/eyes) must keep measuring in
  // those units — mixing in raw shoulder width would read as "too close"
  if (geo.sSh !== null && baseline.sSh0 !== null) return geo.sSh
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

interface HeadRef {
  mid: Point
  yHd0: number | null
  h0: number | null
  o0: number | null
}

/**
 * The head position and the baseline it must be compared with. Ears and eyes
 * sit at different heights, so a head measured from the eyes against an
 * ear-referenced baseline reads as a constant sink/forward bias — pick the
 * reference line the baseline actually captured.
 */
function headReference(geo: FrameGeometry, baseline: CalibrationBaseline): HeadRef | null {
  if (geo.earMid !== null && baseline.capabilities.ears) {
    return { mid: geo.earMid, yHd0: baseline.yHd0, h0: baseline.h0, o0: baseline.o0 }
  }
  if (geo.eyeMid !== null && baseline.yHdEye0 != null) {
    return { mid: geo.eyeMid, yHd0: baseline.yHdEye0, h0: baseline.hEye0 ?? null, o0: baseline.oEye0 ?? null }
  }
  // baselines from before the eye-referenced twins existed: legacy behavior
  return geo.headMid !== null ? { mid: geo.headMid, yHd0: baseline.yHd0, h0: baseline.h0, o0: baseline.o0 } : null
}

/**
 * Pitch-proxy denominator. Turning the head (looking at a side monitor)
 * foreshortens the ear/eye line and would inflate the pitch reading; the
 * shoulder-predicted face width isn't affected, so take whichever is less
 * foreshortened.
 */
function yawRobust(faceWidth: number, geo: FrameGeometry, baseline: CalibrationBaseline, unitsPerEar: number): number {
  if (geo.sSh === null || baseline.r0 === null || baseline.r0 <= 0) return faceWidth
  return Math.max(faceWidth, geo.sSh * baseline.r0 * unitsPerEar)
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

  const head = headReference(geo, baseline)

  // Issue 1 — sinking: weighted vertical drop in baseline shoulder-width units
  const dropSh =
    geo.shMid !== null && baseline.ySh0 !== null ? (geo.shMid.y - baseline.ySh0) / baseline.U0 : null
  const dropHd = head !== null && head.yHd0 !== null ? (head.mid.y - head.yHd0) / baseline.U0 : null
  if (dropSh !== null && dropHd !== null) m.sink = 0.6 * dropSh + 0.4 * dropHd
  else if (dropSh !== null) m.sink = dropSh
  else if (dropHd !== null) m.sink = dropHd

  // Issue 2 — head-forward: gap shrink, face growth, pitch proxy
  if (geo.shMid !== null && head !== null && head.h0 !== null && head.h0 > 0 && s !== null && s > 0) {
    const h = (geo.shMid.y - head.mid.y) / s
    m.fwdGap = (head.h0 - h) / head.h0
  }
  const sFace = faceScale(geo, baseline)
  if (sFace !== null && geo.sSh !== null && geo.sSh > 0 && baseline.r0 !== null && baseline.r0 > 0) {
    m.fwdFace = sFace / geo.sSh / baseline.r0 - 1
  }
  // pitch is compared against the baseline of the SAME reference line (ears or
  // eyes) — mixing them injects a constant bias larger than the slight threshold
  if (geo.nose !== null) {
    // eye widths per ear width (0.75 ≈ anthropometric ratio when uncalibrated)
    const eyePerEar =
      baseline.sEye0 !== null && baseline.sEar0 !== null && baseline.sEar0 > 0
        ? baseline.sEye0 / baseline.sEar0
        : 0.75
    if (geo.earMid !== null && geo.sEar !== null && geo.sEar > 0 && baseline.p0 !== null) {
      m.fwdPitch = (geo.nose.y - geo.earMid.y) / yawRobust(geo.sEar, geo, baseline, 1) - baseline.p0
    } else if (geo.eyeMid !== null && geo.sEye !== null && geo.sEye > 0 && baseline.pEye0 !== null) {
      // eye-referenced delta, converted into ear-scale units so the Pd
      // thresholds keep their meaning
      m.fwdPitch =
        ((geo.nose.y - geo.eyeMid.y) / yawRobust(geo.sEye, geo, baseline, eyePerEar) - baseline.pEye0) * eyePerEar
    }
  }

  // Issue 3 — side lean: head roll, shoulder tilt, lateral offset
  // (in the unmirrored frame the model sees, positive deltas all mean
  // "toward the person's left")
  if (geo.headAngleDeg !== null) {
    const ref = geo.headAngleSource === 'ears' ? baseline.phiHead0 : baseline.phiEye0
    if (ref !== null) {
      m.leanRollSigned = wrapDeg(geo.headAngleDeg - ref)
      m.leanRoll = Math.abs(m.leanRollSigned)
    }
  }
  if (geo.shAngleDeg !== null && baseline.phiSh0 !== null) {
    m.leanTiltSigned = wrapDeg(geo.shAngleDeg - baseline.phiSh0)
    m.leanTilt = Math.abs(m.leanTiltSigned)
  }
  if (head !== null && geo.shMid !== null && head.o0 !== null && s !== null && s > 0) {
    m.leanSigned = (head.mid.x - geo.shMid.x) / s - head.o0
    m.leanLateral = Math.abs(m.leanSigned)
  }

  return m
}
