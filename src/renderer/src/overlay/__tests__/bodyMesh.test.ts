import { describe, expect, it } from 'vitest'
import type { Landmark } from '@renderer/posture/types'
import {
  BodyMeshBuilder,
  EDGE_FACE,
  EDGE_OUTLINE,
  EDGE_SEAM,
  bodyAnchor,
  buildBodyMesh,
  buildFaceTopology,
  downsampleMask,
  easeAnchor,
  faceOnPerson,
  headAnchor,
  meshSpacing,
  setMeshSpacing,
  sampleMask,
  worstPerRegion,
  wrapTurn,
  type Anchor,
  type BodyMesh,
  type FaceInput
} from '../bodyMesh'

const W = 640
const H = 480
const ASPECT = W / H

/**
 * A desk-webcam silhouette: head disc, neck, torso running off the bottom
 * edge. `k` shrinks the person about the head (k < 1 = further away).
 */
function scene(dx = 0, dy = 0, k = 1): { mask: Float32Array; lm: Landmark[] } {
  const mask = new Float32Array(W * H)
  const hx = 320 + dx
  const hy = 150 + dy
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const head = (x - hx) ** 2 / (70 * k) ** 2 + (y - hy) ** 2 / (88 * k) ** 2 < 1
      const neck = Math.abs(x - hx) < 38 * k && y > hy + 60 * k && y < hy + 120 * k
      const torsoTop = hy + 105 * k
      const half = (170 + (y - torsoTop) * 0.25) * k
      const torso = y >= torsoTop && Math.abs(x - hx) < half
      if (head || neck || torso) mask[y * W + x] = 1
    }
  }
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }))
  const set = (i: number, x: number, y: number): void => {
    lm[i] = { x: (320 + (x - 320) * k + dx) / W, y: (150 + (y - 150) * k + dy) / H, visibility: 0.99 }
  }
  set(0, 320, 165) // nose
  set(1, 332, 135) // left eye inner (person's left = image right)
  set(2, 342, 135)
  set(3, 352, 135)
  set(4, 308, 135)
  set(5, 298, 135)
  set(6, 288, 135)
  set(7, 382, 150) // left ear
  set(8, 258, 150) // right ear
  set(9, 336, 192) // mouth left
  set(10, 304, 192) // mouth right
  set(11, 440, 270) // left shoulder
  set(12, 200, 270) // right shoulder
  return { mask, lm }
}

const RINGS = 4
const SPOKES = 16

/**
 * A stand-in for FaceLandmarker: a center point plus concentric rings over the
 * face, tessellated like MediaPipe lists it (every triangle's three sides, so
 * shared edges repeat). Ring 1 plays the part of a lip contour.
 */
function syntheticFace(size = 1): FaceInput {
  const points: Landmark[] = [{ x: 320 / W, y: 150 / H }]
  for (let r = 1; r <= RINGS; r++) {
    for (let k = 0; k < SPOKES; k++) {
      const t = (k / SPOKES) * Math.PI * 2
      const rx = 52 * size * (r / RINGS)
      const ry = 68 * size * (r / RINGS)
      points.push({ x: (320 + Math.cos(t) * rx) / W, y: (150 + Math.sin(t) * ry) / H })
    }
  }
  const id = (r: number, k: number): number => 1 + (r - 1) * SPOKES + (k % SPOKES)
  const tess: { start: number; end: number }[] = []
  const tri = (a: number, b: number, c: number): void => {
    tess.push({ start: a, end: b }, { start: b, end: c }, { start: c, end: a })
  }
  for (let k = 0; k < SPOKES; k++) {
    tri(0, id(1, k), id(1, k + 1))
    for (let r = 1; r < RINGS; r++) {
      tri(id(r, k), id(r + 1, k), id(r + 1, k + 1))
      tri(id(r, k), id(r + 1, k + 1), id(r, k + 1))
    }
  }
  const ring = (r: number): { start: number; end: number }[] =>
    Array.from({ length: SPOKES }, (_, k) => ({ start: id(r, k), end: id(r, k + 1) }))
  return { points, topology: buildFaceTopology(tess, ring(RINGS), [ring(1)]) }
}

function build(dx = 0, dy = 0, face: FaceInput | null = null, k = 1): BodyMesh {
  const { mask, lm } = scene(dx, dy, k)
  const grid = downsampleMask(mask, W, H)
  const body = bodyAnchor(lm, ASPECT)!
  const head = headAnchor(lm, ASPECT)
  const mesh = buildBodyMesh(grid, lm, ASPECT, { body, head }, face)
  expect(mesh).not.toBeNull()
  return mesh!
}

