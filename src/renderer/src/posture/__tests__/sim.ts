// 3D posture simulator (docs/specs/detection.md §10) — the test harness for
// "works from any camera angle". A parametric seated skeleton in room/body
// coordinates is rendered by a virtual pinhole camera into MediaPipe-shaped
// output (33 image landmarks + 33 world landmarks). Like the real model, which predicts
// world landmarks from a crop as if it were viewed along the optical axis, the world
// landmarks are rendered in the crop-ray frame: rotated against the camera frame by the
// angle between the optical axis and the ray to the crop centre (see cropRotation).
//
// Room/body coordinates (metres): origin at the neutral hip midpoint,
// X = the person's left, Y = up, Z = forward (toward the screen).
// Deterministic: all noise comes from a seeded PRNG.

import type { Landmark, PoseFrame } from '../types'
import { DEG, RAD, add, clamp, cross, dot, norm, rotate, scale, sub, tiltDeg, unit, type Vec3 } from '../vec'

// ---------------------------------------------------------------------------
// seeded PRNG

/** mulberry32: small, fast, deterministic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Rng {
  private readonly next: () => number
  private spare: number | null = null
  constructor(seed: number) {
    this.next = mulberry32(seed)
  }
  uniform(lo = 0, hi = 1): number {
    return lo + (hi - lo) * this.next()
  }
  gauss(sigma = 1): number {
    if (this.spare !== null) {
      const s = this.spare
      this.spare = null
      return s * sigma
    }
    let u = 0
    while (u <= 1e-12) u = this.next()
    const v = this.next()
    const r = Math.sqrt(-2 * Math.log(u))
    this.spare = r * Math.sin(2 * Math.PI * v)
    return r * Math.cos(2 * Math.PI * v) * sigma
  }
  unitVec(): Vec3 {
    return unit([this.gauss(), this.gauss(), this.gauss()]) ?? [1, 0, 0]
  }
}

// ---------------------------------------------------------------------------
// posture

export interface PostureParams {
  /** trunk lean, degrees (+ forward) */
  trunkPitch: number
  /** trunk lateral lean, degrees (+ toward the person's left) */
  trunkRoll: number
  /** torso compression fraction (0.1 = 10% shorter hip→shoulder) */
  slump: number
  /** neck flexion relative to the trunk, degrees (+ head forward) */
  neckFlex: number
  /** lateral neck flexion, degrees (+ toward the left) */
  neckLat: number
  /** head pitch relative to the neck, degrees (+ nose down) */
  headPitch: number
  /** head roll relative to the neck, degrees (+ = left ear goes down, head tilts toward the left) */
  headRoll: number
  /** head yaw relative to the neck, degrees (+ = face turns to the person's left) */
  headYaw: number
  /** shoulder raise, metres */
  shrugL: number
  shrugR: number
  /** whole-body yaw about the vertical through the hips, degrees (+ = turn to the left) */
  swivel: number
  /** whole-body translation toward the screen, metres */
  slide: number
  /** whole-body drop, metres (+ = down) */
  sink: number
  /** thigh slope, degrees (+ = knees higher than hips) */
  thighSlope: number
  /**
   * Rounded shoulders (protraction), metres: both shoulder joints move this far forward of
   * the top of the trunk, and a little inward (0.35×) and down (0.25×). The neck still rises
   * from the top of the trunk, so — as for MediaPipe's shoulder landmarks — the ears read
   * less far ahead of the shoulders and the hip→shoulder chord leans forward.
   */
  shoulderRound: number
}

export const NEUTRAL: Readonly<PostureParams> = Object.freeze({
  trunkPitch: 0,
  trunkRoll: 0,
  slump: 0,
  neckFlex: 0,
  neckLat: 0,
  headPitch: 0,
  headRoll: 0,
  headYaw: 0,
  shrugL: 0,
  shrugR: 0,
  swivel: 0,
  slide: 0,
  sink: 0,
  thighSlope: 0,
  shoulderRound: 0
})

export const posture = (p: Partial<PostureParams> = {}): PostureParams => ({ ...NEUTRAL, ...p })

const X: Vec3 = [1, 0, 0]
const Y: Vec3 = [0, 1, 0]
const Z: Vec3 = [0, 0, 1]

interface Frame3 {
  l: Vec3
  u: Vec3
  f: Vec3
}

/** Rotate a frame about one of its own axes. */
function pitchFrame(fr: Frame3, deg: number): Frame3 {
  // + = up tips toward forward (about +l, right-hand rule takes u → f)
  return { l: fr.l, u: rotate(fr.u, fr.l, deg), f: rotate(fr.f, fr.l, deg) }
}
function rollFrame(fr: Frame3, deg: number): Frame3 {
  // + = up tips toward the left (about −f)
  return { l: rotate(fr.l, fr.f, -deg), u: rotate(fr.u, fr.f, -deg), f: fr.f }
}
function yawFrame(fr: Frame3, deg: number): Frame3 {
  // + = forward turns toward the left (about +u)
  return { l: rotate(fr.l, fr.u, deg), u: fr.u, f: rotate(fr.f, fr.u, deg) }
}
const at = (o: Vec3, fr: Frame3, l: number, u: number, f: number): Vec3 =>
  add(o, add(scale(fr.l, l), add(scale(fr.u, u), scale(fr.f, f))))
