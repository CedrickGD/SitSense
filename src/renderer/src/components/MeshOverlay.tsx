import { useEffect, useRef, type JSX } from 'react'
import { ISSUES, type IssueId, type Stage } from '@shared/posture'
import { OVERLAY_PRESETS, type OverlaySettings } from '@shared/settings'
import { STAGE_COLOR } from '@renderer/lib/ui'
import { easeAnchor, setMeshSpacing, worstPerRegion, type Anchor, type BodyMesh, type RegionKey } from '@renderer/overlay/bodyMesh'
import { meshIntensityOf, meshLook, type MeshLook } from '@renderer/overlay/meshLook'
import { MeshPainter, type Hotspot, type RGB } from '@renderer/overlay/meshPaint'
import { useAppStore } from '@renderer/state/store'

const FRAME_MS = 1000 / 30
/** anchor easing between detection frames (the model runs at 5–15 fps) */
const TAU_ANCHOR_S = 0.07
const TAU_COLOR_S = 0.3
const TAU_FADE_S = 0.18

/** Which part of the mesh lights up for each issue when the color is fixed. */
const ISSUE_REGION: Record<IssueId, RegionKey> = {
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

function stageRgb(stage: Stage): RGB {
  return themeColor(STAGE_COLOR[stage])
}

/** The overlay's base hue for the current settings and posture. */
function overlayRgb(overlay: OverlaySettings, stage: Stage): RGB {
  if (overlay.color === 'posture') return stageRgb(stage)
  if (overlay.color === 'custom') return hexToRgb(overlay.customColor)
  return hexToRgb(OVERLAY_PRESETS[overlay.color])
}

function ease(current: number, target: number, dtS: number, tau: number): number {
  return current + (target - current) * (1 - Math.exp(-dtS / tau))
}

interface Props {
  /** force the hologram look (default: follow settings.overlay.style) */
  hologram?: boolean
}

/**
 * Canvas renderer for the body wireframe. Runs its own ~30 fps loop, reading
 * the store directly so React never re-renders per frame, and eases the
 * mesh's body frame between detection results so motion stays fluid even at
 * the 5 fps power-saving preset. How strongly it draws follows
 * settings.overlay.meshIntensity: subtle by default, so the person stays
 * clearly visible under the lattice.
 */
export default function MeshOverlay({ hologram: hologramProp }: Props = {}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const windowVisible = useAppStore((s) => s.windowVisible)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !windowVisible) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const painter = new MeshPainter()
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

    let raf = 0
    let last = 0
    let mesh: BodyMesh | null = null
    let meshSeq = 0
    let anchor: Anchor | null = null
    let fade = 0
    let color: RGB | null = null
    let drewEmpty = false
    let lookKey = ''
    let look: MeshLook | null = null
    /** what the canvas currently shows, when it is a still frame ('' = must redraw) */
    let shown = ''

    const lookFor = (overlay: OverlaySettings): MeshLook => {
      const intensity = meshIntensityOf(overlay)
      const holo = hologramProp ?? overlay.style === 'hologram'
      const key = `${intensity}|${holo}`
      if (!look || key !== lookKey) {
        look = meshLook(intensity, holo)
        lookKey = key
        // the builder picks the lattice spacing up on its next detection frame
        setMeshSpacing(look.spacing)
      }
      return look
    }
    const initial = useAppStore.getState().settings?.overlay
    if (initial) lookFor(initial)

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
      const lk = lookFor(settings)

      // keep the last mesh around so the wireframe can fade out instead of blinking off
      if (latest && latest !== mesh) {
        if (!mesh || fade < 0.05) anchor = null // coming back: start on the body, don't ease in from where it was
        mesh = latest
        meshSeq++
      }
      fade = ease(fade, latest ? 1 : 0, dtS, TAU_FADE_S)

      const scale = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.max(1, Math.round(canvas.clientWidth * scale))
      const h = Math.max(1, Math.round(canvas.clientHeight * scale))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        shown = ''
      }
      if (!mesh || fade < 0.01) {
        if (!drewEmpty) ctx.clearRect(0, 0, w, h)
        drewEmpty = true
        shown = ''
        return
      }
      drewEmpty = false
      const dpr = w / Math.max(1, canvas.clientWidth)

      // ---- ease the body frame toward the latest detection (snapping on big jumps) ----
      anchor = easeAnchor(anchor, mesh.anchor, dtS > 0 ? 1 - Math.exp(-dtS / TAU_ANCHOR_S) : 0)

      const stage: Stage = snapshot && snapshot.presence === 'active' ? snapshot.worstStage : 0
      const want = overlayRgb(settings, stage)
      color = color ?? [...want]
      for (let k = 0; k < 3; k++) color[k] = ease(color[k], want[k], dtS, TAU_COLOR_S)

      // problem areas glow in their stage color when the base hue is fixed —
      // one paint per region, in the worst stage of the issues that share it
      const regions = mesh.regions
      const hotspots: Hotspot[] =
        settings.color !== 'posture' && snapshot?.presence === 'active'
          ? worstPerRegion(
              ISSUES.map((i) => [i, snapshot.issues[i].stage] as const),
              ISSUE_REGION
            ).flatMap(([key, st]) => {
              const region = regions[key]
              return region ? [{ region, color: stageRgb(st as Stage), stage: st }] : []
            })
          : []

      const motion = !reducedMotion.matches
      const animating = MeshPainter.animating({ tS, motion, hotspots, look: lk })
      // nothing moved, faded or recolored since the last still frame: leave the canvas be
      const p = painter.project(mesh, meshSeq, anchor, w, h, dpr, lk)
      const still = `${p.key}|${lookKey}|${fade.toFixed(3)}|${color.map(Math.round).join()}|${hotspots.map((s) => `${s.region.u}:${s.region.v}:${s.stage}`).join()}`
      if (!animating && still === shown) return
      shown = animating ? '' : still

      painter.paint(ctx, { mesh, meshSeq, anchor, w, h, dpr, color, fade, look: lk, hotspots, tS, motion })
    }

    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      painter.dispose() // release the scratch buffers' backing stores right away
    }
  }, [windowVisible, hologramProp])

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100" />
}