function toImage(mesh: BodyMesh, k: number): { x: number; y: number } {
  const a = mesh.anchor
  const c = Math.cos(a.angle)
  const s = Math.sin(a.angle)
  return {
    x: a.x + (c * mesh.u[k] - s * mesh.v[k]) * a.scale,
    y: a.y + (s * mesh.u[k] + c * mesh.v[k]) * a.scale
  }
}

describe('body anchors', () => {
  it('uses the shoulder line as the body frame', () => {
    const { lm } = scene()
    const a = bodyAnchor(lm, ASPECT)!
    expect(a.x).toBeCloseTo((320 / W) * ASPECT, 5)
    expect(a.y).toBeCloseTo(270 / H, 5)
    expect(a.angle).toBeCloseTo(0, 5)
    expect(a.scale).toBeCloseTo((240 / W) * ASPECT, 5)
  })

  it('falls back to the ears when the shoulders are hidden', () => {
    const { lm } = scene()
    lm[11] = { ...lm[11], visibility: 0.1 }
    lm[12] = { ...lm[12], visibility: 0.1 }
    const a = bodyAnchor(lm, ASPECT)!
    expect(a.scale).toBeCloseTo(((124 / W) * ASPECT) * 2.4, 5)
    expect(a.angle).toBeCloseTo(0, 5)
  })

  it('front-on, a single visible shoulder keeps the two-shoulder frame (mirrored about the head)', () => {
    const both = bodyAnchor(scene().lm, ASPECT)!
    for (const hidden of [11, 12]) {
      const { lm } = scene()
      lm[hidden] = { ...lm[hidden], visibility: 0.1 }
      const a = bodyAnchor(lm, ASPECT)!
      // not the ears-to-shoulder diagonal (45°, centred on the visible shoulder)
      expect(a.x).toBeCloseTo(both.x, 5)
      expect(a.y).toBeCloseTo(both.y, 5)
      expect(a.angle).toBeCloseTo(both.angle, 5)
      expect(a.scale).toBeCloseTo(both.scale, 5)
    }
  })

  it('side-on, a single visible shoulder is oriented and sized by the head-to-shoulder axis', () => {
    const { lm } = sideScene()
    lm[11] = { ...lm[11], visibility: 0.1 } // far shoulder hidden
    const a = bodyAnchor(lm, ASPECT)!
    expect(a.x).toBeCloseTo((320 / W) * ASPECT, 5) // the near shoulder
    expect(a.y).toBeCloseTo(270 / H, 5)
    // near ear (310, 150) → shoulder (320, 270)
    expect(a.angle).toBeCloseTo(Math.atan2(-10, 120), 5)
    expect(a.scale * H).toBeCloseTo(1.6 * Math.hypot(10, 120), 3)
  })

  it('does not rotate the lattice when one shoulder flickers in and out of view front-on', () => {
    const builder = new BodyMeshBuilder()
    const angles: number[] = []
    for (let f = 0; f < 20; f++) {
      const { mask, lm } = scene()
      if (f % 3 === 0) lm[11] = { ...lm[11], visibility: 0.45 }
      const mesh = builder.update(mask, W, H, lm, f * 100)
      expect(mesh).not.toBeNull()
      angles.push(mesh!.anchor.angle)
    }
    expect(Math.max(...angles) - Math.min(...angles)).toBeLessThan(0.1)
  })

  it('keeps the head frame on the face when one ear is hidden front-on', () => {
    const both = headAnchor(scene().lm, ASPECT)!
    for (const hidden of [7, 8]) {
      const { lm } = scene()
      lm[hidden] = { ...lm[hidden], visibility: 0.1 }
      const a = headAnchor(lm, ASPECT)!
      // the old frame sat on the visible ear, ~62 px (half a head) off the face
      expect(Math.abs(a.x - both.x) / both.scale).toBeLessThan(0.15)
      expect(Math.abs(a.y - both.y) / both.scale).toBeLessThan(0.15)
      expect(Math.abs(a.angle)).toBeLessThan(0.05)
    }
  })

  it('stays upright when the landmark order is reversed (seen from behind)', () => {
    const { lm } = scene()
    const l = lm[11]
    lm[11] = lm[12]
    lm[12] = l
    expect(Math.abs(bodyAnchor(lm, ASPECT)!.angle)).toBeLessThan(1e-6)
  })

  it('returns null without usable landmarks', () => {
    const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.1 }))
    expect(bodyAnchor(lm, ASPECT)).toBeNull()
    expect(headAnchor(lm, ASPECT)).toBeNull()
  })
})