const dirIn = (fr: Frame3, l: number, u: number, f: number): Vec3 =>
  unit(add(scale(fr.l, l), add(scale(fr.u, u), scale(fr.f, f)))) as Vec3

export interface Skeleton {
  /** 33 room-frame points */
  points: Vec3[]
  /** 33 outward unit normals */
  normals: Vec3[]
  /** body forward / left after swivel (horizontal) */
  forward: Vec3
  left: Vec3
}

/** Build the seated skeleton (room frame) for a posture. */
export function skeleton(p: PostureParams): Skeleton {
  const pts: Vec3[] = Array.from({ length: 33 }, () => [0, 0, 0] as Vec3)
  const nrm: Vec3[] = Array.from({ length: 33 }, () => Z)
  const body: Frame3 = { l: X, u: Y, f: Z }

  // pelvis + legs (body frame, before the whole-body transform)
  const hipL: Vec3 = [0.09, 0, 0]
  const hipR: Vec3 = [-0.09, 0, 0]
  const s = p.thighSlope * RAD
  const kneeL: Vec3 = [0.1, 0.45 * Math.sin(s), 0.45 * Math.cos(s)]
  const kneeR: Vec3 = [-0.1, 0.45 * Math.sin(s), 0.45 * Math.cos(s)]
  pts[23] = hipL
  pts[24] = hipR
  nrm[23] = dirIn(body, 0.7, 0, 0.7)
  nrm[24] = dirIn(body, -0.7, 0, 0.7)
  pts[25] = kneeL
  pts[26] = kneeR
  nrm[25] = dirIn(body, 0.3, 0.4, 1)
  nrm[26] = dirIn(body, -0.3, 0.4, 1)
  pts[27] = add(kneeL, [0, -0.45, 0.05])
  pts[28] = add(kneeR, [0, -0.45, 0.05])
  pts[29] = add(pts[27], [0, -0.05, -0.05])
  pts[30] = add(pts[28], [0, -0.05, -0.05])
  pts[31] = add(pts[27], [0, -0.07, 0.15])
  pts[32] = add(pts[28], [0, -0.07, 0.15])
  for (const i of [27, 28, 29, 30, 31, 32]) nrm[i] = dirIn(body, i % 2 ? 0.3 : -0.3, 0.2, 1)

  // trunk (shMid = the top of the trunk, where the neck rises; the shoulder joints sit on
  // either side of it, forward of it when the shoulders are rounded)
  const trunk = pitchFrame(rollFrame(body, p.trunkRoll), p.trunkPitch)
  const torsoLen = 0.48 * (1 - p.slump)
  const shMid = at([0, 0, 0], trunk, 0, torsoLen, 0)
  const rnd = p.shoulderRound ?? 0
  pts[11] = at(shMid, trunk, 0.18 - 0.35 * rnd, p.shrugL - 0.25 * rnd, rnd)
  pts[12] = at(shMid, trunk, -0.18 + 0.35 * rnd, p.shrugR - 0.25 * rnd, rnd)
  nrm[11] = dirIn(trunk, 0.8, 0.3, 0.5)
  nrm[12] = dirIn(trunk, -0.8, 0.3, 0.5)

  // arms hang (room-vertical), forearms forward to a keyboard
  for (const [sh, el, wr, side] of [
    [11, 13, 15, 1],
    [12, 14, 16, -1]
  ] as const) {
    pts[el] = add(pts[sh], [side * 0.03, -0.27, 0.06])
    pts[wr] = add(pts[el], [-side * 0.04, 0.04, 0.25])
    nrm[el] = dirIn(body, side * 0.8, 0, 0.5)
    nrm[wr] = dirIn(body, 0, 0.7, 0.7)
  }
  for (const [i, wr] of [
    [17, 15],
    [19, 15],
    [21, 15],
    [18, 16],
    [20, 16],
    [22, 16]
  ] as const) {
    pts[i] = add(pts[wr], [0, 0, 0.06])
    nrm[i] = dirIn(body, 0, 0.7, 0.7)
  }

  // neck + head
  const neck = rollFrame(pitchFrame(trunk, p.neckFlex), p.neckLat)
  const earMid = at(shMid, neck, 0, 0.15, 0)
  const head = rollFrame(pitchFrame(yawFrame(neck, p.headYaw), p.headPitch), p.headRoll)
  pts[7] = at(earMid, head, 0.075, 0, 0)
  pts[8] = at(earMid, head, -0.075, 0, 0)
  nrm[7] = head.l
  nrm[8] = scale(head.l, -1)
  pts[0] = at(earMid, head, 0, -0.025, 0.1)
  nrm[0] = head.f
  pts[3] = at(earMid, head, 0.045, 0.015, 0.08)
  pts[6] = at(earMid, head, -0.045, 0.015, 0.08)
  nrm[3] = dirIn(head, 0.85, 0, 0.5)
  nrm[6] = dirIn(head, -0.85, 0, 0.5)
  pts[2] = at(earMid, head, 0.032, 0.015, 0.088)
  pts[5] = at(earMid, head, -0.032, 0.015, 0.088)
  pts[1] = at(earMid, head, 0.018, 0.015, 0.093)
  pts[4] = at(earMid, head, -0.018, 0.015, 0.093)
  pts[9] = at(earMid, head, 0.025, -0.06, 0.088)
  pts[10] = at(earMid, head, -0.025, -0.06, 0.088)
  for (const i of [1, 2, 4, 5, 9, 10]) nrm[i] = dirIn(head, i === 2 || i === 1 || i === 9 ? 0.3 : -0.3, 0, 1)

  // whole-body transform: swivel about the vertical through the hips, then slide/sink
  const shift: Vec3 = [0, -p.sink, p.slide]
  const points = pts.map((q) => add(rotate(q, Y, p.swivel), shift))
  const normals = nrm.map((n) => rotate(n, Y, p.swivel))
  return { points, normals, forward: rotate(Z, Y, p.swivel), left: rotate(X, Y, p.swivel) }
}

