import type { CalibrationBaseline } from '@shared/posture'
import { LM } from '../constants'
import type { Landmark } from '../types'

/**
 * Canonical upright test pose (normalized image coords, y grows downward):
 *   shoulders (0.35,0.62)-(0.65,0.62)  → sSh = 0.30, shMid (0.5, 0.62)
 *   ears      (0.44,0.32)-(0.56,0.32)  → sEar = 0.12, earMid (0.5, 0.32)
 *   eyes      (0.455,0.34)-(0.545,0.34)→ sEye = 0.09
 *   nose      (0.5, 0.38)              → pitch p0 = (0.38-0.32)/0.12 = 0.5
 * Derived: U0 = 0.30, h0 = 1.0, r0 = 0.4, line angles = 180° (left lm is image-left).
 */
export interface PoseSpec {
  nose?: [number, number]
  leftEye?: [number, number]
  rightEye?: [number, number]
  leftEar?: [number, number]
  rightEar?: [number, number]
  leftShoulder?: [number, number]
  rightShoulder?: [number, number]
  /** per-landmark visibility override, by index */
  visibility?: Partial<Record<number, number>>
}

export function makeFrame(spec: PoseSpec = {}): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }))
  const put = (idx: number, xy: [number, number] | undefined, def: [number, number]): void => {
    const [x, y] = xy ?? def
    lm[idx] = { x, y, visibility: 1 }
  }
  put(LM.nose, spec.nose, [0.5, 0.38])
  put(LM.leftEyeOuter, spec.leftEye, [0.455, 0.34])
  put(LM.rightEyeOuter, spec.rightEye, [0.545, 0.34])
  put(LM.leftEar, spec.leftEar, [0.44, 0.32])
  put(LM.rightEar, spec.rightEar, [0.56, 0.32])
  put(LM.leftShoulder, spec.leftShoulder, [0.35, 0.62])
  put(LM.rightShoulder, spec.rightShoulder, [0.65, 0.62])
  for (const [idx, v] of Object.entries(spec.visibility ?? {})) {
    lm[Number(idx)] = { ...lm[Number(idx)], visibility: v }
  }
  return lm
}

/** Baseline exactly matching makeFrame() defaults. */
export function uprightBaseline(overrides: Partial<CalibrationBaseline> = {}): CalibrationBaseline {
  return {
    capturedAt: 0,
    cameraDeviceId: null,
    capabilities: { shoulders: true, ears: true, eyes: true },
    sSh0: 0.3,
    sEar0: 0.12,
    sEye0: 0.09,
    U0: 0.3,
    REar: 2.5,
    REye: 0.3 / 0.09,
    ySh0: 0.62,
    yHd0: 0.32,
    h0: 1.0,
    r0: 0.4,
    p0: 0.5,
    // eye-referenced pitch: (0.38 − 0.34) / 0.09
    pEye0: 0.4 / 0.9,
    phiHead0: 180,
    phiEye0: 180,
    phiSh0: 180,
    o0: 0,
    ...overrides
  }
}

/** Shift a coordinate pair. */
export const shift = (p: [number, number], dx: number, dy: number): [number, number] => [p[0] + dx, p[1] + dy]