describe('mask grid', () => {
  it('keeps the silhouette and blends with the previous grid', () => {
    const { mask } = scene()
    const grid = downsampleMask(mask, W, H)
    expect(grid.w).toBe(112)
    expect(grid.h).toBe(84)
    expect(sampleMask(grid, ASPECT, (320 / W) * ASPECT, 150 / H)).toBeGreaterThan(0.9)
    expect(sampleMask(grid, ASPECT, (40 / W) * ASPECT, 40 / H)).toBeLessThan(0.1)
    expect(sampleMask(grid, ASPECT, -0.1, 0.5)).toBe(0)

    const empty = downsampleMask(new Float32Array(W * H), W, H, grid)
    const v = sampleMask(empty, ASPECT, (320 / W) * ASPECT, 150 / H)
    expect(v).toBeGreaterThan(0.2)
    expect(v).toBeLessThan(0.5)
  })
})

describe('buildBodyMesh', () => {
  it('fills the silhouette with a reasonable number of vertices', () => {
    const mesh = build()
    expect(mesh.u.length).toBeGreaterThan(150)
    expect(mesh.u.length).toBeLessThan(2500)
    expect(mesh.edges.length / 2).toBeGreaterThan(mesh.u.length) // triangulated, not a point cloud
  })

  it('never draws edges across the background', () => {
    const mesh = build()
    const { mask } = scene()
    const grid = downsampleMask(mask, W, H)
    for (let e = 0; e < mesh.edges.length; e += 2) {
      const a = toImage(mesh, mesh.edges[e])
      const b = toImage(mesh, mesh.edges[e + 1])
      expect(sampleMask(grid, ASPECT, (a.x + b.x) / 2, (a.y + b.y) / 2)).toBeGreaterThan(0.1)
    }
  })

  it('is denser on the head than on the body', () => {
    const mesh = build()
    let head = 0
    let torso = 0
    for (let k = 0; k < mesh.u.length; k++) {
      const p = toImage(mesh, k)
      const px = (p.x / ASPECT) * W
      const py = p.y * H
      if (Math.hypot(px - 320, py - 140) < 50) head++
      if (Math.hypot(px - 320, py - 390) < 50) torso++
    }
    expect(head).toBeGreaterThan(torso * 2)
  })

  it('stitches the canonical face mesh in over the face', () => {
    const face = syntheticFace()
    const topo = face.topology
    const mesh = build(0, 0, face)
    const nFaceEdges = topo.edges.length / 2
    const firstFace = mesh.edgeKind.length - nFaceEdges
    // every face edge is drawn once, lip contour highlighted
    let outlines = 0
    for (let e = firstFace; e < mesh.edgeKind.length; e++) {
      if (mesh.edgeKind[e] === EDGE_OUTLINE) outlines++
      else expect(mesh.edgeKind[e]).toBe(EDGE_FACE)
    }
    expect(outlines).toBe(SPOKES)

    // the body mesh stays out of the face: no body vertex or edge inside the oval
    const inOval = (x: number, y: number, scale: number): boolean =>
      ((x / ASPECT) * W - 320) ** 2 / (52 * scale) ** 2 + (y * H - 150) ** 2 / (68 * scale) ** 2 < 1
    const faceVertices = new Set<number>()
    for (let e = firstFace * 2; e < mesh.edges.length; e++) faceVertices.add(mesh.edges[e])
    for (let k = 0; k < mesh.u.length; k++) {
      if (faceVertices.has(k)) continue
      const p = toImage(mesh, k)
      expect(inOval(p.x, p.y, 1.02)).toBe(false)
    }
    for (let e = 0; e < firstFace * 2; e += 2) {
      const a = toImage(mesh, mesh.edges[e])
      const b = toImage(mesh, mesh.edges[e + 1])
      expect(inOval((a.x + b.x) / 2, (a.y + b.y) / 2, 0.9)).toBe(false)
    }
    // ...but it does connect to the oval's rim
    const rim = new Set(Array.from(topo.oval, (fi) => fi))
    let stitches = 0
    for (let e = 0; e < firstFace * 2; e += 2) {
      if (mesh.edges[e] < rim.size || mesh.edges[e + 1] < rim.size) stitches++
    }
    expect(stitches).toBeGreaterThan(rim.size)
  })

  it('keeps a visible spacing on the head when the person is far away', () => {
    const mesh = build(0, 0, null, 0.3)
    const pts = Array.from({ length: mesh.u.length }, (_, k) => toImage(mesh, k))
    const head = pts.filter((p) => Math.hypot((p.x / ASPECT) * W - 320, p.y * H - 150) < 18)
    expect(head.length).toBeGreaterThan(3)
    const nearest = head.map((p) =>
      Math.min(...pts.map((q) => (q === p ? Infinity : Math.hypot(p.x - q.x, p.y - q.y))))
    )
    nearest.sort((a, b) => a - b)
    expect(nearest[nearest.length >> 1]).toBeGreaterThan(0.008) // median, in image heights (~4 px at 480p)
  })

  it('leaves a tiny face plain instead of smudging the face mesh into it', () => {
    const face = syntheticFace()
    const tiny = { ...face, points: face.points.map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.3, y: p.y })) }
    expect(build(0, 0, tiny).u.length).toBe(build().u.length)
  })

  it('ignores face landmarks that do not cover the topology', () => {
    const face = syntheticFace()
    const partial = { ...face, points: face.points.slice(0, 10) }
    const mesh = build(0, 0, partial)
    expect(mesh.u.length).toBe(build().u.length)
  })

  it('has no holes inside the body: every outline edge lies on the silhouette', () => {
    for (const [dx, dy, k] of [
      [0, 0, 1],
      [24, 10, 1],
      [-30, 40, 0.8],
      [10, -20, 1.3]
    ]) {
      // a face that nearly fills the head, like a real forehead running up to the hairline
      const face = syntheticFace(1.22)
      const moved = { ...face, points: face.points.map((p) => ({ x: (320 + (p.x * W - 320) * k + dx) / W, y: (150 + (p.y * H - 150) * k + dy) / H })) }
      for (const mesh of [build(dx, dy, null, k), build(dx, dy, moved, k)]) {
      const { mask } = scene(dx, dy, k)
      const grid = downsampleMask(mask, W, H)
      // an outline edge must have background within about one lattice step
      const nearBackground = (x: number, y: number): boolean =>
        Array.from({ length: 16 }, (_, i) => (i / 16) * Math.PI * 2).some(
          (t) => sampleMask(grid, ASPECT, x + (Math.cos(t) * 24 * k) / H, y + (Math.sin(t) * 24 * k) / H) < 0.5
        )
      for (let e = 0; e < mesh.edges.length; e += 2) {
        if (mesh.edgeKind[e / 2] !== EDGE_OUTLINE) continue
        if (mesh.faceVertex[mesh.edges[e]] && mesh.faceVertex[mesh.edges[e + 1]]) continue // eye/lip contours
        const a = toImage(mesh, mesh.edges[e])
        const b = toImage(mesh, mesh.edges[e + 1])
        expect(nearBackground((a.x + b.x) / 2, (a.y + b.y) / 2)).toBe(true)
      }
      }
    }
  })

  it('marks where the torso runs off the frame as a seam, not a silhouette', () => {
    const mesh = build()
    let seams = 0
    for (let e = 0; e < mesh.edges.length; e += 2) {
      if (mesh.edgeKind[e / 2] !== EDGE_SEAM) continue
      seams++
      expect(toImage(mesh, mesh.edges[e]).y).toBeGreaterThan(0.99)
    }
    expect(seams).toBeGreaterThan(3)
  })

  it('is deterministic', () => {
    const a = build()
    const b = build()
    expect(Array.from(a.u)).toEqual(Array.from(b.u))
    expect(Array.from(a.edges)).toEqual(Array.from(b.edges))
  })

  it('rides on the body: moving the person keeps interior vertices in place in body space', () => {
    const a = build()
    const b = build(24, 10)
    const key = (m: BodyMesh, k: number): string => `${m.u[k].toFixed(4)},${m.v[k].toFixed(4)}`
    const inB = new Set(Array.from({ length: b.u.length }, (_, k) => key(b, k)))
    let shared = 0
    for (let k = 0; k < a.u.length; k++) if (inB.has(key(a, k))) shared++
    expect(shared / a.u.length).toBeGreaterThan(0.6)
  })

  it('reports joints and issue regions in body space', () => {
    const mesh = build()
    expect(mesh.joints.length).toBe(2) // both shoulders; arms and hips are out of frame
    expect(mesh.regions.head).not.toBeNull()
    expect(mesh.regions.neck).not.toBeNull()
    expect(mesh.regions.shoulders!.u).toBeCloseTo(0, 5)
    expect(mesh.regions.head!.v).toBeLessThan(mesh.regions.neck!.v)
  })
})

