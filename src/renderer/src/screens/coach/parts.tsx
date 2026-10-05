// Small Coach-only building blocks (ui-v3.md §4.2, §4.6): the avatar, the empty-state
// illustration, numbers in Plex Mono inside prose, and the posture-check result card.

import { Fragment, type JSX, type ReactNode } from 'react'
import { LM } from '@renderer/posture/constants'
import { Icon } from '@renderer/components/icons'
import { Chip, ScoreRing } from '@renderer/components/primitives'
import { fmtScore } from '@renderer/lib/format'
import type { CheckSketch, CoachMessage } from './types'

/** 24 px coach avatar: the spark in a sage-soft circle. */
export function CoachAvatar({ size = 24 }: { size?: number }): JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-sage-soft text-sage ring-1 ring-sage/15"
      style={{ width: size, height: size }}
    >
      <Icon name="spark" size={Math.round(size * 0.58)} />
    </span>
  )
}

/** 64 px illustration for the no-AI states: a chat bubble holding the spine glyph. */
export function CoachIllustration(): JSX.Element {
  return (
    <span className="relative flex h-[88px] w-[88px] items-center justify-center rounded-full bg-card-2 ring-1 ring-white/[0.06]">
      <span aria-hidden className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_50%_40%,rgb(147_201_162/0.14),transparent_65%)]" />
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden className="relative">
        <path
          d="M14 14h36a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6H30l-9 8v-8h-7a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6Z"
          stroke="var(--color-text-dim)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <rect x="25" y="19.5" width="14" height="4.5" rx="2.25" fill="var(--color-sage)" />
        <rect x="27" y="26.75" width="14" height="4.5" rx="2.25" fill="var(--color-sage)" opacity="0.85" />
        <rect x="24" y="34" width="14" height="4.5" rx="2.25" fill="var(--color-sage)" opacity="0.7" />
      </svg>
    </span>
  )
}

const NUM_RE = /([+−-]?\d[\d.,:]*(?:\s?(?:°|%|min|h|m|cm))?)/g

/** Prose with every number set in Plex Mono tabular figures (§8.3). */
export function MonoText({ children }: { children: string }): JSX.Element {
  const parts = children.split(NUM_RE)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-mono text-[12px] tabular-nums">
            {p}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        )
      )}
    </>
  )
}

// ───────────────────────────── posture check card ─────────────────────────────

const SKETCH_EDGES: ReadonlyArray<readonly [number, number]> = [
  [LM.nose, LM.leftEar],
  [LM.nose, LM.rightEar],
  [LM.leftEar, LM.leftShoulder],
  [LM.rightEar, LM.rightShoulder],
  [LM.leftShoulder, LM.rightShoulder],
  [LM.leftShoulder, LM.leftElbow],
  [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow],
  [LM.rightElbow, LM.rightWrist],
  [LM.leftShoulder, LM.leftHip],
  [LM.rightShoulder, LM.rightHip],
  [LM.leftHip, LM.rightHip],
  [LM.leftHip, LM.leftKnee],
  [LM.rightHip, LM.rightKnee]
]

/** The pose drawing that was sent, small (same look as the sketch: light lines on dark gray). */
function SketchThumb({ sketch }: { sketch: CheckSketch }): JSX.Element {
  const h = 100 / (sketch.aspect > 0 ? sketch.aspect : 4 / 3)
  const pt = (i: number): [number, number] | null => {
    const p = sketch.points[i]
    return p ? [p[0] * 100, p[1] * h] : null
  }
  return (
    <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full bg-[#2b2b2b]" aria-hidden>
      {SKETCH_EDGES.map(([a, b]) => {
        const p = pt(a)
        const q = pt(b)
        return p && q ? <line key={`${a}-${b}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#c9c9c9" strokeWidth={2.4} strokeLinecap="round" /> : null
      })}
      {[LM.nose, LM.leftEar, LM.rightEar, LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip].map((i) => {
        const p = pt(i)
        return p ? <circle key={i} cx={p[0]} cy={p[1]} r={2} fill="#c9c9c9" /> : null
      })}
    </svg>
  )
}

/** The pose sketch that was sent, small, with its caption (only while the sketch is known). */
function SentThumb({ sketch }: { sketch: CheckSketch }): JSX.Element {
  return (
    <figure className="flex w-[96px] shrink-0 flex-col items-center gap-1.5">
      <div className="relative h-[72px] w-[96px] overflow-hidden rounded-lg ring-1 ring-white/10">
        <SketchThumb sketch={sketch} />
      </div>
      <figcaption className="text-center type-caption text-text-faint">Pose sketch sent</figcaption>
    </figure>
  )
}

/** The posture-check result (§4.2): a nested e2 card. */
export function CheckCard({ message }: { message: CoachMessage }): JSX.Element | null {
  const r = message.review
  if (!r) return null
  const good = r.verdict === 'good'
  // the sketch is drawn when we have it; a snapshot (never stored) or a sketch from before
  // a restart is named in the footer instead of an empty placeholder box
  const thumb = message.share !== 'snapshot' && message.sketch ? message.sketch : null
  const sentNote = thumb ? '' : message.share === 'snapshot' ? ' · Camera snapshot sent' : ' · Pose sketch sent'
  return (
    <div className="surface-raised max-w-[540px] p-4">
      <div className="flex gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <ScoreRing value={r.score} size={40} />
            <span className="flex items-baseline gap-0.5">
              <span className="type-value-lg text-text">{fmtScore(r.score)}</span>
              <span className="font-mono text-[12px] text-text-faint tabular-nums">/100</span>
            </span>
            <Chip tone={good ? 'sage' : 'amber'} icon={good ? 'check' : 'alert'}>
              {good ? 'Looks good' : 'Adjust'}
            </Chip>
          </div>
          <p className="type-body-lg text-text">{r.summary}</p>
          {r.instructions.length > 0 && (
            <ol className="flex flex-col gap-1.5">
              {r.instructions.slice(0, 3).map((tip, i) => (
                <li key={i} className="flex gap-2.5 type-body-lg text-text-dim">
                  <span
                    aria-hidden
                    className="mt-[2px] inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-white/[0.06] font-mono text-[11px] text-text-dim tabular-nums"
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0">{tip}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        {thumb && <SentThumb sketch={thumb} />}
      </div>
      <p className="mt-3 border-t border-white/[0.06] pt-2.5 type-caption text-text-faint">
        Checked by {r.connectionLabel}
        {r.model ? ` · ${r.model}` : ''}
        {sentNote}
      </p>
    </div>
  )
}

/** Centered caption between two hairlines (day separators). */
export function Separator({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-1" role="separator">
      <span aria-hidden className="h-px flex-1 bg-white/[0.06]" />
      <span className="type-micro text-text-faint">{children}</span>
      <span aria-hidden className="h-px flex-1 bg-white/[0.06]" />
    </div>
  )
}