// ---------------------------------------------------------------------------
// ground truth (room frame, independent of the detection code)

export interface Truth {
  neckFwd: number
  trunkFwd: number
  headPitch: number
  /** lateral trunk lean (+ left), relative to the (level) pelvis */
  trunkLat: number
  /** neck lateral tilt relative to the trunk, in the trunk's frontal plane (+ left) */
  neckLatTrunk: number
  /** neck lateral tilt relative to gravity (+ left) */
  neckLatGravity: number
  /** + = left shoulder higher */
  shoulderTilt: number
  /** + = left ear higher than the shoulder line, frontal plane */
  headRollRel: number
}

export function truth(p: PostureParams): Truth {
  const sk = skeleton(p)
  const P = sk.points
  const F = sk.forward
  const L = sk.left
  const mid = (a: number, b: number): Vec3 => scale(add(P[a], P[b]), 0.5)
  const sh = mid(11, 12)
  const ear = mid(7, 8)
  const hip = mid(23, 24)
  const N = sub(ear, sh)
  const T = sub(sh, hip)
  const n = sub(P[0], ear)
  const nh = sub(n, scale(Y, dot(n, Y)))
  // trunk-relative neck tilt in the trunk's own frontal plane (spanned by the trunk and
  // the pelvis line): gravity-free, like the detection code's trunk-referenced neckLat
  const Tu = unit(T) as Vec3
  const Hl = unit(sub(P[23], P[24])) as Vec3
  const Lt = unit(sub(Hl, scale(Tu, dot(Hl, Tu)))) as Vec3
  const inPlane = (v: Vec3): number => {
    let q = sub(v, scale(F, dot(v, F)))
    if (dot(q, L) < 0) q = scale(q, -1)
    return Math.atan2(dot(q, Y), dot(q, L)) * DEG
  }
  const S = sub(P[11], P[12])
  return {
    neckFwd: tiltDeg(N, Y, F),
    trunkFwd: tiltDeg(T, Y, F),
    headPitch: Math.atan2(-dot(n, Y), norm(nh)) * DEG,
    trunkLat: tiltDeg(T, Y, L),
    neckLatTrunk: tiltDeg(N, Tu, Lt),
    neckLatGravity: tiltDeg(N, Y, L),
    shoulderTilt: Math.asin(dot(unit(S) as Vec3, Y)) * DEG,
    headRollRel: inPlane(sub(P[7], P[8])) - inPlane(S)
  }
}

// ---------------------------------------------------------------------------
// realistic seated postures (good and bad), each with the eyes on the screen

/**
 * The simulator's ear→nose line points this far below the head's (Frankfort) horizontal: the
 * nose sits 2.5 cm below and 10 cm in front of the ear midpoint. A level gaze therefore reads
 * truth().headPitch ≈ 14°.
 */
export const NOSE_DROP_DEG = Math.atan2(0.025, 0.1) * DEG

/**
 * The posture with its head pitched (relative to the neck) so that the head's Frankfort plane
 * is `frankfortDeg` below horizontal: 0 = level gaze, + = looking down (a screen below eye
 * level), − = looking up. People keep their eyes on the screen whatever the trunk does, so
 * every realistic posture below is built with it.
 */