describe('buildFaceTopology', () => {
  it('dedupes shared edges, flags contours and orders the oval loop', () => {
    const tess = [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 0 },
      { start: 2, end: 1 },
      { start: 1, end: 3 },
      { start: 3, end: 2 }
    ]
    const oval = [
      { start: 3, end: 2 },
      { start: 0, end: 1 },
      { start: 2, end: 0 },
      { start: 1, end: 3 }
    ]
    const iris = [{ start: 4, end: 5 }]
    const topo = buildFaceTopology(tess, oval, [[{ start: 1, end: 0 }], iris])
    expect(topo.edges.length / 2).toBe(6) // 5 unique tessellation edges + the iris edge
    expect(topo.size).toBe(6)
    expect(Array.from(topo.oval)).toEqual([3, 2, 0, 1])
    const flagged = Array.from(topo.feature).reduce((a, b) => a + b, 0)
    expect(flagged).toBe(2) // 0–1 and the iris
  })
})

describe('BodyMeshBuilder', () => {
  it('builds from raw masks and resets when the person is lost', () => {
    const builder = new BodyMeshBuilder()
    const { mask, lm } = scene()
    expect(builder.update(mask, W, H, lm, 0)).not.toBeNull()
    expect(builder.update(mask, W, H, null, 100)).toBeNull()
    expect(builder.update(mask, W, H, lm, 200)).not.toBeNull()
  })

  it('smooths face jitter at rest but follows real movement at once', () => {
    const builder = new BodyMeshBuilder()
    const { mask, lm } = scene()
    const face = syntheticFace()
    const shifted = (dx: number): FaceInput => ({ ...face, points: face.points.map((p) => ({ x: p.x + dx / W, y: p.y })) })
    const centerX = (m: BodyMesh): number => {
      // interior face points are appended last, in landmark order — the center (0) comes first
      const k = m.u.length - (face.topology.size - face.topology.oval.length)
      return (toImage(m, k).x / ASPECT) * W
    }
    builder.update(mask, W, H, lm, 0, shifted(0))
    const jitter = centerX(builder.update(mask, W, H, lm, 100, shifted(1.5))!)
    expect(jitter - 320).toBeGreaterThan(0.2)
    expect(jitter - 320).toBeLessThan(1.2)
    const jump = centerX(builder.update(mask, W, H, lm, 200, shifted(30))!)
    expect(jump - 320).toBeGreaterThan(29)
  })

  it('rejects a mask that does not match its declared size', () => {
    const builder = new BodyMeshBuilder()
    const { lm } = scene()
    expect(builder.update(new Float32Array(10), W, H, lm, 0)).toBeNull()
  })
})

