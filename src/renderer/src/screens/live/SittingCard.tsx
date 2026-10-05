// Live › Sitting card (docs/specs/ui-v3.md §3.5): the current sitting stretch, progress
// toward the next break reminder, and today's breaks. Data: store.sitting (main's
// break tracker) + settings.breaks.

import type { JSX } from 'react'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { useAppStore } from '@renderer/state/store'
import { useNow } from '@renderer/lib/hooks'
import { Card, CardHeader, LinkButton, ProgressBar } from '@renderer/components/primitives'
import { sittingView } from './liveModel'

const TONE_COLOR = {
  sage: 'var(--color-sage)',
  amber: 'var(--color-amber)',
  due: 'var(--color-amber)',
  off: 'var(--color-hairline-strong)'
} as const

export default function SittingCard(): JSX.Element {
  const sitting = useAppStore((s) => s.sitting)
  const breaks = useAppStore((s) => s.settings?.breaks) ?? DEFAULT_SETTINGS.breaks
  const openSettings = useAppStore((s) => s.openSettings)
  const now = useNow(15_000)
  // break start comes from main (sitting.breakSince), so leaving Live doesn't reset it
  const v = sittingView(sitting, breaks, now)

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
      <p className="mt-auto pt-3 type-caption text-text-faint">{v.footer}</p>
    </Card>
  )
}
