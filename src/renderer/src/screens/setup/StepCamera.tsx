// Setup step 1 — Camera (ui-v3.md §7.2): make sure SitSense can measure what it needs
// before coaching begins. No session runs here, so nothing can be saved yet.

import { useEffect, type JSX } from 'react'
import type { CameraError } from '@shared/posture'
import { useSetupProbe } from '@renderer/detection/setup-ui'
import { Icon, type IconName } from '@renderer/components/icons'
import { Button, Kbd, Select, Tooltip } from '@renderer/components/primitives'
import type { Breakpoint } from '@renderer/lib/hooks'
import { useAppStore } from '@renderer/state/store'
import type { Settings } from '@shared/settings'
import { aiLabel, aiSetupState, backWarning, blockedCopy, probeRows } from './copy'
import { ProbeMark, SetupCamera, SetupColumns, StepEyebrow } from './parts'

const CAMERA_ERROR: Record<Exclude<CameraError, null>, string> = {
  denied: 'Camera access is blocked',
  'not-found': 'No camera found',
  'in-use': 'Another app is using the camera'
}

export default function StepCamera({
  bp,
  onStart,
  onOpenAi
}: {
  bp: Breakpoint
  onStart: () => void
  /** the AI models sheet (setup keeps running behind it) */
  onOpenAi: () => void
}): JSX.Element {
  const probe = useSetupProbe()
  const view = useSetupProbe((s) => s.view)
  const settings = useAppStore((s) => s.settings)
  return (
    <SetupColumns
      bp={bp}
      center
      left={
        <>
          <SetupCamera view={view} />
          <CameraTips compact={bp === 'compact'} settings={settings} />
        </>
      }
      right={<CameraPanel bp={bp} probe={probe} onStart={onStart} onOpenAi={onOpenAi} />}
    />
  )
}