export function eyesOnScreen(p: Partial<PostureParams>, frankfortDeg: number): PostureParams {
  let q = posture({ ...p, headPitch: 0 })
  // headPitch is a rotation about the head's own left axis: additive for sagittal postures,
  // nearly so with a roll or a swivel — two refinements make it exact enough
  for (let i = 0; i < 3; i++) {
    const err = NOSE_DROP_DEG + frankfortDeg - truth(q).headPitch
    q = { ...q, headPitch: q.headPitch + err }
  }
  return q
}

export type PostureFamily = 'upright' | 'reclined' | 'lying' | 'slumped' | 'hunch'

export interface SeatedPosture {
  name: string
  family: PostureFamily
  p: PostureParams
}

/** a neck flexion (relative to the trunk) that puts the neck at `absDeg` from vertical (+ = forward) */
const neckAt = (trunkPitch: number, absDeg: number): number => absDeg - trunkPitch

/**
 * Acceptable working postures (docs/specs/detection.md, "Posture judge v3"): an upright trunk,
 * or one reclined 5–15° against a backrest, with the head stacked over the shoulders (ears 0–8°
 * ahead) and the eyes on a screen at or a little below eye level. The ergonomic reference is a
 * hip angle of ~90–110° (trunk 0–20° back from vertical) with the ears over the shoulders.
 * Thigh slopes vary with the chair height.
 */
export const GOOD_SEATED: readonly SeatedPosture[] = [
  { name: 'upright', family: 'upright', p: eyesOnScreen({}, 5) },
  { name: 'upright, ears 6° ahead, low screen', family: 'upright', p: eyesOnScreen({ neckFlex: 6 }, 12) },
  { name: 'upright, high chair (knees 10° down)', family: 'upright', p: eyesOnScreen({ thighSlope: -10, neckFlex: 4 }, 8) },
  { name: 'upright, low chair (knees 10° up)', family: 'upright', p: eyesOnScreen({ thighSlope: 10 }, 5) },
  { name: 'upright, leaning 5° in', family: 'upright', p: eyesOnScreen({ trunkPitch: 5, neckFlex: 2 }, 10) },
  { name: 'reclined 5°, head stacked', family: 'reclined', p: eyesOnScreen({ trunkPitch: -5, neckFlex: neckAt(-5, 3) }, 6) },
  { name: 'reclined 10°, head stacked', family: 'reclined', p: eyesOnScreen({ trunkPitch: -10, neckFlex: neckAt(-10, 4) }, 5) },
  { name: 'reclined 15°, head stacked', family: 'reclined', p: eyesOnScreen({ trunkPitch: -15, neckFlex: neckAt(-15, 5) }, 4) },
  {
    name: 'reclined 12°, knees 5° up',
    family: 'reclined',
    p: eyesOnScreen({ trunkPitch: -12, neckFlex: neckAt(-12, 4), thighSlope: 5 }, 6)
  },
  {
    name: 'reclined 12°, knees 5° down',
    family: 'reclined',
    p: eyesOnScreen({ trunkPitch: -12, neckFlex: neckAt(-12, 4), thighSlope: -5 }, 6)
  }
]

/**
 * Bad postures that setup must never accept as good, from any camera:
 * - lying in the chair: the pelvis slid 10–20 cm forward (and a little down), the trunk
 *   reclined 30–50°, the neck flexed forward relative to the trunk to keep the eyes on the
 *   screen, the shoulders rounded;
 * - slumped: thoracic flexion — the trunk compressed and rounded (its hip→shoulder chord leans
 *   forward), rounded shoulders, the head forward;
 * - perched forward hunch: on the front of the seat, the trunk leaning 20–35° toward the
 *   screen, rounded shoulders, the head forward or tipped back to see the screen.
 */
