// Setup step 3 — Saved (ui-v3.md §7.6): the good posture is stored; say what was measured,
// who verified it, and hand over to monitoring.

import { useEffect, useRef, type JSX } from 'react'
import SpineGlyph from '@renderer/components/SpineGlyph'
import { Icon } from '@renderer/components/icons'
import { Button, Chip } from '@renderer/components/primitives'
import type { Breakpoint } from '@renderer/lib/hooks'
import { useAppStore } from '@renderer/state/store'
import { aiSetupState, baselineReadout, unverifiedCopy, verificationBadge } from './copy'

export default function StepSaved({
  bp,
  onRedo,
  onOpenAi
}: {
  bp: Breakpoint
  onRedo: () => void
  onOpenAi: () => void
}): JSX.Element {
  const compact = bp === 'compact'
  const setup = useAppStore((s) => s.setup)
  const paused = useAppStore((s) => s.pause.paused)
  const settings = useAppStore((s) => s.settings)
  const setRoute = useAppStore((s) => s.setRoute)
  const actionsRef = useRef<HTMLDivElement>(null)
  const summary = setup.baselineSummary
  const failed = setup.saveError !== null
  const reviewer = setup.reviewResult?.verdict === 'good' ? setup.reviewResult : null
  const badge = verificationBadge(setup)
  const note = failed ? null : unverifiedCopy(summary, setup.unverifiedChecks, aiSetupState(settings))
  // a forced save is the user's choice — it is saved, but never called good (§7.3 language rules)
  const headline = failed
    ? 'Couldn’t save your posture.'
    : summary?.forced
      ? 'Your posture is saved — unverified.'
      : 'This is your good posture.'

  // keyboard users land on the next step
  useEffect(() => {
    const active = document.activeElement
    if (active && active !== document.body && !active.closest('main, [data-setup-body]')) return
    actionsRef.current?.querySelector('button')?.focus()
  }, [])

  return (
    <div className={`flex h-full flex-col items-center justify-center text-center ${compact ? 'gap-4 px-6 pb-6' : 'gap-5 px-8 pb-10'}`}>
      <p className="sr-only" aria-live="polite">
        {headline}
      </p>
      {failed ? (
        <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-card-2 text-coral">
          <Icon name="alert" size={32} />
        </span>
      ) : (
        <div className="relative motion-safe:animate-[ss-reveal_600ms_ease-out_backwards]">
          <SpineGlyph size={compact ? 84 : 120} issue={null} stage={0} breathing />
        </div>
      )}

      <div className="flex max-w-[560px] flex-col items-center gap-2">
        <p className="type-micro text-text-faint">{failed ? 'Posture setup' : 'Step 3 of 3'}</p>
        <h1 id="setup-primary" className={`${compact ? 'type-h2' : 'type-h1'} ${failed ? 'text-coral' : 'text-text'}`}>
          {headline}
        </h1>
        {failed ? (
          <p className="type-body-lg text-text-dim">Redo setup to try again.</p>
        ) : (
          summary && <p className="type-value-lg text-text-dim">{baselineReadout(summary)}</p>
        )}
      </div>

      {!failed && badge && (
        <Chip tone={badge.tone} size="md" icon={badge.tone === 'sage' ? 'check' : 'alert'}>
          {badge.text}
        </Chip>
      )}

      {!failed && reviewer && (
        <figure className="max-w-[480px] border-l-2 border-sage/50 pl-4 text-left">
          <blockquote className="type-body-lg text-text">“{reviewer.summary}”</blockquote>
          <figcaption className="mt-1 type-caption text-text-faint">
            {reviewer.label} · {reviewer.model}
          </figcaption>
        </figure>
      )}

      {!failed && summary?.forced && (
        <p className="max-w-[52ch] type-body text-text-dim">
          SitSense couldn’t confirm it. Your score will be marked unverified until you redo setup.
        </p>
      )}

      {note && (
        <div className="surface-raised flex max-w-[520px] items-center gap-3 rounded-xl px-4 py-3 text-left">
          <p className="min-w-0 flex-1 type-body text-text-dim">{note.text}</p>
          {note.linkToSettings && (
            <Button size="sm" ringOn="card-2" onClick={onOpenAi}>
              Open AI settings
            </Button>
          )}
        </div>
      )}

      <div ref={actionsRef} className="mt-2 flex items-center gap-3">
        {failed ? (
          <Button variant="primary" size="lg" icon="refresh" ringOn="setup" onClick={onRedo}>
            Redo setup
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              size="lg"
              iconRight="arrow-right"
              ringOn="setup"
              onClick={() => {
                // Saved stays on screen through a pause — "Start monitoring" means it
                if (paused) void window.sitsense.setPause(false)
                setRoute('live')
              }}
            >
              Start monitoring
            </Button>
            <Button variant="ghost" size="lg" ringOn="setup" onClick={onRedo}>
              Redo setup
            </Button>
          </>
        )}
      </div>

      {!failed && (
        <p className="flex items-center gap-1.5 type-caption text-text-faint">
          <Icon name="lock" size={14} />
          Only these numbers are stored, on this device.
        </p>
      )}
    </div>
  )
}
