import type { IssueId, Stage } from '@shared/posture'

/** Single source of the stage → color mapping (spec: same 4 colors everywhere). */
export const STAGE_COLOR: Record<Stage, string> = {
  0: 'var(--color-sage)',
  1: 'var(--color-amber)',
  2: 'var(--color-ember)',
  3: 'var(--color-coral)'
}

export const STAGE_LABEL: Record<Stage, string> = {
  0: 'fine',
  1: 'slight',
  2: 'clear',
  3: 'severe'
}

export const ISSUE_SHORT: Record<IssueId, string> = {
  sink: 'Slouching',
  headForward: 'Head forward',
  lean: 'Leaning',
  tooClose: 'Too close'
}

export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

export function formatCountdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatClock(epochMinute: number): string {
  const d = new Date(epochMinute * 60_000)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}