export const BAD_SEATED: readonly SeatedPosture[] = [
  // lying in the chair
  {
    name: 'lying 40°, pelvis 15 cm forward',
    family: 'lying',
    p: eyesOnScreen({ trunkPitch: -40, slide: 0.15, sink: 0.03, neckFlex: neckAt(-40, 8), shoulderRound: 0.03 }, 3)
  },
  {
    name: 'lying 30°, pelvis 10 cm forward',
    family: 'lying',
    p: eyesOnScreen({ trunkPitch: -30, slide: 0.1, sink: 0.02, neckFlex: neckAt(-30, 6), shoulderRound: 0.03 }, 5)
  },
  {
    name: 'lying 50°, pelvis 20 cm forward',
    family: 'lying',
    p: eyesOnScreen({ trunkPitch: -50, slide: 0.2, sink: 0.04, neckFlex: neckAt(-50, 12), shoulderRound: 0.04 }, 0)
  },
  {
    name: 'lying 35°, head craned forward',
    family: 'lying',
    p: eyesOnScreen({ trunkPitch: -35, slide: 0.12, sink: 0.03, neckFlex: neckAt(-35, 20), shoulderRound: 0.04 }, 8)
  },
  {
    name: 'lying 35°, head back, chin tucked',
    family: 'lying',
    p: eyesOnScreen({ trunkPitch: -35, slide: 0.15, sink: 0.03, neckFlex: neckAt(-35, -2), shoulderRound: 0.02 }, 2)
  },
  {
    name: 'lying 40°, knees 8° up',
    family: 'lying',
    p: eyesOnScreen({ trunkPitch: -40, slide: 0.15, sink: 0.03, neckFlex: neckAt(-40, 6), shoulderRound: 0.03, thighSlope: 8 }, 4)
  },
  {
    name: 'lying 40°, legs out (knees 8° down)',
    family: 'lying',
    p: eyesOnScreen({ trunkPitch: -40, slide: 0.18, sink: 0.04, neckFlex: neckAt(-40, 8), shoulderRound: 0.03, thighSlope: -8 }, 3)
  },
  // slumped (the neck angles are relative to the top of the trunk; the rounded shoulders hide
  // part of them from the shoulder landmarks, as they do from MediaPipe's)
  {
    name: 'slumped, head forward',
    family: 'slumped',
    p: eyesOnScreen({ trunkPitch: 15, slump: 0.1, shoulderRound: 0.04, neckFlex: neckAt(15, 38) }, 8)
  },
  {
    name: 'slumped deep, chin poked',
    family: 'slumped',
    p: eyesOnScreen({ trunkPitch: 18, slump: 0.14, shoulderRound: 0.05, neckFlex: neckAt(18, 45) }, 4)
  },
  {
    name: 'slouched back (pelvis tucked), head poked forward',
    family: 'slumped',
    p: eyesOnScreen({ trunkPitch: -12, slide: 0.06, slump: 0.12, shoulderRound: 0.04, neckFlex: neckAt(-12, 48) }, 6)
  },
  // perched forward hunch
  {
    name: 'perched hunch 25°',
    family: 'hunch',
    p: eyesOnScreen({ trunkPitch: 25, slide: 0.1, shoulderRound: 0.03, neckFlex: 12 }, 12)
  },
  {
    name: 'perched hunch 35°, head tipped back',
    family: 'hunch',
    p: eyesOnScreen({ trunkPitch: 35, slide: 0.15, shoulderRound: 0.04, neckFlex: 5 }, 10)
  },
  {
    name: 'hunch 20°, head forward',
    family: 'hunch',
    p: eyesOnScreen({ trunkPitch: 20, slide: 0.06, shoulderRound: 0.04, neckFlex: 18 }, 15)
  }
]

// ---------------------------------------------------------------------------
// camera

export interface CameraParams {
  /** degrees, + = toward the person's left; 0 = in front of them */
  azimuth: number
  /** degrees, + = above */
  elevation: number
  /** metres from the aim point */
  distance: number
  /** degrees about the optical axis */
  roll: number
  /** true horizontal field of view, degrees */
  hfov: number
  /** width / height */
  aspect: number
  /** aim point (room frame); default the chest (0, 0.35, 0) */
  aim?: Vec3
}

export interface SimNoise {
  /** σ of normalized image coordinates */
  image: number
  /** σ of world x/y, metres */
  worldXY: number
  /** σ of world z, metres */
  worldZ: number
}

export const SPEC_NOISE: SimNoise = { image: 0.002, worldXY: 0.01, worldZ: 0.025 }
export const NO_NOISE: SimNoise = { image: 0, worldXY: 0, worldZ: 0 }

export interface SimOptions {
  seed?: number
  noise?: SimNoise
  /** hips/legs hidden by a desk: visibility 0.1 and unreliable (biased) world coords */
  deskOcclusion?: boolean
  /** extra world bias for off-frame points, metres [min, max] */
  offFrameBias?: [number, number]
  /** swap MediaPipe's left/right labels (model confusion) */
  swapLabels?: boolean
  /**
   * Render world landmarks in the crop-ray frame (default true). false = in true camera
   * axes, i.e. as if the model knew where its crop was.
   */
  cropRay?: boolean
  /**
   * Render a phantom instead of the seated user: the same body, moved, turned and scaled as a
   * figure (a print on the desk, a poster, someone across the room). The image shows the
   * figure; the world landmarks are human-size, as the pose model reconstructs any person.
   */
  figure?: FigurePlacement
}

/** Where a phantom figure is (SimOptions.figure). Room frame. */
export interface FigurePlacement {
  /** size relative to the simulated person (a printed figure: well below 1) */
  scale: number
  /** room directions of the body's up (hips → head) and forward (its face); made orthogonal */
  up: Vec3
  forward: Vec3
  /** room position of the figure's chest (the body point (0, 0.3, 0)) */
  at: Vec3
}

/** The body's points as the camera sees them: positions, normals, and hip-relative world vectors (human size). */
interface PlacedBody {
  points: Vec3[]
  normals: Vec3[]
  hipMid: Vec3
  /** world landmark i before the camera rotation: point minus hip midpoint, human size */
  rel: (i: number) => Vec3
}

