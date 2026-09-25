import type { CalibrationBaseline } from '@shared/posture'
import {
  CAL_DURATION_S,
  CAL_MAX_CV,
  CAL_MIN_FRAMES,
  K_SH_PER_EAR,
  R_EYE_FALLBACK,
  V_CAL
} from './constants'
import { computeGeometry, wrapDeg } from './metrics'
import type { Frame } from './types'

/** 'interrupted' is set by the controller when the camera goes away mid-capture */
export type CalibrationFailure = 'not-enough-frames' | 'unstable' | 'face-camera' | 'interrupted'

export type CalibrationResult = { ok: true; baseline: CalibrationBaseline } | { ok: false; reason: CalibrationFailure }

/**
 * Nose offset from the ear (or eye) midpoint, in face widths, above which the
 * head is turned too far (~15–20°) for a baseline: a yawed face bakes a
 * foreshortened face width and pitch into it, and facing the camera normally
 * afterwards then reads as "head forward".
 */
const MAX_CAL_YAW = 0.2

/**
 * Collects frames while the user sits upright, then aggregates every stored
 * quantity with the MEDIAN across valid frames (robust to blinks and jitter).
 * See docs/specs/detection.md §3.
 */
export class CalibrationSession {
  private readonly startMs: number
  private readonly samples = {
    sSh: [] as number[],
    sEar: [] as number[],
    sEye: [] as number[],
    ySh: [] as number[],
    yHdEar: [] as number[],
    yHdEye: [] as number[],
    hEar: [] as number[],
    hEye: [] as number[],
    oEar: [] as number[],
    oEye: [] as number[],
    r: [] as number[],
    p: [] as number[],
    pEye: [] as number[],
    phiHead: [] as number[],
    phiEye: [] as number[],
    phiSh: [] as number[]
  }
  private valid = 0
  private yawed = 0

  constructor(startMs: number) {
    this.startMs = startMs
  }

  get validFrames(): number {
    return this.valid
  }

  isComplete(tMs: number): boolean {
    return tMs - this.startMs >= CAL_DURATION_S * 1000
  }

  /** Capture progress in [0, 1]. */
  progress(tMs: number): number {
    return Math.min(1, Math.max(0, (tMs - this.startMs) / (CAL_DURATION_S * 1000)))
  }

  addFrame(frame: Frame, _tMs: number): void {
    const geo = computeGeometry(frame, V_CAL)
    // a valid calibration frame requires the head (nose + ears-or-eyes)
    if (!geo.groups.head || geo.headMid === null) return
    const faceMid = geo.earMid ?? geo.eyeMid
    const faceWidth = geo.sEar ?? geo.sEye
    if (geo.nose !== null && faceMid !== null && faceWidth !== null && faceWidth > 0) {
      if (Math.abs(geo.nose.x - faceMid.x) / faceWidth > MAX_CAL_YAW) {
        this.yawed++
        return
      }
    }
    this.valid++

    const s = this.samples
    if (geo.sSh !== null) s.sSh.push(geo.sSh)
    if (geo.sEar !== null) s.sEar.push(geo.sEar)
    if (geo.sEye !== null) s.sEye.push(geo.sEye)
    if (geo.shMid !== null) s.ySh.push(geo.shMid.y)
    // head position per reference line — ears and eyes sit at different
    // heights, and the runtime compares against whichever one it can see
    const heads: [typeof geo.earMid, number[], number[], number[]][] = [
      [geo.earMid, s.yHdEar, s.hEar, s.oEar],
      [geo.eyeMid, s.yHdEye, s.hEye, s.oEye]
    ]
    for (const [mid, yHd, h, o] of heads) {
      if (mid === null) continue
      yHd.push(mid.y)
      if (geo.shMid !== null && geo.sSh !== null && geo.sSh > 0) {
        h.push((geo.shMid.y - mid.y) / geo.sSh)
        o.push((mid.x - geo.shMid.x) / geo.sSh)
      }
    }
    if (geo.shMid !== null && geo.sSh !== null && geo.sSh > 0 && geo.sEar !== null) s.r.push(geo.sEar / geo.sSh)
    if (geo.nose !== null && geo.sEar !== null && geo.sEar > 0 && geo.earMid !== null) {
      s.p.push((geo.nose.y - geo.earMid.y) / geo.sEar)
    }
    // eye-referenced baselines are captured whenever eyes are usable — the
    // runtime falls back to them the moment ears drop out mid-session
    if (geo.nose !== null && geo.sEye !== null && geo.sEye > 0 && geo.eyeMid !== null) {
      s.pEye.push((geo.nose.y - geo.eyeMid.y) / geo.sEye)
    }
    if (geo.headAngleSource === 'ears' && geo.headAngleDeg !== null) s.phiHead.push(geo.headAngleDeg)
    if (geo.eyeAngleDeg !== null) s.phiEye.push(geo.eyeAngleDeg)
    if (geo.shAngleDeg !== null) s.phiSh.push(geo.shAngleDeg)
  }

