// Dev-only harness: paints the body wireframe over a synthetic "camera image"
// of a seated person, at several intensities, so the overlay's look can be
// judged without a webcam (the fake camera shows no person). Not part of the
// app bundle; run it with run-mesh-preview.mjs next to this file.

import Delaunator from 'delaunator'
import type { Landmark } from '@renderer/posture/types'
import { bodyAnchor, buildBodyMesh, buildFaceTopology, downsampleMask, headAnchor, type BodyMesh, type FaceInput } from '../bodyMesh'
import { meshLook } from '../meshLook'
import { MeshPainter, type Hotspot, type RGB } from '../meshPaint'

const W = 1280
const H = 720
const ASPECT = W / H
const SAGE: RGB = [0x93, 0xc9, 0xa2]
const CYAN: RGB = [0x44, 0xd7, 0xf0]
const EMBER: RGB = [0xe0, 0x8a, 0x56]
const CORAL: RGB = [0xe0, 0x65, 0x5c]

const HEAD = { x: 640, y: 255, rx: 92, ry: 118 }
const FACE = { x: 640, y: 268, rx: 80, ry: 104 }
const EYES = [
  { x: 607, y: 250 },
  { x: 673, y: 250 }
]
const MOUTH = { x: 640, y: 322 }

function canvas(w = W, h = H): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

function ellipse(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, fill: string | CanvasGradient): void {
  g.fillStyle = fill
  g.beginPath()
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
  g.fill()
}

/** The person alone, on a transparent layer (its alpha is the segmentation mask). */
function drawPerson(): HTMLCanvasElement {
  const [c, g] = canvas()
  // torso + arms: a shirt
  const shirt = g.createLinearGradient(0, 400, 0, H)
  shirt.addColorStop(0, '#4d6e84')
  shirt.addColorStop(1, '#2f4656')
  g.fillStyle = shirt
  g.beginPath()
  g.moveTo(600, 400)
  g.bezierCurveTo(520, 405, 450, 420, 420, 470)
  g.lineTo(360, H)
  g.lineTo(920, H)
  g.lineTo(860, 470)
  g.bezierCurveTo(830, 420, 760, 405, 680, 400)
  g.closePath()
  g.fill()
  // folds
  g.strokeStyle = 'rgba(0,0,0,0.18)'
  g.lineWidth = 3
  for (const [x0, y0, x1, y1] of [
    [520, 520, 560, 700],
    [760, 520, 720, 700],
    [640, 560, 650, 710]
  ]) {
    g.beginPath()
    g.moveTo(x0, y0)
    g.quadraticCurveTo((x0 + x1) / 2 + 15, (y0 + y1) / 2, x1, y1)
    g.stroke()
  }
  // neck
  const neck = g.createLinearGradient(590, 0, 690, 0)
  neck.addColorStop(0, '#a8714f')
  neck.addColorStop(0.5, '#c88e68')
  neck.addColorStop(1, '#a8714f')
  g.fillStyle = neck
  g.fillRect(598, 330, 84, 90)
  // collar
  g.fillStyle = '#e8e4dc'
  g.beginPath()
  g.moveTo(590, 402)
  g.lineTo(640, 450)
  g.lineTo(690, 402)
  g.lineTo(676, 396)
  g.lineTo(640, 432)
  g.lineTo(604, 396)
  g.closePath()
  g.fill()
  // ears
  ellipse(g, 549, 262, 14, 26, '#c08560')
  ellipse(g, 731, 262, 14, 26, '#c08560')
  // head
  const skin = g.createRadialGradient(625, 235, 10, 640, 260, 125)
  skin.addColorStop(0, '#e6b38f')
  skin.addColorStop(0.7, '#cf9670')
  skin.addColorStop(1, '#a8714f')
  ellipse(g, HEAD.x, HEAD.y, HEAD.rx, HEAD.ry, skin)
  // hair
  g.fillStyle = '#3a2a20'
  g.beginPath()
  g.ellipse(HEAD.x, HEAD.y - 30, HEAD.rx + 6, HEAD.ry - 18, 0, Math.PI, Math.PI * 2)
  g.bezierCurveTo(HEAD.x + 60, 190, HEAD.x - 40, 175, HEAD.x - HEAD.rx - 6, HEAD.y - 30)
  g.fill()
  // brows, eyes
  g.strokeStyle = '#3a2a20'
  g.lineWidth = 5
  g.lineCap = 'round'
  for (const e of EYES) {
    g.beginPath()
    g.moveTo(e.x - 20, e.y - 20)
    g.quadraticCurveTo(e.x, e.y - 28, e.x + 20, e.y - 20)
    g.stroke()
    ellipse(g, e.x, e.y, 17, 8, '#f3eee8')
    ellipse(g, e.x, e.y, 7, 7, '#4a3324')
    ellipse(g, e.x, e.y, 3, 3, '#111')
  }
  // nose
  g.strokeStyle = 'rgba(110,60,35,0.55)'
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(640, 262)
  g.quadraticCurveTo(632, 290, 628, 296)
  g.quadraticCurveTo(640, 302, 652, 296)
  g.stroke()
  // mouth
  g.fillStyle = '#a4524a'
  g.beginPath()
  g.moveTo(MOUTH.x - 26, MOUTH.y)
  g.quadraticCurveTo(MOUTH.x, MOUTH.y - 8, MOUTH.x + 26, MOUTH.y)
  g.quadraticCurveTo(MOUTH.x, MOUTH.y + 12, MOUTH.x - 26, MOUTH.y)
  g.fill()
  return c
}