function placeBody(sk: Skeleton, fig: FigurePlacement | undefined): PlacedBody {
  const hip = scale(add(sk.points[23], sk.points[24]), 0.5)
  if (!fig) return { points: sk.points, normals: sk.normals, hipMid: hip, rel: (i) => sub(sk.points[i], hip) }
  const u = unit(fig.up) as Vec3
  const f = unit(sub(fig.forward, scale(u, dot(fig.forward, u)))) as Vec3
  const l = cross(u, f)
  const R = (v: Vec3): Vec3 => add(scale(l, v[0]), add(scale(u, v[1]), scale(f, v[2])))
  const chest: Vec3 = [0, 0.3, 0]
  const points = sk.points.map((q) => add(fig.at, scale(R(sub(q, chest)), fig.scale)))
  return {
    points,
    normals: sk.normals.map(R),
    hipMid: scale(add(points[23], points[24]), 0.5),
    rel: (i) => R(sub(sk.points[i], hip))
  }
}

const LR_PAIRS: Array<[number, number]> = [
  [1, 4],
  [2, 5],
  [3, 6],
  [7, 8],
  [9, 10],
  [11, 12],
  [13, 14],
  [15, 16],
  [17, 18],
  [19, 20],
  [21, 22],
  [23, 24],
  [25, 26],
  [27, 28],
  [29, 30],
  [31, 32]
]

/** A virtual camera filming the seated skeleton. */
export class PoseSim {
  readonly cam: CameraParams
  readonly position: Vec3
  /** camera axes in the room frame: x = image right, y = image down, z = optical axis */
  readonly axes: { x: Vec3; y: Vec3; z: Vec3 }
  /** true focal length in image-height units */
  readonly focal: number
  private readonly rng: Rng
  private readonly noise: SimNoise
  private readonly biases: Vec3[]
  private readonly opts: SimOptions

  constructor(cam: CameraParams, opts: SimOptions = {}) {
    this.cam = cam
    this.opts = opts
    this.rng = new Rng(opts.seed ?? 1)
    this.noise = opts.noise ?? SPEC_NOISE
    const aim = cam.aim ?? ([0, 0.35, 0] as Vec3)
    const az = cam.azimuth * RAD
    const el = cam.elevation * RAD
    const dir: Vec3 = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]
    this.position = add(aim, scale(dir, cam.distance))
    const z = unit(sub(aim, this.position)) as Vec3
    let x = unit(cross(z, Y)) as Vec3
    let y = cross(z, x)
    x = rotate(x, z, cam.roll)
    y = rotate(y, z, cam.roll)
    this.axes = { x, y, z }
    this.focal = (cam.aspect * 0.5) / Math.tan((cam.hfov * RAD) / 2)
    const [bmin, bmax] = opts.offFrameBias ?? [0.06, 0.1]
    this.biases = Array.from({ length: 33 }, () => scale(this.rng.unitVec(), this.rng.uniform(bmin, bmax)))
  }

  /** room vector → camera coordinates */
  toCam(v: Vec3): Vec3 {
    return [dot(v, this.axes.x), dot(v, this.axes.y), dot(v, this.axes.z)]
  }

  /** True gravity up in camera coordinates. */
  get trueUp(): Vec3 {
    return this.toCam(Y)
  }

  /** Camera pitch, degrees (+ = looking down). */
  get pitchDeg(): number {
    return Math.asin(clamp(-dot(this.axes.z, Y), -1, 1)) * DEG
  }

  /** Noise-free normalized image position of a room point (may lie outside [0, 1]). */
  private project(P: Vec3): [number, number] {
    const pc = this.toCam(sub(P, this.position))
    if (pc[2] <= 0.05) return [pc[0] >= 0 ? 1.6 : -0.6, pc[1] >= 0 ? 1.6 : -0.6]
    return [(this.focal * pc[0]) / pc[2] / this.cam.aspect + 0.5, (this.focal * pc[1]) / pc[2] + 0.5]
  }

  /**
   * The rotation (camera frame) taking the optical axis onto the ray to the crop centre:
   * the hip midpoint, in or out of the frame (BlazePose centres its ROI on the hip centre
   * it predicts), clamped to the frame expanded by 0.5. World landmarks are rendered
   * rotated by its inverse. Null when ~on axis.
   */
  cropRotation(p: PostureParams): { axis: Vec3; deg: number } | null {
    const hip = this.project(placeBody(skeleton(p), this.opts.figure).hipMid)
    const cx = clamp(hip[0], -0.5, 1.5)
    const cy = clamp(hip[1], -0.5, 1.5)
    const ray = unit([((cx - 0.5) * this.cam.aspect) / this.focal, (cy - 0.5) / this.focal, 1]) as Vec3
    const axis = unit(cross(Z, ray))
    const deg = Math.acos(clamp(ray[2], -1, 1)) * DEG
    return axis && deg > 1e-3 ? { axis, deg } : null
  }

  /** Render one frame (with noise unless the sim was built with NO_NOISE). */
  render(p: PostureParams): PoseFrame {
    const sk = placeBody(skeleton(p), this.opts.figure)
    const crop = this.opts.cropRay === false ? null : this.cropRotation(p)
    const hipMid = sk.hipMid
    const image: Landmark[] = []
    const world: Landmark[] = []
    const n = this.noise
    for (let i = 0; i < 33; i++) {
      const P = sk.points[i]
      const pc = this.toCam(sub(P, this.position))
      let inFrame = pc[2] > 0.05
      let x = 0.5
      let y = 0.5
      if (inFrame) {
        x = (this.focal * pc[0]) / pc[2] / this.cam.aspect + 0.5
        y = (this.focal * pc[1]) / pc[2] + 0.5
        inFrame = x >= 0 && x <= 1 && y >= 0 && y <= 1
      } else {
        // behind the camera: place it far outside the frame
        x = pc[0] >= 0 ? 1.6 : -0.6
        y = pc[1] >= 0 ? 1.6 : -0.6
      }
      const toCamDir = unit(sub(this.position, P)) as Vec3
      let vis = clamp(0.75 + 0.9 * dot(sk.normals[i], toCamDir), 0.05, 0.99)
      const occluded = this.opts.deskOcclusion === true && i >= 23
      if (!inFrame) vis = 0.05
      else if (occluded) vis = 0.1
      let w = this.toCam(sk.rel(i))
      if (crop) w = rotate(w, crop.axis, -crop.deg)
      if (!inFrame || occluded) w = add(w, this.biases[i])
      image.push({
        x: x + this.rng.gauss(n.image),
        y: y + this.rng.gauss(n.image),
        z: (pc[2] - this.toCam(sub(hipMid, this.position))[2]) * 0.5,
        visibility: vis
      })
      world.push({
        x: w[0] + this.rng.gauss(n.worldXY),
        y: w[1] + this.rng.gauss(n.worldXY),
        z: w[2] + this.rng.gauss(n.worldZ),
        visibility: vis
      })
    }
    if (this.opts.swapLabels) {
      for (const [a, b] of LR_PAIRS) {
        ;[image[a], image[b]] = [image[b], image[a]]
        ;[world[a], world[b]] = [world[b], world[a]]
      }
    }
    return { image, world, aspect: this.cam.aspect }
  }
}

