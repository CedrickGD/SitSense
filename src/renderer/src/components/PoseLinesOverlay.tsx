// The "Lines" camera overlay (overlay.style 'skeleton', the default) — docs/specs/ui.md §3.
//
// Draws what the posture judge measures, from any camera angle: the near-side
// ear → shoulder → hip chain as a thick rounded polyline with joint dots, the shoulder
// line and head (ear-to-ear) line thin when both ends are visible, and a dashed
// true-vertical line through the shoulder (gravity projected into the image, so
// "ears over this line" reads at a glance).
//
// The near side is chosen here, with hysteresis (`nextSide`): from the front both sides
// are about equally visible, and a side that flipped with the noise would slide the thick
// chain across the chest.
//
// Only this component subscribes to `s.pose` (≤ 15 Hz, visible window only), so the
// camera feed around it never re-renders per frame.

import { useRef, type CSSProperties, type JSX } from 'react'
import type { Stage } from '@shared/posture'
import { STAGE_COLOR } from '@renderer/lib/ui'
import { isSuspended, NOT_JUDGED_COLOR } from '@renderer/lib/score'
import { LM } from '@renderer/posture/constants'
import type { Landmark } from '@renderer/posture/types'
import { isSeen } from '@renderer/detection/pose-geometry'
import { useAppStore, type BodySegment, type PoseOverlayData } from '@renderer/state/store'

type Pt = readonly [number, number]
type Side = 'left' | 'right'

/** Geometry in viewBox units (`0 0 100 vh`, isotropic, NOT mirrored — the SVG is mirrored with CSS). */
export interface LinesGeometry {
  vw: number
  vh: number
  side: 'left' | 'right'
  /** near-side chain points (null = not seen) */
  ear: Pt | null
  shoulder: Pt | null
  hip: Pt | null
  /** ear → shoulder (head-forward lives here) */
  neck: [Pt, Pt] | null
  /** shoulder → hip (slouching lives here) */
  trunk: [Pt, Pt] | null
  /** left ↔ right shoulder, both seen (leaning) */
  shoulderLine: [Pt, Pt] | null
  /** left ↔ right ear, both seen (too close) */
  headLine: [Pt, Pt] | null
  /** true vertical through the drawn shoulder (else the guide's): [top, bottom]; null without a guide */
  vertical: [Pt, Pt] | null
}

const SIDE_LM = {
  left: { ear: LM.leftEar, shoulder: LM.leftShoulder, hip: LM.leftHip },
  right: { ear: LM.rightEar, shoulder: LM.rightShoulder, hip: LM.rightHip }
} as const

const vis = (p: Landmark | undefined): number => (p ? (p.visibility ?? 0) : 0)
const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const other = (s: Side): Side => (s === 'left' ? 'right' : 'left')

/** the other side must out-score the drawn one by this much (ear + shoulder + hip visibility) … */
export const SIDE_SWITCH_MARGIN = 0.3
/** … for this many pose updates in a row before the chain moves over */
export const SIDE_SWITCH_FRAMES = 3

export interface SideState {
  side: Side
  /** consecutive updates the other side has clearly won */
  streak: number
}

const sideScore = (lm: readonly Landmark[], s: Side): number =>
  vis(lm[SIDE_LM[s].ear]) + vis(lm[SIDE_LM[s].shoulder]) + vis(lm[SIDE_LM[s].hip])

/**
 * The side to draw the thick chain on, with hysteresis. Uses the image landmarks' own
 * labels (that's what gets drawn), so it never depends on whether the posture guide is
 * present. Switches at once only when the drawn side's shoulder is lost and the other
 * one is seen; otherwise after the other side wins clearly for SIDE_SWITCH_FRAMES updates.
 */
export function nextSide(lm: readonly Landmark[], prev: SideState | null): SideState {
  const l = sideScore(lm, 'left')
  const r = sideScore(lm, 'right')
  if (!prev) {
    const lSeen = isSeen(lm[LM.leftShoulder])
    const rSeen = isSeen(lm[LM.rightShoulder])
    if (lSeen !== rSeen) return { side: lSeen ? 'left' : 'right', streak: 0 }
    return { side: l >= r ? 'left' : 'right', streak: 0 }
  }
  const cur = prev.side
  const alt = other(cur)
  if (!isSeen(lm[SIDE_LM[cur].shoulder]) && isSeen(lm[SIDE_LM[alt].shoulder])) return { side: alt, streak: 0 }
  const [sc, sa] = cur === 'left' ? [l, r] : [r, l]
  if (sa > sc + SIDE_SWITCH_MARGIN) {
    const streak = prev.streak + 1
    return streak >= SIDE_SWITCH_FRAMES ? { side: alt, streak: 0 } : { side: cur, streak }
  }
  return { side: cur, streak: 0 }
}

