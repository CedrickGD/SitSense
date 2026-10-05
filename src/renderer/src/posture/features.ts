// Per-frame posture geometry (docs/specs/detection.md §1–§3). Pure functions.
//
// Coordinate frames
// - image landmarks: normalized x (by width), y (by height), y down. Converted to
//   isotropic image coordinates (height units, origin at the image centre):
//   u = (x − 0.5)·aspect, v = y − 0.5.
// - world landmarks / camera frame: metres, +x image-right, +y image-down,
//   +z away from the camera. camUp = (0, −1, 0). The world landmarks are first rotated
//   from the model's crop frame into true camera axes (rayCorrected).
// - body frame: L̂ = the person's left, Û = up (gravity), F̂ = L̂ × Û = forward.
//   A person facing the camera has L̂ ≈ +x (their left is image-right) and F̂ ≈ −z.
// - body vectors (neck, trunk, shoulder/hip/ear lines, thighs) come from the world
//   landmarks (the FOV enters only through the small viewing-ray correction). Positions (anchor, head) and the short head-direction
//   vector come from a pinhole back-projection placed by a perspective translation fit
//   (see translationFit / Ctx.pos and the spec's Implementation notes).

import type { UpSource, Vec3 } from '@shared/posture'
import {
  FRAME_MARGIN,
  FRAME_TRUST_INSIDE,
  HFOV_ASSUMED,
  LANDMARK_COUNT,
  HIP_LINE_MAX_M,
  HIP_LINE_MIN_M,
  HIP_TWIST_MAX,
  HIP_TWIST_HYST,
  HIP_TWIST_MIN_FRAMES,
  LAT_MAX_YAW,
  LM,
  PPM_MIN_SEGMENTS,
  SHOULDER_LINE_MIN_M,
  SHOULDER_CAMERA_MAX_YAW,
  UP_FRAME_MAX_TILT,
  UP_HIP_PERSPECTIVE_FULL,
  UP_HIP_PERSPECTIVE_MIN,
  UP_MAX_ROLL,
  UP_MAX_TILT,
  UP_MAX_TRUNK_TILT,
  UP_MIN_ACCEPT_RATIO,
  UP_MIN_FRAMES,
  UP_THIGH_ANGLE_MAX,
  UP_THIGH_ANGLE_MIN,
  UP_THIGH_SIGMA,
  V_KNEE_UP,
  V_ROLL_SHOULDERS,
  V_SEEN,
  VIEW_ANGLED_MAX_YAW,
  VIEW_FRONT_MAX_YAW
} from './constants'
import type {
  Frame,
  LateralAxisSource,
  Landmark,
  NeckLatRef,
  PostureFeatures,
  Side,
  UpEstimate,
  ViewInfo,
  VisibilitySummary
} from './types'
import {
  DEG,
  RAD,
  add,
  angleDeg,
  clamp,
  median,
  cross,
  dot,
  neg,
  norm,
  reject,
  rotate,
  scale,
  sub,
  tiltDeg,
  unit,
  wrapDeg
} from './vec'

export const CAM_UP: Vec3 = [0, -1, 0]

export interface ExtractOptions {
  /**
   * Fixed gravity "up" in camera coordinates (e.g. the baseline's). When omitted
   * the per-frame `estimateUp` is used.
   */
  up?: Vec3
  /** source label of `up` (default 'camera', the most conservative) */
  upSource?: UpSource
  /**
   * The baseline's body forward. Used (a) to orient forward when the nose is not in
   * the frame, and (b) as the body's forward when neither the hips nor both shoulders
   * are in the frame (head + one shoulder): the body frame is never taken from the
   * head, which turns on its own.
   */
  forwardHint?: Vec3
  /**
   * Use the hips (and knees) at all (default true). Pass false when the hips were judged
   * hallucinated during setup (see hipTwist / HipConsistency) — at runtime the engine
   * passes whether the baseline used them, so both are measured the same way.
   */
  hips?: boolean
  /** horizontal field of view assumed for metric depth and the viewing-ray correction (default HFOV_ASSUMED) */
  hfovDeg?: number
  /**
   * Lateral features are measured while the body yaw is below this (default LAT_MAX_YAW).
   * The engine passes a little more and gates with its smoothed yaw instead, so per-frame
   * yaw noise right at the limit does not make the lateral metrics flicker.
   */
  lateralMaxYaw?: number
}

// ---------------------------------------------------------------------------
// landmark access

interface Ctx {
  img: readonly Landmark[]
  w: readonly Landmark[]
  aspect: number
  /** focal length (height units) for the assumed HFOV */
  f: number
  /** image height-units per metre at the shoulders (= f / Z_shoulders); null when unmeasurable */
  ppm: number | null
  /**
   * Camera-frame 3D positions (metres) by pinhole back-projection of the image
   * landmarks at depth Z_i = z_i + T_z. The 2D landmarks are the model's most precise
   * output; world depth only supplies the relative depth. Null when the scale is
   * unknown (then the ray-corrected world landmarks are used, which share the camera's axes).
   */
  pos: Vec3[] | null
  /** hips/knees may be used (ExtractOptions.hips) */
  useHips: boolean
}

const lmOk = (l: Landmark | undefined): l is Landmark =>
  l !== undefined && l !== null && Number.isFinite(l.x) && Number.isFinite(l.y)

