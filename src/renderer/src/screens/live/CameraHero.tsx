// Live › camera hero (docs/specs/ui-v3.md §3.2): the mirrored preview with its chips and
// overlay switcher, or — when the preview is hidden — a calm panel the same size that
// still surfaces camera / model trouble (audit: never claim "still watching" falsely).

import { useState, type JSX, type ReactNode } from 'react'
import { useAppStore } from '@renderer/state/store'
import { detectionController } from '@renderer/detection/controller'
import { useMonitoring } from '@renderer/lib/hooks'
import CameraFeed, { CAMERA_ERROR_COPY, modelErrorCopy } from '@renderer/components/CameraFeed'
import SpineGlyph from '@renderer/components/SpineGlyph'
import { Button } from '@renderer/components/primitives'
import { Icon } from '@renderer/components/icons'

function Panel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="@container flex h-full w-full flex-col items-center justify-center-safe gap-4 overflow-y-auto rounded-[20px] bg-card p-6 text-center ring-1 ring-white/[0.06] shadow-[inset_0_1px_0_rgb(255_255_255/0.035)] @max-md:gap-3 @max-md:p-4">
      {children}
    </div>
  )
}

function HiddenPreview({ onShow, focusShow }: { onShow: () => void; focusShow: boolean }): JSX.Element {
  const m = useMonitoring()
  const openSettings = useAppStore((s) => s.openSettings)
  const modelCopy = modelErrorCopy(useAppStore((s) => s.detectorErrorReason))

  if (!m.paused && m.cameraError) {
    const c = CAMERA_ERROR_COPY[m.cameraError]
    return (
      <Panel>
        <span role="alert" className="flex flex-col items-center gap-3">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-card-2 text-amber ring-1 ring-white/[0.06]">
            <Icon name="camera" size={28} />
          </span>
          <span className="type-h3 text-text">{c.headline}</span>
          <span className="max-w-[44ch] type-body-lg text-text-dim">{c.body}</span>
        </span>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" ringOn="card" onClick={() => detectionController.retryCamera()}>
            {c.action}
          </Button>
          <Button variant="ghost" ringOn="card" onClick={() => openSettings('camera')}>
            Choose another camera
          </Button>
        </div>
      </Panel>
    )
  }
  if (!m.paused && m.detectorError === 'model') {
    return (
      <Panel>
        <span role="alert" className="flex flex-col items-center gap-3">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-card-2 text-amber ring-1 ring-white/[0.06]">
            <Icon name="cpu" size={28} />
          </span>
          <span className="type-h3 text-text">{modelCopy.headline}</span>
          <span className="max-w-[44ch] type-body-lg text-text-dim">{modelCopy.body}</span>
        </span>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" ringOn="card" onClick={() => detectionController.retryCamera()}>
            {modelCopy.action}
          </Button>
          <Button variant="ghost" ringOn="card" onClick={() => openSettings('detection')}>
            Open Settings
          </Button>
        </div>
      </Panel>
    )
  }

  // only claim "still watching" when it is (audit)
  const line = m.paused
    ? 'Preview hidden — monitoring is paused.'
    : m.detectorError === 'inference'
      ? 'Preview hidden — detection is restarting…'
      : !m.running
        ? 'Preview hidden — starting the camera…'
        : !m.calibrated
          ? 'Preview hidden — set up your posture to get nudges.'
          : m.mismatch
            ? 'Preview hidden — nudges are off for this camera.'
            : 'Preview hidden — SitSense is still watching.'
  const watching = !m.paused && m.running && m.calibrated && !m.mismatch && !m.detectorError
  return (
    <Panel>
      <SpineGlyph size={88} issue={null} stage={0} mode={m.paused ? 'paused' : watching ? 'normal' : 'off'} breathing={watching} className="@max-md:h-16 @max-md:w-16" />
      <p className="type-body-lg text-text-dim" role="status">
        {line}
      </p>
      {/* after "Hide preview" the button that brought us here is gone: keep keyboard focus nearby */}
      <Button variant="ghost" size="sm" icon="eye" ringOn="card" onClick={onShow} autoFocus={focusShow}>
        Show preview
      </Button>
    </Panel>
  )
}

/** Fills its grid cell; the cell's height comes from the row (≥ 16:9 of its width). */
export default function CameraHero(): JSX.Element {
  const hidePreview = useAppStore((s) => s.settings?.general.hidePreview ?? false)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const setHidden = (v: boolean): void => void patchSettings({ general: { hidePreview: v } })
  const [hiddenHere, setHiddenHere] = useState(false)
  return hidePreview ? (
    <HiddenPreview onShow={() => setHidden(false)} focusShow={hiddenHere} />
  ) : (
    <CameraFeed
      hero
      onHide={() => {
        setHiddenHere(true)
        setHidden(true)
      }}
    />
  )
}