/** A room behind the person, with some texture so faint lines are judged against detail. */
function drawRoom(g: CanvasRenderingContext2D): void {
  const wall = g.createLinearGradient(0, 0, W, H)
  wall.addColorStop(0, '#8a7f72')
  wall.addColorStop(1, '#4a423a')
  g.fillStyle = wall
  g.fillRect(0, 0, W, H)
  // window light
  const light = g.createRadialGradient(1080, 140, 20, 1080, 140, 380)
  light.addColorStop(0, 'rgba(255,240,215,0.55)')
  light.addColorStop(1, 'rgba(255,240,215,0)')
  g.fillStyle = light
  g.fillRect(0, 0, W, H)
  // shelf with books
  g.fillStyle = '#3b3029'
  g.fillRect(40, 300, 300, 12)
  const books = ['#7a4b3a', '#4f6a5a', '#b39459', '#5a5f7a', '#8a3f3f', '#6d7c4f']
  for (let i = 0; i < 12; i++) {
    g.fillStyle = books[i % books.length]
    const bw = 16 + ((i * 7) % 9)
    g.fillRect(52 + i * 23, 300 - (70 + ((i * 13) % 30)), bw, 70 + ((i * 13) % 30))
  }
  // chair back
  g.fillStyle = '#26221f'
  g.beginPath()
  g.roundRect(390, 360, 500, 400, 60)
  g.fill()
}

function grain(g: CanvasRenderingContext2D): void {
  const img = g.getImageData(0, 0, W, H)
  let s = 12345
  for (let k = 0; k < img.data.length; k += 4) {
    s = (Math.imul(s, 1103515245) + 12345) | 0
    const n = ((s >>> 16) & 31) - 16
    img.data[k] += n
    img.data[k + 1] += n
    img.data[k + 2] += n
  }
  g.putImageData(img, 0, 0)
}

function landmarks(): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }))
  const set = (i: number, x: number, y: number): void => {
    lm[i] = { x: x / W, y: y / H, visibility: 0.99 }
  }
  set(0, 640, 288) // nose
  set(1, 660, 250)
  set(2, EYES[1].x, EYES[1].y)
  set(3, 690, 250)
  set(4, 620, 250)
  set(5, EYES[0].x, EYES[0].y)
  set(6, 590, 250)
  set(7, 731, 262) // left ear (image right)
  set(8, 549, 262)
  set(9, 662, 322)
  set(10, 618, 322)
  set(11, 820, 445) // left shoulder
  set(12, 460, 445)
  set(13, 880, 690) // elbows, just in frame
  set(14, 400, 690)
  return lm
}

