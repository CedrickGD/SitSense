// The target figure: a schematic seated person in the posture setup is looking for, with
// the body part the current instruction is about highlighted (a dashed amber ghost of the
// "now" and a sage arrow toward the target). It is a teaching diagram, not a camera
// overlay — it looks the same from any camera angle (the any-angle rule).

import type { JSX } from 'react'
import type { GuideFocus } from './copy'

type P = readonly [number, number]

interface Pose {
  pelvis: P
  shoulder: P
  head: P
  knee: P
  foot: P
  elbow: P
  hand: P
}

/** upright against the backrest, ears over the shoulders, hips all the way back */
const TARGET: Pose = {
  pelvis: [50, 76],
  shoulder: [51, 39],
  head: [53, 23],
  knee: [88, 74],
  foot: [91, 102],
  elbow: [60, 59],
  hand: [84, 57]
}

/** the "now" the instruction is about (only the parts that differ are drawn) */
const GHOST: Partial<Record<Exclude<GuideFocus, null>, Partial<Pose>>> = {
  back: { pelvis: [52, 76], shoulder: [67, 42], head: [75, 28] },
  lying: { pelvis: [68, 80], shoulder: [45, 49], head: [56, 32], knee: [100, 78] },
  recline: { pelvis: [51, 76], shoulder: [33, 44], head: [30, 29] },
  head: { head: [68, 27] }
}

/** where the arrow starts (on the ghost) and ends (on the target) */
const ARROW: Partial<Record<Exclude<GuideFocus, null>, readonly [P, P]>> = {
  back: [
    [72, 32],
    [58, 31]
  ],
  lying: [
    [66, 88],
    [53, 88]
  ],
  recline: [
    [35, 31],
    [47, 29]
  ],
  head: [
    [70, 15],
    [58, 14]
  ]
}

const line = (a: P, b: P): string => `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`

function Figure({ pose, ghost }: { pose: Pose; ghost?: boolean }): JSX.Element {
  const common = ghost
    ? { stroke: 'var(--color-amber)', strokeWidth: 2.4, strokeDasharray: '3.5 3', opacity: 0.95 }
    : { stroke: 'var(--color-sage)', strokeWidth: 5, opacity: 0.95 }
  const limb = ghost ? common : { ...common, strokeWidth: 3.6, opacity: 0.75 }
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      {/* thigh + shin, arm */}
      <path d={`${line(pose.pelvis, pose.knee)}${line(pose.knee, pose.foot)}`} {...limb} />
      {!ghost && <path d={`${line(pose.shoulder, pose.elbow)}${line(pose.elbow, pose.hand)}`} {...limb} />}
      {/* trunk + neck */}
      <path d={`${line(pose.pelvis, pose.shoulder)}`} {...common} />
      <path d={line(pose.shoulder, [pose.head[0] - 1, pose.head[1] + 7])} {...common} strokeWidth={ghost ? 2.2 : 4} />
      <circle cx={pose.head[0]} cy={pose.head[1]} r={8} {...common} strokeWidth={ghost ? 2.2 : 2.6} fill={ghost ? 'none' : 'rgb(147 201 162 / 0.12)'} />
    </g>
  )
}

export default function PostureGuide({ focus, size = 150 }: { focus: GuideFocus; size?: number }): JSX.Element {
  const g = focus ? GHOST[focus] : undefined
  const ghost: Pose | null = g ? { ...TARGET, ...g } : null
  const arrow = focus ? ARROW[focus] : undefined
  return (
    <svg
      aria-hidden
      width={size}
      height={(size * 106) / 140}
      viewBox="18 6 140 106"
      className="shrink-0 overflow-visible"
    >
      <defs>
        <marker id="ss-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M1 1L8 5L1 9" fill="none" stroke="var(--color-sage)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      {/* chair and desk, quiet */}
      <g fill="none" stroke="rgb(255 255 255 / 0.13)" strokeWidth="2.4" strokeLinecap="round">
        <path d="M40 24L42 82" />
        <path d="M42 82H86" />
        <path d="M64 82V106M50 108H78" />
        <path d="M112 72H156" />
        <path d="M140 58V72" />
        <rect x="128" y="34" width="24" height="24" rx="2.5" />
      </g>
      {/* a recline tips the backrest back with you: the ghost leans on that, not through the upright one */}
      {focus === 'recline' && (
        <path d="M28 26L42 82" fill="none" stroke="var(--color-amber)" strokeWidth="2.2" strokeDasharray="3.5 3" strokeLinecap="round" opacity="0.6" />
      )}
      {ghost && <Figure pose={ghost} ghost />}
      <Figure pose={TARGET} />
      {focus === 'hips' && (
        <circle
          cx={TARGET.pelvis[0]}
          cy={TARGET.pelvis[1]}
          r={9}
          fill="none"
          stroke="var(--color-amber)"
          strokeWidth="1.8"
          strokeDasharray="3 3"
          className="motion-safe:animate-[softPulse_2s_ease-in-out_infinite]"
        />
      )}
      {focus === 'side' && (
        <circle
          cx={TARGET.shoulder[0]}
          cy={TARGET.shoulder[1]}
          r={8}
          fill="none"
          stroke="var(--color-amber)"
          strokeWidth="1.8"
          strokeDasharray="3 3"
        />
      )}
      {arrow && (
        <path
          d={line(arrow[0], arrow[1])}
          stroke="var(--color-sage)"
          strokeWidth="2"
          strokeLinecap="round"
          markerEnd="url(#ss-arrow)"
          className="motion-safe:animate-[ss-nudge_1.6s_ease-in-out_3]"
        />
      )}
    </svg>
  )
}
