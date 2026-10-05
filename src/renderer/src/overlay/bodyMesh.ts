// Body wireframe for the camera preview: a triangulated mesh that fills the
// person's silhouette (from the pose model's segmentation mask), denser on the
// head, with MediaPipe's canonical face mesh stitched in over the face — the
// classic face-mesh look, whole-body. Pure apart from the builder's temporal
// smoothing, so it unit-tests with synthetic masks. Visual only: nothing here
// feeds the posture engine.

import Delaunator from 'delaunator'
import type { Landmark } from '@renderer/posture/types'

/** Person probability on a coarse grid; cell (i, j) is centered at ((i+.5)/w, (j+.5)/h). */
export interface MaskGrid {
  w: number
  h: number
  data: Float32Array
}

/**
 * A similarity frame in isotropic image units (x scaled by the frame aspect,
 * y in [0, 1]) so distances and angles are not squashed by the aspect ratio.
 */
export interface Anchor {
  x: number
  y: number
  angle: number
  scale: number
}

/** Circle in body space. */
export interface Region {
  u: number
  v: number
  r: number
}

export const EDGE_INNER = 0
export const EDGE_OUTLINE = 1
/** where the body runs off the image edge — not a real silhouette */
export const EDGE_SEAM = 2
/** face-mesh tessellation: far denser than the body, so drawn finer */
export const EDGE_FACE = 3

/** MediaPipe face-mesh topology, flattened once (see buildFaceTopology). */
export interface FaceTopology {
  /** landmarks the topology addresses (468; the iris points aren't drawn) */
  size: number
  /** unique vertex index pairs of the canonical tessellation (+ any extra contours) */
  edges: Uint16Array
  /** per edge: 1 = eye or lip contour */
  feature: Uint8Array
  /** the face oval as an ordered loop of landmark indices */
  oval: Uint16Array
}

export interface FaceInput {
  points: readonly Landmark[]
  topology: FaceTopology
}

export interface BodyMesh {
  /** frame width / height */
  aspect: number
  /** smoothed body frame (shoulder midpoint, shoulder width, shoulder-line angle) */
  anchor: Anchor
  /** vertices in body space: image point = anchor.xy + rotate(anchor.angle) · (u, v) · anchor.scale */
  u: Float32Array
  v: Float32Array
  /** per vertex: 1 = part of the (much denser) face mesh */
  faceVertex: Uint8Array
  /** vertex index pairs */
  edges: Uint32Array
  /** per edge: EDGE_INNER | EDGE_OUTLINE | EDGE_SEAM | EDGE_FACE */
  edgeKind: Uint8Array
  /** tracked joints (shoulders, elbows, wrists, hips) in body space */
  joints: { u: number; v: number }[]
  /** where posture issues live on the body, for problem-area highlights */
  regions: { head: Region | null; neck: Region | null; shoulders: Region | null }
}

// ---------- tuning ----------

const MASK_T = 0.5
const GRID_W = 112
/** weight of the previous grid in the temporal blend (edge flicker vs. lag) */
const GRID_KEEP = 0.35
const V_MIN = 0.5
/** lattice spacing on the body, in shoulder widths */
const BODY_STEP = 0.085
/** lattice spacing on the head, in head (ear-to-ear) widths */
const HEAD_STEP = 0.085
/** head region radius, in head widths */
const HEAD_R = 0.82
/** spacing floors in image heights — a far-away person must not fill in solid */
const MIN_HEAD_STEP = 0.011
const MIN_BODY_STEP = 0.016
/** below this width (image heights) the face mesh would be a smudge — use the plain head */
const MIN_FACE_WIDTH = 0.08
const JITTER = 0.26
/**
 * Longest triangle side kept, in local lattice steps. Only a backstop — the
 * mask checks already reject triangles that bridge background — so it must
 * leave room for the gaps that lattice jitter and the face-oval margin open.
 */
const MAX_EDGE = 3.5
const EDGE_MID_MIN = 0.12

/*
 * Body proportions that let one measurement stand in for another when the
 * camera angle hides it. Side-on, the left/right lines (shoulder to shoulder,
 * ear to ear) collapse to a few noisy pixels, while the torso axis and the
 * nose-to-ear distance keep their length.
 */
/** shoulder width per ear-to-shoulder distance */
const SH_PER_NECK = 1.6
/** shoulder width per shoulder-to-hip distance */
const SH_PER_TORSO = 0.75
/** head width per nose-to-ear distance (side-on the nose sits ~3/4 of a head width in front of the ear) */
const HEAD_PER_NOSE_EAR = 1.4
/** head width per shoulder width, when nothing on the head gives a size */
const HEAD_PER_SHOULDER = 0.45
/** body frame scale per head width, when the shoulders are out of view */
const BODY_PER_HEAD = 2.4
/**
 * A left/right line's length relative to what the proportions predict: below
 * FRONTAL_LO it is ignored (side view), above FRONTAL_HI it alone sets the
 * frame (front view), with a smooth hand-over in between.
 */
const FRONTAL_LO = 0.45
const FRONTAL_HI = 0.9
/** a face from FaceLandmarker must sit within this many face widths of the pose's nose / head */
const FACE_MATCH = 0.75

const LM_NOSE = 0
const LM_EYE_L_OUT = 3
const LM_EYE_R_OUT = 6
const LM_EAR_L = 7
const LM_EAR_R = 8
const LM_SH_L = 11
const LM_SH_R = 12
const LM_HIP_L = 23
const LM_HIP_R = 24
const JOINTS = [11, 12, 13, 14, 15, 16, 23, 24]

// ---------- small geometry ----------

interface P {
  x: number
  y: number
}

