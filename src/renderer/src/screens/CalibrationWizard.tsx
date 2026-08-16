import { useEffect, useState, type JSX } from 'react'
import { detectionController } from '@renderer/detection/controller'
import type { PlacementCheck } from '@renderer/posture/calibration'
import { useAppStore } from '@renderer/state/store'
import CameraFeed from '@renderer/components/CameraFeed'
import SpineGlyph from '@renderer/components/SpineGlyph'
import { Button } from '@renderer/components/primitives'

type WizardStep = 'position' | 'capture' | 'done'

function CheckRow({ ok, partial, label, hint }: { ok: boolean; partial?: boolean; label: string; hint?: string }): JSX.Element {
  const symbol = ok ? '✓' : partial ? '◐' : '✕'
  const color = ok ? 'text-sage' : partial ? 'text-amber' : 'text-coral'
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex items-center gap-2 text-[13px] text-text">
        <span className={`w-4 text-center font-mono ${color}`}>{symbol}</span>
        {label}
      </span>
      {!ok && hint && <span className="pl-6 text-xs text-text-faint">{hint}</span>}
    </li>
  )
}

function PlacementChecklist({ placement }: { placement: PlacementCheck | null }): JSX.Element {
  const p = placement
  const verdict = p?.verdict ?? 'unusable'
  const verdictText =
    verdict === 'good'
      ? 'Placement: good'
      : verdict === 'workable'
        ? 'Placement: workable — tracking may be less precise'
        : 'Placement: not usable yet'
  const verdictColor = verdict === 'good' ? 'text-sage' : verdict === 'workable' ? 'text-amber' : 'text-coral'

  return (
    <div className="rounded-2xl bg-card p-5 ring-1 ring-white/8">
      <p className="mb-3 text-xs font-medium text-text-faint uppercase">Camera check</p>
      <ul className="flex flex-col gap-2">
        <CheckRow ok={p?.faceVisible ?? false} label="Face visible" hint="Make sure your face is in frame and lit." />
        <CheckRow
          ok={p?.shouldersVisible ?? false}
          partial={p?.faceVisible}
          label="Shoulders visible"
          hint="Move back or lower the camera so both shoulders show. Face-only works, but less precisely."
        />
        <CheckRow
          ok={p?.earsVisible ?? false}
          partial={p?.eyesVisible}
          label="Ears visible"
          hint="Turn slightly toward the camera, or raise it closer to eye level."
        />
      </ul>
      <p className={`mt-4 border-t border-hairline pt-3 text-[13px] ${verdictColor}`}>{verdictText}</p>
    </div>
  )
}

export default function CalibrationWizard(): JSX.Element {
  const [step, setStep] = useState<WizardStep>('position')
  const calibration = useAppStore((s) => s.calibration)
  const setRoute = useAppStore((s) => s.setRoute)

  useEffect(() => {
    detectionController.startPlacementCheck()
    return () => detectionController.cancelCalibration()
  }, [])

  useEffect(() => {
    if (calibration.phase === 'done') setStep('done')
  }, [calibration.phase])

  const capturing = calibration.phase === 'capturing' || calibration.phase === 'countdown'
  const canContinue = calibration.placement?.verdict === 'good' || calibration.placement?.verdict === 'workable'

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center justify-center gap-6">
        {(['Position', 'Capture', 'Done'] as const).map((label, i) => {
          const idx = ['position', 'capture', 'done'].indexOf(step)
          const active = i <= idx
          return (
            <span key={label} className={`flex items-center gap-1.5 text-xs ${active ? 'text-sage' : 'text-text-faint'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-sage' : 'bg-hairline'}`} />
              {label}
            </span>
          )
        })}
      </div>

      {step === 'position' && (
        <div className="flex min-h-0 flex-1 gap-6">
          <div className="min-w-0 flex-[3]">
            <CameraFeed showAway={false} />
          </div>
          <div className="flex w-72 shrink-0 flex-col gap-4">
            <PlacementChecklist placement={calibration.placement} />
            <Button variant="primary" disabled={!canContinue} onClick={() => setStep('capture')}>
              Continue
            </Button>
            <Button variant="ghost" onClick={() => setRoute('dashboard')}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {step === 'capture' && (
        <div className="flex min-h-0 flex-1 flex-col items-center gap-4">
          <div className="text-center">
            <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
              Sit the way you'd like to sit all day.
            </h1>
            <p className="mt-1 text-[13px] text-text-dim">
              Upright but relaxed — shoulders level, screen at eye height. This becomes your baseline.
            </p>
          </div>
          <div className="relative w-full max-w-xl">
            <CameraFeed showAway={false} />
            {calibration.phase === 'countdown' && (
              <div className="absolute inset-0 flex items-center justify-center rounded-[20px] bg-ink/50">
                <span className="font-display text-5xl font-semibold text-text">{calibration.countdownValue}</span>
              </div>
            )}
            {calibration.phase === 'capturing' && (
              <div className="absolute inset-x-6 bottom-4 rounded-full bg-ink/70 p-1">
                <div
                  className="h-1.5 rounded-full transition-all"
                  style={{
                    width: `${Math.round(calibration.progress * 100)}%`,
                    backgroundColor: calibration.banner === 'hold' ? 'var(--color-amber)' : 'var(--color-sage)'
                  }}
                />
              </div>
            )}
          </div>
          {calibration.phase === 'capturing' ? (
            <p className="font-mono text-[13px] text-text-dim">
              {calibration.banner === 'hold' ? 'Hold still — re-acquiring…' : 'Hold it… capturing'}
            </p>
          ) : calibration.phase === 'failed' ? (
            <div className="text-center">
              <p className="text-[13px] text-coral">
                {calibration.failReason === 'unstable'
                  ? "Couldn't get a steady read — please hold still and retry."
                  : "Couldn't see you clearly — adjust lighting or camera placement and retry."}
              </p>
              <div className="mt-3 flex justify-center gap-2">
                <Button variant="primary" onClick={() => detectionController.beginCountdown()}>
                  Retry capture
                </Button>
                <Button variant="ghost" onClick={() => setStep('position')}>
                  Back
                </Button>
              </div>
            </div>
          ) : calibration.phase !== 'countdown' ? (
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => detectionController.beginCountdown()}>
                Capture my baseline
              </Button>
              <Button variant="ghost" disabled={capturing} onClick={() => setStep('position')}>
                Back
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {step === 'done' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <SpineGlyph size={120} issue={null} stage={0} />
          <h1 className="font-display text-3xl font-semibold tracking-tight text-text">Baseline captured.</h1>
          <p className="max-w-md text-[13px] text-text-dim">
            SitSense now measures every frame against this posture. Recalibrate any time you move your desk
            or camera.
          </p>
          <div className="mt-2 flex gap-2">
            <Button variant="primary" onClick={() => setRoute('dashboard')}>
              Start monitoring
            </Button>
            <Button variant="ghost" onClick={() => setStep('capture')}>
              Redo capture
            </Button>
          </div>
          <p className="text-xs text-text-faint">Your baseline is stored only on this device.</p>
        </div>
      )}
    </div>
  )
}