function visOf(c: Ctx, i: number): number {
  const l = c.img[i]
  if (!lmOk(l)) return 0
  const v = l.visibility
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** How far inside the frame the image point is (normalized units; negative = outside). */
function marginOf(c: Ctx, i: number): number {
  const l = c.img[i]
  if (!lmOk(l)) return -Infinity
  return Math.min(l.x, 1 - l.x, l.y, 1 - l.y)
}

/**
 * In-frame trust in [0, 1]: 0 at the frame edge, 1 from
 * FRAME_TRUST_INSIDE inside. Off-frame points are extrapolated by the model and
 * must not be trusted; the ramp avoids jumps when a point grazes the edge.
 */
function trustOf(c: Ctx, i: number): number {
  if (!worldOk(c, i) || (!c.useHips && HIP_LMS.has(i))) return 0
  return clamp(marginOf(c, i) / FRAME_TRUST_INSIDE, 0, 1)
}

function worldOk(c: Ctx, i: number): boolean {
  const p = c.w[i]
  return lmOk(p) && Number.isFinite(p.z ?? 0)
}

/** §1: visibility ≥ V_SEEN and inside the frame expanded by 5%. */
function seenOf(c: Ctx, i: number): boolean {
  if (!c.useHips && HIP_LMS.has(i)) return false
  return visOf(c, i) >= V_SEEN && marginOf(c, i) >= -FRAME_MARGIN && worldOk(c, i)
}

/** World landmark (metres, hip-centred, ray-corrected into camera axes; see rayCorrected). */
const RW = (c: Ctx, i: number): Vec3 => {
  const p = c.w[i]
  return [p.x, p.y, p.z ?? 0]
}

/** World landmark used for body vectors (see notes). */
const W = RW

/** Back-projected camera-frame position (metres) when the scale is known, else the world landmark. */
const P = (c: Ctx, i: number): Vec3 => (c.pos ? c.pos[i] : RW(c, i))

/** Isotropic image coordinates (height units, origin at the centre). */
const UV = (c: Ctx, i: number): [number, number] => {
  const l = c.img[i]
  return [(l.x - 0.5) * c.aspect, l.y - 0.5]
}

const pairWorldRaw = (c: Ctx, l: number, r: number): Vec3 | null => pairWorld(c, l, r, RW)

/** Trust-weighted point of a left/right pair (the plain midpoint when both are in frame). */
function pairWorld(c: Ctx, l: number, r: number, get: (c: Ctx, i: number) => Vec3 = W): Vec3 | null {
  const wl = trustOf(c, l)
  const wr = trustOf(c, r)
  const s = wl + wr
  if (s < 1e-6) return null
  const a = wl > 0 ? scale(get(c, l), wl) : ([0, 0, 0] as Vec3)
  const b = wr > 0 ? scale(get(c, r), wr) : ([0, 0, 0] as Vec3)
  return scale(add(a, b), 1 / s)
}

/**
 * Shoulder midpoint. Each in-frame shoulder proposes itself plus half the world shoulder
 * vector toward the other one (whose world position the model predicts even when it is
 * outside the frame); the proposals are trust-weighted. With both shoulders in frame
 * this is the plain midpoint; with one cut off it stays on the body's axis instead of
 * collapsing onto the visible shoulder 18 cm to the side. `get` = W (world) or P
 * (camera-frame positions).
 */
function shoulderMid(c: Ctx, get: (c: Ctx, i: number) => Vec3): Vec3 {
  const l = LM.leftShoulder
  const r = LM.rightShoulder
  const half = scale(sub(RW(c, r), RW(c, l)), 0.5)
  const wl = trustOf(c, l)
  const wr = trustOf(c, r)
  const s = wl + wr
  if (s < 1e-6) return scale(add(get(c, l), get(c, r)), 0.5)
  const fromL = add(get(c, l), half)
  const fromR = sub(get(c, r), half)
  return scale(add(scale(fromL, wl), scale(fromR, wr)), 1 / s)
}

/** Trust-weighted isotropic image point of a pair. */
function pairImage(c: Ctx, l: number, r: number): [number, number] | null {
  const wl = trustOf(c, l)
  const wr = trustOf(c, r)
  const s = wl + wr
  if (s < 1e-6) return null
  const a = wl > 0 ? UV(c, l) : [0, 0]
  const b = wr > 0 ? UV(c, r) : [0, 0]
  return [(a[0] * wl + b[0] * wr) / s, (a[1] * wl + b[1] * wr) / s]
}

/**
 * Pair vector A→B averaged per side (§3.1), V = Σ w_s (B_s − A_s) / Σ w_s with
 * w_s = min(trust(A_s), trust(B_s)) (in-frame trust instead of vis², see notes).
 * With both sides in frame this is the midpoint-to-midpoint vector; with one side
 * cut off it stays on that side, so it never picks up a lateral offset (trunk).
 */
function pairVector(c: Ctx, aL: number, aR: number, bL: number, bR: number): Vec3 | null {
  const wl = Math.min(trustOf(c, aL), trustOf(c, bL))
  const wr = Math.min(trustOf(c, aR), trustOf(c, bR))
  const s = wl + wr
  if (s >= 1e-3) {
    let v: Vec3 = [0, 0, 0]
    if (wl > 0) v = add(v, scale(sub(W(c, bL), W(c, aL)), wl))
    if (wr > 0) v = add(v, scale(sub(W(c, bR), W(c, aR)), wr))
    return scale(v, 1 / s)
  }
  const a = pairWorld(c, aL, aR)
  const b = pairWorld(c, bL, bR)
  return a && b ? sub(b, a) : null
}

const HIP_LMS: ReadonlySet<number> = new Set([LM.leftHip, LM.rightHip, LM.leftKnee, LM.rightKnee])

function toCtx(frame: Frame, hfovDeg = HFOV_ASSUMED, useHips = true): Ctx | null {
  if (frame === null || frame === undefined) return null
  const { image, world, aspect } = frame
  if (!Array.isArray(image) || image.length < LANDMARK_COUNT) return null
  if (!Array.isArray(world) || world.length < LANDMARK_COUNT) return null
  if (!(Number.isFinite(aspect) && aspect > 0)) return null
  const f = focalLength(aspect, hfovDeg)
  const c: Ctx = { img: image, w: rayCorrected(image, world, aspect, f), aspect, f, ppm: null, pos: null, useHips }
  if (scaleSegments(c) >= PPM_MIN_SEGMENTS) {
    const T = translationFit(c)
    const sh = T ? pairWorldRaw(c, LM.leftShoulder, LM.rightShoulder) : null
    if (T && sh && sh[2] + T[2] > 0.05) {
      c.ppm = c.f / (sh[2] + T[2])
      c.pos = reconstruct(c, T)
    }
  }
  return c
}

/**
 * The crop centre is clamped to the frame expanded by this much (normalized units): a
 * guard against wild extrapolations, loose enough (about 35 deg off axis vertically on a
 * 65 deg 16:9 webcam) not to saturate for hips just below a desk webcam's frame.
 */
const CROP_CENTER_MAX_OUT = 0.5

/**
 * Isotropic image point the pose model's crop is (approximately) centred on: the hip
 * midpoint. BlazePose builds its ROI around the hip centre it predicts (detector
 * alignment keypoint, then auxiliary landmark 0 of the previous frame) whether or not
 * the hips are inside the frame, so the image hips are used as reported even when they
 * are off-frame extrapolations: switching to another point at the frame edge would rotate
 * the world frame by tens of degrees within a few percent of frame height. The shoulder
 * midpoint is only a fallback for hips that are not reported at all (non-finite). Image
 * positions only (they are what the model's crop was built from), so it does not depend
 * on ExtractOptions.hips. Null when neither pair is usable.
 */
function cropCenter(img: readonly Landmark[], aspect: number): [number, number] | null {
  const lh = img[LM.leftHip]
  const rh = img[LM.rightHip]
  const ls = img[LM.leftShoulder]
  const rs = img[LM.rightShoulder]
  let x: number
  let y: number
  if (lmOk(lh) && lmOk(rh)) {
    x = (lh.x + rh.x) / 2
    y = (lh.y + rh.y) / 2
  } else if (lmOk(ls) && lmOk(rs)) {
    x = (ls.x + rs.x) / 2
    y = (ls.y + rs.y) / 2
  } else return null
  x = clamp(x, -CROP_CENTER_MAX_OUT, 1 + CROP_CENTER_MAX_OUT)
  y = clamp(y, -CROP_CENTER_MAX_OUT, 1 + CROP_CENTER_MAX_OUT)
  return [(x - 0.5) * aspect, y - 0.5]
}

/**
 * Off-centre viewing-ray correction. The model predicts world landmarks from its crop as
 * if the crop were viewed along the optical axis, so for a person off the image centre
 * the world frame is rotated against the true camera frame by the angle between the
 * optical axis and the ray to the crop centre (up to half the FOV at the frame edge).
 * World landmarks are rotated by the rotation that takes camera +z onto that ray (the
 * shortest one, about z × ray), which brings them into true camera axes. Depends on the
 * assumed focal length.
 */
function rayCorrected(img: readonly Landmark[], world: readonly Landmark[], aspect: number, f: number): readonly Landmark[] {
  const ctr = cropCenter(img, aspect)
  if (!ctr) return world
  const ray = unit([ctr[0] / f, ctr[1] / f, 1])
  const axis = ray ? unit(cross([0, 0, 1], ray)) : null
  if (!ray || !axis) return world
  const deg = Math.acos(clamp(ray[2], -1, 1)) * DEG
  if (!(deg > 1e-3)) return world
  return world.map((p) => {
    if (!lmOk(p) || !Number.isFinite(p.z ?? 0)) return p
    const [x, y, z] = rotate([p.x, p.y, p.z ?? 0], axis, deg)
    return { ...p, x, y, z }
  })
}

/** Pinhole back-projection of every landmark (see Ctx.pos). */
function reconstruct(c: Ctx, T: Vec3): Vec3[] {
  const out: Vec3[] = new Array(LANDMARK_COUNT)
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const wz = worldOk(c, i) ? (c.w[i].z ?? 0) : 0
    const Z = Math.max(0.05, wz + T[2])
    if (lmOk(c.img[i])) {
      const [u, v] = UV(c, i)
      out[i] = [(u * Z) / c.f, (v * Z) / c.f, Z]
    } else {
      out[i] = worldOk(c, i) ? add(RW(c, i), T) : [T[0], T[1], T[2]]
    }
  }
  return out
}

/** Landmarks used to place the body in the camera frame. */
const FIT_LANDMARKS = [
  LM.nose,
  LM.leftEyeOuter,
  LM.rightEyeOuter,
  LM.leftEar,
  LM.rightEar,
  LM.leftShoulder,
  LM.rightShoulder,
  LM.leftHip,
  LM.rightHip
]

