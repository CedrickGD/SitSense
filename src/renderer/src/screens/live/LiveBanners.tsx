// Live banners (docs/specs/ui-v3.md §3.7): at most one, full width above row 1, in
// priority order — camera mismatch, view changed, unverified baseline, fallback camera.

import { useState, type JSX } from 'react'
import { useAppStore } from '@renderer/state/store'
import { detectionController } from '@renderer/detection/controller'
import { useMonitoring } from '@renderer/lib/hooks'
import { useFallbackCameraNote, usableConnections } from '@renderer/components/CameraFeed'
import { Banner, Button } from '@renderer/components/primitives'
import { pickBanner } from './liveModel'

/** the sentence keeps ~20rem before the actions wrap under it (narrow windows) */
const BANNER_WRAP = '[&>span:nth-child(2)]:basis-[20rem]'

// "once per app start until dismissed": module state outlives the Live screen's remounts
const dismissed = { recalibrate: false, unverified: false }

export default function LiveBanners(): JSX.Element | null {
  const m = useMonitoring()
  const settings = useAppStore((s) => s.settings)
  const recalibrationSuggested = useAppStore((s) => s.snapshot?.recalibrationSuggested ?? false)
  const openSetup = useAppStore((s) => s.openSetup)
  const openSettings = useAppStore((s) => s.openSettings)
  const fallbackNote = useFallbackCameraNote()
  const [, rerender] = useState(0)
  const dismiss = (key: keyof typeof dismissed): void => {
    dismissed[key] = true
    rerender((n) => n + 1)
  }

  const baseline = settings?.calibration ?? null
  const which = pickBanner({
    mismatch: m.calibrated && m.mismatch,
    // only meaningful while posture is really being judged
    recalibrationSuggested: m.watching && recalibrationSuggested,
    recalibrateDismissed: dismissed.recalibrate,
    unverified: !!baseline && !baseline.verified,
    unverifiedDismissed: dismissed.unverified,
    usingFallback: m.live && fallbackNote !== null
  })
  if (!which) return null

  const redo = (
    <Button size="sm" variant="secondary" icon="setup" ringOn="card" onClick={() => openSetup()}>
      Redo posture setup
    </Button>
  )

  if (which === 'mismatch') {
    return (
      <Banner
        className={BANNER_WRAP}
        tone="amber"
        actions={
          <>
            {redo}
            <Button size="sm" variant="ghost" ringOn="card" onClick={() => detectionController.keepBaselineForThisCamera()}>
              Keep it for this camera
            </Button>
          </>
        }
      >
        This posture was set up with a different camera.
      </Banner>
    )
  }
  if (which === 'recalibrate') {
    return (
      <Banner
        className={BANNER_WRAP}
        tone="amber"
        actions={
          <>
            {redo}
            <Button size="sm" variant="ghost" ringOn="card" onClick={() => dismiss('recalibrate')}>
              Dismiss
            </Button>
          </>
        }
      >
        Your view changed a lot since setup — readings may be off.
      </Banner>
    )
  }
  if (which === 'unverified') {
    // what the camera couldn't check: without a back angle in the baseline it was the back
    const what = baseline?.trunkFwd === null ? 'back' : 'posture'
    const noAi = usableConnections(settings).length === 0
    return (
      <Banner
        className={BANNER_WRAP}
        tone="amber"
        onDismiss={() => dismiss('unverified')}
        actions={
          <>
            {redo}
            {noAi && (
              <Button size="sm" variant="ghost" ringOn="card" onClick={() => openSettings('ai')}>
                Connect an AI model for a second opinion
              </Button>
            )}
          </>
        }
      >
        Your saved posture isn't verified — SitSense couldn't check your {what} from this angle.
      </Banner>
    )
  }
  return (
    <Banner
      className={BANNER_WRAP}
      tone="slate"
      icon="camera"
      actions={
        <Button size="sm" variant="ghost" ringOn="card" onClick={() => openSettings('camera')}>
          Camera settings
        </Button>
      }
    >
      {fallbackNote}
    </Banner>
  )
}
