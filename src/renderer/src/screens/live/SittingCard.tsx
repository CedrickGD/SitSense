// Live › Sitting card (docs/specs/ui-v3.md §3.5): the current sitting stretch, progress
// toward the next break reminder, and today's breaks. Data: store.sitting (main's
// break tracker) + settings.breaks. A tall card adds today's sitting totals as detail
// rows instead of leaving the space empty.

import { useMemo, type JSX } from 'react'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { useAppStore } from '@renderer/state/store'
import { useNow } from '@renderer/lib/hooks'
import { DASH, fmtCount, fmtMinutes } from '@renderer/lib/format'
import { Card, CardHeader, LinkButton, ProgressBar } from '@renderer/components/primitives'
import { sittingToday, sittingView } from './liveModel'

const TONE_COLOR = {
  sage: 'var(--color-sage)',
  amber: 'var(--color-amber)',
  due: 'var(--color-amber)',
  off: 'var(--color-hairline-strong)'
} as const

/** Card height the stretch, bar and line need (header and padding included). */
const BASE_PX = 190
/** One detail row (33 px) — the rows show only when at least two fit. */
const ROW_PX = 33

export default function SittingCard({ room = 0 }: { room?: number }): JSX.Element {
  const sitting = useAppStore((s) => s.sitting)
  const breaks = useAppStore((s) => s.settings?.breaks) ?? DEFAULT_SETTINGS.breaks
  const minutes = useAppStore((s) => s.today?.minutes)
  const openSettings = useAppStore((s) => s.openSettings)
  const now = useNow(15_000)
  // break start comes from main (sitting.breakSince), so leaving Live doesn't reset it
  const v = sittingView(sitting, breaks, now)
  const totals = useMemo(() => sittingToday(minutes), [minutes])

  // `rank`: which rows stay when only some fit (shown in list order); breaks today replaces
  // the footer, so it is never the one left out
  const all = [
    { rank: 0, label: 'Sat today', value: totals.satMinutes > 0 ? fmtMinutes(totals.satMinutes) : DASH },
    { rank: 2, label: 'Longest stretch', value: totals.longestMinutes > 0 ? fmtMinutes(totals.longestMinutes) : DASH },
    { rank: 1, label: 'Breaks today', value: fmtCount(sitting?.breaksToday ?? 0) },
    breaks.enabled
      ? { rank: 3, label: 'Remind me every', value: fmtMinutes(breaks.intervalMinutes) }
      : { rank: 3, label: 'Break reminders', value: 'off' }
  ]
  const fit = Math.max(0, Math.floor((room - BASE_PX) / ROW_PX))
  const rows = all.filter((r) => r.rank < fit)
  const detailed = rows.length >= 2

  return (
    <Card dense className="flex h-full min-w-0 flex-col" aria-label="Sitting">
      <CardHeader eyebrow="Sitting" icon="coffee" />
      <p className="flex flex-wrap items-baseline gap-x-1.5">
        <span className={`type-h2 whitespace-nowrap ${v.sittingNow ? 'text-text' : 'text-text-faint'}`}>{v.value}</span>
        <span className="type-caption text-text-dim">{v.sittingNow ? 'in your chair' : 'not sitting'}</span>
      </p>
      {v.progress !== null && (
        <ProgressBar
          className="mt-3"
          value={v.progress}
          color={TONE_COLOR[v.tone]}
          pulse={v.tone === 'due'}
          label="Sitting time toward the next break"
        />
      )}
      <p className={`mt-3 flex flex-wrap items-center gap-x-2 type-caption ${v.tone === 'due' ? 'text-amber' : 'text-text-dim'}`}>
        <span>{v.line}</span>
        {v.offerTurnOn && <LinkButton onClick={() => openSettings('notifications')}>Turn on</LinkButton>}
      </p>
      {detailed ? (
        // the breaks footer becomes one of the rows
        <dl className="mt-auto flex flex-col pt-4">
          {rows.map((r) => (
            <div key={r.label} className="flex min-h-[33px] items-center justify-between gap-3 border-t border-white/[0.06]">
              <dt className="truncate type-caption text-text-dim">{r.label}</dt>
              <dd className="shrink-0 font-mono text-[12px] leading-4 text-text tabular-nums">{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-auto pt-3 type-caption text-text-faint">{v.footer}</p>
      )}
    </Card>
  )
}
