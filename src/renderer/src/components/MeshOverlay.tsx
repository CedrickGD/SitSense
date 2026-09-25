import { useEffect, useRef, type JSX } from 'react'
import { ISSUES, type IssueId, type Stage } from '@shared/posture'
import { OVERLAY_PRESETS, type OverlaySettings } from '@shared/settings'
import { STAGE_COLOR } from '@renderer/lib/ui'
import { EDGE_FACE, EDGE_INNER, EDGE_OUTLINE, type Anchor, type BodyMesh, type Region } from '@renderer/overlay/bodyMesh'
import { useAppStore } from '@renderer/state/store'

type RGB = [number, number, number]

const FRAME_MS = 1000 / 30
/** anchor easing between detection frames (the model runs at 5–15 fps) */
const TAU_ANCHOR_S = 0.07
const TAU_COLOR_S = 0.3
const TAU_FADE_S = 0.18
const SWEEP_PERIOD_S = 4.5
const SWEEP_ACTIVE = 0.42
const HOTSPOT_PULSE_S = 1.6

/** Which part of the mesh lights up for each issue when the color is fixed. */
const ISSUE_REGION: Record<IssueId, keyof BodyMesh['regions']> = {
  sink: 'neck',
  headForward: 'head',
  lean: 'shoulders',
  tooClose: 'head'
}

const cssColorCache = new Map<string, RGB>()

function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255]
}

/** 'var(--color-sage)' → its hex value from the theme */
function themeColor(cssVar: string): RGB {
  const cached = cssColorCache.get(cssVar)
  if (cached) return cached
  const name = cssVar.replace(/^var\((.*)\)$/, '$1')
  const rgb = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue(name))
  cssColorCache.set(cssVar, rgb)
  return rgb
}

export function stageRgb(stage: Stage): RGB {
  return themeColor(STAGE_COLOR[stage])
}

/** The overlay's base hue for the current settings and posture. */
export function overlayRgb(overlay: OverlaySettings, stage: Stage): RGB {
  if (overlay.color === 'posture') return stageRgb(stage)
  if (overlay.color === 'custom') return hexToRgb(overlay.customColor)
  return hexToRgb(OVERLAY_PRESETS[overlay.color])
}