/** A stand-in for FaceLandmarker: ~380 points over the face with eye and lip contours, Delaunay-tessellated. */
function syntheticFace(): FaceInput {
  const pts: { x: number; y: number }[] = []
  const RINGS = 9
  const SPOKES = 36
  const nearFeature = (x: number, y: number): boolean =>
    EYES.some((e) => ((x - e.x) / 26) ** 2 + ((y - e.y) / 14) ** 2 < 1) || ((x - MOUTH.x) / 36) ** 2 + ((y - MOUTH.y) / 16) ** 2 < 1
  // outermost ring first: it is the oval
  for (let r = RINGS; r >= 1; r--) {
    for (let k = 0; k < SPOKES; k++) {
      const t = ((k + (r % 2) * 0.5) / SPOKES) * Math.PI * 2
      const x = FACE.x + Math.cos(t) * FACE.rx * (r / RINGS)
      const y = FACE.y + Math.sin(t) * FACE.ry * (r / RINGS)
      if (r < RINGS && nearFeature(x, y)) continue
      pts.push({ x, y })
    }
  }
  pts.push({ x: FACE.x, y: FACE.y })
  const contour = (cx: number, cy: number, rx: number, ry: number, n: number): number[] => {
    const ids: number[] = []
    for (let k = 0; k < n; k++) {
      const t = (k / n) * Math.PI * 2
      ids.push(pts.length)
      pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry })
    }
    return ids
  }
  const eyeL = contour(EYES[0].x, EYES[0].y, 18, 8, 16)
  const eyeR = contour(EYES[1].x, EYES[1].y, 18, 8, 16)
  const lips = contour(MOUTH.x, MOUTH.y + 2, 27, 9, 20)
  const coords = new Float64Array(pts.length * 2)
  pts.forEach((p, i) => {
    coords[2 * i] = p.x
    coords[2 * i + 1] = p.y
  })
  const T = new Delaunator(coords).triangles
  const tess: { start: number; end: number }[] = []
  for (let t = 0; t < T.length; t += 3) {
    // drop the triangles Delaunay adds across the oval's outside (all three on the rim, spanning a chord)
    const [a, b, c] = [T[t], T[t + 1], T[t + 2]]
    const cx = (pts[a].x + pts[b].x + pts[c].x) / 3
    const cy = (pts[a].y + pts[b].y + pts[c].y) / 3
    if (((cx - FACE.x) / FACE.rx) ** 2 + ((cy - FACE.y) / FACE.ry) ** 2 > 1) continue
    tess.push({ start: a, end: b }, { start: b, end: c }, { start: c, end: a })
  }
  const loop = (ids: number[]): { start: number; end: number }[] => ids.map((id, k) => ({ start: id, end: ids[(k + 1) % ids.length] }))
  const oval = Array.from({ length: SPOKES }, (_, k) => k)
  const points: Landmark[] = pts.map((p) => ({ x: p.x / W, y: p.y / H }))
  return { points, topology: buildFaceTopology(tess, loop(oval), [loop(eyeL), loop(eyeR), loop(lips)]) }
}

function maskOf(person: HTMLCanvasElement): { data: Float32Array; w: number; h: number } {
  const mw = 640
  const mh = 360
  const [c, g] = canvas(mw, mh)
  g.drawImage(person, 0, 0, mw, mh)
  const img = g.getImageData(0, 0, mw, mh).data
  const data = new Float32Array(mw * mh)
  for (let k = 0; k < data.length; k++) data[k] = img[4 * k + 3] / 255
  c.width = 0
  return { data, w: mw, h: mh }
}

function meshAt(spacing: number, mask: { data: Float32Array; w: number; h: number }, lm: Landmark[], face: FaceInput): BodyMesh {
  const grid = downsampleMask(mask.data, mask.w, mask.h)
  const body = bodyAnchor(lm, ASPECT)!
  const head = headAnchor(lm, ASPECT, body)
  const mesh = buildBodyMesh(grid, lm, ASPECT, { body, head }, face, spacing)
  if (!mesh) throw new Error('no mesh')
  return mesh
}

export interface Shot {
  name: string
  dataUrl: string
}