/**
 * Pure layout of the Lines overlay from the store's pose data. `side` is the near side
 * to draw (from `nextSide`, which keeps it steady across frames); without it the side is
 * picked from this frame alone. Returns null when nothing useful is in view.
 */
export function linesGeometry(pose: PoseOverlayData, side?: Side): LinesGeometry | null {
  const aspect = pose.aspect > 0 && Number.isFinite(pose.aspect) ? pose.aspect : 4 / 3
  const vw = 100
  const vh = 100 / aspect
  const lm = pose.image
  const at = (i: number): Pt | null => {
    const p = lm[i]
    return isSeen(p) ? [p.x * vw, p.y * vh] : null
  }

  const near: Side = side ?? nextSide(lm, null).side
  const ids = SIDE_LM[near]
  const ear = at(ids.ear)
  const shoulder = at(ids.shoulder)
  const hip = at(ids.hip)

  const ls = at(LM.leftShoulder)
  const rs = at(LM.rightShoulder)
  const le = at(LM.leftEar)
  const re = at(LM.rightEar)

  if (!shoulder && !ear && !ls && !rs) return null

  let vertical: [Pt, Pt] | null = null
  const g = pose.guide
  if (g) {
    const [ux, uy] = g.up2d
    const n = Math.hypot(ux, uy)
    if (n > 1e-6 && Number.isFinite(n)) {
      const dx = ux / n
      const dy = uy / n
      // through the drawn shoulder dot, so "ears over this line" matches the chain; the
      // guide's shoulder is the visibility-weighted mean of both, which in an angled or
      // front view sits across the body from the near ear
      const s: Pt = shoulder ?? [g.shoulder.x * vw, g.shoulder.y * vh]
      const refEar = ear ?? le ?? re
      const up = Math.max(refEar ? 1.7 * dist(refEar, s) : 0, 0.32 * vh)
      const down = hip ? Math.max(dist(hip, s), 0.15 * vh) : 0.22 * vh
      vertical = [
        [s[0] + dx * up, s[1] + dy * up],
        [s[0] - dx * down, s[1] - dy * down]
      ]
    }
  }

  return {
    vw,
    vh,
    side: near,
    ear,
    shoulder,
    hip,
    neck: ear && shoulder ? [ear, shoulder] : null,
    trunk: shoulder && hip ? [shoulder, hip] : null,
    shoulderLine: ls && rs ? [ls, rs] : null,
    headLine: le && re ? [le, re] : null,
    vertical
  }
}

/** Stroke color per body segment: one color in posture mode, issue stages over a fixed hue. */
export function segmentColors(
  segments: Record<BodySegment, Stage>,
  mode: 'posture' | 'fixed',
  fixedColor: string
): Record<BodySegment, string> {
  if (mode === 'posture') {
    const worst = Math.max(segments.head, segments.neck, segments.trunk, segments.shoulders) as Stage
    const c = STAGE_COLOR[worst]
    return { head: c, neck: c, trunk: c, shoulders: c }
  }
  const pick = (st: Stage): string => (st > 0 ? STAGE_COLOR[st] : fixedColor)
  return {
    head: pick(segments.head),
    neck: pick(segments.neck),
    trunk: pick(segments.trunk),
    shoulders: pick(segments.shoulders)
  }
}

const f = (n: number): string => n.toFixed(2)
const linePath = (a: Pt, b: Pt): string => `path('M ${f(a[0])} ${f(a[1])} L ${f(b[0])} ${f(b[1])}')`

// sizes in viewBox units (the frame is 100 wide)
const THICK = 1.25
const THIN = 0.5
const HALO = 0.9
const JOINT_R = 1.35
const HALO_COLOR = 'rgba(23, 21, 18, 0.5)'

/**
 * Geometry goes through the CSS `d` / `cx` / `cy` properties so Chromium can ease
 * between detection frames (5–15 fps) — `.pose-lines` in main.css, off under reduced motion.
 */