/**
 * Perspective placement (replaces the spec's weak-perspective ppm ratio, see notes).
 * Ray-corrected world landmarks share the camera's axes, so camera position = world + T with one
 * unknown translation. Each seen landmark gives two equations linear in T:
 *   u·(z + T_z) = f·(x + T_x),   v·(z + T_z) = f·(y + T_y)
 * solved by least squares. Unlike a per-segment image/world length ratio, this stays
 * consistent when the set of visible landmarks changes.
 */
function translationFit(c: Ctx): Vec3 | null {
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  const r = [0, 0, 0]
  let n = 0
  const addRow = (row: [number, number, number], rhs: number): void => {
    for (let a = 0; a < 3; a++) {
      r[a] += row[a] * rhs
      for (let b = 0; b < 3; b++) A[a][b] += row[a] * row[b]
    }
  }
  for (const i of FIT_LANDMARKS) {
    if (!seenOf(c, i)) continue
    const [u, v] = UV(c, i)
    const [x, y, z] = RW(c, i)
    addRow([-c.f, 0, u], c.f * x - u * z)
    addRow([0, -c.f, v], c.f * y - v * z)
    n++
  }
  if (n < 3) return null
  const T = solve3(A, r)
  return T && T.every(Number.isFinite) && T[2] > 0 ? T : null
}

/** Solve a 3×3 linear system (Cramer's rule); null when singular. */
function solve3(A: number[][], b: number[]): Vec3 | null {
  const det = (m: number[][]): number =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const d = det(A)
  if (!(Math.abs(d) > 1e-12)) return null
  const col = (k: number): number[][] => A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d]
}

// ---------------------------------------------------------------------------
// presence (§2)

/** §2: pose + world landmarks + head seen (nose or an ear) + at least one shoulder seen. */
export function isGoodFrame(frame: Frame): boolean {
  const c = toCtx(frame)
  return c !== null && goodCtx(c)
}

function goodCtx(c: Ctx): boolean {
  const head = seenOf(c, LM.nose) || seenOf(c, LM.leftEar) || seenOf(c, LM.rightEar)
  const shoulder = seenOf(c, LM.leftShoulder) || seenOf(c, LM.rightShoulder)
  // the neck vector needs an ear and a shoulder whose positions are not
  // extrapolated from outside the frame (see Implementation notes)
  const geometry =
    (trustOf(c, LM.leftEar) > 0 || trustOf(c, LM.rightEar) > 0) &&
    (trustOf(c, LM.leftShoulder) > 0 || trustOf(c, LM.rightShoulder) > 0)
  // and enough seen segments to measure the scale (distance, position metrics)
  return head && shoulder && geometry && c.ppm !== null
}

// ---------------------------------------------------------------------------
// gravity (§3.2) — level-camera model
//
// Webcams are mounted level (|roll| ≲ UP_MAX_ROLL) but may look steeply up or down, so
// gravity is a camera PITCH: up = cameraUp(pitch), roll 0. A two-parameter (roll + pitch)
// fit from body cues is what invented camera roll before: the perspective tilt of a turned
// body's hip line under a pitched camera, and hallucinated hips or knees (under a desk),
// were read as 12–41° of roll. Body cues now only give the pitch; a hip line facing the
// camera that would need more roll than a level camera has only marks the horizontal as
// unconfirmed (UpEstimator.levelConsistent), it never tilts the vertical.

/**
 * Camera roll of an up vector (degrees): the camera's rotation about its optical axis,
 * i.e. how far the true vertical through the image centre leans from the image's vertical
 * (+ = it leans toward image-right). This is what a tilted overlay line shows.
 */
export const cameraRollDeg = (up: Vec3): number => Math.atan2(up[0], -up[1]) * DEG

/** Camera pitch of an up vector (degrees, + = the camera looks down). */
export const cameraPitchDeg = (up: Vec3): number => Math.atan2(-up[2], Math.hypot(up[0], up[1])) * DEG

/**
 * The up vector (camera coordinates) of a camera pitched `pitchDeg` (+ = looking down) and
 * rolled `rollDeg` (cameraRollDeg's sign): the inverse of cameraPitchDeg / cameraRollDeg.
 */
export function cameraUp(pitchDeg: number, rollDeg = 0): Vec3 {
  const p = pitchDeg * RAD
  const r = rollDeg * RAD
  return [Math.sin(r) * Math.cos(p), -Math.cos(r) * Math.cos(p), -Math.sin(p)]
}

/**
 * Per-frame gravity estimate in camera coordinates (level-camera model):
 * 1. 'body': both hips seen and a knee seen (vis ≥ 0.7). Seated thighs and the hip line are
 *    both near-horizontal, so K × H is up; its PITCH is taken (thighHipUp). Thighs slope
 *    ±10–15° in practice, so that pitch carries that uncertainty (the assessment's tolerance
 *    accounts for it); estimates that would put the trunk more than UP_MAX_TRUNK_TILT from
 *    vertical are rejected (hallucinated knees).
 * 2. 'hips': both hips seen. The pitch from a turned body's hip-line perspective; a hip line
 *    facing the camera gives none (hipLineUp).
 * 3. 'camera': camUp (pitch unknown, roll 0).
 * Estimates further than UP_MAX_TILT from camUp fall through to the next rule.
 */
export function estimateUp(frame: Frame, opts: { hips?: boolean } = {}): UpEstimate {
  const c = toCtx(frame, HFOV_ASSUMED, opts.hips ?? true)
  return c ? estimateUpCtx(c) : { up: [...CAM_UP] as Vec3, source: 'camera' }
}

function estimateUpCtx(c: Ctx, maxTilt = UP_MAX_TILT): UpEstimate {
  const k = upCues(c)
  if (k.body && angleDeg(k.body, CAM_UP) <= maxTilt) return { up: k.body, source: 'body' }
  const hips = k.hipLine ? hipLineUp(k.hipLine, maxTilt) : null
  if (hips) return { up: hips, source: 'hips' }
  return { up: [...CAM_UP] as Vec3, source: 'camera' }
}

/** One frame's gravity cues (before the tilt gates). */
interface UpCues {
  /** level-camera thigh estimate, thighHipUp (null when unavailable or rejected) */
  body: Vec3 | null
  /** the raw thigh estimate K × H behind it */
  thighUp: Vec3 | null
  /** the unit hip line (person's left minus right) when it is usable */
  hipLine: Vec3 | null
  /** the thigh estimate had its inputs this frame (and was not dropped for the posture) */
  bodyTried: boolean
  /** the hip line had its inputs this frame */
  hipsTried: boolean
}

function upCues(c: Ctx): UpCues {
  const out: UpCues = { body: null, thighUp: null, hipLine: null, bodyTried: false, hipsTried: false }
  if (!hipLine(c)) return out
  const H = sub(RW(c, LM.leftHip), RW(c, LM.rightHip))
  const Hu = unit(H)
  if (!Hu) return out
  out.hipsTried = true
  out.hipLine = Hu
  // thighs
  let K: Vec3 = [0, 0, 0]
  let nK = 0
  for (const [hip, knee] of [
    [LM.leftHip, LM.leftKnee],
    [LM.rightHip, LM.rightKnee]
  ] as const) {
    if (seenOf(c, knee) && visOf(c, knee) >= V_KNEE_UP) {
      K = add(K, sub(RW(c, knee), RW(c, hip)))
      nK++
    }
  }
  if (nK > 0) {
    const a = angleDeg(K, H)
    let up = unit(cross(K, H))
    if (up && dot(up, CAM_UP) < 0) up = neg(up)
    // an implausible trunk says nothing about the estimate's quality (the user may be
    // hunched right now): such frames count neither for nor against 'body'
    if (!up || trunkPlausible(c, up)) {
      out.bodyTried = true
      if (up && a >= UP_THIGH_ANGLE_MIN && a <= UP_THIGH_ANGLE_MAX) {
        out.thighUp = up
        out.body = thighHipUp(Hu, up)
      }
    }
  }
  return out
}

