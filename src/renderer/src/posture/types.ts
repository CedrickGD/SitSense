// Input/internal types of the pure detection core. No MediaPipe imports here —
// the core is engine-agnostic and unit-testable with synthetic landmarks.

export interface Landmark {
  x: number
  y: number
  z?: number
  visibility?: number
}

/** One video frame's pose result; null when the detector found no pose. */
export type Frame = readonly Landmark[] | null

export interface Point {
  x: number
  y: number
}

export interface GroupAvailability {
  shoulders: boolean
  ears: boolean
  eyes: boolean
  head: boolean
}

/** Per-frame geometric primitives (docs/specs/detection.md §1). */
export interface FrameGeometry {
  groups: GroupAvailability
  /** frame is usable for posture evaluation (pose + head or shoulders) */
  good: boolean
  shMid: Point | null
  earMid: Point | null
  eyeMid: Point | null
  headMid: Point | null
  nose: Point | null
  sSh: number | null
  sEar: number | null
  sEye: number | null
  /** ear-line angle in degrees, or eye-line fallback marker */
  headAngleDeg: number | null
  headAngleSource: 'ears' | 'eyes' | null
  shAngleDeg: number | null
}

/** Raw (unsmoothed) metric values; undefined = not computable this frame. */
export interface RawMetrics {
  /** unified scale in image units (pre-EMA) */
  scale?: number
  sink?: number
  fwdGap?: number
  fwdFace?: number
  fwdPitch?: number
  leanRoll?: number
  leanTilt?: number
  leanLateral?: number
  /** signed lateral offset delta, for lean direction */
  leanSigned?: number
}