function hash01(i: number, j: number, seed: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1274126177)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function toIso(l: Landmark, aspect: number): P {
  return { x: l.x * aspect, y: l.y }
}

function lmIso(lm: readonly Landmark[], i: number, aspect: number): P | null {
  const l = lm[i]
  if (!l || (l.visibility ?? 0) < V_MIN) return null
  if (l.x < -0.05 || l.x > 1.05 || l.y < -0.05 || l.y > 1.05) return null
  return toIso(l, aspect)
}

const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Mean of the points that are present. */
function meanOf(ps: readonly (P | null)[]): P | null {
  let x = 0
  let y = 0
  let n = 0
  for (const p of ps) {
    if (!p) continue
    x += p.x
    y += p.y
    n++
  }
  return n ? { x: x / n, y: y / n } : null
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** The angle equivalent to `a` modulo 2 pi, in [-pi, pi]. */
export function wrapTurn(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
}

/** The angle equivalent to `a` modulo pi (a line has no direction), in [-pi/2, pi/2]. */
function wrapHalfTurn(a: number): number {
  return a - Math.PI * Math.round(a / Math.PI)
}

/** Keeps angles upright: a person seen from behind must not flip the lattice. */
function uprightAngle(a: number): number {
  return wrapHalfTurn(a)
}

/** The frame angle whose +v axis (body "down") points along `d` in the image. */
function angleOfDown(d: P): number {
  return Math.atan2(-d.x, d.y)
}

function frameFromLine(from: P, to: P, scaleMul: number, origin: P): Anchor {
  return {
    x: origin.x,
    y: origin.y,
    angle: uprightAngle(Math.atan2(to.y - from.y, to.x - from.x)),
    scale: dist(from, to) * scaleMul
  }
}

/** Even-odd point-in-polygon on flat [x0, y0, x1, y1, …] coordinates. */
function inPolygon(poly: Float64Array, x: number, y: number): boolean {
  let inside = false
  const n = poly.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i]
    const yi = poly[2 * i + 1]
    const xj = poly[2 * j]
    const yj = poly[2 * j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The polygon scaled about its centroid — a margin so nothing crowds its rim. */
function grownPolygon(poly: Float64Array, factor: number): Float64Array {
  let cx = 0
  let cy = 0
  const n = poly.length / 2
  for (let i = 0; i < n; i++) {
    cx += poly[2 * i] / n
    cy += poly[2 * i + 1] / n
  }
  const out = new Float64Array(poly.length)
  for (let i = 0; i < n; i++) {
    out[2 * i] = cx + (poly[2 * i] - cx) * factor
    out[2 * i + 1] = cy + (poly[2 * i + 1] - cy) * factor
  }
  return out
}

/** Spatial hash for "is there already a point within r?" queries. */
class PointSet {
  private buckets = new Map<number, number[]>()
  constructor(private cell: number) {}

  private key(ix: number, iy: number): number {
    return (ix + 1024) * 4096 + (iy + 1024)
  }

  near(x: number, y: number, r: number): boolean {
    const span = Math.ceil(r / this.cell)
    const cx = Math.floor(x / this.cell)
    const cy = Math.floor(y / this.cell)
    const r2 = r * r
    for (let ix = cx - span; ix <= cx + span; ix++) {
      for (let iy = cy - span; iy <= cy + span; iy++) {
        const b = this.buckets.get(this.key(ix, iy))
        if (!b) continue
        for (let k = 0; k < b.length; k += 2) {
          const dx = b[k] - x
          const dy = b[k + 1] - y
          if (dx * dx + dy * dy < r2) return true
        }
      }
    }
    return false
  }

  add(x: number, y: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell))
    const b = this.buckets.get(k)
    if (b) b.push(x, y)
    else this.buckets.set(k, [x, y])
  }
}

// ---------- mask ----------

/**
 * Resamples the model's full-resolution mask onto a coarse grid (2×2
 * supersampled), blended with the previous grid to calm edge flicker.
 */
export function downsampleMask(
  src: Float32Array,
  sw: number,
  sh: number,
  prev: MaskGrid | null = null,
  gw = GRID_W
): MaskGrid {
  const gh = Math.max(8, Math.round((gw * sh) / sw))
  const data = new Float32Array(gw * gh)
  const fx = sw / gw
  const fy = sh / gh
  for (let j = 0; j < gh; j++) {
    const y0 = Math.min(sh - 1, Math.floor((j + 0.25) * fy)) * sw
    const y1 = Math.min(sh - 1, Math.floor((j + 0.75) * fy)) * sw
    for (let i = 0; i < gw; i++) {
      const x0 = Math.min(sw - 1, Math.floor((i + 0.25) * fx))
      const x1 = Math.min(sw - 1, Math.floor((i + 0.75) * fx))
      data[j * gw + i] = (src[y0 + x0] + src[y0 + x1] + src[y1 + x0] + src[y1 + x1]) / 4
    }
  }
  if (prev && prev.w === gw && prev.h === gh) {
    for (let k = 0; k < data.length; k++) data[k] = prev.data[k] * GRID_KEEP + data[k] * (1 - GRID_KEEP)
  }
  return { w: gw, h: gh, data }
}