/**
 * The thigh estimate K × H in the level-camera model. K × H is ⟂ the hip line H by
 * construction; what the thighs add is where on the family of ups ⟂ H it sits, and that is
 * exactly what their slope (±10–15°) or a knee hallucinated under a desk gets wrong: their
 * error is a rotation about H. For a body facing the camera that rotation is pitch, which
 * nothing else measures: the thighs set it. For a turned body it is mostly roll (slope·sin β,
 * β = the hip line's angle to camera x) — which a level camera does not have, so the thighs'
 * own roll reveals their slope, and the pitch error that slope causes (slope·cos β) is taken
 * back: the member t of the family nearest the thighs' own (t_thigh) whose roll a level
 * camera explains, i.e. the least (excess/ROLL_EXCESS_SIGMA)² + ((t − t_thigh)/UP_THIGH_SIGMA)²,
 * where excess = the roll beyond UP_MAX_ROLL plus 2 standard errors of the measured roll
 * (`rollNoiseDeg`: the UpEstimator passes its mean's; 0 for one frame). Unlike the hip line's
 * own perspective reading this rests on the roll, i.e. mostly on the precise image-plane
 * directions rather than the hips' noisy depth. Of that member only the pitch is kept: the
 * result has roll 0.
 */
export function thighHipUp(H: Vec3, thighUp: Vec3, rollNoiseDeg = 0): Vec3 {
  const h = unit(H)
  const u = unit(thighUp)
  if (!u) return thighUp
  const level = (m: Vec3): Vec3 => cameraUp(cameraPitchDeg(m))
  const a = h ? unit(reject(CAM_UP, h)) : null
  if (!h || !a) return level(u)
  const b = cross(h, a)
  const at = (t: number): Vec3 => add(scale(a, Math.cos(t)), scale(b, Math.sin(t)))
  const tb = Math.atan2(dot(u, b), dot(u, a))
  const span = 4 * UP_THIGH_SIGMA * RAD
  // a level camera shows up to UP_MAX_ROLL of roll, and the measured roll is uncertain by its
  // standard error: only the roll beyond both (2σ) is evidence of the thighs' slope
  const band = UP_MAX_ROLL + 2 * Math.max(0, rollNoiseDeg)
  const cost = (t: number): number => {
    const m = at(t)
    const excess = Math.max(0, Math.abs(cameraRollDeg(m)) - band)
    return m[1] < 0 ? (excess / ROLL_EXCESS_SIGMA) ** 2 + (((t - tb) * DEG) / UP_THIGH_SIGMA) ** 2 : Infinity
  }
  const t = argmin(cost, tb - span, tb + span, 32)
  return level(Number.isFinite(cost(t)) ? at(t) : u)
}

/** thighHipUp: spread (deg) of the penalty on thigh roll beyond what a level camera and noise explain (≈ a hard bound) */
const ROLL_EXCESS_SIGMA = 1

/** Minimizer of f on [lo, hi]: a coarse scan, then golden-section refinement around the best sample. */
function argmin(f: (t: number) => number, lo: number, hi: number, samples: number): number {
  const step = (hi - lo) / samples
  let best = lo
  let bestF = f(lo)
  for (let i = 1; i <= samples; i++) {
    const t = lo + i * step
    const v = f(t)
    if (v < bestF) {
      bestF = v
      best = t
    }
  }
  let l = Math.max(lo, best - step)
  let r = Math.min(hi, best + step)
  const g = (Math.sqrt(5) - 1) / 2
  for (let i = 0; i < 40; i++) {
    const m1 = r - g * (r - l)
    const m2 = l + g * (r - l)
    if (f(m1) <= f(m2)) r = m2
    else l = m1
  }
  const t = (l + r) / 2
  return f(t) <= bestF ? t : best
}

/** The smallest rotation from camUp that makes some up ⟂ the unit hip line h (degrees). */
const hipCorrectionDeg = (h: Vec3): number => Math.asin(clamp(Math.abs(dot(h, CAM_UP)), 0, 1)) * DEG