// ---------- other camera angles ----------

/**
 * A side-on desk webcam above shoulder height, the person facing image-left
 * (`facing` = -1) or image-right (+1): the far ear and eye are hidden, and the
 * far shoulder projects just 12 px above the near one with `jx` px of x noise.
 */
function sideScene(jx = 0, facing = -1): { mask: Float32Array; lm: Landmark[] } {
  const mask = new Float32Array(W * H)
  const fx = (x: number): number => 320 + (x - 320) * -facing // mirror for facing right
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const mx = fx(x)
      const head = (mx - 290) ** 2 / 64 ** 2 + (y - 150) ** 2 / 82 ** 2 < 1
      const neck = mx > 280 && mx < 350 && y > 200 && y < 262
      const torso = y >= 245 && mx > 250 - (y - 245) * 0.1 && mx < 395 + (y - 245) * 0.1
      if (head || neck || torso) mask[y * W + x] = 1
    }
  }
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }))
  const set = (i: number, x: number, y: number, visibility = 0.99): void => {
    lm[i] = { x: fx(x) / W, y: y / H, visibility }
  }
  set(0, 240, 165) // nose, out in front
  set(1, 258, 138, 0.2) // far eye: hidden
  set(2, 254, 138, 0.2)
  set(3, 250, 138, 0.2)
  set(4, 262, 138)
  set(5, 266, 138)
  set(6, 270, 138) // near eye, outer corner
  set(7, 300, 150, 0.1) // far ear: hidden
  set(8, 310, 150) // near ear
  set(11, 320 + jx, 258, 0.7) // far shoulder, just above the near one
  set(12, 320, 270) // near shoulder
  return { mask, lm }
}

function buildFrom({ mask, lm }: { mask: Float32Array; lm: Landmark[] }, face: FaceInput | null = null): BodyMesh {
  const grid = downsampleMask(mask, W, H)
  const body = bodyAnchor(lm, ASPECT)!
  const mesh = buildBodyMesh(grid, lm, ASPECT, { body, head: headAnchor(lm, ASPECT, body) }, face)
  expect(mesh).not.toBeNull()
  return mesh!
}

function toImageUV(mesh: BodyMesh, u: number, v: number): { x: number; y: number } {
  const a = mesh.anchor
  const c = Math.cos(a.angle)
  const s = Math.sin(a.angle)
  return { x: a.x + (c * u - s * v) * a.scale, y: a.y + (s * u + c * v) * a.scale }
}

/** A region's radius in pixels at 480p. */
const regionPx = (mesh: BodyMesh, key: keyof BodyMesh['regions']): number => mesh.regions[key]!.r * mesh.anchor.scale * H

