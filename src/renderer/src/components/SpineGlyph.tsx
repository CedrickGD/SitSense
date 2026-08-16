import type { JSX } from 'react'
import type { IssueId, Stage } from '@shared/posture'
import { STAGE_COLOR } from '@renderer/lib/ui'

interface SpineGlyphProps {
  size?: number
  issue: IssueId | null
  stage: Stage
  direction?: 'left' | 'right'
  /** paused/away render styles */
  mode?: 'normal' | 'paused' | 'away'
  breathing?: boolean
}

const SEG_Y = [8, 26, 44, 62, 80]
// forward-curve profile for the sink C-curve (top bows out, bottom tucks in)
const SINK_CURVE = [6, 3, 0, -3, -5]

/**
 * The app's signature: a 5-segment spine that mirrors the live posture.
 * Shape encodes the issue, color encodes the stage — never color alone.
 */
export default function SpineGlyph({
  size = 96,
  issue,
  stage,
  direction = 'right',
  mode = 'normal',
  breathing = true
}: SpineGlyphProps): JSX.Element {
  const k = stage / 3 // deformation intensity
  const color =
    mode === 'paused'
      ? 'var(--color-slate-cool)'
      : mode === 'away'
        ? 'var(--color-text-faint)'
        : STAGE_COLOR[stage]
  const dirSign = direction === 'left' ? -1 : 1

  const segments = SEG_Y.map((y, i) => {
    let x = 25
    let yy = y
    if (issue === 'sink') {
      x += SINK_CURVE[i] * k
      yy = 80 - (80 - y) * (1 - 0.22 * k) // compress the stack downward
    } else if (issue === 'headForward' && i < 2) {
      x += (i === 0 ? 9 : 4.5) * k
    }
    return { x, y: yy }
  })

  const groupTransform =
    issue === 'lean'
      ? `rotate(${dirSign * 16 * k} 32 88)`
      : issue === 'tooClose'
        ? `translate(${32 - 32 * (1 + 0.14 * k)} ${88 - 88 * (1 + 0.14 * k)}) scale(${1 + 0.14 * k})`
        : undefined

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 96"
      aria-hidden
      style={{ overflow: 'visible' }}
    >
      {stage === 0 && mode === 'normal' && breathing && (
        <ellipse
          cx={32}
          cy={44}
          rx={26}
          ry={52}
          fill={color}
          className="motion-safe:animate-[breathe_6s_ease-in-out_infinite]"
          style={{ opacity: 0.25, filter: 'blur(14px)' }}
        />
      )}
      <g transform={groupTransform} style={{ transition: 'transform 300ms ease-out' }}>
        {segments.map((s, i) => (
          <rect
            key={i}
            x={s.x}
            y={s.y}
            width={14}
            height={12}
            rx={6}
            fill={mode === 'away' ? 'none' : color}
            stroke={mode === 'away' ? color : 'none'}
            strokeWidth={mode === 'away' ? 2.5 : 0}
            style={{
              transition: 'x 300ms ease-out, y 300ms ease-out, fill 200ms linear',
              ...(issue === 'tooClose' && stage > 0 ? { filter: `blur(${0.6 * k}px)` } : {})
            }}
          />
        ))}
        {mode === 'paused' && (
          <g>
            <rect x={40} y={66} width={22} height={24} rx={5} fill="var(--color-ink)" />
            <rect x={45} y={70} width={4.5} height={16} rx={2.2} fill="var(--color-text)" />
            <rect x={53} y={70} width={4.5} height={16} rx={2.2} fill="var(--color-text)" />
          </g>
        )}
      </g>
    </svg>
  )
}