/** Hermite step 0 → 1 between lo and hi. */
function smoothstep(lo: number, hi: number, x: number): number {
  const t = clamp((x - lo) / (hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}

/** What a (level) hip line says about a level-mounted camera, see hipLineUp. Degrees. */
interface HipLineReading {
  /** camera pitch: the line's perspective reading as far as it shows perspective (else 0: unknown) */
  pitch: number
  /** the roll it would still need at that pitch to be horizontal */
  roll: number
  /** how much of the pitch it shows, 0..1 (hipPerspectiveWeight, 0 for an in-plane tilt) */
  weight: number
}

function readHipLine(H: Vec3): HipLineReading | null {
  let h = unit(H)
  if (!h) return null
  if (h[0] < 0) h = neg(h)
  // perspective: the pitch at which a level camera sees h horizontal,
  // −h_y·cos p − h_z·sin p = 0 (taken in (−90°, 90°])
  let pitchH = Math.atan2(-h[1], h[2]) * DEG
  if (pitchH > 90) pitchH -= 180
  else if (pitchH <= -90) pitchH += 180
  // a line that no plausible pitch makes horizontal shows no perspective: an in-plane tilt
  // (a rolled camera, hallucinated hips)
  const w = Math.abs(pitchH) <= UP_FRAME_MAX_TILT ? hipPerspectiveWeight(h) : 0
  const pitch = w * pitchH
  // h·cameraUp(pitch, r) = 0  ⇔  A·sin r − B·cos r = C, the solution closest to 0
  const A = h[0] * Math.cos(pitch * RAD)
  const B = h[1] * Math.cos(pitch * RAD)
  const C = h[2] * Math.sin(pitch * RAD)
  const R = Math.hypot(A, B)
  if (!(R > 1e-9)) return null
  const roll = (Math.atan2(B, A) + Math.asin(clamp(C / R, -1, 1))) * DEG
  return { pitch, roll: wrapDeg(roll), weight: w }
}

/**
 * Gravity from the hip line alone (camera coordinates; its length and sign do not matter),
 * in the level-camera model, or null (a degenerate line, or one that no level camera within
 * maxTilt sees horizontal).
 *
 * A horizontal hip line only says up ⟂ H: one constraint for the camera's roll and pitch.
 * For a level camera it is the pitch: a camera pitch tilts the hip line in the picture as
 * far as the body is turned (the far hip of a turned body seen from above sits higher), and
 * that perspective reads the pitch exactly (tan p = −H_y / H_z). It needs a lever: a hip line
 * near the image's horizontal axis (angle β to camera x below UP_HIP_PERSPECTIVE_MIN) faces
 * the camera, and its few degrees of tilt are the camera's own small roll, the pelvis, or
 * depth noise, which a pitch reading would amplify ~1/sin β-fold: it gives no pitch
 * (unknown: 0, level). From UP_HIP_PERSPECTIVE_FULL the line gives the pitch; in between,
 * that part of it (hipPerspectiveWeight). The roll stays 0 either way. A line whose reading
 * (pitch, plus the roll it would still need) is further than maxTilt from camUp is no
 * horizontal at all for a supported camera: no estimate.
 */
export function hipLineUp(H: Vec3, maxTilt = UP_MAX_TILT): Vec3 | null {
  const r = readHipLine(H)
  if (!r) return null
  if (angleDeg(cameraUp(r.pitch, r.roll), CAM_UP) > maxTilt + 1e-9) return null
  return cameraUp(r.pitch)
}

/**
 * How much camera pitch a hip line (any length/sign) can show in perspective, 0..1: 0 while
 * it lies within UP_HIP_PERSPECTIVE_MIN of the image's horizontal axis (camera x), 1 from
 * UP_HIP_PERSPECTIVE_FULL (see hipLineUp).
 */
export function hipPerspectiveWeight(H: Vec3): number {
  const h = unit(H)
  if (!h) return 0
  const beta = Math.acos(clamp(Math.abs(h[0]), 0, 1)) * DEG
  return smoothstep(UP_HIP_PERSPECTIVE_MIN, UP_HIP_PERSPECTIVE_FULL, beta)
}

/**
 * Clamp an up estimate's camera roll (cameraRollDeg) to ±maxDeg (default UP_MAX_ROLL), keeping
 * its pitch. maxDeg = 0 levels the camera. (The estimates are level already; this bounds
 * ready-made ones pushed into an UpEstimator.)
 */
export function limitRoll(up: Vec3, maxDeg = UP_MAX_ROLL): Vec3 {
  const u = unit(up)
  if (!u) return up
  const r = Math.atan2(u[0], -u[1])
  const max = maxDeg * RAD
  if (Math.abs(r) <= max) return u
  // rotate within the image plane: the pitch (u_z) is unchanged
  const xy = Math.hypot(u[0], u[1])
  const rc = Math.sign(r) * max
  return [Math.sin(rc) * xy, -Math.cos(rc) * xy, u[2]]
}

/**
 * The hip line is usable as a horizontal reference when both hips are inside the
 * frame and at least one is seen: in a profile the far hip is occluded but its 3D
 * position is still predicted, and only the line's direction is needed.
 */
function hipLine(c: Ctx): boolean {
  if (!(bothInFrame(c, LM.leftHip, LM.rightHip) && (seenOf(c, LM.leftHip) || seenOf(c, LM.rightHip)))) return false
  const len = norm(sub(RW(c, LM.leftHip), RW(c, LM.rightHip)))
  return len >= HIP_LINE_MIN_M && len <= HIP_LINE_MAX_M
}

/** A seated trunk is never near-horizontal: reject thigh estimates that say so (hallucinated knees). */
function trunkPlausible(c: Ctx, up: Vec3): boolean {
  const T = pairVector(c, LM.leftHip, LM.rightHip, LM.leftShoulder, LM.rightShoulder)
  if (!T || norm(T) < 1e-6) return true
  return angleDeg(T, up) <= UP_MAX_TRUNK_TILT
}

/**
 * Twist between the pelvis and shoulder lines about the trunk axis (degrees, 0–90), or
 * null unless both hips and both shoulders are inside the frame. A seated person's hips
 * and shoulders face the same way (a lateral lean or a shrug does not twist them), so a
 * consistently large twist means the hips are hallucinated (predicted under a desk). One
 * frame is noisy (the depth of an 18 cm hip line): judge the median over a window, see
 * HipConsistency.
 */
export function hipTwist(frame: Frame): number | null {
  const c = toCtx(frame)
  if (!c || !bothInFrame(c, LM.leftHip, LM.rightHip) || !bothInFrame(c, LM.leftShoulder, LM.rightShoulder)) return null
  if (!(seenOf(c, LM.leftHip) || seenOf(c, LM.rightHip))) return null
  const H = sub(RW(c, LM.leftHip), RW(c, LM.rightHip))
  const S = sub(RW(c, LM.leftShoulder), RW(c, LM.rightShoulder))
  const mid = (a: number, b: number): Vec3 => scale(add(RW(c, a), RW(c, b)), 0.5)
  const T = unit(sub(mid(LM.leftShoulder, LM.rightShoulder), mid(LM.leftHip, LM.rightHip)))
  if (!T) return null
  const a = angleDeg(reject(H, T), reject(S, T))
  return Number.isFinite(a) ? Math.min(a, 180 - a) : null
}

/**
 * Session-level verdict on whether the hips are real: the median hipTwist over the
 * recent frames that show them. Until enough frames are in, the hips are trusted. The
 * verdict has a hysteresis of ±HIP_TWIST_HYST around HIP_TWIST_MAX, so the median of a few
 * noisy frames near the limit does not switch the hips (the gravity source, the trunk) on
 * and off from frame to frame. A one-shot verdict over a set of frames (buildBaseline) passes
 * hysteresis = false: the plain median against HIP_TWIST_MAX.
 */
export class HipConsistency {
  private twists: number[] = []
  private readonly window: number
  private readonly hyst: number
  private verdict = true

  constructor(window = 30, hysteresis = true) {
    this.window = window
    this.hyst = hysteresis ? HIP_TWIST_HYST : 0
  }

  push(frame: Frame): void {
    const t = hipTwist(frame)
    if (t === null) return
    this.twists.push(t)
    if (this.twists.length > this.window) this.twists.shift()
    if (this.twists.length < HIP_TWIST_MIN_FRAMES) return
    const m = median(this.twists)
    if (this.verdict && m > HIP_TWIST_MAX + this.hyst) this.verdict = false
    else if (!this.verdict && m <= HIP_TWIST_MAX - this.hyst) this.verdict = true
  }

  /** false when the hips look hallucinated (pass as ExtractOptions.hips) */
  get trusted(): boolean {
    return this.verdict
  }

  reset(): void {
    this.twists = []
    this.verdict = true
  }
}

const SOURCE_RANK: Record<UpSource, number> = { camera: 0, hips: 1, body: 2 }

/**
 * Accumulates gravity evidence over frames (§3.2) and estimates from the mean evidence
 * of the best source seen so far. A better source takes over once it has UP_MIN_FRAMES
 * frames, so one stray frame cannot hijack it.
 * - 'body': the running mean of the per-frame raw thigh estimates K × H (unit vectors),
 *   made a level-camera estimate once by thighHipUp with the mean hip line and the standard
 *   error of the thighs' roll (from its per-frame scatter).
 * - 'hips': the running mean of the frames' hip lines (sign-aligned unit vectors); the
 *   estimate is hipLineUp of that mean. Solving once on the mean keeps the estimate exactly
 *   ⟂ the mean hip line, which the mean of per-frame solutions is not (the solution is a
 *   nonlinear function of a noisy line).
 * - ready-made estimates (push(UpEstimate)) join their source's mean as unit vectors.
 * Every frame estimate is a level-camera one (|roll| ≤ UP_MAX_ROLL); the final estimate is
 * clamped again (limitRoll) for ready-made ones. Guards against a
 * biased mean: a source counts only when at least UP_MIN_ACCEPT_RATIO of the frames that
 * had its inputs produced it, and the per-frame tilt gate is only a loose sanity check
 * (UP_FRAME_MAX_TILT) while the mean itself is gated at UP_MAX_TILT — for a camera tilted
 * just past the limit, gating each frame would keep only the frames that noise pulled
 * under it.
 */
export class UpEstimator {
  private sums: Record<UpSource, Vec3> = { camera: [0, 0, 0], hips: [0, 0, 0], body: [0, 0, 0] }
  /** sign-aligned sum of the frames' unit hip lines, and how many there are */
  private hipSum: Vec3 = [0, 0, 0]
  private hipFrames = 0
  /** the raw thigh estimates' camera roll: count, sum and sum of squares (its noise, see thighHipUp) */
  private thighN = 0
  private thighRoll = 0
  private thighRollSq = 0
  private counts: Record<UpSource, number> = { camera: 0, hips: 0, body: 0 }
  private tries: Record<UpSource, number> = { camera: 0, hips: 0, body: 0 }
  /** estimate cache (cleared by push/reset) */
  private cached: UpEstimate | null = null

  /**
   * Add one frame (BAD frames are ignored) or one ready-made estimate. `hips: false`
   * ignores the hips/knees (hallucinated, see HipConsistency).
   */
  push(input: Frame | UpEstimate, opts: { hips?: boolean } = {}): void {
    this.cached = null
    if (input !== null && 'up' in input && 'source' in input) {
      const u = unit(input.up)
      if (!u) return
      this.add(input.source, u)
      this.tries[input.source]++
      if (input.source !== 'camera') this.tries.camera++
      return
    }
    const c = toCtx(input as Frame, HFOV_ASSUMED, opts.hips ?? true)
    if (!c || !goodCtx(c)) return
    // every available source accumulates on its own; estimate picks the best usable one
    const k = upCues(c)
    if (k.bodyTried) this.tries.body++
    if (k.hipsTried) this.tries.hips++
    this.tries.camera++
    if (k.body && k.thighUp && angleDeg(k.body, CAM_UP) <= UP_FRAME_MAX_TILT) {
      this.add('body', k.thighUp)
      const r = cameraRollDeg(k.thighUp)
      this.thighN++
      this.thighRoll += r
      this.thighRollSq += r * r
    }
    // a hip line counts when some gravity within the sanity gate is ⟂ to it
    if (k.hipLine && hipCorrectionDeg(k.hipLine) <= UP_FRAME_MAX_TILT) {
      this.hipSum = add(this.hipSum, dot(k.hipLine, this.hipSum) < 0 ? neg(k.hipLine) : k.hipLine)
      this.hipFrames++
      this.counts.hips++
    }
    this.add('camera', [...CAM_UP] as Vec3)
  }

  private add(s: UpSource, u: Vec3): void {
    this.sums[s] = add(this.sums[s], u)
    this.counts[s]++
  }

  /** frames (or estimates) pushed so far */
  get frameCount(): number {
    return this.tries.camera
  }

  /** A source's mean estimate (before the gates and the roll clamp). */
  private mean(s: UpSource): Vec3 | null {
    if (s === 'camera') return unit(this.sums.camera)
    const H = this.hipFrames > 0 ? unit(this.hipSum) : null
    if (s === 'body') {
      const t = unit(this.sums.body)
      if (!t) return null
      if (!H) return cameraUp(cameraPitchDeg(t))
      // the standard error of the mean thigh roll (per-frame scatter / √n)
      const n = this.thighN
      const v = n > 1 ? Math.max(0, this.thighRollSq - (this.thighRoll * this.thighRoll) / n) / (n - 1) : 0
      return thighHipUp(H, t, Math.sqrt(v / Math.max(1, n)))
    }
    if (!H) return unit(this.sums.hips)
    const fromLines = hipLineUp(H)
    if (!fromLines) return unit(this.sums.hips)
    return unit(add(scale(fromLines, this.hipFrames), this.sums.hips))
  }

  /**
   * How much of the current estimate's camera pitch was observed, 0..1: 1 for the thighs,
   * the mean hip line's perspective weight for 'hips' (0 = it faces the camera and the pitch
   * is assumed level), 0 for 'camera'. The baseline's trunk refinement supplies the rest.
   */
  get pitchWeight(): number {
    const s = this.estimate.source
    if (s === 'camera') return 0
    if (s === 'body' || this.hipFrames === 0) return 1
    const H = unit(this.hipSum)
    return (H && readHipLine(H)?.weight) || 0
  }

  /**
   * false when the hip line contradicts a level camera: at the estimated pitch it would still
   * need more than 2·UP_MAX_ROLL of roll (a level webcam's roll plus a seated pelvis's own
   * tilt and noise) — a camera rolled past the level-mount prior, or hallucinated or tilted
   * hips. The vertical is never tilted for it, but then the absolute horizontal (the
   * shoulders' tilt against gravity) cannot be judged (assess.ts AssessOptions.levelUnconfirmed).
   */
  get levelConsistent(): boolean {
    if (this.hipFrames === 0 || this.estimate.source === 'camera') return true
    const H = unit(this.hipSum)
    const r = H ? readHipLine(H) : null
    return !r || Math.abs(r.roll) <= 2 * UP_MAX_ROLL
  }

  /** The current best estimate ('camera' until anything better has enough frames). */
  get estimate(): UpEstimate {
    if (this.cached) return { up: [...this.cached.up] as Vec3, source: this.cached.source }
    const e = this.compute()
    this.cached = e
    return { up: [...e.up] as Vec3, source: e.source }
  }

  private compute(): UpEstimate {
    const order: UpSource[] = ['body', 'hips']
    const usable = (s: UpSource): Vec3 | null => {
      if (this.counts[s] < UP_MIN_ACCEPT_RATIO * this.tries[s]) return null
      const u = this.mean(s)
      // (a hip-line estimate may sit exactly on the bound: allow for rounding)
      if (!u || angleDeg(u, CAM_UP) > UP_MAX_TILT + 1e-6) return null
      return limitRoll(u)
    }
    for (const s of order) {
      if (this.counts[s] >= UP_MIN_FRAMES) {
        const u = usable(s)
        if (u) return { up: u, source: s }
      }
    }
    // nothing has enough frames yet: the most-seen usable non-camera source, else camera
    let best: UpSource = 'camera'
    for (const s of order) if (this.counts[s] > this.counts[best] && SOURCE_RANK[s] > 0 && usable(s)) best = s
    if (best !== 'camera') {
      const u = usable(best)
      if (u) return { up: u, source: best }
    }
    return { up: [...CAM_UP] as Vec3, source: 'camera' }
  }

  reset(): void {
    this.sums = { camera: [0, 0, 0], hips: [0, 0, 0], body: [0, 0, 0] }
    this.hipSum = [0, 0, 0]
    this.hipFrames = 0
    this.thighN = 0
    this.thighRoll = 0
    this.thighRollSq = 0
    this.counts = { camera: 0, hips: 0, body: 0 }
    this.tries = { camera: 0, hips: 0, body: 0 }
    this.cached = null
  }
}

// ---------------------------------------------------------------------------
// features (§3.3–§3.5)

/** Focal length in height units for the assumed HFOV (§1). */
export const focalLength = (aspect: number, hfovDeg = HFOV_ASSUMED): number =>
  (aspect * 0.5) / Math.tan((hfovDeg * RAD) / 2)

const PPM_SEGMENTS: ReadonlyArray<readonly [number, number]> = [
  [LM.leftShoulder, LM.rightShoulder],
  [LM.leftEar, LM.rightEar],
  [LM.leftEyeOuter, LM.rightEyeOuter],
  [LM.leftEar, LM.leftShoulder],
  [LM.rightEar, LM.rightShoulder],
  [LM.nose, LM.leftEar],
  [LM.nose, LM.rightEar],
  [LM.leftShoulder, LM.leftHip],
  [LM.rightShoulder, LM.rightHip]
]

/** Number of seen segments with a measurable length (§3.5: the scale needs ≥ 2). */
function scaleSegments(c: Ctx): number {
  let n = 0
  for (const [a, b] of PPM_SEGMENTS) {
    if (!seenOf(c, a) || !seenOf(c, b)) continue
    const pa = RW(c, a)
    const pb = RW(c, b)
    if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) > 1e-4) n++
  }
  return n
}