function CameraPanel({
  bp,
  probe,
  onStart,
  onOpenAi
}: {
  bp: Breakpoint
  probe: ReturnType<typeof useSetupProbe.getState>
  onStart: () => void
  onOpenAi: () => void
}): JSX.Element {
  const compact = bp === 'compact'
  const running = useAppStore((s) => s.detection.running)
  const cameraError = useAppStore((s) => s.detection.cameraError)
  const paused = useAppStore((s) => s.pause.paused)
  const suspended = useAppStore((s) => s.setup.suspended)
  const detectorError = useAppStore((s) => s.detectorError)
  const settings = useAppStore((s) => s.settings)
  const cameras = useAppStore((s) => s.cameras)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const hasBaseline = !!settings?.calibration

  const blocked = blockedCopy({ suspended }, { paused, cameraError: cameraError !== null, detectorError })
  const rows = probeRows(probe, { running, cameraError: cameraError ? CAMERA_ERROR[cameraError] : null })
  const ai = aiSetupState(settings)
  const warning = backWarning(probe, ai)
  const canStart = !blocked && probe.ready

  // Enter starts coaching (§7.2) — unless focus is on something that handles Enter itself
  useEffect(() => {
    if (!canStart) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.repeat) return
      const el = document.activeElement
      if (el && el !== document.body && el.closest('button, a, input, select, textarea, [role="dialog"]')) return
      e.preventDefault()
      onStart()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canStart, onStart])

  const pickedCamera = settings?.cameraDeviceId ?? ''

  return (
    <div className="flex flex-col">
      <StepEyebrow n={1} />
      <h1 id="setup-primary" className={`mt-2 text-text ${compact ? 'type-h2' : 'type-h1'}`}>
        {blocked ? blocked.text : 'Let’s check your camera.'}
      </h1>
      <p className={`mt-2 max-w-[46ch] text-text-dim ${compact ? 'type-body' : 'type-body-lg'}`}>
        {blocked
          ? blocked.sub
          : 'Sit where you normally work. Any camera angle is fine — your head and at least one shoulder need to be in the picture.'}
      </p>

      {cameras.length > 1 && !blocked && (
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="type-caption text-text-dim">Camera</span>
          <Select
            value={pickedCamera}
            ariaLabel="Camera"
            onChange={(v) => void patchSettings({ cameraDeviceId: v || null })}
            options={[
              ...(pickedCamera ? [] : [{ value: '', label: 'Default camera' }]),
              ...cameras.map((c, i) => ({ value: c.deviceId, label: c.label || `Camera ${i + 1}` }))
            ]}
          />
        </label>
      )}

      <p className={`type-micro text-text-faint ${compact ? 'mt-4' : 'mt-6'}`}>What I can see</p>
      <ul aria-label="What SitSense can see" aria-live="polite" className={`flex flex-col ${compact ? 'mt-1' : 'mt-2'}`}>
        {rows.map((r) => (
          <li key={r.id} className={`flex items-start gap-3 ${compact ? 'min-h-7 py-1' : 'min-h-9 py-2'}`}>
            <span className="mt-px">
              <ProbeMark tone={r.tone} />
            </span>
            <div className="min-w-0 flex-1">
              <p
                key={r.text}
                className={`${compact ? 'type-body' : 'type-body-lg'} ${
                  r.tone === 'pending' ? 'text-text-faint' : 'text-text'
                } motion-safe:animate-[fadeIn_150ms_ease-out]`}
              >
                {r.text}
              </p>
              {r.detail && <p className="mt-0.5 type-caption text-text-dim">{r.detail}</p>}
            </div>
          </li>
        ))}
      </ul>

      <div className={`flex flex-col gap-3 ${compact ? 'pt-4' : 'pt-8'}`}>
        {warning && (
          <div className="flex gap-2">
            <Icon name="alert" size={16} className="mt-px shrink-0 text-amber" />
            <div className="flex min-w-0 flex-col items-start gap-1.5">
              <p className="type-caption text-amber">{warning}</p>
              {ai === 'none' || ai === 'turned-off' ? (
                <Button variant="ghost" size="sm" icon="spark" ringOn="setup" className="-ml-2.5" onClick={onOpenAi}>
                  {ai === 'none' ? 'Connect an AI model' : 'Turn on your AI model'}
                </Button>
              ) : ai === 'off-in-setup' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="spark"
                  ringOn="setup"
                  className="-ml-2.5"
                  onClick={() => void patchSettings({ ai: { useInSetup: true } })}
                >
                  Turn on
                </Button>
              ) : null}
            </div>
          </div>
        )}
        {hasBaseline && !blocked && (
          <p className="type-caption text-text-faint">Redoing setup replaces your saved posture once the new one is confirmed.</p>
        )}
        <div className="flex items-center gap-3">
          {blocked ? (
            <BlockedAction />
          ) : (
            <StartButton enabled={canStart} onStart={onStart} />
          )}
          {canStart && (
            <span className="flex items-center gap-1.5 type-caption text-text-faint" aria-hidden>
              or press <Kbd>Enter</Kbd>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function StartButton({ enabled, onStart }: { enabled: boolean; onStart: () => void }): JSX.Element {
  // aria-disabled, not disabled: the button stays focusable with its own focus ring and
  // name, and keeps the mouse events its tooltip needs
  return (
    <Tooltip content="Sit in view of the camera first — your head and a shoulder." disabled={enabled}>
      <Button
        variant="primary"
        size="lg"
        iconRight="arrow-right"
        ringOn="setup"
        aria-disabled={!enabled || undefined}
        // dim the fill, not the element: an element opacity would fade the focus ring too
        className={enabled ? '' : 'cursor-not-allowed bg-sage/40! text-ink/80! hover:brightness-100!'}
        onClick={enabled ? onStart : undefined}
      >
        Start coaching
      </Button>
    </Tooltip>
  )
}

function BlockedAction(): JSX.Element | null {
  const paused = useAppStore((s) => s.pause.paused || s.setup.suspended === 'paused')
  if (!paused) return null
  return (
    <Button variant="primary" size="lg" icon="play" ringOn="setup" onClick={() => void window.sitsense.setPause(false)}>
      Resume monitoring
    </Button>
  )
}

const TIPS: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'camera', title: 'Any angle works', body: 'Front, side or in between — only part of you needs to be in the picture.' },
  { icon: 'setup', title: 'Your real workspace', body: 'Chair, screen and keyboard where they always are, so the coaching fits your day.' },
  { icon: 'lock', title: 'Stays on this PC', body: 'The video never leaves your computer. Only a few numbers are saved.' }
]

/** The privacy tip must not promise more than is true: a cloud reviewer gets an image. */
function privacyTip(settings: Settings | null): { icon: IconName; title: string; body: string } {
  if (aiSetupState(settings) !== 'on') return TIPS[2]
  const what = settings?.ai.share === 'snapshot' ? 'one small camera snapshot' : 'a pose sketch (no camera image)'
  return {
    icon: 'lock',
    title: 'What leaves this PC',
    body: `Video stays on this PC. For the second opinion, ${what} goes to ${aiLabel(settings) ?? 'your AI model'}.`
  }
}

function CameraTips({ compact, settings }: { compact: boolean; settings: Settings | null }): JSX.Element {
  const tips = [TIPS[0], TIPS[1], privacyTip(settings)]
  return (
    <ul className={`grid gap-4 ${compact ? 'grid-cols-1 gap-2.5' : 'grid-cols-3'}`} aria-label="Tips">
      {(compact ? tips.slice(0, 2) : tips).map((t) => (
        <li key={t.title} className={`flex gap-3 ${compact ? 'items-center' : 'flex-col'}`}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.04] text-text-dim ring-1 ring-white/[0.06]">
            <Icon name={t.icon} size={16} />
          </span>
          <div className="min-w-0">
            <p className="type-body font-medium text-text">{t.title}</p>
            {!compact && <p className="mt-0.5 type-caption text-text-dim">{t.body}</p>}
          </div>
        </li>
      ))}
    </ul>
  )
}