const rgba = (c: RGB, a: number): string => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`

function ease(current: number, target: number, dtS: number, tau: number): number {
  return current + (target - current) * (1 - Math.exp(-dtS / tau))
}

interface Scratch {
  lines: HTMLCanvasElement
  fx: HTMLCanvasElement
}

function sized(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  return c.getContext('2d')!
}

/**
 * Canvas renderer for the body wireframe. Runs its own ~30 fps loop, reading
 * the store directly so React never re-renders per frame, and eases the
 * mesh's body frame between detection results so motion stays fluid even at
 * the 5 fps power-saving preset.
 */
export default function MeshOverlay(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const windowVisible = useAppStore((s) => s.windowVisible)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !windowVisible) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const scratch: Scratch = { lines: document.createElement('canvas'), fx: document.createElement('canvas') }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

    let raf = 0
    let last = 0
    let mesh: BodyMesh | null = null
    let anchor: Anchor | null = null
    let fade = 0
    let color: RGB | null = null
    let drewEmpty = false
    let px = new Float32Array(0)
    let py = new Float32Array(0)

    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)
      if (now - last < FRAME_MS - 4) return // tolerance: vsync jitter must not halve the rate
      const dtS = last ? Math.min(0.25, (now - last) / 1000) : 0
      last = now
      const tS = now / 1000

      const state = useAppStore.getState()
      const latest = state.mesh
      const settings = state.settings?.overlay
      const snapshot = state.snapshot
      if (!settings) return

      // keep the last mesh around so the wireframe can fade out instead of blinking off
      if (latest && latest !== mesh) {
        if (!mesh || fade < 0.05) anchor = { ...latest.anchor }
        mesh = latest
      }
      fade = ease(fade, latest ? 1 : 0, dtS, TAU_FADE_S)

      const w = Math.max(1, Math.round(canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1)))
      const h = Math.max(1, Math.round(canvas.clientHeight * Math.min(2, window.devicePixelRatio || 1)))
      sized(canvas, w, h)
      if (!mesh || !anchor || fade < 0.01) {
        if (!drewEmpty) ctx.clearRect(0, 0, w, h)
        drewEmpty = true
        return
      }
      drewEmpty = false
      const dpr = w / Math.max(1, canvas.clientWidth)

      // ---- ease the body frame toward the latest detection ----
      const target = mesh.anchor
      if (Math.hypot(target.x - anchor.x, target.y - anchor.y) > 0.5 * target.scale) anchor = { ...target }
      anchor.x = ease(anchor.x, target.x, dtS, TAU_ANCHOR_S)
      anchor.y = ease(anchor.y, target.y, dtS, TAU_ANCHOR_S)
      anchor.angle = ease(anchor.angle, target.angle, dtS, TAU_ANCHOR_S)
      anchor.scale = ease(anchor.scale, target.scale, dtS, TAU_ANCHOR_S)

      const stage: Stage = snapshot && snapshot.presence === 'active' ? snapshot.worstStage : 0
      const want = overlayRgb(settings, stage)
      color = color ?? [...want]
      for (let k = 0; k < 3; k++) color[k] = ease(color[k], want[k], dtS, TAU_COLOR_S)

      // ---- project: isotropic image units → canvas px, cropped like object-cover ----
      const dh = Math.max(h, w / mesh.aspect)
      const offX = (w - dh * mesh.aspect) / 2
      const offY = (h - dh) / 2
      const cos = Math.cos(anchor.angle)
      const sin = Math.sin(anchor.angle)
      const project = (u: number, v: number): [number, number] => [
        offX + (anchor!.x + (cos * u - sin * v) * anchor!.scale) * dh,
        offY + (anchor!.y + (sin * u + cos * v) * anchor!.scale) * dh
      ]
      const n = mesh.u.length
      if (px.length < n) {
        px = new Float32Array(n)
        py = new Float32Array(n)
      }
      let top = Infinity
      let bottom = -Infinity
      let left = Infinity
      let right = -Infinity
      // inlined projection: this runs for every vertex at 30 fps
      const ax = offX + anchor.x * dh
      const ay = offY + anchor.y * dh
      const k1 = cos * anchor.scale * dh
      const k2 = sin * anchor.scale * dh
      for (let k = 0; k < n; k++) {
        const u = mesh.u[k]
        const v = mesh.v[k]
        const x = ax + k1 * u - k2 * v
        const y = ay + k2 * u + k1 * v
        px[k] = x
        py[k] = y
        if (y < top) top = y
        if (y > bottom) bottom = y
        if (x < left) left = x
        if (x > right) right = x
      }

      const inner = new Path2D()
      const outline = new Path2D()
      const face = new Path2D()
      for (let e = 0; e < mesh.edges.length; e += 2) {
        const kind = mesh.edgeKind[e / 2]
        // seams are skipped: there the body just leaves the frame
        const path = kind === EDGE_INNER ? inner : kind === EDGE_OUTLINE ? outline : kind === EDGE_FACE ? face : null
        if (!path) continue
        const a = mesh.edges[e]
        const b = mesh.edges[e + 1]
        path.moveTo(px[a], py[a])
        path.lineTo(px[b], py[b])
      }
      const nodes = new Path2D()
      for (let k = 0; k < n; k++) {
        const r = (mesh.faceVertex[k] ? 0.6 : 1.05) * dpr
        nodes.moveTo(px[k] + r, py[k])
        nodes.arc(px[k], py[k], r, 0, Math.PI * 2)
      }

      const strokeMesh = (g: CanvasRenderingContext2D, c: RGB, alpha: number): void => {
        g.lineWidth = 0.6 * dpr
        g.strokeStyle = rgba(c, 0.42 * alpha)
        g.stroke(face)
        g.lineWidth = 0.75 * dpr
        g.strokeStyle = rgba(c, 0.6 * alpha)
        g.stroke(inner)
        g.lineWidth = 1.4 * dpr
        g.strokeStyle = rgba(c, alpha)
        g.stroke(outline)
        g.fillStyle = rgba(c, 0.9 * alpha)
        g.fill(nodes)
      }

      // ---- base wireframe + glow ----
      const lines = sized(scratch.lines, w, h)
      lines.clearRect(0, 0, w, h)
      strokeMesh(lines, color, 1)

      ctx.clearRect(0, 0, w, h)
      ctx.globalAlpha = fade
      // a soft dark bed under the lines keeps them legible on bright skin and walls
      ctx.lineWidth = 2.2 * dpr
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)'
      ctx.stroke(inner)
      ctx.lineWidth = 3 * dpr
      ctx.stroke(outline)
      ctx.globalCompositeOperation = 'lighter'
      ctx.filter = `blur(${(3.5 * dpr).toFixed(1)}px)`
      ctx.drawImage(scratch.lines, 0, 0)
      ctx.filter = 'none'
      ctx.globalCompositeOperation = 'source-over'
      ctx.drawImage(scratch.lines, 0, 0)

      const motion = !reducedMotion.matches
      const fx = sized(scratch.fx, w, h)

      // ---- problem areas glow in their stage color when the base hue is fixed ----
      if (settings.color !== 'posture' && snapshot?.presence === 'active') {
        const pulse = motion ? 0.8 + 0.2 * Math.sin((tS * Math.PI * 2) / HOTSPOT_PULSE_S) : 1
        for (const issue of ISSUES) {
          const st = snapshot.issues[issue].stage
          const region: Region | null = mesh.regions[ISSUE_REGION[issue]]
          if (st === 0 || !region) continue
          const [cx, cy] = project(region.u, region.v)
          const r = region.r * anchor.scale * dh * 1.25
          const hot = stageRgb(st)
          const strength = (0.45 + 0.55 * (st / 3)) * pulse * fade
          fx.globalCompositeOperation = 'source-over'
          fx.clearRect(0, 0, w, h)
          strokeMesh(fx, hot, 1)
          fx.globalCompositeOperation = 'destination-in'
          const g = fx.createRadialGradient(cx, cy, 0, cx, cy, r)
          g.addColorStop(0, 'rgba(0,0,0,1)')
          g.addColorStop(0.55, 'rgba(0,0,0,0.8)')
          g.addColorStop(1, 'rgba(0,0,0,0)')
          fx.fillStyle = g
          fx.fillRect(0, 0, w, h)
          ctx.globalAlpha = strength
          ctx.drawImage(scratch.fx, 0, 0)
          const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
          halo.addColorStop(0, rgba(hot, 0.12))
          halo.addColorStop(1, rgba(hot, 0))
          ctx.fillStyle = halo
          ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r)
        }
      }

      // ---- scanner sweep: a bright band that runs down the body every few seconds ----
      const phase = (tS % SWEEP_PERIOD_S) / SWEEP_PERIOD_S
      if (motion && phase < SWEEP_ACTIVE && bottom > top) {
        const band = Math.max(18 * dpr, (bottom - top) * 0.1)
        const t = phase / SWEEP_ACTIVE
        const y = top - band + t * (bottom - top + 2 * band)
        fx.globalCompositeOperation = 'source-over'
        fx.clearRect(0, 0, w, h)
        fx.drawImage(scratch.lines, 0, 0)
        fx.globalCompositeOperation = 'destination-in'
        const g = fx.createLinearGradient(0, y - band, 0, y + band)
        g.addColorStop(0, 'rgba(0,0,0,0)')
        g.addColorStop(0.5, 'rgba(0,0,0,1)')
        g.addColorStop(1, 'rgba(0,0,0,0)')
        fx.fillStyle = g
        fx.fillRect(0, y - band, w, 2 * band)
        const edgeFade = Math.min(1, t * 6, (1 - t) * 6)
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = fade * edgeFade
        ctx.drawImage(scratch.fx, 0, 0)
        ctx.drawImage(scratch.fx, 0, 0)
        const scan = ctx.createLinearGradient(left, 0, right, 0)
        scan.addColorStop(0, rgba(color, 0))
        scan.addColorStop(0.5, rgba(color, 0.35))
        scan.addColorStop(1, rgba(color, 0))
        ctx.fillStyle = scan
        ctx.fillRect(left, y - 0.5 * dpr, right - left, 1 * dpr)
        ctx.globalCompositeOperation = 'source-over'
      }

      // ---- tracked joints ----
      ctx.globalAlpha = fade
      ctx.lineWidth = 1.2 * dpr
      for (const j of mesh.joints) {
        const [x, y] = project(j.u, j.v)
        ctx.strokeStyle = rgba(color, 0.6)
        ctx.beginPath()
        ctx.arc(x, y, 5 * dpr, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = rgba(color, 1)
        ctx.beginPath()
        ctx.arc(x, y, 2 * dpr, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      // release the scratch buffers' backing stores right away
      scratch.lines.width = scratch.fx.width = 0
    }
  }, [windowVisible])

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100" />
}