function Seg({ a, b, color, width, halo, dash }: {
  a: Pt
  b: Pt
  color: string
  width: number
  halo?: boolean
  dash?: string
}): JSX.Element {
  const d = { d: linePath(a, b) } as CSSProperties
  return (
    <>
      {halo && <path style={d} stroke={HALO_COLOR} strokeWidth={width + HALO} strokeLinecap="round" fill="none" />}
      <path
        className="pose-lines-stroke"
        style={{ ...d, stroke: color }}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={dash}
        fill="none"
      />
    </>
  )
}

function Joint({ p, color }: { p: Pt; color: string }): JSX.Element {
  return (
    <circle
      className="pose-lines-joint"
      style={{ cx: `${f(p[0])}px`, cy: `${f(p[1])}px`, fill: color } as CSSProperties}
      r={JOINT_R}
      stroke={HALO_COLOR}
      strokeWidth={0.5}
    />
  )
}

export function LinesSvg({
  pose,
  side,
  mode,
  color,
  easeMs
}: {
  pose: PoseOverlayData
  side?: Side
  mode: 'posture' | 'fixed'
  color: string
  easeMs: number
}): JSX.Element | null {
  const g = linesGeometry(pose, side)
  if (!g) return null
  const c = segmentColors(pose.segments, mode, color)
  return (
    <svg
      viewBox={`0 0 ${g.vw} ${f(g.vh)}`}
      preserveAspectRatio="xMidYMid slice"
      className="pose-lines pointer-events-none absolute inset-0 h-full w-full -scale-x-100"
      style={{ '--pose-ease': `${Math.round(easeMs)}ms` } as CSSProperties}
      aria-hidden
    >
      {/* reference first, so the body draws over it. The side-dependent parts are keyed by
          side: when the near side changes they remount instead of easing across the body. */}
      {g.vertical && (
        <g key={`vertical-${g.side}`}>
          <Seg a={g.vertical[0]} b={g.vertical[1]} color={HALO_COLOR} width={0.8} />
          <Seg a={g.vertical[0]} b={g.vertical[1]} color="var(--color-text)" width={0.42} dash="2.2 1.6" />
        </g>
      )}
      {g.shoulderLine && <Seg a={g.shoulderLine[0]} b={g.shoulderLine[1]} color={c.shoulders} width={THIN} halo />}
      {g.headLine && <Seg a={g.headLine[0]} b={g.headLine[1]} color={c.head} width={THIN} halo />}
      <g key={`chain-${g.side}`}>
        {g.trunk && <Seg a={g.trunk[0]} b={g.trunk[1]} color={c.trunk} width={THICK} halo />}
        {g.neck && <Seg a={g.neck[0]} b={g.neck[1]} color={c.neck} width={THICK} halo />}
        {g.hip && <Joint p={g.hip} color={c.trunk} />}
        {g.shoulder && <Joint p={g.shoulder} color={c.shoulders} />}
        {g.ear && <Joint p={g.ear} color={c.head} />}
      </g>
    </svg>
  )
}

/**
 * Lines overlay bound to the store. `color` is the fixed hue (ignored when
 * `mode === 'posture'`, which follows the worst stage instead).
 */
export default function PoseLinesOverlay({
  mode,
  color
}: {
  mode: 'posture' | 'fixed'
  color: string
}): JSX.Element | null {
  const pose = useAppStore((s) => s.pose)
  const fps = useAppStore((s) => s.detection.targetFps)
  // suspended detectors report every segment at stage 0 without judging it: in posture
  // mode that must read neutral, not the sage that means "good"
  const suspended = useAppStore((s) => s.snapshot?.presence === 'active' && isSuspended(s.snapshot))
  // the near side carries over between pose updates (hysteresis). Advanced once per pose
  // object, so a re-render without a new pose (or a StrictMode double render) doesn't count.
  const sideRef = useRef<{ pose: PoseOverlayData | null; state: SideState | null }>({ pose: null, state: null })
  if (pose && sideRef.current.pose !== pose) {
    sideRef.current = { pose, state: nextSide(pose.image, sideRef.current.state) }
  }
  if (!pose) return null
  // ease over most of one detection interval; poses are published at ≤ 15 Hz
  const easeMs = Math.min(180, (1000 / Math.max(1, Math.min(fps, 15))) * 0.85)
  const neutral = suspended && mode === 'posture'
  return (
    <LinesSvg
      pose={pose}
      side={sideRef.current.state?.side}
      mode={neutral ? 'fixed' : mode}
      color={neutral ? NOT_JUDGED_COLOR : color}
      easeMs={easeMs}
    />
  )
}
