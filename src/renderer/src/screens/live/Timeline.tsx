// The day timeline (docs/specs/ui-v3.md §3.5 row 2; History reuses the idea at 28 px).
// Built locally for Live — a candidate for components/Timeline.tsx (§9) once History
// settles on the same props.

import type { JSX } from 'react'
import type { IssueId, Stage, StatMinute } from '@shared/posture'
import { ISSUE_SHORT, STAGE_COLOR, STAGE_LABEL, type TimelineRun } from '@renderer/lib/ui'
import { fmtClockMinute } from '@renderer/lib/format'
import { Tooltip } from '@renderer/components/primitives'

export function runColor(state: StatMinute['s']): string {
  if (state === 'good') return 'var(--color-sage-deep)'
  if (state === 'away' || state === 'paused') return 'transparent'
  const stage = Number(state.split(':')[1] ?? 1) as Stage
  return STAGE_COLOR[stage]
}

export function runLabel(state: StatMinute['s']): string {
  if (state === 'good') return 'Good posture'
  if (state === 'away') return 'Away'
  if (state === 'paused') return 'Paused'
  const [issue, stage] = state.split(':')
  return `${ISSUE_SHORT[issue as IssueId]} (${STAGE_LABEL[Number(stage) as Stage]})`
}

interface TimelineProps {
  runs: TimelineRun[]
  first: number
  last: number
  /** px: 20 on Live, 16 on short windows, 28 in History */
  height?: number
  /** 0..1 positions of full hours */
  ticks?: number[]
  ariaLabel: string
}

export default function Timeline({ runs, first, last, height = 20, ticks = [], ariaLabel }: TimelineProps): JSX.Element {
  const span = Math.max(1, last - first + 1)
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="relative flex w-full overflow-hidden rounded-md bg-ink ring-1 ring-white/[0.04] motion-safe:origin-left motion-safe:animate-[growIn_400ms_ease-out]"
      style={{ height }}
    >
      {runs.map((r, i) => {
        const away = r.state === 'away' || r.state === 'paused'
        return (
          <Tooltip key={`${r.from}-${i}`} content={`${fmtClockMinute(r.from)}–${fmtClockMinute(r.to + 1)} · ${runLabel(r.state)}`} delay={120}>
            <div
              className={`h-full shrink-0 transition-[filter] duration-150 hover:brightness-125 ${away ? 'border-t border-dotted border-hairline-strong' : ''}`}
              style={{ width: `${((r.to - r.from + 1) / span) * 100}%`, backgroundColor: runColor(r.state) }}
            />
          </Tooltip>
        )
      })}
      {ticks.map((t) => (
        <span key={t} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-white/[0.08]" style={{ left: `${t * 100}%` }} />
      ))}
    </div>
  )
}