/**
 * Desk occlusion as MediaPipe reports it: the hips and legs are hidden, so their world
 * coordinates are the occluded (biased, 6–10 cm off) guesses of SimOptions.deskOcclusion,
 * yet they come with high visibility (the real elevated-camera recording: 0.83–0.89).
 * Construct with { deskOcclusion: true }.
 */
export class HallucinatingSim extends PoseSim {
  render(p: PostureParams): PoseFrame {
    const fr = super.render(p)
    const conf = (l: Landmark, i: number): Landmark => (i >= 23 && i <= 28 ? { ...l, visibility: 0.9 } : l)
    return { ...fr, image: fr.image.map(conf), world: fr.world!.map(conf) }
  }
}

// ---------------------------------------------------------------------------
// viewpoint grid

export interface Viewpoint extends CameraParams {
  name: string
}

/**
 * The grid's camera rolls before the level-camera model (up to ±8°, beyond the level-mount
 * prior). The same viewpoints with these rolls are re-run by viewpoints.test.ts for graceful
 * degradation (setup completes, no roll is invented, no false alerts).
 */
export const ROLLED_GRID_ROLLS: readonly number[] = [-8, 0, 5, -3, 8, 2]
/**
 * Camera rolls the grid cycles through: ROLLED_GRID_ROLLS clamped to the level-mount prior.
 * Webcams are mounted level (|roll| ≲ 3°, UP_MAX_ROLL); the gravity estimate is a
 * level-camera one, so a larger roll is not recovered without a horizontal cue.
 */
export const GRID_ROLLS: readonly number[] = ROLLED_GRID_ROLLS.map((r) => clamp(r, -3, 3))

/**
 * ≥ 40 deterministic viewpoints covering azimuth −90…90, elevation −20…50,
 * distance 0.5–2.0 m, roll −3…3° (`rollCycle`), HFOV 55–85° and both aspects. Never the
 * assumed 65° HFOV. Plus a few hand-picked hard cases: cameras below the shoulders that
 * see no hips (camera-only gravity, where a swivel leaks camera pitch), and a close
 * off-centre framing that shows the head and one shoulder only.
 */