/** Renders every preview; each is camera image + overlay, like CameraFeed composites them. */
function render(): Shot[] {
  const person = drawPerson()
  const [cam, cg] = canvas()
  drawRoom(cg)
  cg.drawImage(person, 0, 0)
  grain(cg)
  const mask = maskOf(person)
  const lm = landmarks()
  const face = syntheticFace()

  const shots: Shot[] = [{ name: 'camera-only', dataUrl: cam.toDataURL('image/png') }]
  const painter = new MeshPainter()
  // painted like a ~960 CSS px preview on a 150 % display
  const DPR = 1.5
  const OW = 960 * DPR
  const OH = 540 * DPR
  const [overlay, og] = canvas(OW, OH)
  const [out, outG] = canvas(OW, OH)
  const [crop, cropG] = canvas(560 * DPR, 400 * DPR)

  const variants: { name: string; intensity: number; hologram?: boolean; color?: RGB; hot?: boolean; sweepT?: number }[] = [
    { name: 'mesh-low-0.15', intensity: 0.15 },
    { name: 'mesh-default-0.40', intensity: 0.4 },
    { name: 'mesh-mid-0.70', intensity: 0.7 },
    { name: 'mesh-high-1.00', intensity: 1 },
    { name: 'mesh-default-sweep', intensity: 0.4, sweepT: 0.5 },
    { name: 'mesh-default-cyan-hotspot', intensity: 0.4, color: CYAN, hot: true },
    { name: 'hologram-default-0.40', intensity: 0.4, hologram: true },
    { name: 'hologram-high-1.00', intensity: 1, hologram: true }
  ]
  for (const v of variants) {
    const look = meshLook(v.intensity, v.hologram)
    const mesh = meshAt(look.spacing, mask, lm, face)
    const hotspots: Hotspot[] = []
    if (v.hot && mesh.regions.shoulders) hotspots.push({ region: mesh.regions.shoulders, color: CORAL, stage: 3 })
    if (v.hot && mesh.regions.head) hotspots.push({ region: mesh.regions.head, color: EMBER, stage: 2 })
    painter.paint(og, {
      mesh,
      meshSeq: shots.length,
      anchor: mesh.anchor,
      w: OW,
      h: OH,
      dpr: DPR,
      color: v.color ?? SAGE,
      fade: 1,
      look,
      hotspots,
      // sweep phase: tS = t * period; 'motion' off unless a sweep shot is wanted
      tS: v.sweepT !== undefined ? v.sweepT * 4.5 * 0.42 : 0,
      motion: v.sweepT !== undefined || hotspots.length > 0
    })
    outG.globalCompositeOperation = 'source-over'
    outG.filter = v.hologram ? 'brightness(0.32) contrast(1.25) saturate(0.35)' : 'none'
    outG.drawImage(cam, 0, 0, OW, OH)
    outG.filter = 'none'
    if (v.hologram) {
      // CameraFeed's tint + vignette (scanlines omitted)
      outG.globalCompositeOperation = 'screen'
      outG.fillStyle = 'rgba(147,201,162,0.1)'
      outG.fillRect(0, 0, OW, OH)
      outG.globalCompositeOperation = 'source-over'
      const vig = outG.createRadialGradient(OW / 2, OH / 2, OW * 0.2, OW / 2, OH / 2, OW * 0.6)
      vig.addColorStop(0, 'rgba(0,0,0,0)')
      vig.addColorStop(1, 'rgba(0,0,0,0.55)')
      outG.fillStyle = vig
      outG.fillRect(0, 0, OW, OH)
    }
    outG.drawImage(overlay, 0, 0)
    const edges = mesh.edges.length / 2
    shots.push({ name: `${v.name}`, dataUrl: out.toDataURL('image/png') })
    // head and shoulders at 1:1 device pixels, to judge line weight without downscaling
    cropG.drawImage(out, (OW - crop.width) / 2, 110 * (OW / W), crop.width, crop.height, 0, 0, crop.width, crop.height)
    shots.push({ name: `${v.name}-crop`, dataUrl: crop.toDataURL('image/png') })
    // the face, magnified 2x (nearest neighbour)
    const k = OW / W
    const [zoom, zg] = canvas(600, 640)
    zg.imageSmoothingEnabled = false
    zg.drawImage(out, HEAD.x * k - 150, (HEAD.y - 30) * k - 160, 300, 320, 0, 0, 600, 640)
    shots.push({ name: `${v.name}-face`, dataUrl: zoom.toDataURL('image/png') })
    console.log(`${v.name}: ${mesh.u.length} vertices, ${edges} edges, spacing ${look.spacing.toFixed(2)}`)
  }
  painter.dispose()
  return shots
}

;(window as unknown as { renderMeshPreviews: () => Shot[] }).renderMeshPreviews = render
