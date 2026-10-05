// Pure 2D helpers shared by the Lines overlay data (store.pose) and the AI review
// sketch. No DOM, no MediaPipe — unit-tested in __tests__/pose-geometry.test.ts.
//
// Coordinates:
// - normalized image coords: x by width, y by height, y down, NOT mirrored (what
//   MediaPipe returns; the preview mirrors with CSS, so a mirrored overlay flips x).
// - isotropic image coords: u = (x − 0.5)·aspect, v = y − 0.5 (height units, y down).
//   An SVG with viewBox `0 0 100 100/aspect` (x·100, y·100/aspect) is isotropic too, so a
//   direction in isotropic coords is drawn as-is.

import { ISSUES, type IssueId, type PostureSnapshot, type Stage } from '@shared/posture'
import { FRAME_MARGIN, LM, V_SEEN } from '@renderer/posture/constants'
import { focalLength } from '@renderer/posture/features'
import type { Landmark, PoseFrame, PostureFeatures, Vec3 } from '@renderer/posture/types'

export type BodySegment = 'head' | 'neck' | 'trunk' | 'shoulders'

/**
 * The body segment each issue "lives on" in the Lines overlay:
 * head forward → the ear→shoulder (neck) line; slouching → the shoulder→hip (trunk)
 * line; leaning → the shoulder line; too close → the head.
 */
export const ISSUE_SEGMENT: Record<IssueId, BodySegment> = {
  headForward: 'neck',
  sink: 'trunk',
  lean: 'shoulders',
  tooClose: 'head'
}

/** Worst active stage per body segment (all 0 unless the user is present). */
export function segmentStages(snapshot: PostureSnapshot | null): Record<BodySegment, Stage> {
  const out: Record<BodySegment, Stage> = { head: 0, neck: 0, trunk: 0, shoulders: 0 }
  if (!snapshot || snapshot.presence !== 'active') return out
  for (const issue of ISSUES) {
    const seg = ISSUE_SEGMENT[issue]
    const st = snapshot.issues[issue]?.stage ?? 0
    if (st > out[seg]) out[seg] = st
  }
  return out
}

/** A landmark is "seen": visibility ≥ V_SEEN and inside the frame expanded by FRAME_MARGIN. */
export function isSeen(p: Landmark | undefined): p is Landmark {
  if (!p) return false
  return (
    (p.visibility ?? 0) >= V_SEEN &&
    p.x >= -FRAME_MARGIN &&
    p.x <= 1 + FRAME_MARGIN &&
    p.y >= -FRAME_MARGIN &&
    p.y <= 1 + FRAME_MARGIN
  )
}

/**
 * The shoulder point in normalized image coords: the visibility-weighted mean of the
 * seen shoulders (the more visible one dominates in an angled view), else the more
 * visible shoulder. null when no shoulder landmark exists.
 */
export function shoulderPoint(image: readonly Landmark[]): { x: number; y: number } | null {
  const l = image[LM.leftShoulder]
  const r = image[LM.rightShoulder]
  const seen = [l, r].filter(isSeen)
  if (seen.length > 0) {
    let wx = 0
    let wy = 0
    let w = 0
    for (const p of seen) {
      const k = (p.visibility ?? 0) ** 2 + 1e-3
      wx += p.x * k
      wy += p.y * k
      w += k
    }
    return { x: wx / w, y: wy / w }
  }
  const best = [l, r].filter(Boolean).sort((a, b) => (b!.visibility ?? 0) - (a!.visibility ?? 0))[0]
  return best ? { x: best.x, y: best.y } : null
}

/**
 * True "up" (gravity, from the features) projected into the image at the shoulder,
 * as a unit vector in isotropic image coords (v down, so an upright camera gives
 * ≈ [0, −1]). Uses the pinhole projection of a short segment along `up` from the
 * camera-frame shoulder anchor when the depth is known (a camera far above or below
 * the user makes vertical lines converge), else the orthographic direction.
 */
export function projectUp(features: Pick<PostureFeatures, 'up' | 'anchor'>, aspect: number): [number, number] {
  const up: Vec3 = features.up
  const a = features.anchor
  if (a && a[2] > 0.05) {
    const f = focalLength(aspect)
    const len = 0.15
    const b: Vec3 = [a[0] + up[0] * len, a[1] + up[1] * len, a[2] + up[2] * len]
    if (b[2] > 0.05) {
      const du = (f * b[0]) / b[2] - (f * a[0]) / a[2]
      const dv = (f * b[1]) / b[2] - (f * a[1]) / a[2]
      const n = Math.hypot(du, dv)
      if (n > 1e-6) return [du / n, dv / n]
    }
  }
  const n = Math.hypot(up[0], up[1])
  return n > 1e-6 ? [up[0] / n, up[1] / n] : [0, -1]
}

/** Overlay guide for the Lines view (see PoseOverlayData in state/store.ts). */
export interface OverlayGuide {
  /** unit direction of true up, isotropic image coords (v down), at the shoulder point */
  up2d: [number, number]
  /** the side of the body facing the camera (draw its ear → shoulder → hip chain) */
  nearSide: 'left' | 'right'
  /** shoulder point, normalized image coords (not mirrored) */
  shoulder: { x: number; y: number }
}

export function overlayGuide(frame: PoseFrame, features: PostureFeatures | null): OverlayGuide | null {
  if (!features) return null
  const shoulder = shoulderPoint(frame.image)
  if (!shoulder) return null
  return { up2d: projectUp(features, frame.aspect), nearSide: features.nearSide, shoulder }
}