export function viewpointGrid(rollCycle: readonly number[] = GRID_ROLLS): Viewpoint[] {
  const az = [-90, -60, -35, -15, 0, 20, 40, 65, 90]
  const el = [-20, 0, 15, 30, 50]
  const dists = [0.6, 0.85, 1.2, 1.6, 2.0, 0.5, 1.0]
  const rolls = rollCycle
  const hfovs = [55, 70, 85, 60, 78]
  const out: Viewpoint[] = []
  let k = 0
  for (const a of az) {
    for (const e of el) {
      const cam: CameraParams = {
        azimuth: a,
        elevation: e,
        distance: dists[k % dists.length],
        roll: rolls[k % rolls.length],
        hfov: hfovs[k % hfovs.length],
        aspect: k % 2 === 0 ? 16 / 9 : 4 / 3
      }
      out.push({ ...cam, name: `az${a} el${e} d${cam.distance} r${cam.roll} fov${cam.hfov} ${k % 2 ? '4:3' : '16:9'}` })
      k++
    }
  }
  out.push(
    { azimuth: -60, elevation: -20, distance: 0.8, roll: 0, hfov: 70, aspect: 16 / 9, name: 'below, no hips: az-60 el-20 d0.8' },
    { azimuth: -75, elevation: -20, distance: 0.8, roll: 0, hfov: 70, aspect: 16 / 9, name: 'below, no hips: az-75 el-20 d0.8' },
    {
      azimuth: 40,
      elevation: 5,
      distance: 0.55,
      roll: 3,
      hfov: 60,
      aspect: 4 / 3,
      aim: [-0.15, 0.55, 0],
      name: 'head + one shoulder: az40 el5 d0.55'
    }
  )
  return out
}

// ---------------------------------------------------------------------------
// phantoms: person-like things that are not the user (docs/specs/detection.md, Implementation
// notes, "Presence plausibility"). MediaPipe reconstructs each one at human size.

/** The camera's room pose (position and axes) for a viewpoint. */
export function cameraPose(cam: CameraParams): { position: Vec3; axes: { x: Vec3; y: Vec3; z: Vec3 }; focal: number } {
  const s = new PoseSim(cam, { noise: NO_NOISE })
  return { position: s.position, axes: s.axes, focal: s.focal }
}

/** The camera's horizontal viewing direction (room frame). */
const headingOf = (cam: CameraParams): Vec3 => {
  const z = cameraPose(cam).axes.z
  return unit([z[0], 0, z[2]]) ?? Z
}

export interface DeskPhantomOptions {
  /**
   * Where the figure's head points on the desk, degrees about the vertical from the camera's
   * horizontal viewing direction: 0 = away from the camera (along the line of sight), 180 =
   * toward it, ±90 = across the view (a desk-mat print lying left–right).
   */
  headingDeg: number
  /** the figure faces up (default) or lies face down */
  faceUp?: boolean
  /** figure size relative to a person (default 0.45: a ~60 cm desk-mat figure) */
  scale?: number
  /** desk surface below the camera, metres (default 0.35) */
  deskDrop?: number
  /** where the figure's chest appears in the picture: normalized offset below the centre (default 0.15) */
  imageV?: number
  /** horizontal image offset of the chest, normalized (default 0) */
  imageU?: number
}

/**
 * A figure lying flat on the desk (a print on a desk mat, a figurine), seen by the camera from
 * above: its chest where the ray through (imageU, imageV) meets the desk plane. Null when that
 * ray does not reach the desk within 1.5 m (a camera looking up, or level, sees no desk there).
 */
export function deskPhantom(cam: CameraParams, o: DeskPhantomOptions): FigurePlacement | null {
  const pose = cameraPose(cam)
  const v = o.imageV ?? 0.15
  const u = (o.imageU ?? 0) * cam.aspect
  const ray = unit(add(pose.axes.z, add(scale(pose.axes.y, v / pose.focal), scale(pose.axes.x, u / pose.focal)))) as Vec3
  const drop = o.deskDrop ?? 0.35
  if (!(ray[1] < -1e-3)) return null
  const t = drop / -ray[1]
  if (!(t > 0.15 && t <= 1.5)) return null
  const head = rotate(headingOf(cam), Y, o.headingDeg)
  return {
    scale: o.scale ?? 0.45,
    up: head,
    forward: o.faceUp === false ? ([0, -1, 0] as Vec3) : Y,
    at: add(pose.position, scale(ray, t))
  }
}

/**
 * An upright figure facing the camera `distance` metres along the ray through the normalized
 * image offset (imageU, imageV) from the centre: a poster on a wall (scale < 1) or a person
 * across the room (scale 1).
 */
export function uprightPhantom(cam: CameraParams, distance: number, figScale: number, imageU = 0, imageV = 0): FigurePlacement {
  const pose = cameraPose(cam)
  const ray = unit(
    add(pose.axes.z, add(scale(pose.axes.y, imageV / pose.focal), scale(pose.axes.x, (imageU * cam.aspect) / pose.focal)))
  ) as Vec3
  return { scale: figScale, up: Y, forward: scale(headingOf(cam), -1), at: add(pose.position, scale(ray, distance)) }
}