/** Bilinear mask lookup at an isotropic image point; outside the frame is background. */
export function sampleMask(grid: MaskGrid, aspect: number, x: number, y: number): number {
  const nx = x / aspect
  if (nx < 0 || nx > 1 || y < 0 || y > 1) return 0
  const gx = Math.min(grid.w - 1, Math.max(0, nx * grid.w - 0.5))
  const gy = Math.min(grid.h - 1, Math.max(0, y * grid.h - 0.5))
  const i0 = Math.floor(gx)
  const j0 = Math.floor(gy)
  const i1 = Math.min(grid.w - 1, i0 + 1)
  const j1 = Math.min(grid.h - 1, j0 + 1)
  const tx = gx - i0
  const ty = gy - j0
  const d = grid.data
  const top = d[j0 * grid.w + i0] * (1 - tx) + d[j0 * grid.w + i1] * tx
  const bot = d[j1 * grid.w + i0] * (1 - tx) + d[j1 * grid.w + i1] * tx
  return top * (1 - ty) + bot * ty
}

// ---------- anchors ----------

/** Where the head is, for the torso axis: between the ears, else the nose, else the eyes. */
function headPoint(lm: readonly Landmark[], aspect: number): P | null {
  return (
    meanOf([lmIso(lm, LM_EAR_L, aspect), lmIso(lm, LM_EAR_R, aspect)]) ??
    lmIso(lm, LM_NOSE, aspect) ??
    meanOf([lmIso(lm, LM_EYE_L_OUT, aspect), lmIso(lm, LM_EYE_R_OUT, aspect)])
  )
}

/**
 * Body frame: origin on the shoulders, scale ~ shoulder width, +v down the
 * torso. Seen from the front the shoulder line sets it; turning side-on that
 * line shrinks to a few pixels whose direction is noise (and wraps through
 * +-pi/2), so the frame hands over to the torso axis (shoulders to hips, or
 * head to shoulders), which keeps its length and direction from any camera
 * angle. With one shoulder hidden in a front view, the other is mirrored about
 * the head's midline, so a shoulder flickering in and out of view does not
 * swing the frame onto the head-to-shoulder diagonal. Falls back to a head
 * frame when no shoulder is in view.
 */
export function bodyAnchor(lm: readonly Landmark[], aspect: number): Anchor | null {
  const ls = lmIso(lm, LM_SH_L, aspect)
  const rs = lmIso(lm, LM_SH_R, aspect)
  const hips = meanOf([lmIso(lm, LM_HIP_L, aspect), lmIso(lm, LM_HIP_R, aspect)])
  const head = headPoint(lm, aspect)
  if (ls && rs) {
    const a = torsoFrame(ls, rs, hips, head)
    if (a) return a
  } else if (ls || rs) {
    const one = (ls ?? rs) as P
    const side = torsoFrame(one, null, hips, head)
    const hf = headFrameW(lm, aspect, null)
    if (hf && hf.wf > 0) {
      // front view: the hidden shoulder sits opposite the visible one, across
      // the vertical through the head
      const twin = { x: 2 * hf.frame.x - one.x, y: one.y }
      const front = ls ? torsoFrame(ls, twin, hips, head) : torsoFrame(twin, one, hips, head)
      if (front && side) return blendAnchor(side, front, hf.wf)
      if (front) return front
    }
    if (side) return side
  }
  const hf = headFrame(lm, aspect, null)
  return hf ? { ...hf, scale: hf.scale * BODY_PER_HEAD } : null
}

/** Body frame from the left and (optional) right shoulder, oriented by the hips or head. */
function torsoFrame(ls: P, rs: P | null, hips: P | null, head: P | null): Anchor | null {
  const s = rs ? mid(ls, rs) : ls
  const sw = rs ? dist(ls, rs) : 0
  let axis: P | null = null
  let axisWidth = 0
  if (hips && dist(hips, s) > 1e-3) {
    axis = { x: hips.x - s.x, y: hips.y - s.y }
    axisWidth = dist(hips, s) * SH_PER_TORSO
  } else if (head && dist(head, s) > 1e-3) {
    axis = { x: s.x - head.x, y: s.y - head.y }
    axisWidth = dist(head, s) * SH_PER_NECK
  }
  if (axis) {
    const len = Math.hypot(axis.x, axis.y)
    const dA = { x: axis.x / len, y: axis.y / len }
    if (!rs || sw <= 1e-3) return { x: s.x, y: s.y, angle: angleOfDown(dA), scale: axisWidth }
    // "down" across the shoulder line, oriented by the torso so that a person
    // seen from behind (left and right swapped) stays upright
    let dS = { x: -(ls.y - rs.y) / sw, y: (ls.x - rs.x) / sw }
    if (dS.x * dA.x + dS.y * dA.y < 0) dS = { x: -dS.x, y: -dS.y }
    const w = smoothstep(FRONTAL_LO, FRONTAL_HI, sw / axisWidth)
    // two unit vectors at most 90 degrees apart: the blend never cancels out
    const d = { x: w * dS.x + (1 - w) * dA.x, y: w * dS.y + (1 - w) * dA.y }
    return { x: s.x, y: s.y, angle: angleOfDown(d), scale: w * sw + (1 - w) * axisWidth }
  }
  if (rs && sw > 1e-3) return frameFromLine(rs, ls, 1, s)
  return null
}

/** `a` moved toward `b` by `t`, turning the short way round. */
function blendAnchor(a: Anchor, b: Anchor, t: number): Anchor {
  return {
    x: a.x + t * (b.x - a.x),
    y: a.y + t * (b.y - a.y),
    angle: a.angle + t * wrapTurn(b.angle - a.angle),
    scale: a.scale + t * (b.scale - a.scale)
  }
}

function headFrame(lm: readonly Landmark[], aspect: number, body: Anchor | null): Anchor | null {
  return headFrameW(lm, aspect, body)?.frame ?? null
}

/**
 * Head frame centered on the skull (scale = head width), with `wf`, how
 * front-on the head is (0 = side view, 1 = front view). Front-on the ear (or
 * outer-eye) line sets its angle and width; side-on that line collapses, so the
 * width comes from the nose-to-ear distance, the angle from `body` (or image
 * upright), and the center slides from between the ears toward the nose.
 */
