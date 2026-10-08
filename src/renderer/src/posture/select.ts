// Which of several detected poses is the user (docs/specs/detection.md §2, "Several poses in
// view"). Pure functions.
//
// The pose model runs with room for two poses. With room for one it tracks whichever pose it
// found first and stops looking for others while it holds it: a figure printed on the desk mat
// that was picked up while the chair was empty kept the model busy, and the user who sat down
// in front of it was never found. With room for two, the detector keeps looking while it
// tracks fewer than two, and SitSense picks the user among what it finds.

import { LM } from './constants'
import { frameReject, type ExtractOptions } from './features'
import type { FrameReject, Landmark, PoseFrame } from './types'

/** Isotropic image point (x in image-height units from the left edge, y down). */
export interface PosePoint {
  x: number
  y: number
}

/** a landmark counts toward a pose's apparent size with at least this visibility */
const SIZE_MIN_VIS = 0.5
/** the upper body and hips: legs are often hallucinated under a desk */
const SIZE_LAST_INDEX = LM.rightHip
/**
 * A pose whose shoulders are within this distance (image-height units) of the last pick
 * continues it: a person does not cross a quarter of the picture between two frames.
 */
export const PICK_FOLLOW_MAX = 0.25

/** 0: GOOD; 1: a person, too little of them in view (maybe the user leaning out); 2: not the user. */
const rank = (r: FrameReject | null): number => (r === null ? 0 : r === 'not-in-view' || r === 'no-pose' ? 1 : 2)

const seen = (l: Landmark | undefined): l is Landmark =>
  l !== undefined && (l.visibility ?? 1) >= SIZE_MIN_VIS && l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1

/** The pose's shoulder midpoint (else the mean of its seen upper-body points), or null. */
export function posePoint(frame: PoseFrame): PosePoint | null {
  const { image, aspect } = frame
  const ls = image[LM.leftShoulder]
  const rs = image[LM.rightShoulder]
  if (seen(ls) && seen(rs)) return { x: ((ls.x + rs.x) / 2) * aspect, y: (ls.y + rs.y) / 2 }
  const pts = image.slice(0, SIZE_LAST_INDEX + 1).filter(seen)
  if (pts.length === 0) return null
  return {
    x: (pts.reduce((a, l) => a + l.x, 0) / pts.length) * aspect,
    y: pts.reduce((a, l) => a + l.y, 0) / pts.length
  }
}

/** Apparent size: the diagonal of the seen upper body's bounding box (image-height units). */
export function poseSize(frame: PoseFrame): number {
  const pts = frame.image.slice(0, SIZE_LAST_INDEX + 1).filter(seen)
  if (pts.length < 3) return 0
  const xs = pts.map((l) => l.x * frame.aspect)
  const ys = pts.map((l) => l.y)
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
}

/**
 * Index of the user among the detected poses. A pose that could be someone sitting at the
 * screen (the presence plausibility of `frameReject`, measured with `opts`) beats one that is
 * only partly in view, which beats one that is not the user (a figure lying on the desk, a
 * small picture, someone far behind). Among equals, the pose that continues the last pick
 * (`prev`, its posePoint) wins, so two plausible people never make the readings jump between
 * them; without one, the largest (nearest) pose.
 */
export function pickUser(frames: readonly PoseFrame[], opts: ExtractOptions = {}, prev: PosePoint | null = null): number {
  if (frames.length <= 1) return 0
  let best = 0
  let bestKey: [number, number, number] | null = null
  frames.forEach((frame, i) => {
    const p = posePoint(frame)
    const d = prev && p ? Math.hypot(p.x - prev.x, p.y - prev.y) : Infinity
    const follows = d <= PICK_FOLLOW_MAX
    const key: [number, number, number] = [rank(frameReject(frame, opts)), follows ? 0 : 1, follows ? d : -poseSize(frame)]
    if (bestKey === null || less(key, bestKey)) {
      best = i
      bestKey = key
    }
  })
  return best
}

const less = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}