  finish(nowMs = 0, cameraDeviceId: string | null = null): CalibrationResult {
    if (this.valid < CAL_MIN_FRAMES) {
      // most frames were thrown out for a turned head: say so, it's fixable
      return { ok: false, reason: this.yawed > this.valid ? 'face-camera' : 'not-enough-frames' }
    }

    const s = this.samples
    const half = Math.min(15, Math.ceil(this.valid / 2))
    const capShoulders = s.sSh.length >= half
    const capEars = s.sEar.length >= half
    const capEyes = s.sEye.length >= half

    // stability check on the scale that will define U0
    const primaryScale = capShoulders ? s.sSh : capEars ? s.sEar : s.sEye
    if (primaryScale.length === 0) return { ok: false, reason: 'not-enough-frames' }
    if (coefficientOfVariation(primaryScale) > CAL_MAX_CV) return { ok: false, reason: 'unstable' }

    const sSh0 = capShoulders ? median(s.sSh) : null
    const sEar0 = capEars ? median(s.sEar) : null
    const sEye0 = capEyes ? median(s.sEye) : null

    let U0: number
    let REar: number | null
    let REye: number | null
    if (sSh0 !== null) {
      U0 = sSh0
      REar = sEar0 !== null ? sSh0 / sEar0 : null
      REye = sEye0 !== null ? sSh0 / sEye0 : null
    } else if (sEar0 !== null) {
      U0 = K_SH_PER_EAR * sEar0
      REar = K_SH_PER_EAR
      REye = sEye0 !== null ? K_SH_PER_EAR * (sEar0 / sEye0) : null
    } else if (sEye0 !== null) {
      U0 = R_EYE_FALLBACK * sEye0
      REar = null
      REye = R_EYE_FALLBACK
    } else {
      return { ok: false, reason: 'not-enough-frames' }
    }

    const baseline: CalibrationBaseline = {
      capturedAt: nowMs,
      cameraDeviceId,
      capabilities: { shoulders: capShoulders, ears: capEars, eyes: capEyes },
      sSh0,
      sEar0,
      sEye0,
      U0,
      REar,
      REye,
      ySh0: capShoulders ? median(s.ySh) : null,
      // yHd0/h0/o0 are ear-referenced whenever ears were captured
      // (capabilities.ears), eye-referenced otherwise
      yHd0: medianOrNull(capEars ? s.yHdEar : s.yHdEye),
      h0: capShoulders ? medianOrNull(capEars ? s.hEar : s.hEye) : null,
      r0: capShoulders && s.r.length > 0 ? median(s.r) : null,
      p0: s.p.length > 0 ? median(s.p) : null,
      pEye0: s.pEye.length > 0 ? median(s.pEye) : null,
      phiHead0: s.phiHead.length > 0 ? medianAngle(s.phiHead) : null,
      phiEye0: s.phiEye.length > 0 ? medianAngle(s.phiEye) : null,
      phiSh0: capShoulders && s.phiSh.length > 0 ? medianAngle(s.phiSh) : null,
      o0: capShoulders ? medianOrNull(capEars ? s.oEar : s.oEye) : null,
      yHdEye0: capEyes ? medianOrNull(s.yHdEye) : null,
      hEye0: capEyes && capShoulders ? medianOrNull(s.hEye) : null,
      oEye0: capEyes && capShoulders ? medianOrNull(s.oEye) : null
    }
    return { ok: true, baseline }
  }
}

export interface PlacementCheck {
  faceVisible: boolean
  earsVisible: boolean
  eyesVisible: boolean
  shouldersVisible: boolean
  verdict: 'good' | 'workable' | 'unusable'
}

/** Live camera-placement feedback for the calibration wizard's first step. */
export function assessPlacement(frame: Frame): PlacementCheck {
  const geo = computeGeometry(frame, V_CAL)
  const faceVisible = geo.groups.head
  const verdict: PlacementCheck['verdict'] =
    faceVisible && geo.groups.shoulders ? 'good' : faceVisible ? 'workable' : 'unusable'
  return {
    faceVisible,
    earsVisible: geo.groups.ears,
    eyesVisible: geo.groups.eyes,
    shouldersVisible: geo.groups.shoulders,
    verdict
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function medianOrNull(values: number[]): number | null {
  return values.length > 0 ? median(values) : null
}

/**
 * Median of line angles, wrap-safe: level features seen through a mirrored
 * camera hover around ±180°, and a plain median of +179.8/−179.8 samples is 0°
 * — a 180° baseline error that reads as a permanent severe lean. Take the
 * median of the offsets from the circular mean instead.
 */
export function medianAngle(degrees: number[]): number {
  let sx = 0
  let sy = 0
  for (const d of degrees) {
    sx += Math.cos((d * Math.PI) / 180)
    sy += Math.sin((d * Math.PI) / 180)
  }
  const ref = (Math.atan2(sy, sx) * 180) / Math.PI
  return wrapDeg(ref + median(degrees.map((d) => wrapDeg(d - ref))))
}

/**
 * Robust CV: MAD-based (×1.4826 for σ-consistency) rather than std-based, so a
 * short burst of tracking glitches doesn't fail a calibration whose median is
 * solid — the check should reject sustained movement, not sensor noise.
 */
function coefficientOfVariation(values: number[]): number {
  const med = median(values)
  if (med === 0) return Infinity
  const deviations = values.map((v) => Math.abs(v - med))
  return (1.4826 * median(deviations)) / Math.abs(med)
}
