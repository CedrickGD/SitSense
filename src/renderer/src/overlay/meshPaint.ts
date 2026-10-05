// Canvas painter for the body wireframe, shared by the live overlay
// (MeshOverlay) and the dev preview harness. It knows nothing about the store
// or the theme: colors come in resolved, line weights come from a MeshLook.

import { EDGE_FACE, EDGE_INNER, EDGE_OUTLINE, type Anchor, type BodyMesh, type Region } from './bodyMesh'
import type { MeshLook } from './meshLook'

export type RGB = [number, number, number]

export const rgba = (c: RGB, a: number): string => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`

const SWEEP_PERIOD_S = 4.5
const SWEEP_ACTIVE = 0.42
const HOTSPOT_PULSE_S = 1.6

/** The projected mesh: vertices in canvas px and its paths, rebuilt only when the geometry changes. */
export interface Projected {
  key: string
  /** isotropic image units → canvas px: x = ox + cu·u − su·v, y = oy + su·u + cu·v */
  ox: number
  oy: number
  cu: number
  su: number
  /** canvas px per body unit */
  unit: number
  top: number
  bottom: number
  left: number
  right: number
  inner: Path2D
  outline: Path2D
  /** eye and lip contours of the face mesh */
  features: Path2D
  face: Path2D
  nodes: Path2D | null
}

/** A problem area to light up: where, in which color, how bad (stage 1–3). */
export interface Hotspot {
  region: Region
  color: RGB
  stage: number
}

export interface PaintFrame {
  mesh: BodyMesh
  /** id that changes whenever `mesh` is a different object (keys the projection cache) */
  meshSeq: number
  /** display body frame (eased toward mesh.anchor) */
  anchor: Anchor
  /** canvas size in device px, and device px per CSS px */
  w: number
  h: number
  dpr: number
  color: RGB
  /** 0–1 presence fade */
  fade: number
  look: MeshLook
  hotspots: readonly Hotspot[]
  /** seconds, drives the sweep and the hotspot pulse */
  tS: number
  motion: boolean
}

function sized(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  return c.getContext('2d')!
}

/** A canvas rectangle in whole pixels, clipped to w × h; null when empty. */
function pixelRect(x0: number, y0: number, x1: number, y1: number, w: number, h: number): [number, number, number, number] | null {
  const l = Math.max(0, Math.floor(x0))
  const t = Math.max(0, Math.floor(y0))
  const r = Math.min(w, Math.ceil(x1))
  const b = Math.min(h, Math.ceil(y1))
  return r > l && b > t ? [l, t, r - l, b - t] : null
}

export class MeshPainter {
  private lines: HTMLCanvasElement
  private fx: HTMLCanvasElement
  private px = new Float32Array(0)
  private py = new Float32Array(0)
  private proj: Projected | null = null

  constructor(makeCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')) {
    this.lines = makeCanvas()
    this.fx = makeCanvas()
  }

  /** Releases the scratch buffers' backing stores. */
  dispose(): void {
    this.lines.width = this.fx.width = 0
    this.proj = null
  }

  /** Whether this frame animates on its own (sweep or pulsing hotspots), so it must repaint every tick. */
  static animating(f: Pick<PaintFrame, 'tS' | 'motion' | 'hotspots' | 'look'>): boolean {
    if (!f.motion) return false
    const phase = (f.tS % SWEEP_PERIOD_S) / SWEEP_PERIOD_S
    return (phase < SWEEP_ACTIVE && f.look.sweep > 0.01) || f.hotspots.length > 0
  }

  project(m: BodyMesh, meshSeq: number, at: Anchor, w: number, h: number, dpr: number, look: MeshLook): Projected {
    const nodeR = look.nodeAlpha > 0.005 ? look.nodeRadius : 0
    const key = `${meshSeq}|${at.x.toFixed(5)}|${at.y.toFixed(5)}|${at.angle.toFixed(5)}|${at.scale.toFixed(5)}|${w}|${h}|${dpr.toFixed(3)}|${nodeR.toFixed(3)}|${look.faceNodes ? 1 : 0}`
    if (this.proj && this.proj.key === key) return this.proj
    // isotropic image units → canvas px, cropped like object-cover
    const dh = Math.max(h, w / m.aspect)
    const unit = at.scale * dh
    const cu = Math.cos(at.angle) * unit
    const su = Math.sin(at.angle) * unit
    const ox = (w - dh * m.aspect) / 2 + at.x * dh
    const oy = (h - dh) / 2 + at.y * dh
    const n = m.u.length
    if (this.px.length < n) {
      this.px = new Float32Array(n)
      this.py = new Float32Array(n)
    }
    const { px, py } = this
    let top = Infinity
    let bottom = -Infinity
    let left = Infinity
    let right = -Infinity
    for (let k = 0; k < n; k++) {
      const u = m.u[k]
      const v = m.v[k]
      const x = ox + cu * u - su * v
      const y = oy + su * u + cu * v
      px[k] = x
      py[k] = y
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < left) left = x
      if (x > right) right = x
    }
    const inner = new Path2D()
    const outline = new Path2D()
    const features = new Path2D()
    const face = new Path2D()
    for (let e = 0; e < m.edges.length; e += 2) {
      const kind = m.edgeKind[e / 2]
      const a = m.edges[e]
      const b = m.edges[e + 1]
      // seams are skipped: there the body just leaves the frame
      const path =
        kind === EDGE_INNER
          ? inner
          : kind === EDGE_OUTLINE
            ? m.faceVertex[a] && m.faceVertex[b]
              ? features
              : outline
            : kind === EDGE_FACE
              ? face
              : null
      if (!path) continue
      path.moveTo(px[a], py[a])
      path.lineTo(px[b], py[b])
    }
    let nodes: Path2D | null = null
    if (nodeR > 0) {
      nodes = new Path2D()
      for (let k = 0; k < n; k++) {
        if (m.faceVertex[k] && !look.faceNodes) continue
        const r = (m.faceVertex[k] ? 0.6 : nodeR) * dpr
        nodes.moveTo(px[k] + r, py[k])
        nodes.arc(px[k], py[k], r, 0, Math.PI * 2)
      }
    }
    this.proj = { key, ox, oy, cu, su, unit, top, bottom, left, right, inner, outline, features, face, nodes }
    return this.proj
  }

  /** Paints one frame onto `ctx` (cleared first). Returns the projection it used. */
  paint(ctx: CanvasRenderingContext2D, f: PaintFrame): Projected {
    const { w, h, dpr, look, color, fade, tS, motion } = f
    const p = this.project(f.mesh, f.meshSeq, f.anchor, w, h, dpr, look)

    // ---- the wireframe, drawn once into a scratch layer the effects reuse ----
    const lines = sized(this.lines, w, h)
    lines.clearRect(0, 0, w, h)
    lines.lineJoin = 'round'
    lines.lineCap = 'round'
    lines.lineWidth = look.faceWidth * dpr
    lines.strokeStyle = rgba(color, look.faceAlpha)
    lines.stroke(p.face)
    lines.lineWidth = look.innerWidth * dpr
    lines.strokeStyle = rgba(color, look.innerAlpha)
    lines.stroke(p.inner)
    lines.lineWidth = look.featureWidth * dpr
    lines.strokeStyle = rgba(color, look.featureAlpha)
    lines.stroke(p.features)
    lines.lineWidth = look.outlineWidth * dpr
    lines.strokeStyle = rgba(color, look.outlineAlpha)
    lines.stroke(p.outline)
    if (p.nodes) {
      lines.fillStyle = rgba(color, look.nodeAlpha)
      lines.fill(p.nodes)
    }

    ctx.clearRect(0, 0, w, h)
    ctx.globalAlpha = fade
    if (look.bedAlpha > 0.005) {
      // a soft dark bed under the lines keeps them legible on bright skin and walls
      ctx.strokeStyle = `rgba(0, 0, 0, ${look.bedAlpha})`
      ctx.lineWidth = (look.innerWidth + 1.45) * dpr
      ctx.stroke(p.inner)
      ctx.lineWidth = (look.outlineWidth + 1.6) * dpr
      ctx.stroke(p.outline)
    }
    if (look.glowAlpha > 0.01) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = fade * look.glowAlpha
      ctx.filter = `blur(${(look.glowBlur * dpr).toFixed(1)}px)`
      ctx.drawImage(this.lines, 0, 0)
      ctx.filter = 'none'
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = fade
    }
    ctx.drawImage(this.lines, 0, 0)

    const fx = sized(this.fx, w, h)

    // ---- hotspots: the wireframe restroked in the stage color, masked to each region ----
    // (restroked rather than recolored: at low intensity the base lines are too faint to carry the warning)
    if (f.hotspots.length) {
      const pulse = motion ? 0.8 + 0.2 * Math.sin((tS * Math.PI * 2) / HOTSPOT_PULSE_S) : 1
      for (const { region, color: hot, stage } of f.hotspots) {
        const cx = p.ox + p.cu * region.u - p.su * region.v
        const cy = p.oy + p.su * region.u + p.cu * region.v
        const r = region.r * p.unit * 1.25
        const rect = pixelRect(cx - r, cy - r, cx + r, cy + r, w, h)
        if (!rect) continue
        const [rx, ry, rw, rh] = rect
        fx.save()
        fx.beginPath()
        fx.rect(rx, ry, rw, rh)
        fx.clip() // keeps the strokes and the unbounded composite mode below off the rest of the canvas
        fx.globalCompositeOperation = 'source-over'
        fx.clearRect(rx, ry, rw, rh)
        fx.lineJoin = 'round'
        fx.lineCap = 'round'
        fx.lineWidth = look.faceWidth * dpr
        fx.strokeStyle = rgba(hot, 0.45)
        fx.stroke(p.face)
        fx.lineWidth = (look.innerWidth + 0.15) * dpr
        fx.strokeStyle = rgba(hot, 1)
        fx.stroke(p.inner)
        fx.stroke(p.features)
        fx.lineWidth = look.outlineWidth * dpr
        fx.stroke(p.outline)
        fx.globalCompositeOperation = 'destination-in'
        const g = fx.createRadialGradient(cx, cy, 0, cx, cy, r)
        g.addColorStop(0, 'rgba(0,0,0,1)')
        g.addColorStop(0.55, 'rgba(0,0,0,0.8)')
        g.addColorStop(1, 'rgba(0,0,0,0)')
        fx.fillStyle = g
        fx.fillRect(rx, ry, rw, rh)
        fx.restore()
        ctx.globalAlpha = Math.min(1, (0.45 + 0.55 * (stage / 3)) * pulse * fade * look.hotspot)
        ctx.drawImage(this.fx, rx, ry, rw, rh, rx, ry, rw, rh)
        ctx.globalAlpha = pulse * fade
        const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
        halo.addColorStop(0, rgba(hot, 0.12 * look.hotspot))
        halo.addColorStop(1, rgba(hot, 0))
        ctx.fillStyle = halo
        ctx.fillRect(rx, ry, rw, rh)
      }
    }

    // ---- scanner sweep: a band that runs down the body every few seconds ----
    const phase = (tS % SWEEP_PERIOD_S) / SWEEP_PERIOD_S
    if (motion && phase < SWEEP_ACTIVE && look.sweep > 0.01 && p.bottom > p.top) {
      const band = Math.max(18 * dpr, (p.bottom - p.top) * 0.1)
      const t = phase / SWEEP_ACTIVE
      const y = p.top - band + t * (p.bottom - p.top + 2 * band)
      const strip = pixelRect(0, y - band, w, y + band, w, h)
      if (strip) {
        const [sx, sy, sw, sh] = strip
        fx.save()
        fx.beginPath()
        fx.rect(sx, sy, sw, sh)
        fx.clip()
        fx.globalCompositeOperation = 'source-over'
        fx.clearRect(sx, sy, sw, sh)
        fx.drawImage(this.lines, sx, sy, sw, sh, sx, sy, sw, sh)
        fx.globalCompositeOperation = 'destination-in'
        const g = fx.createLinearGradient(0, y - band, 0, y + band)
        g.addColorStop(0, 'rgba(0,0,0,0)')
        g.addColorStop(0.5, 'rgba(0,0,0,1)')
        g.addColorStop(1, 'rgba(0,0,0,0)')
        fx.fillStyle = g
        fx.fillRect(sx, sy, sw, sh)
        fx.restore()
        const edgeFade = Math.min(1, t * 6, (1 - t) * 6)
        ctx.globalCompositeOperation = 'lighter'
        // up to two extra passes of the band's lines, scaled by the look
        const passes = look.sweep * 2
        for (let k = 0; k < Math.ceil(passes); k++) {
          ctx.globalAlpha = fade * edgeFade * Math.min(1, passes - k)
          ctx.drawImage(this.fx, sx, sy, sw, sh, sx, sy, sw, sh)
        }
        ctx.globalAlpha = fade * edgeFade
        const scan = ctx.createLinearGradient(p.left, 0, p.right, 0)
        scan.addColorStop(0, rgba(color, 0))
        scan.addColorStop(0.5, rgba(color, 0.35 * look.sweep))
        scan.addColorStop(1, rgba(color, 0))
        ctx.fillStyle = scan
        ctx.fillRect(p.left, y - 0.5 * dpr, p.right - p.left, 1 * dpr)
        ctx.globalCompositeOperation = 'source-over'
      }
    }

    // ---- tracked joints ----
    if (look.jointAlpha > 0.01) {
      ctx.globalAlpha = fade
      ctx.lineWidth = 1.2 * dpr
      const ring = rgba(color, 0.6 * look.jointAlpha)
      const dot = rgba(color, look.jointAlpha)
      for (const j of f.mesh.joints) {
        const x = p.ox + p.cu * j.u - p.su * j.v
        const y = p.oy + p.su * j.u + p.cu * j.v
        ctx.strokeStyle = ring
        ctx.beginPath()
        ctx.arc(x, y, look.jointRadius * dpr, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = dot
        ctx.beginPath()
        ctx.arc(x, y, 0.4 * look.jointRadius * dpr, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
    return p
  }
}