function headFrameW(
  lm: readonly Landmark[],
  aspect: number,
  body: Anchor | null
): { frame: Anchor; wf: number } | null {
  const le = lmIso(lm, LM_EAR_L, aspect)
  const re = lmIso(lm, LM_EAR_R, aspect)
  const nose = lmIso(lm, LM_NOSE, aspect)
  let pair: [P, P] | null = null
  let pairW = 0
  if (le && re && dist(le, re) > 1e-3) {
    pair = [re, le]
    pairW = dist(le, re)
  } else {
    const lo = lmIso(lm, LM_EYE_L_OUT, aspect)
    const ro = lmIso(lm, LM_EYE_R_OUT, aspect)
    if (lo && ro && dist(lo, ro) > 1e-3) {
      pair = [ro, lo]
      pairW = dist(lo, ro) * 1.7
    }
  }
  let noseEar = 0
  if (nose) for (const e of [le, re]) if (e) noseEar = Math.max(noseEar, dist(nose, e))
  let size = Math.max(pairW, HEAD_PER_NOSE_EAR * noseEar)
  if (size <= 1e-3 && nose && body) size = HEAD_PER_SHOULDER * body.scale
  if (size <= 1e-3) return null

  const ref = body ? body.angle : 0
  const wf = pair ? smoothstep(FRONTAL_LO, FRONTAL_HI, pairW / size) : 0
  // the line has no direction: take whichever is nearest the reference
  const line = pair ? ref + wrapHalfTurn(Math.atan2(pair[1].y - pair[0].y, pair[1].x - pair[0].x) - ref) : ref
  const angle = ref + wf * (line - ref)
  // side-on the skull's center sits behind the nose, ~0.3 of the way from the ear
  const towardNose = (e: P, k: number): P => (nose ? { x: e.x + k * (nose.x - e.x), y: e.y + k * (nose.y - e.y) } : e)
  let c: P | null
  if (le && re) {
    c = towardNose(mid(le, re), (1 - wf) * 0.3)
  } else if (le || re) {
    // one ear: a side view, or a front view with the other ear behind hair or a
    // headset. Front-on the eye pair gives the center across the face; the ear
    // only gives its depth along the head axis
    const ear = (le ?? re) as P
    const side = towardNose(ear, 0.3)
    if (pair) {
      const pm = mid(pair[0], pair[1])
      const dn = { x: -Math.sin(angle), y: Math.cos(angle) }
      const depth = (ear.x - pm.x) * dn.x + (ear.y - pm.y) * dn.y
      const front = { x: pm.x + depth * dn.x, y: pm.y + depth * dn.y }
      c = { x: side.x + wf * (front.x - side.x), y: side.y + wf * (front.y - side.y) }
    } else {
      c = side
    }
  } else {
    c = pair ? mid(pair[0], pair[1]) : nose
  }
  if (!c) return null
  return { frame: { x: c.x, y: c.y, angle, scale: size }, wf }
}

/**
 * Head frame (scale = head width), centered a little above the ear line.
 * `body` (the raw body frame) steadies its angle side-on and gives it a size
 * when only the nose is visible.
 */
export function headAnchor(lm: readonly Landmark[], aspect: number, body: Anchor | null = null): Anchor | null {
  const frame = headFrame(lm, aspect, body)
  if (!frame) return null
  // image "up" in the head frame is -v
  const lift = 0.12 * frame.scale
  return { ...frame, x: frame.x + Math.sin(frame.angle) * lift, y: frame.y - Math.cos(frame.angle) * lift }
}

// ---------- mesh ----------

interface Anchors {
  body: Anchor
  head: Anchor | null
}

/** Hex lattice with per-site jitter, emitted in isotropic image coordinates. */
function lattice(
  a: Anchor,
  step: number,
  seed: number,
  bounds: { u0: number; u1: number; v0: number; v1: number },
  emit: (x: number, y: number) => void
): void {
  const c = Math.cos(a.angle)
  const s = Math.sin(a.angle)
  const rowH = step * 0.866
  const j0 = Math.floor(bounds.v0 / rowH) - 1
  const j1 = Math.ceil(bounds.v1 / rowH) + 1
  const i0 = Math.floor(bounds.u0 / step) - 1
  const i1 = Math.ceil(bounds.u1 / step) + 1
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const u = (i + (j & 1) * 0.5 + (hash01(i, j, seed) - 0.5) * 2 * JITTER) * step
      const v = (j + (hash01(j, i, seed + 7) - 0.5) * 2 * JITTER) * rowH
      emit(a.x + (c * u - s * v) * a.scale, a.y + (s * u + c * v) * a.scale)
    }
  }
}

/** Mask bounding box, expressed in an anchor's local units. */
function localBounds(grid: MaskGrid, aspect: number, a: Anchor): { u0: number; u1: number; v0: number; v1: number } | null {
  let minI = Infinity
  let maxI = -Infinity
  let minJ = Infinity
  let maxJ = -Infinity
  for (let j = 0; j < grid.h; j++) {
    for (let i = 0; i < grid.w; i++) {
      if (grid.data[j * grid.w + i] < MASK_T) continue
      if (i < minI) minI = i
      if (i > maxI) maxI = i
      if (j < minJ) minJ = j
      if (j > maxJ) maxJ = j
    }
  }
  if (minI === Infinity) return null
  const x0 = (minI / grid.w) * aspect
  const x1 = ((maxI + 1) / grid.w) * aspect
  const y0 = minJ / grid.h
  const y1 = (maxJ + 1) / grid.h
  const c = Math.cos(-a.angle)
  const s = Math.sin(-a.angle)
  const out = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity }
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1]
  ]) {
    const dx = (x - a.x) / a.scale
    const dy = (y - a.y) / a.scale
    const u = c * dx - s * dy
    const v = s * dx + c * dy
    out.u0 = Math.min(out.u0, u)
    out.u1 = Math.max(out.u1, u)
    out.v0 = Math.min(out.v0, v)
    out.v1 = Math.max(out.v1, v)
  }
  return out
}