describe('side views', () => {
  it('keeps the body frame steady when the near-vertical shoulder line jitters', () => {
    for (const facing of [-1, 1]) {
      const angles = [-2, -1, 0, 1, 2].map((jx) => bodyAnchor(sideScene(jx, facing).lm, ASPECT)!.angle)
      // the old shoulder-line frame flipped between about +1.4 and -1.4 rad here
      expect(Math.max(...angles) - Math.min(...angles)).toBeLessThan(0.05)
      // and it is upright: down the head-to-shoulder axis, not across the shoulders
      for (const a of angles) expect(Math.abs(a)).toBeLessThan(0.2)
    }
  })

  it('sizes the body frame from the torso, not the collapsed shoulder width', () => {
    const a = bodyAnchor(sideScene().lm, ASPECT)!
    // ear (310, 150) to shoulders (320, 264): ~114 px, so ~183 px "shoulder width"; the raw spread is 12 px
    expect(a.scale * H).toBeGreaterThan(150)
    expect(a.scale * H).toBeLessThan(220)
  })

  it('does not boil: the smoothed frame holds still over noisy side-on frames', () => {
    const builder = new BodyMeshBuilder()
    const angles: number[] = []
    for (let f = 0; f < 20; f++) {
      const { mask, lm } = sideScene(f % 2 ? 2 : -2)
      const mesh = builder.update(mask, W, H, lm, f * 100)
      expect(mesh).not.toBeNull()
      angles.push(mesh!.anchor.angle)
    }
    expect(Math.max(...angles) - Math.min(...angles)).toBeLessThan(0.03)
  })

  it('keeps head, neck and shoulder regions at a usable size side-on', () => {
    for (const facing of [-1, 1]) {
      const scn = sideScene(0, facing)
      const mesh = buildFrom(scn)
      expect(mesh.regions.head).not.toBeNull()
      expect(mesh.regions.neck).not.toBeNull()
      expect(mesh.regions.shoulders).not.toBeNull()
      // the head is ~128 px wide; the old ear-spread sizing gave null or a few pixels
      expect(regionPx(mesh, 'head')).toBeGreaterThan(50)
      expect(regionPx(mesh, 'head')).toBeLessThan(120)
      expect(regionPx(mesh, 'neck')).toBeGreaterThan(40)
      expect(regionPx(mesh, 'shoulders')).toBeGreaterThan(80)
      // the head region sits on the head, the neck between it and the shoulders
      const grid = downsampleMask(scn.mask, W, H)
      const at = (r: { u: number; v: number }): { x: number; y: number } => toImageUV(mesh, r.u, r.v)
      const head = at(mesh.regions.head!)
      expect(sampleMask(grid, ASPECT, head.x, head.y)).toBeGreaterThan(0.5)
      expect(head.y).toBeLessThan(at(mesh.regions.neck!).y)
      expect(at(mesh.regions.neck!).y).toBeLessThan(at(mesh.regions.shoulders!).y)
    }
  })

  it('still builds a denser head lattice side-on', () => {
    const mesh = buildFrom(sideScene())
    let head = 0
    let torso = 0
    for (let k = 0; k < mesh.u.length; k++) {
      const p = toImage(mesh, k)
      const px = (p.x / ASPECT) * W
      const py = p.y * H
      if (Math.hypot(px - 290, py - 140) < 40) head++
      if (Math.hypot(px - 320, py - 400) < 40) torso++
    }
    expect(head).toBeGreaterThan(torso * 1.5)
  })

  it('never draws edges across the background side-on', () => {
    const scn = sideScene()
    const mesh = buildFrom(scn)
    const grid = downsampleMask(scn.mask, W, H)
    for (let e = 0; e < mesh.edges.length; e += 2) {
      if (mesh.edgeKind[e / 2] === EDGE_SEAM) continue // pinned to the image border, never drawn
      const a = toImage(mesh, mesh.edges[e])
      const b = toImage(mesh, mesh.edges[e + 1])
      expect(sampleMask(grid, ASPECT, (a.x + b.x) / 2, (a.y + b.y) / 2)).toBeGreaterThan(0.1)
    }
  })

  it('keeps the frame continuous when only a wrapping shoulder line is left', () => {
    // shoulders alone (no head or hips to orient them): the line wraps through +-pi/2.
    // ±2 px on a 12 px line is real ±10° noise, but it must not swing the frame
    // across the circle (the old filter swung ±0.8 rad, 1.6 rad per frame)
    const builder = new BodyMeshBuilder()
    const angles: number[] = []
    for (let f = 0; f < 20; f++) {
      const { mask, lm } = sideScene(f % 2 ? 2 : -2)
      for (const i of [0, 4, 5, 6, 8]) lm[i] = { ...lm[i], visibility: 0.1 }
      const mesh = builder.update(mask, W, H, lm, f * 100)
      expect(mesh).not.toBeNull()
      angles.push(mesh!.anchor.angle)
    }
    for (let f = 1; f < angles.length; f++) expect(Math.abs(wrapTurn(angles[f] - angles[f - 1]))).toBeLessThan(0.3)
  })
})

