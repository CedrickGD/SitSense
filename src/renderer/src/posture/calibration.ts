import type { CalibrationBaseline } from '@shared/posture'
import {
  CAL_DURATION_S,
  CAL_MAX_CV,
  CAL_MIN_FRAMES,
  K_SH_PER_EAR,
  R_EYE_FALLBACK,
  V_CAL
} from './constants'
import { computeGeometry } from './metrics'
import type { Frame } from './types'

export type CalibrationResult =
  | { ok: true; baseline: CalibrationBaseline }
  | { ok: false; reason: 'not-enough-frames' | 'unstable' }

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
    yHd: [] as number[],
    h: [] as number[],
    r: [] as number[],
    p: [] as number[],
    phiHead: [] as number[],
    phiEye: [] as number[],
    phiSh: [] as number[],
    o: [] as number[]
  }
  private valid = 0

  constructor(startMs: number) {
    this.startMs = startMs
  }

  get validFrames(): number {
    return this.valid
  }

  isComplete(tMs: number): boolean {
    return tMs - this.startMs >= CAL_DURATION_S * 1000
  }

  addFrame(frame: Frame, _tMs: number): void {
    const geo = computeGeometry(frame, V_CAL)
    // a valid calibration frame requires the head (nose + ears-or-eyes)
    if (!geo.groups.head || geo.headMid === null) return
    this.valid++

    const s = this.samples
    if (geo.sSh !== null) s.sSh.push(geo.sSh)
    if (geo.sEar !== null) s.sEar.push(geo.sEar)
    if (geo.sEye !== null) s.sEye.push(geo.sEye)
    if (geo.shMid !== null) s.ySh.push(geo.shMid.y)
    s.yHd.push(geo.headMid.y)
    if (geo.shMid !== null && geo.sSh !== null && geo.sSh > 0) {
      s.h.push((geo.shMid.y - geo.headMid.y) / geo.sSh)
      s.o.push((geo.headMid.x - geo.shMid.x) / geo.sSh)
      if (geo.sEar !== null) s.r.push(geo.sEar / geo.sSh)
    }
    if (geo.nose !== null && geo.sEar !== null && geo.sEar > 0 && geo.earMid !== null) {
      s.p.push((geo.nose.y - geo.earMid.y) / geo.sEar)
    }
    if (geo.headAngleSource === 'ears' && geo.headAngleDeg !== null) s.phiHead.push(geo.headAngleDeg)
    if (geo.eyeMid !== null && geo.groups.eyes) {
      // eye-line angle is tracked separately so the runtime eye-fallback has its own reference
      const eyeAngle = geo.headAngleSource === 'eyes' ? geo.headAngleDeg : null
      if (eyeAngle !== null) s.phiEye.push(eyeAngle)
    }
    if (geo.shAngleDeg !== null) s.phiSh.push(geo.shAngleDeg)
  }

  finish(nowMs = 0, cameraDeviceId: string | null = null): CalibrationResult {
    if (this.valid < CAL_MIN_FRAMES) return { ok: false, reason: 'not-enough-frames' }

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
      yHd0: median(s.yHd),
      h0: capShoulders && s.h.length > 0 ? median(s.h) : null,
      r0: capShoulders && s.r.length > 0 ? median(s.r) : null,
      p0: s.p.length > 0 ? median(s.p) : null,
      phiHead0: s.phiHead.length > 0 ? median(s.phiHead) : null,
      phiEye0: s.phiEye.length > 0 ? median(s.phiEye) : null,
      phiSh0: capShoulders && s.phiSh.length > 0 ? median(s.phiSh) : null,
      o0: capShoulders && s.o.length > 0 ? median(s.o) : null
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