interface Connection {
  start: number
  end: number
}

/**
 * Flattens FaceLandmarker's connection lists (FACE_LANDMARKS_TESSELATION,
 * FACE_LANDMARKS_FACE_OVAL, eye/iris/lip contours) into typed arrays. The
 * tessellation lists every triangle's three sides, so shared edges repeat —
 * they are drawn once.
 */
export function buildFaceTopology(
  tessellation: readonly Connection[],
  oval: readonly Connection[],
  features: readonly (readonly Connection[])[]
): FaceTopology {
  const key = (a: number, b: number): number => (a < b ? a * 4096 + b : b * 4096 + a)
  const featureKeys = new Set(features.flatMap((list) => list.map((c) => key(c.start, c.end))))
  const seen = new Set<number>()
  const edges: number[] = []
  const feature: number[] = []
  let size = 0
  const add = (c: Connection): void => {
    const k = key(c.start, c.end)
    if (seen.has(k)) return
    seen.add(k)
    edges.push(c.start, c.end)
    feature.push(featureKeys.has(k) ? 1 : 0)
    size = Math.max(size, c.start + 1, c.end + 1)
  }
  tessellation.forEach(add)
  features.forEach((list) => list.forEach(add)) // contours outside the tessellation still get drawn

  const next = new Map(oval.map((c) => [c.start, c.end]))
  const loop: number[] = []
  let v: number | undefined = oval[0]?.start
  while (v !== undefined && loop.length < oval.length && !loop.includes(v)) {
    loop.push(v)
    v = next.get(v)
  }
  return { size, edges: Uint16Array.from(edges), feature: Uint8Array.from(feature), oval: Uint16Array.from(loop) }
}

/** Width of the face oval in normalized x units. */
function faceWidth(face: FaceInput): number {
  let min = Infinity
  let max = -Infinity
  for (const i of face.topology.oval) {
    const x = face.points[i]?.x ?? 0
    if (x < min) min = x
    if (x > max) max = x
  }
  return max - min
}

/**
 * Whether a face from FaceLandmarker belongs to the tracked person. It runs
 * on its own: when the user turns away or half leaves the frame it happily
 * returns someone else's face (a coworker behind them, a poster on the wall).
 * The face must sit on the person's mask and next to the pose's own nose (or
 * head frame when the nose is hidden).
 */
export function faceOnPerson(
  face: FaceInput,
  grid: MaskGrid,
  aspect: number,
  lm: readonly Landmark[],
  head: Anchor | null
): boolean {
  const oval = face.topology.oval
  if (oval.length < 3) return false
  let cx = 0
  let cy = 0
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const i of oval) {
    const p = face.points[i]
    if (!p) return false
    const x = p.x * aspect
    cx += x / oval.length
    cy += p.y / oval.length
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, p.y)
    y1 = Math.max(y1, p.y)
  }
  if (sampleMask(grid, aspect, cx, cy) < MASK_T) return false
  const ref = lmIso(lm, LM_NOSE, aspect) ?? head
  if (!ref) return true // nothing on the pose to compare with; the mask check has to do
  const size = Math.max(x1 - x0, y1 - y0, head ? head.scale : 0)
  return dist(ref, { x: cx, y: cy }) <= FACE_MATCH * size
}

/** lattice spacing multipliers outside this range make a smudge or a few stray triangles */
const SPACING_MIN = 1
const SPACING_MAX = 2.5

function clampSpacing(k: number): number {
  return Number.isFinite(k) ? Math.min(SPACING_MAX, Math.max(SPACING_MIN, k)) : SPACING_MIN
}

/**
 * Lattice spacing the display asks for (see meshLook): a subtle overlay wants
 * a sparser lattice, not just fainter lines. The overlay sets it and every
 * BodyMeshBuilder reads it on its next frame, so the detection loop needs no
 * knowledge of display settings.
 */
let displaySpacing = SPACING_MIN

export function setMeshSpacing(k: number): void {
  displaySpacing = clampSpacing(k)
}

export function meshSpacing(): number {
  return displaySpacing
}

/**
 * One frame's mesh. `anchors` should already be smoothed (see
 * BodyMeshBuilder) — the lattice rides on them, so their jitter would be the
 * mesh's jitter. `spacing` (>= 1) widens the lattice; 1 is the densest.
 */