function visibilitySummary(c: Ctx): VisibilitySummary {
  const s = {
    nose: seenOf(c, LM.nose),
    leftEar: seenOf(c, LM.leftEar),
    rightEar: seenOf(c, LM.rightEar),
    leftEyeOuter: seenOf(c, LM.leftEyeOuter),
    rightEyeOuter: seenOf(c, LM.rightEyeOuter),
    leftShoulder: seenOf(c, LM.leftShoulder),
    rightShoulder: seenOf(c, LM.rightShoulder),
    leftHip: seenOf(c, LM.leftHip),
    rightHip: seenOf(c, LM.rightHip),
    leftKnee: seenOf(c, LM.leftKnee),
    rightKnee: seenOf(c, LM.rightKnee)
  }
  const n = (a: boolean, b: boolean): number => (a ? 1 : 0) + (b ? 1 : 0)
  return {
    head: s.nose || s.leftEar || s.rightEar,
    nose: s.nose,
    ears: n(s.leftEar, s.rightEar),
    eyes: n(s.leftEyeOuter, s.rightEyeOuter),
    shoulders: n(s.leftShoulder, s.rightShoulder),
    hips: n(s.leftHip, s.rightHip),
    hipsInFrame: n(marginOf(c, LM.leftHip) >= 0, marginOf(c, LM.rightHip) >= 0),
    knees: n(s.leftKnee, s.rightKnee),
    seen: s
  }
}

const viewKind = (yaw: number): ViewInfo['kind'] =>
  yaw < VIEW_FRONT_MAX_YAW ? 'front' : yaw < VIEW_ANGLED_MAX_YAW ? 'angled' : 'side'

/** Both points of a pair are reliably inside the frame (lateral measures need both sides). */
const bothInFrame = (c: Ctx, l: number, r: number): boolean => trustOf(c, l) >= 0.5 && trustOf(c, r) >= 0.5