describe('oblique and overhead views', () => {
  it('a three-quarter view keeps an upright frame and every region', () => {
    const { mask, lm } = scene()
    lm[11] = { ...lm[11], x: 400 / W, y: 265 / H }
    lm[12] = { ...lm[12], x: 230 / W, y: 275 / H }
    lm[8] = { ...lm[8], x: 280 / W, visibility: 0.8 }
    const mesh = buildFrom({ mask, lm })
    expect(Math.abs(mesh.anchor.angle)).toBeLessThan(0.1)
    expect(mesh.anchor.scale * H).toBeGreaterThan(160)
    expect(mesh.anchor.scale * H).toBeLessThan(200)
    for (const key of ['head', 'neck', 'shoulders'] as const) expect(mesh.regions[key]).not.toBeNull()
  })

  it('a camera above, with the head foreshortened onto the shoulders, keeps the shoulder frame', () => {
    const { mask, lm } = scene()
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8]) lm[i] = { ...lm[i], y: lm[i].y + 95 / H }
    const a = bodyAnchor(lm, ASPECT)!
    expect(a.angle).toBeCloseTo(0, 5)
    expect(a.scale * H).toBeCloseTo(240, 3)
    const mesh = buildFrom({ mask, lm })
    for (const key of ['head', 'neck', 'shoulders'] as const) expect(mesh.regions[key]).not.toBeNull()
  })

  it('uses the hips for the torso axis when they are in view', () => {
    const { lm } = scene()
    lm[11] = { ...lm[11], x: 322 / W, y: 262 / H } // side-on shoulders, ~8 px apart
    lm[12] = { ...lm[12], x: 320 / W, y: 270 / H }
    lm[23] = { x: 330 / W, y: 470 / H, visibility: 0.9 }
    lm[24] = { x: 330 / W, y: 470 / H, visibility: 0.9 }
    const a = bodyAnchor(lm, ASPECT)!
    expect(a.angle).toBeCloseTo(Math.atan2(-(330 - 321), 470 - 266), 2)
    expect(a.scale * H).toBeCloseTo(0.75 * Math.hypot(9, 204), 0)
  })
})

describe('face identity', () => {
  const moved = (face: FaceInput, dx: number, dy: number): FaceInput => ({
    ...face,
    points: face.points.map((p) => ({ x: p.x + dx / W, y: p.y + dy / H }))
  })
  const faceEdges = (m: BodyMesh): number => m.edgeKind.filter((k) => k === EDGE_FACE).length

  it('accepts the face on the tracked person', () => {
    const { mask, lm } = scene()
    expect(faceOnPerson(syntheticFace(), downsampleMask(mask, W, H), ASPECT, lm, headAnchor(lm, ASPECT))).toBe(true)
    expect(faceEdges(build(0, 0, syntheticFace()))).toBeGreaterThan(0)
  })

  it('ignores a face on the background (a poster, a coworker behind)', () => {
    const mesh = build(0, 0, moved(syntheticFace(), -240, -60))
    expect(faceEdges(mesh)).toBe(0)
    expect(mesh.u.length).toBe(build().u.length) // and it punches no hole in the body mesh
  })

  it('ignores a face that overlaps the person but is not at their head', () => {
    const mesh = build(0, 0, moved(syntheticFace(), 0, 200))
    expect(faceEdges(mesh)).toBe(0)
    expect(mesh.u.length).toBe(build().u.length)
  })

  it('keeps a stranger out of the face smoothing', () => {
    const builder = new BodyMeshBuilder()
    const { mask, lm } = scene()
    const face = syntheticFace()
    expect(faceEdges(builder.update(mask, W, H, lm, 0, face)!)).toBeGreaterThan(0)
    expect(faceEdges(builder.update(mask, W, H, lm, 100, moved(face, -240, -60))!)).toBe(0)
    // back on the user: drawn where it is, not blended with the stranger
    const back = builder.update(mask, W, H, lm, 200, moved(face, 4, 0))!
    const k = back.u.length - (face.topology.size - face.topology.oval.length)
    expect((toImage(back, k).x / ASPECT) * W).toBeCloseTo(324, 3)
  })
})