export function buildBodyMesh(
  grid: MaskGrid,
  lm: readonly Landmark[],
  aspect: number,
  anchors: Anchors,
  face: FaceInput | null = null,
  spacing = 1
): BodyMesh | null {
  const { body, head } = anchors
  const bounds = localBounds(grid, aspect, body)
  if (!bounds || body.scale <= 1e-4) return null

  const spread = clampSpacing(spacing)
  const bodyUnits = Math.max(BODY_STEP * spread, MIN_BODY_STEP / body.scale)
  const headUnits = head ? Math.max(HEAD_STEP * spread, MIN_HEAD_STEP / head.scale) : bodyUnits
  const bodyStep = bodyUnits * body.scale
  const headStep = head ? headUnits * head.scale : bodyStep
  const headR = head ? HEAD_R * head.scale : 0
  const inHead = (x: number, y: number, pad = 0): boolean =>
    !!head && (x - head.x) ** 2 + (y - head.y) ** 2 < (headR + pad) ** 2
  const stepAt = (x: number, y: number): number => (inHead(x, y) ? headStep : bodyStep)
  const inside = (x: number, y: number): boolean => sampleMask(grid, aspect, x, y) >= MASK_T

  const xs: number[] = []
  const ys: number[] = []
  const seamVertex: boolean[] = []
  const fixed = new PointSet(Math.min(bodyStep, headStep))
  const push = (x: number, y: number, seam = false): void => {
    xs.push(x)
    ys.push(y)
    seamVertex.push(seam)
  }

  // 1. face oval first: the canonical face mesh owns everything inside it, and
  //    the body mesh stitches onto its rim (only a face that is this person's)
  const topo =
    face &&
    face.points.length >= face.topology.size &&
    face.topology.oval.length >= 3 &&
    faceWidth(face) >= MIN_FACE_WIDTH / aspect &&
    faceOnPerson(face, grid, aspect, lm, head)
      ? face.topology
      : null
  const faceVertex = topo ? new Int32Array(topo.size).fill(-1) : null
  let oval: Float64Array | null = null
  let ovalMargin: Float64Array | null = null
  let ovalCore: Float64Array | null = null
  if (topo && face && faceVertex) {
    oval = new Float64Array(topo.oval.length * 2)
    topo.oval.forEach((fi, k) => {
      const p = face.points[fi]
      oval![2 * k] = p.x * aspect
      oval![2 * k + 1] = p.y
      faceVertex[fi] = xs.length
      fixed.add(p.x * aspect, p.y)
      push(p.x * aspect, p.y)
    })
    ovalMargin = grownPolygon(oval, 1.06)
    ovalCore = grownPolygon(oval, 0.995)
  }
  const inFace = (x: number, y: number, poly: Float64Array | null): boolean => !!poly && inPolygon(poly, x, y)

  // 2. silhouette: iso-crossings between neighbouring grid cells, thinned to the local spacing
  const d = grid.data
  const cellX = (i: number): number => ((i + 0.5) / grid.w) * aspect
  const cellY = (j: number): number => (j + 0.5) / grid.h
  const addContour = (x: number, y: number, seam = false): void => {
    const r = stepAt(x, y) * (seam ? 1.1 : 0.8)
    if (inFace(x, y, ovalMargin) || fixed.near(x, y, r)) return
    fixed.add(x, y)
    push(x, y, seam)
  }
  for (let j = 0; j < grid.h; j++) {
    for (let i = 0; i < grid.w; i++) {
      const a = d[j * grid.w + i]
      if (i + 1 < grid.w) {
        const b = d[j * grid.w + i + 1]
        if (a >= MASK_T !== b >= MASK_T) {
          const t = (MASK_T - a) / (b - a)
          addContour(cellX(i + t), cellY(j))
        }
      }
      if (j + 1 < grid.h) {
        const b = d[(j + 1) * grid.w + i]
        if (a >= MASK_T !== b >= MASK_T) {
          const t = (MASK_T - a) / (b - a)
          addContour(cellX(i), cellY(j + t))
        }
      }
      // where the body leaves the frame, pin vertices to the image edge
      if (a >= MASK_T) {
        if (j === grid.h - 1) addContour(cellX(i), 1, true)
        else if (j === 0) addContour(cellX(i), 0, true)
        if (i === 0) addContour(0, cellY(j), true)
        else if (i === grid.w - 1) addContour(aspect, cellY(j), true)
      }
    }
  }

  // 3. interior lattices: fine on the head, coarse on the body
  const addLattice = (x: number, y: number, step: number): void => {
    if (!inside(x, y) || inFace(x, y, ovalMargin) || fixed.near(x, y, step * 0.5)) return
    push(x, y)
  }
  lattice(body, bodyUnits, 1, bounds, (x, y) => {
    if (!inHead(x, y, bodyStep * 0.4)) addLattice(x, y, bodyStep)
  })
  if (head) {
    const hb = { u0: -HEAD_R, u1: HEAD_R, v0: -HEAD_R, v1: HEAD_R }
    lattice(head, headUnits, 2, hb, (x, y) => {
      if (inHead(x, y)) addLattice(x, y, headStep)
    })
  }

  const nTriangulated = xs.length
  if (nTriangulated < 3) return null

  // 4. triangulate, keep triangles that sit on the person
  const coords = new Float64Array(nTriangulated * 2)
  for (let k = 0; k < nTriangulated; k++) {
    coords[2 * k] = xs[k]
    coords[2 * k + 1] = ys[k]
  }
  let tri: { triangles: Uint32Array; halfedges: Int32Array }
  try {
    tri = new Delaunator(coords)
  } catch {
    return null // degenerate (e.g. all points collinear)
  }
  const T = tri.triangles
  const H = tri.halfedges
  const nTri = T.length / 3
  const keep = new Uint8Array(nTri)
  for (let t = 0; t < nTri; t++) {
    const a = T[3 * t]
    const b = T[3 * t + 1]
    const c = T[3 * t + 2]
    const cx = (xs[a] + xs[b] + xs[c]) / 3
    const cy = (ys[a] + ys[b] + ys[c]) / 3
    if (!inside(cx, cy) || inFace(cx, cy, ovalCore)) continue
    const maxLen = MAX_EDGE * stepAt(cx, cy)
    const la = Math.hypot(xs[a] - xs[b], ys[a] - ys[b])
    const lb = Math.hypot(xs[b] - xs[c], ys[b] - ys[c])
    const lc = Math.hypot(xs[c] - xs[a], ys[c] - ys[a])
    if (Math.max(la, lb, lc) > maxLen) continue
    // a centroid inside can still hide an edge cutting across a concave notch
    // (armpit, neck-to-shoulder corner); silhouette-hugging edges stay well above this
    const edgeOut = (p: number, q: number): boolean =>
      sampleMask(grid, aspect, (xs[p] + xs[q]) / 2, (ys[p] + ys[q]) / 2) < EDGE_MID_MIN
    if (edgeOut(a, b) || edgeOut(b, c) || edgeOut(c, a)) continue
    keep[t] = 1
  }

  const nOval = topo ? topo.oval.length : 0
  const edgeList: number[] = []
  const kinds: number[] = []
  for (let e = 0; e < T.length; e++) {
    const t = (e / 3) | 0
    if (!keep[t]) continue
    const twin = H[e]
    const twinKept = twin !== -1 && keep[(twin / 3) | 0] === 1
    if (twinKept && twin < e) continue // emit shared edges once
    const a = T[e]
    const b = T[e % 3 === 2 ? e - 2 : e + 1]
    if (a < nOval && b < nOval) continue // the face mesh draws its own rim
    edgeList.push(a, b)
    kinds.push(twinKept ? EDGE_INNER : seamVertex[a] && seamVertex[b] ? EDGE_SEAM : EDGE_OUTLINE)
  }

  // 5. the face mesh itself: canonical tessellation, eyes/irises/lips as outlines
  if (topo && face && faceVertex) {
    for (let fi = 0; fi < topo.size; fi++) {
      if (faceVertex[fi] !== -1) continue
      faceVertex[fi] = xs.length
      push(face.points[fi].x * aspect, face.points[fi].y)
    }
    for (let k = 0; k < topo.edges.length; k += 2) {
      edgeList.push(faceVertex[topo.edges[k]], faceVertex[topo.edges[k + 1]])
      kinds.push(topo.feature[k / 2] ? EDGE_OUTLINE : EDGE_FACE)
    }
  }
  if (edgeList.length === 0) return null
  const n = xs.length

  // 6. express everything in the body frame
  const c = Math.cos(-body.angle)
  const s = Math.sin(-body.angle)
  const toBody = (x: number, y: number): { u: number; v: number } => {
    const dx = (x - body.x) / body.scale
    const dy = (y - body.y) / body.scale
    return { u: c * dx - s * dy, v: s * dx + c * dy }
  }
  const u = new Float32Array(n)
  const v = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const p = toBody(xs[k], ys[k])
    u[k] = p.u
    v[k] = p.v
  }
  const isFace = new Uint8Array(n)
  if (faceVertex) for (const k of faceVertex) isFace[k] = 1

  const joints: { u: number; v: number }[] = []
  for (const i of JOINTS) {
    const p = lmIso(lm, i, aspect)
    if (p && p.y <= 1 && sampleMask(grid, aspect, p.x, p.y) >= 0.3) joints.push(toBody(p.x, p.y))
  }

  // sized from the frames' scales, which hold up from any camera angle (the raw
  // shoulder or ear spread collapses to a few pixels side-on); a single visible
  // shoulder is enough to place the neck and shoulders
  const shoulder = meanOf([lmIso(lm, LM_SH_L, aspect), lmIso(lm, LM_SH_R, aspect)])
  const shW = body.scale
  const region = (p: P, r: number): Region => ({ ...toBody(p.x, p.y), r: r / body.scale })
  const regions: BodyMesh['regions'] = {
    head: head ? region(head, headR) : null,
    neck: head && shoulder ? region(mid(head, shoulder), 0.38 * shW) : null,
    shoulders: shoulder ? region(shoulder, 0.62 * shW) : null
  }

  return {
    aspect,
    anchor: body,
    u,
    v,
    faceVertex: isFace,
    edges: Uint32Array.from(edgeList),
    edgeKind: Uint8Array.from(kinds),
    joints,
    regions
  }
}

