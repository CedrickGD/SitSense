// "What your coach sees" (ui-v3.md §4.5): three toggles with a live one-line preview of
// exactly what goes out, and the privacy note. A 280 px panel on wide windows; a row of
// chips above the composer below 1100 px.

import { useEffect, type JSX } from 'react'
import type { AiConnection, AiShareMode } from '@shared/ai'
import { Icon, type IconName } from '@renderer/components/icons'
import { Card, CardHeader, Divider, LinkButton, Tooltip } from '@renderer/components/primitives'
import { presetForConnection } from '@renderer/components/ai-settings'
import { useNow } from '@renderer/lib/hooks'
import { useAppStore } from '@renderer/state/store'
import { baselinePreview, isLocalConnection, livePreview, todayPreview, type ContextPreview } from './context'
import { contextInputs, useCoachStore } from './coachStore'
import { MonoText } from './parts'
import type { CoachContextToggles } from './types'

interface RowDef {
  key: keyof CoachContextToggles
  title: string
  chip: string
  icon: IconName
}

const ROWS: readonly RowDef[] = [
  { key: 'live', title: 'Live measurements', chip: 'Live', icon: 'live' },
  { key: 'today', title: 'Today’s stats', chip: 'Today', icon: 'history' },
  { key: 'baseline', title: 'Your saved posture', chip: 'Setup', icon: 'setup' }
]

/** Re-reads the inputs every few seconds (the snapshot changes ~1×/s; the panel needn't). */
export function useContextPreviews(): Record<keyof CoachContextToggles, ContextPreview> {
  // subscribe to what the previews depend on, so toggling pause / setup updates at once
  useAppStore((s) => s.pause.paused)
  useAppStore((s) => s.detection.running)
  useAppStore((s) => s.settings?.calibration)
  useAppStore((s) => s.snapshot?.worstStage)
  useAppStore((s) => s.snapshot?.presence)
  const range = useCoachStore((s) => s.range)
  const refreshStats = useCoachStore((s) => s.refreshStats)
  useNow(5000)
  useEffect(() => {
    void refreshStats()
    const t = setInterval(() => void refreshStats(true), 60_000)
    return () => clearInterval(t)
  }, [refreshStats])
  const inputs = contextInputs(range)
  return { live: livePreview(inputs), today: todayPreview(inputs), baseline: baselinePreview(inputs) }
}

/**
 * The tick. On but with nothing to share right now (paused, camera off, no history) it is
 * a sage ring with a dash — "allowed, but nothing goes out" — never a filled check next to
 * "not shared".
 */
function Check({ on, available }: { on: boolean; available: boolean }): JSX.Element {
  const idle = on && !available
  return (
    <span
      aria-hidden
      className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] transition-colors duration-150 ${
        idle
          ? 'bg-transparent ring-[1.5px] ring-sage/55 ring-inset'
          : on
            ? 'bg-sage text-ink'
            : 'bg-transparent ring-1 ring-hairline-strong group-hover:ring-text-faint'
      }`}
    >
      {idle ? <span className="h-0.5 w-2 rounded-full bg-sage/70" /> : on && <Icon name="check" size={12} strokeWidth={2.4} />}
    </span>
  )
}

export function privacyLine(conn: AiConnection | null, aiOff = false): string {
  if (conn) {
    const local = isLocalConnection(conn, presetForConnection(conn).baseUrl)
    return `Your messages and the ticked items go to ${conn.label}${local ? ' on this PC' : ''}. No camera image unless you check your posture.`
  }
  return aiOff ? 'Nothing goes to an AI model while AI is turned off.' : 'Nothing goes to an AI model until you connect one.'
}

function shareLine(share: AiShareMode): string {
  return share === 'snapshot'
    ? 'Check my posture sends one small camera snapshot.'
    : 'Check my posture sends a pose sketch — lines and dots, no camera image.'
}

export function ContextPanel({ conn, share, aiOff = false }: { conn: AiConnection | null; share: AiShareMode; aiOff?: boolean }): JSX.Element {
  const toggles = useCoachStore((s) => s.toggles)
  const setToggle = useCoachStore((s) => s.setToggle)
  const previews = useContextPreviews()
  const openSettings = useAppStore((s) => s.openSettings)

  return (
    <Card as="aside" aria-label="What your coach sees" className="flex w-[280px] shrink-0 flex-col overflow-y-auto">
      <CardHeader icon="eye" eyebrow="What your coach sees" />
      <div className="-mx-2 flex flex-col gap-1">
        {ROWS.map((r) => {
          const on = toggles[r.key]
          const p = previews[r.key]
          return (
            <button
              key={r.key}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => setToggle(r.key, !on)}
              className="group flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left transition-colors duration-150 hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none"
            >
              <Check on={on} available={p.available} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={`type-body font-medium ${on && p.available ? 'text-text' : 'text-text-dim'}`}>{r.title}</span>
                {p.lines.map((l, i) => (
                  <span
                    key={i}
                    className={`type-caption ${on && p.available ? (i === 0 ? 'text-text-dim' : 'text-text-faint') : 'text-text-faint'} ${on ? '' : 'line-through decoration-white/20'}`}
                  >
                    <MonoText>{l}</MonoText>
                  </span>
                ))}
              </span>
            </button>
          )
        })}
      </div>
      <Divider />
      <CardHeader icon="shield" eyebrow="Privacy" className="mb-2" />
      <div className="flex flex-col gap-2.5 type-caption text-text-dim">
        <p>{privacyLine(conn, aiOff)}</p>
        {conn && (
          <p className="flex items-start gap-2">
            <span className="mt-px text-text-faint">
              <Icon name="camera" size={14} />
            </span>
            {shareLine(share)}
          </p>
        )}
        <p className="flex items-start gap-2">
          <span className="mt-px text-text-faint">
            <Icon name="lock" size={14} />
          </span>
          Your chat history stays on this PC.
        </p>
        <LinkButton className="self-start" arrow onClick={() => openSettings('privacy')}>
          Privacy & data
        </LinkButton>
      </div>
    </Card>
  )
}

/** Narrow windows: the three toggles as chips; details in the tooltip. */
export function ContextChips({ showLabel = true }: { showLabel?: boolean }): JSX.Element {
  const toggles = useCoachStore((s) => s.toggles)
  const setToggle = useCoachStore((s) => s.setToggle)
  const previews = useContextPreviews()
  const paused = useAppStore((s) => s.pause.paused)
  return (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5" role="group" aria-label="What your coach sees">
      {showLabel && <span className="type-caption text-text-faint">Coach sees</span>}
      {ROWS.map((r) => {
        const on = toggles[r.key]
        const p = previews[r.key]
        const idle = on && !p.available
        return (
          <Tooltip key={r.key} content={`${r.title}: ${p.lines.join(' · ')}${on ? (idle ? ' (nothing to share right now)' : '') : ' (not shared)'}`}>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={r.title}
              onClick={() => setToggle(r.key, !on)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 type-caption font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none ${
                idle
                  ? 'bg-white/[0.04] text-text-dim ring-1 ring-white/[0.06] hover:text-text'
                  : on
                    ? 'bg-sage-soft text-sage hover:brightness-125'
                    : 'bg-white/[0.04] text-text-faint ring-1 ring-white/[0.06] hover:text-text-dim'
              }`}
            >
              <Icon name={idle ? (paused ? 'pause' : 'camera') : on ? 'check' : r.icon} size={14} strokeWidth={on && !idle ? 2.2 : undefined} />
              {r.chip}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