/**
 * §3: geometry of one frame, or null for a BAD frame (§2).
 * At runtime pass the baseline's `up` (the camera is fixed); during setup pass the
 * UpEstimator's current estimate.
 */
export function extractFeatures(frame: Frame, opts: ExtractOptions = {}): PostureFeatures | null {
  const c = toCtx(frame, opts.hfovDeg, opts.hips ?? true)
  if (!c || !goodCtx(c)) return null

  // ---- gravity
  let U: Vec3
  let upSource: UpSource
  const fixedUp = opts.up ? unit(opts.up) : null
  if (fixedUp) {
    U = fixedUp
    upSource = opts.upSource ?? 'camera'
  } else {
    const est = estimateUpCtx(c)
    U = est.up
    upSource = est.source
  }

  const vis = visibilitySummary(c)
  // bilateral measures need both points seen AND inside the frame (off-frame 3D is extrapolated)
  const hipsBoth = vis.seen.leftHip && vis.seen.rightHip && bothInFrame(c, LM.leftHip, LM.rightHip)
  const hipAny = vis.seen.leftHip || vis.seen.rightHip
  const shouldersBoth = bothInFrame(c, LM.leftShoulder, LM.rightShoulder)

  // ---- body frame (§3.3). The lateral axis always comes from the body: the hip line,
  // else the shoulder line; with only one shoulder in the frame, the baseline's forward
  // (runtime) or the shoulder line with the other shoulder's predicted position (setup).
  // Never from the head — it turns on its own, and with one shoulder in view the neck
  // vector's lateral offset would project onto a forward axis that turned with it.
  const S = sub(W(c, LM.leftShoulder), W(c, LM.rightShoulder))
  const H = sub(W(c, LM.leftHip), W(c, LM.rightHip))
  const Eears = sub(W(c, LM.leftEar), W(c, LM.rightEar))
  const hint = opts.forwardHint ? unit(reject(opts.forwardHint, U)) : null
  let Lraw: Vec3
  let lateralAxis: LateralAxisSource
  if (hipLine(c)) {
    Lraw = H
    lateralAxis = 'hips'
  } else if (shouldersBoth) {
    Lraw = S
    lateralAxis = 'shoulders'
  } else if (hint) {
    Lraw = cross(U, hint)
    lateralAxis = 'baseline'
  } else if (norm(S) >= SHOULDER_LINE_MIN_M) {
    Lraw = S
    lateralAxis = 'shoulders'
  } else {
    Lraw = Eears
    lateralAxis = 'head'
  }
  const Lh = unit(reject(Lraw, U)) ?? unit(reject([1, 0, 0], U)) ?? ([1, 0, 0] as Vec3)
  let F = cross(Lh, U)

  // head direction from back-projected points: a short vector near the head, where the
  // precise 2D landmarks matter most and the depth span (FOV sensitivity) is small
  const earPt = pairWorld(c, LM.leftEar, LM.rightEar, P)
  const nosePt = worldOk(c, LM.nose) ? P(c, LM.nose) : null
  const n = earPt && nosePt ? sub(nosePt, earPt) : null
  // neck: ear point (trust-weighted: the ear MIDPOINT, which a head turn does not move)
  // minus the shoulder MIDPOINT (see the angles below)
  const earW = pairWorld(c, LM.leftEar, LM.rightEar)
  const N = earW ? sub(earW, shoulderMid(c, W)) : null
  if (!N) return null
  if (lateralAxis !== 'baseline') {
    // orient forward toward the nose (this also corrects swapped left/right labels). The
    // sign is tested against the forward of the body's own up (gravity plus the neck
    // axis): with a badly wrong gravity (camera-only from a steep camera) the nose can
    // lie almost along Û, where its component along F̂ is noise
    const Nl = unit(reject(N, Lh))
    const Fo = Nl ? (unit(cross(Lh, add(U, Nl))) ?? F) : F
    let orient = 0
    if (n && trustOf(c, LM.nose) > 0.5) orient = dot(n, Fo)
    else if (hint) orient = dot(hint, F)
    else if (n) orient = dot(n, Fo)
    if (orient < 0) F = neg(F)
  }
  const L = cross(U, F)
  // MediaPipe's labels vs the body geometry (the body line, not the baseline axis)
  const labelLine = lateralAxis === 'hips' ? H : S
  const labelsSwapped = dot(labelLine, L) < 0

  // ---- view (§3.5) — from the anchor's image ray, independent of scale
  const f = c.f
  const shImg =
    pairImage(c, LM.leftShoulder, LM.rightShoulder) ??
    UV(c, vis.seen.leftShoulder ? LM.leftShoulder : LM.rightShoulder)
  const ray = unit([shImg[0] / f, shImg[1] / f, 1]) ?? ([0, 0, 1] as Vec3)
  const toCam = neg(ray)
  const toCamH = unit(reject(toCam, U))
  const yawDeg = toCamH ? angleDeg(F, toCamH) : 0
  const elevationDeg = Math.asin(clamp(dot(toCam, U), -1, 1)) * DEG
  // the camera's optical axis, horizontally, vs the body: how much camera pitch leaks
  // into sagittal angles (∝ |cos|). Unlike yawDeg it does not move when the shoulders
  // move in the picture (a forward lean shifts the anchor ray by ~15° up close)
  const axisH = unit(reject([0, 0, 1], U))
  const opticalYawDeg = axisH ? angleDeg(F, neg(axisH)) : yawDeg
  const view: ViewInfo = { yawDeg, elevationDeg, kind: viewKind(yawDeg), opticalYawDeg }
  const lateralOk = yawDeg < (opts.lateralMaxYaw ?? LAT_MAX_YAW)

  // ---- angles (§3.4)
  // neck N (above): with one shoulder cut off, the shoulder midpoint is the visible
  // shoulder plus half the world shoulder vector (the other shoulder's predicted
  // position): it stays on the body's axis, so neither a swivel nor an error in the
  // forward axis turns the 18 cm shoulder offset into a fake head-forward reading.
  const neckFwd = tiltDeg(N, U, F)

  const T = hipAny ? pairVector(c, LM.leftHip, LM.rightHip, LM.leftShoulder, LM.rightShoulder) : null

  let neckLat: number | null = null
  let neckLatRef: NeckLatRef | null = null
  if (
    lateralOk &&
    bothInFrame(c, LM.leftEar, LM.rightEar) &&
    shouldersBoth &&
    vis.ears + vis.shoulders >= 2
  ) {
    // relative to the trunk when the trunk's own lean (trunkLat) is measured too: in the
    // trunk's frontal plane (spanned by the trunk and the pelvis line), so gravity — and
    // with it any error in Û or F̂ — plays no part. Otherwise relative to gravity, so a
    // whole-upper-body lean is still seen (the engine holds that one on a swivel).
    const Tu = hipsBoth && T ? unit(T) : null
    let Hl = unit(H)
    if (Hl && dot(Hl, L) < 0) Hl = neg(Hl)
    const Lt = Tu && Hl ? unit(reject(Hl, Tu)) : null
    if (Tu && Lt) {
      neckLat = tiltDeg(N, Tu, Lt)
      neckLatRef = 'trunk'
    } else {
      // out of the body's sagittal plane (⟂ L̂): a camera-pitch error lies within that
      // plane and does not scale the reading (atan2(N·L, N·Û) would grow as 1/cos error)
      neckLat = outOfPlaneDeg(N, L)
      neckLatRef = 'gravity'
    }
  }

  let headPitch: number | null = null
  let headYaw: number | null = null
  if (vis.nose && n) {
    const nh = reject(n, U)
    headPitch = Math.atan2(-dot(n, U), norm(nh)) * DEG
    headYaw = Math.atan2(dot(nh, L), dot(nh, F)) * DEG
  }

  let headRollRel: number | null = null
  if (
    lateralOk &&
    visOf(c, LM.leftShoulder) >= V_ROLL_SHOULDERS &&
    visOf(c, LM.rightShoulder) >= V_ROLL_SHOULDERS &&
    bothInFrame(c, LM.leftShoulder, LM.rightShoulder)
  ) {
    let E: Vec3 | null = null
    if (vis.seen.leftEar && vis.seen.rightEar && bothInFrame(c, LM.leftEar, LM.rightEar)) E = Eears
    else if (vis.seen.leftEyeOuter && vis.seen.rightEyeOuter && bothInFrame(c, LM.leftEyeOuter, LM.rightEyeOuter))
      E = sub(W(c, LM.leftEyeOuter), W(c, LM.rightEyeOuter))
    // the body's own frontal plane: spanned by L and the trunk (else the neck), so
    // the angle stays body-relative even when gravity (hence F) is uncertain
    const V = unit(reject(T ?? N, L))
    const Fb = V ? unit(cross(L, V)) : null
    if (E && V && Fb) {
      const inPlane = (v: Vec3): number => {
        let p = reject(v, Fb)
        if (dot(p, L) < 0) p = neg(p)
        return Math.atan2(dot(p, V), dot(p, L)) * DEG
      }
      headRollRel = wrapDeg(inPlane(E) - inPlane(S))
    }
  }

  let shoulderTilt: number | null = null
  if (
    lateralOk &&
    vis.shoulders === 2 &&
    bothInFrame(c, LM.leftShoulder, LM.rightShoulder) &&
    (upSource !== 'camera' || yawDeg <= SHOULDER_CAMERA_MAX_YAW)
  ) {
    let Su = unit(S)
    if (Su) {
      if (dot(Su, L) < 0) Su = neg(Su)
      shoulderTilt = Math.asin(clamp(dot(Su, U), -1, 1)) * DEG
    }
  }

  const trunkFwd = T ? tiltDeg(T, U, F) : null

  // ---- the head on the trunk, gravity-free: angles within the body's own sagittal plane,
  // the plane ⟂ the body's lateral line (hips, else shoulders — no gravity enters), between
  // the trunk and the neck / the head direction. (A gravity error tilts trunkFwd, neckFwd and
  // headPitch alike only when it lies in the sagittal plane; its lateral part — a camera pitch
  // seen from a turned body — leaks into a diagonal nose vector, one ear in view, differently.)
  // Every vector here is a world-landmark vector, so a residual rotation of the world frame
  // (the viewing-ray correction's FOV residual) cancels too; the back-projected head direction
  // `n` would not share it (up to 9° off with a 85° webcam).
  let neckOnTrunk: number | null = null
  let headOnTrunk: number | null = null
  let neckOnTrunkVec: [number, number] | null = null
  let headOnTrunkVec: [number, number] | null = null
  // (the head direction only with an ear reliably inside the frame: the trust-weighted ear
  // point of a single ear grazing the frame edge is that ear alone, whose position may be
  // extrapolated — on the 10 cm ear→nose line that turned a frame by up to 115°)
  const earTrust = trustOf(c, LM.leftEar) + trustOf(c, LM.rightEar)
  if (T) {
    let Lb = lateralAxis === 'hips' || lateralAxis === 'shoulders' ? unit(Lraw) : null
    if (!Lb) Lb = L
    else if (dot(Lb, L) < 0) Lb = neg(Lb)
    const Tu = unit(reject(T, Lb))
    const Fb = Tu ? unit(cross(Lb, Tu)) : null
    if (Tu && Fb) {
      const Ns = reject(N, Lb)
      neckOnTrunkVec = [dot(Ns, Fb), dot(Ns, Tu)]
      neckOnTrunk = neckOnTrunkAngle(neckOnTrunkVec)
      const nW = vis.nose && earW && earTrust >= 0.5 && worldOk(c, LM.nose) ? sub(W(c, LM.nose), earW) : null
      if (nW) {
        const ns = reject(nW, Lb)
        headOnTrunkVec = [dot(ns, Fb), dot(ns, Tu)]
        headOnTrunk = headOnTrunkAngle(headOnTrunkVec)
      }
    }
  }

  let trunkLat: number | null = null
  let torsoLen: number | null = null
  if (hipsBoth && T) {
    torsoLen = norm(T)
    let Hu = unit(H)
    if (Hu && lateralOk) {
      if (dot(Hu, L) < 0) Hu = neg(Hu)
      // the trunk's angle out of the pelvis's sagittal plane (⟂ Ĥ): pelvis-relative and
      // independent of where gravity lies within that plane (a pitch error of Û would
      // otherwise scale it by 1/cos error — ×2 for a 60°-tilted camera)
      trunkLat = outOfPlaneDeg(T, Hu)
    }
  }

  // ---- scale and positions (§3.5): back-projected points (Ctx.pos)
  const ppm = c.ppm
  let anchor: Vec3 | null = null
  let head: Vec3 | null = null
  let neckH: number | null = null
  if (ppm !== null) {
    // on the body's axis even with one shoulder cut off (see N above): a swivel does not move it
    anchor = shoulderMid(c, P)
    head = pairWorld(c, LM.leftEar, LM.rightEar, P)
    const earImg = pairImage(c, LM.leftEar, LM.rightEar)
    if (earImg) {
      const upLen = Math.hypot(U[0], U[1])
      if (upLen > 1e-6) {
        const ux = U[0] / upLen
        const uy = U[1] / upLen
        neckH = ((earImg[0] - shImg[0]) * ux + (earImg[1] - shImg[1]) * uy) / ppm
      }
    }
  }

  // ---- near side (overlay)
  const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0)
  const visL = sum([visOf(c, LM.leftEar), visOf(c, LM.leftShoulder), visOf(c, LM.leftHip)])
  const visR = sum([visOf(c, LM.rightEar), visOf(c, LM.rightShoulder), visOf(c, LM.rightHip)])
  let nearSide: Side = visL >= visR ? 'left' : 'right'
  if (labelsSwapped) nearSide = nearSide === 'left' ? 'right' : 'left'

  if (!Number.isFinite(neckFwd)) return null

  return {
    good: true,
    vis,
    up: U,
    upSource,
    left: L,
    forward: F,
    view,
    nearSide,
    neckFwd,
    neckLat: finiteOrNull(neckLat),
    neckLatRef: neckLat !== null && Number.isFinite(neckLat) ? neckLatRef : null,
    lateralAxis,
    headPitch: finiteOrNull(headPitch),
    headYaw: finiteOrNull(headYaw),
    earsBoth: bothInFrame(c, LM.leftEar, LM.rightEar),
    headRollRel: finiteOrNull(headRollRel),
    shoulderTilt: finiteOrNull(shoulderTilt),
    trunkFwd: finiteOrNull(trunkFwd),
    neckOnTrunk: finiteOrNull(neckOnTrunk),
    headOnTrunk: finiteOrNull(headOnTrunk),
    neckOnTrunkVec: neckOnTrunk !== null && Number.isFinite(neckOnTrunk) ? neckOnTrunkVec : null,
    headOnTrunkVec: headOnTrunk !== null && Number.isFinite(headOnTrunk) ? headOnTrunkVec : null,
    trunkLat: finiteOrNull(trunkLat),
    torsoLen: finiteOrNull(torsoLen),
    ppm,
    anchor,
    head,
    neckH: finiteOrNull(neckH),
    labelsSwapped
  }
}

const finiteOrNull = (v: number | null): number | null => (v !== null && Number.isFinite(v) ? v : null)

/** neckOnTrunk from its [forward, up] components in the trunk's sagittal frame (deg, + = ears ahead) */
export const neckOnTrunkAngle = (v: readonly [number, number]): number => Math.atan2(v[0], v[1]) * DEG

/** headOnTrunk from its [forward, up] components in the trunk's sagittal frame (deg, + = nose down) */
export const headOnTrunkAngle = (v: readonly [number, number]): number => Math.atan2(-v[1], v[0]) * DEG

/** Signed angle of `v` out of the plane perpendicular to the unit `axis` (toward +axis), degrees. */
const outOfPlaneDeg = (v: Vec3, axis: Vec3): number => Math.atan2(dot(v, axis), norm(reject(v, axis))) * DEG