// ---------- temporal smoothing ----------

/** One-Euro filter: heavy smoothing at rest, little lag when moving. */
class OneEuro {
  private x: number | null = null
  private dx = 0
  private t = 0

  constructor(
    private minCutoff: number,
    private beta: number
  ) {}

  reset(): void {
    this.x = null
    this.dx = 0
  }

  /** the current filtered value (null before the first sample) */
  get value(): number | null {
    return this.x
  }

  /** Moves the state by `d` without disturbing its velocity. */
  shift(d: number): void {
    if (this.x !== null) this.x += d
  }

  filter(value: number, tS: number): number {
    if (this.x === null) {
      this.x = value
      this.t = tS
      return value
    }
    const dt = Math.max(1e-3, tS - this.t)
    this.t = tS
    const alpha = (cutoff: number): number => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt))
    this.dx += alpha(1) * ((value - this.x) / dt - this.dx)
    this.x += alpha(this.minCutoff + this.beta * Math.abs(this.dx)) * (value - this.x)
    return this.x
  }
}

class AnchorFilter {
  private fx = new OneEuro(1.2, 3)
  private fy = new OneEuro(1.2, 3)
  private fa = new OneEuro(1.0, 0.6)
  private fs = new OneEuro(0.8, 2)

  reset(): void {
    for (const f of [this.fx, this.fy, this.fa, this.fs]) f.reset()
  }