describe('display helpers', () => {
  const at = (angle: number, scale = 0.5, x = 0.6, y = 0.5): Anchor => ({ x, y, angle, scale })

  it('eases small steps of the display frame', () => {
    const a = easeAnchor(at(0), at(0.2, 0.55, 0.62), 0.5)
    expect(a.angle).toBeCloseTo(0.1, 6)
    expect(a.scale).toBeCloseTo(0.525, 6)
    expect(a.x).toBeCloseTo(0.61, 6)
  })

  it('snaps on a turn or zoom jump instead of whirling the silhouette', () => {
    expect(easeAnchor(at(1.4), at(-1.4), 0.1)).toEqual(at(-1.4))
    expect(easeAnchor(at(0, 0.5), at(0, 0.75), 0.1)).toEqual(at(0, 0.75))
    expect(easeAnchor(at(0, 0.5), at(0, 0.3), 0.1)).toEqual(at(0, 0.3))
    expect(easeAnchor(at(0), at(0, 0.5, 0.95), 0.1)).toEqual(at(0, 0.5, 0.95))
    expect(easeAnchor(null, at(0.3), 0.1)).toEqual(at(0.3))
  })

  it('eases the angle the short way round', () => {
    const a = easeAnchor(at(3.1), at(-3.1), 0.5)
    expect(Math.abs(wrapTurn(a.angle - Math.PI))).toBeLessThan(0.05)
  })

  it('paints a shared region once, in the worst stage', () => {
    const regionOf = { sink: 'neck', headForward: 'head', lean: 'shoulders', tooClose: 'head' } as const
    const stages: (readonly ['sink' | 'headForward' | 'lean' | 'tooClose', number])[] = [
      ['sink', 0],
      ['headForward', 3],
      ['lean', 1],
      ['tooClose', 1]
    ]
    expect(new Map(worstPerRegion(stages, regionOf))).toEqual(
      new Map([
        ['head', 3],
        ['shoulders', 1]
      ])
    )
    const later: (readonly ['headForward' | 'tooClose', number])[] = [
      ['headForward', 1],
      ['tooClose', 2]
    ]
    expect(new Map(worstPerRegion(later, regionOf)).get('head')).toBe(2)
  })
})

describe('lattice spacing (overlay intensity)', () => {
  const buildAt = (spacing: number, face: FaceInput | null = null): BodyMesh => {
    const { mask, lm } = scene()
    const grid = downsampleMask(mask, W, H)
    const body = bodyAnchor(lm, ASPECT)!
    const head = headAnchor(lm, ASPECT)
    return buildBodyMesh(grid, lm, ASPECT, { body, head }, face, spacing)!
  }

  it('a wider spacing gives a sparser lattice that still fills the body', () => {
    const dense = buildAt(1)
    const sparse = buildAt(1.45)
    expect(sparse.u.length).toBeLessThan(dense.u.length * 0.75)
    expect(sparse.u.length).toBeGreaterThan(60)
    // still covers the torso and the head, not only the outline
    let head = 0
    let torso = 0
    for (let k = 0; k < sparse.u.length; k++) {
      const p = toImage(sparse, k)
      if (Math.hypot((p.x / ASPECT) * W - 320, p.y * H - 140) < 50) head++
      if (Math.hypot((p.x / ASPECT) * W - 320, p.y * H - 390) < 60) torso++
    }
    expect(head).toBeGreaterThan(3)
    expect(torso).toBeGreaterThan(3)
  })

  it('opens no holes: outline edges stay on the silhouette at the widest spacing', () => {
    const mesh = buildAt(2.5)
    const { mask } = scene()
    const grid = downsampleMask(mask, W, H)
    const nearBackground = (x: number, y: number): boolean =>
      Array.from({ length: 16 }, (_, i) => (i / 16) * Math.PI * 2).some(
        (t) => sampleMask(grid, ASPECT, x + (Math.cos(t) * 30) / H, y + (Math.sin(t) * 30) / H) < 0.5
      )
    for (let e = 0; e < mesh.edges.length; e += 2) {
      if (mesh.edgeKind[e / 2] !== EDGE_OUTLINE) continue
      const a = toImage(mesh, mesh.edges[e])
      const b = toImage(mesh, mesh.edges[e + 1])
      expect(nearBackground((a.x + b.x) / 2, (a.y + b.y) / 2)).toBe(true)
    }
  })

  it('leaves the face mesh topology alone', () => {
    const face = syntheticFace()
    const faceEdges = (m: BodyMesh): number => m.edgeKind.filter((k) => k === EDGE_FACE).length
    expect(faceEdges(buildAt(1.6, face))).toBe(faceEdges(buildAt(1, face)))
  })

  it('clamps nonsense spacings', () => {
    expect(buildAt(0.2).u.length).toBe(buildAt(1).u.length)
    expect(buildAt(Number.NaN).u.length).toBe(buildAt(1).u.length)
    expect(buildAt(40).u.length).toBe(buildAt(2.5).u.length)
  })

  it('the builder picks up the spacing the display asks for', () => {
    const before = meshSpacing()
    try {
      const { mask, lm } = scene()
      setMeshSpacing(1)
      const dense = new BodyMeshBuilder().update(mask, W, H, lm, 0)!
      setMeshSpacing(1.6)
      expect(meshSpacing()).toBe(1.6)
      const sparse = new BodyMeshBuilder().update(mask, W, H, lm, 0)!
      expect(sparse.u.length).toBeLessThan(dense.u.length)
      setMeshSpacing(Number.POSITIVE_INFINITY)
      expect(meshSpacing()).toBe(1)
    } finally {
      setMeshSpacing(before)
    }
  })
})
