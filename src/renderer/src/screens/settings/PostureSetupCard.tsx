// "Your good posture" (ui-v3 §6.2 General / Posture detection): one component, two places.

import type { JSX } from 'react'
import SpineGlyph from '@renderer/components/SpineGlyph'
import { Button, Tooltip } from '@renderer/components/primitives'
import { Icon } from '@renderer/components/icons'
import { setupLine } from '@renderer/components/ai-settings'
import { detectionController } from '@renderer/detection/controller'
import { useNow } from '@renderer/lib/hooks'
import { useAppStore } from '@renderer/state/store'
import { SettingsCard } from './parts'

export default function PostureSetupCard(): JSX.Element {
  const baseline = useAppStore((s) => s.settings?.calibration ?? null)
  const mismatch = useAppStore((s) => s.baselineCameraMismatch)
  const openSetup = useAppStore((s) => s.openSetup)
  const now = useNow(60_000)
  const line = baseline ? setupLine(baseline, now) : null

  return (
    <SettingsCard span={12} eyebrow="Posture setup">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
        <div className="flex h-16 w-12 shrink-0 items-center justify-center" aria-hidden>
          <SpineGlyph
            size={48}
            issue={null}
            stage={line ? (line.verified ? 0 : 1) : 0}
            mode={line ? 'normal' : 'off'}
            breathing={false}
          />
        </div>
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <p className="type-title text-text">Your good posture</p>
          {line ? (
            <p className="flex flex-wrap items-center gap-x-1.5 type-body text-text-dim">
              <Tooltip content={`Saved ${line.when}`}>
                <span tabIndex={0} className="rounded focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none">
                  {line.ago}
                </span>
              </Tooltip>
              <span aria-hidden className="text-text-faint">
                ·
              </span>
              <span>{line.view}</span>
              <span aria-hidden className="text-text-faint">
                ·
              </span>
              <span className={`inline-flex items-center gap-1 ${line.verified ? 'text-sage' : 'text-amber'}`}>
                <Icon name={line.verified ? 'check' : 'alert'} size={14} />
                {line.verdict}
              </span>
            </p>
          ) : (
            <p className="type-body text-text-dim">
              Not set up yet. SitSense coaches you into a good posture and saves it for you — it takes about a minute.
            </p>
          )}
          <p className="type-caption text-text-faint">Redo it after moving your camera, desk or chair.</p>
        </div>
        <Button variant="primary" icon={line ? 'refresh' : 'setup'} ringOn="card" onClick={() => openSetup('settings')}>
          {line ? 'Redo posture setup' : 'Set up posture'}
        </Button>
      </div>
      {line && !line.verified && (
        <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber/[0.07] px-3 py-2.5 type-caption text-text-dim ring-1 ring-amber/15">
          <Icon name="info" size={14} className="mt-px shrink-0 text-amber" />
          <span>
            SitSense couldn’t confirm this posture from your camera, so your score is marked unverified. Redo setup from a
            view that shows your hips, or connect an AI model for a second opinion.
          </span>
        </p>
      )}
      {line && mismatch && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-white/[0.03] px-3 py-2.5 ring-1 ring-white/[0.06]">
          <p className="min-w-0 flex-1 basis-60 type-caption text-text-dim">
            Your posture was saved with a different camera, so it isn’t being used right now. Redo setup, or keep it for
            this camera.
          </p>
          <Button size="sm" variant="secondary" ringOn="card" onClick={() => detectionController.keepBaselineForThisCamera()}>
            Keep it for this camera
          </Button>
        </div>
      )}
    </SettingsCard>
  )
}