  filter(a: Anchor, tS: number): Anchor {
    // A frame's angle comes from a direction-less line, so a raw angle and the
    // same one +-pi describe the same frame. Unwrap against the filtered angle
    // instead of letting a wrap (near +-pi/2) drag the filter across the circle.
    const prev = this.fa.value
    const raw = prev === null ? a.angle : prev + wrapHalfTurn(a.angle - prev)
    let angle = this.fa.filter(raw, tS)
    // ...and once the filtered frame has drifted well past vertical, take the
    // equivalent upright one again
    if (Math.abs(angle) > Math.PI / 2 + 0.35) {
      const d = -Math.PI * Math.sign(angle)
      this.fa.shift(d)
      angle += d
    }
    return {
      x: this.fx.filter(a.x, tS),
      y: this.fy.filter(a.y, tS),
      angle,
      scale: this.fs.filter(a.scale, tS)
    }
  }
}

/**
 * Stateful wrapper the detection loop feeds with each frame's mask: owns the
 * grid's temporal blend and the anchors' One-Euro smoothing.
 */
export class BodyMeshBuilder {
  private grid: MaskGrid | null = null
  private body = new AnchorFilter()
  private head = new AnchorFilter()
  private hadHead = false
  private face: Float32Array | null = null

  reset(): void {
    this.grid = null
    this.body.reset()
    this.head.reset()
    this.hadHead = false
    this.face = null
  }

  /**
   * Face landmarks jitter by a pixel or two between frames; at rest that reads
   * as shimmer across 1,300 edges. Blend toward each new frame — gently when
   * the face holds still, immediately once it really moves.
   */
  private smoothFace(points: readonly Landmark[]): Landmark[] {
    const n = points.length
    const prev = this.face
    if (!prev || prev.length !== n * 2) {
      this.face = Float32Array.from(points.flatMap((p) => [p.x, p.y]))
      return points.map((p) => ({ x: p.x, y: p.y }))
    }
    let minX = Infinity
    let maxX = -Infinity
    let moved = 0
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, points[i].x)
      maxX = Math.max(maxX, points[i].x)
      moved += Math.hypot(points[i].x - prev[2 * i], points[i].y - prev[2 * i + 1])
    }
    const motion = moved / n / Math.max(1e-3, maxX - minX) // face widths per frame
    const alpha = Math.min(1, 0.35 + motion * 30)
    const out: Landmark[] = new Array(n)
    for (let i = 0; i < n; i++) {
      prev[2 * i] += (points[i].x - prev[2 * i]) * alpha
      prev[2 * i + 1] += (points[i].y - prev[2 * i + 1]) * alpha
      out[i] = { x: prev[2 * i], y: prev[2 * i + 1] }
    }
    return out
  }

  update(
    mask: Float32Array,
    mw: number,
    mh: number,
    lm: readonly Landmark[] | null,
    tMs: number,
    face: FaceInput | null = null
  ): BodyMesh | null {
    if (!lm || mw <= 0 || mh <= 0 || mask.length < mw * mh) {
      this.reset()
      return null
    }
    const aspect = mw / mh
    const rawBody = bodyAnchor(lm, aspect)
    if (!rawBody) {
      this.reset()
      return null
    }
    this.grid = downsampleMask(mask, mw, mh, this.grid)
    const tS = tMs / 1000
    const rawHead = headAnchor(lm, aspect, rawBody)
    if (!rawHead && this.hadHead) this.head.reset()
    this.hadHead = !!rawHead
    // someone else's face must not be stitched in, nor blended into this one's smoothing
    const own = face && faceOnPerson(face, this.grid, aspect, lm, rawHead) ? face : null
    if (!own) this.face = null
    return buildBodyMesh(
      this.grid,
      lm,
      aspect,
      { body: this.body.filter(rawBody, tS), head: rawHead ? this.head.filter(rawHead, tS) : null },
      own ? { points: this.smoothFace(own.points), topology: own.topology } : null,
      displaySpacing
    )
  }
}

// ---------- display helpers (MeshOverlay) ----------

export type RegionKey = keyof BodyMesh['regions']

/** past these, easing the display frame would visibly drag the mesh off the body */
const SNAP_MOVE = 0.5 // in body scales
const SNAP_TURN = 0.3 // rad
const SNAP_ZOOM = 1.3 // ratio

/**
 * One render frame's step of the display body frame toward the latest
 * detection's (`k` = easing fraction for this frame). Every mesh vertex is
 * stored relative to that frame, so a big step in any of position, angle or
 * scale snaps instead of easing; small ones ease, the angle along the short
 * way round.
 */
export function easeAnchor(display: Anchor | null, target: Anchor, k: number): Anchor {
  if (!display) return { ...target }
  const turn = wrapTurn(target.angle - display.angle)
  const zoom = target.scale / Math.max(1e-9, display.scale)
  if (
    Math.hypot(target.x - display.x, target.y - display.y) > SNAP_MOVE * target.scale ||
    Math.abs(turn) > SNAP_TURN ||
    zoom > SNAP_ZOOM ||
    zoom < 1 / SNAP_ZOOM
  ) {
    return { ...target }
  }
  return {
    x: display.x + (target.x - display.x) * k,
    y: display.y + (target.y - display.y) * k,
    angle: display.angle + turn * k,
    scale: display.scale + (target.scale - display.scale) * k
  }
}

/**
 * The worst stage per mesh region, for issues that map onto the same region
 * (head-forward and too-close both light the head): each region is painted
 * once, in its most severe color. Stage-0 issues are left out.
 */
export function worstPerRegion<I extends string>(
  stages: Iterable<readonly [I, number]>,
  regionOf: Readonly<Record<I, RegionKey>>
): [RegionKey, number][] {
  const worst = new Map<RegionKey, number>()
  for (const [issue, stage] of stages) {
    if (stage <= 0) continue
    const key = regionOf[issue]
    worst.set(key, Math.max(stage, worst.get(key) ?? 0))
  }
  return [...worst]
}
