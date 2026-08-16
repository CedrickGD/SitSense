import { useEffect, useRef, useState, type JSX } from 'react'
import type { CameraError } from '@shared/posture'
import { detectionController } from '@renderer/detection/controller'
import { LM } from '@renderer/posture/constants'
import type { Landmark } from '@renderer/posture/types'
import { useAppStore } from '@renderer/state/store'
import { STAGE_COLOR } from '@renderer/lib/ui'
import { Button, EmptyState } from './primitives'

function PoseOverlay({ landmarks, aspect }: { landmarks: Landmark[]; aspect: number }): JSX.Element {
  const color = STAGE_COLOR[useAppStore((s) => s.snapshot?.worstStage ?? 0)]
  // viewBox mirrors the video's intrinsic aspect and 'slice' crops exactly like
  // object-cover, so overlay points land on the pixels they were detected on
  const vw = 100
  const vh = 100 / (aspect || 4 / 3)
  const pts = [LM.nose, LM.leftEyeOuter, LM.rightEyeOuter, LM.leftEar, LM.rightEar, LM.leftShoulder, LM.rightShoulder]
  const seg = (a: number, b: number): JSX.Element | null => {
    const pa = landmarks[a]
    const pb = landmarks[b]
    if (!pa || !pb || (pa.visibility ?? 0) < 0.5 || (pb.visibility ?? 0) < 0.5) return null
    return (
      <line
        key={`${a}-${b}`}
        x1={pa.x * vw}
        y1={pa.y * vh}
        x2={pb.x * vw}
        y2={pb.y * vh}
        stroke={color}
        strokeWidth={0.6}
        opacity={0.8}
      />
    )
  }
  const earMidX = ((landmarks[LM.leftEar]?.x ?? 0) + (landmarks[LM.rightEar]?.x ?? 0)) / 2
  const earMidY = ((landmarks[LM.leftEar]?.y ?? 0) + (landmarks[LM.rightEar]?.y ?? 0)) / 2
  const shMidX = ((landmarks[LM.leftShoulder]?.x ?? 0) + (landmarks[LM.rightShoulder]?.x ?? 0)) / 2
  const shMidY = ((landmarks[LM.leftShoulder]?.y ?? 0) + (landmarks[LM.rightShoulder]?.y ?? 0)) / 2
  const neckVisible =
    (landmarks[LM.leftEar]?.visibility ?? 0) >= 0.5 &&
    (landmarks[LM.rightEar]?.visibility ?? 0) >= 0.5 &&
    (landmarks[LM.leftShoulder]?.visibility ?? 0) >= 0.5 &&
    (landmarks[LM.rightShoulder]?.visibility ?? 0) >= 0.5

  return (
    <svg
      viewBox={`0 0 ${vw} ${vh}`}
      preserveAspectRatio="xMidYMid slice"
      className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100"
    >
      {seg(LM.leftShoulder, LM.rightShoulder)}
      {seg(LM.leftEar, LM.rightEar)}
      {neckVisible && (
        <line
          x1={earMidX * vw}
          y1={earMidY * vh}
          x2={shMidX * vw}
          y2={shMidY * vh}
          stroke={color}
          strokeWidth={0.6}
          opacity={0.8}
        />
      )}
      {pts.map((i) => {
        const p = landmarks[i]
        if (!p) return null
        const dim = (p.visibility ?? 0) < 0.5
        return (
          <circle
            key={i}
            cx={p.x * vw}
            cy={p.y * vh}
            r={1.1}
            fill={color}
            opacity={dim ? 0.35 : 0.85}
            strokeDasharray={dim ? '1 1' : undefined}
          />
        )
      })}
    </svg>
  )
}

function CameraErrorState({ error }: { error: Exclude<CameraError, null> }): JSX.Element {
  const camIcon = (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <rect x="6" y="18" width="36" height="28" rx="6" />
      <path d="M42 28l14-7v22l-14-7" />
      {error === 'denied' && <path d="M10 52L54 12" stroke="var(--color-amber)" />}
      {error === 'in-use' && <circle cx="24" cy="32" r="6" stroke="var(--color-amber)" />}
    </svg>
  )
  if (error === 'not-found') {
    return (
      <EmptyState
        icon={camIcon}
        headline="No camera detected"
        body="Connect a webcam, then scan again. SitSense needs one to see your posture."
        actions={<Button onClick={() => detectionController.restart()}>Scan for cameras</Button>}
      />
    )
  }
  if (error === 'denied') {
    return (
      <EmptyState
        icon={camIcon}
        headline="Camera access is off"
        body="Windows is blocking camera access for desktop apps. Allow it under Privacy & security → Camera, then come back."
        actions={<Button onClick={() => detectionController.restart()}>Check again</Button>}
      />
    )
  }
  return (
    <EmptyState
      icon={camIcon}
      headline="Your camera is busy"
      body="Another app is using the camera, or the Windows camera toggle is off. Close the other app or pick a different camera."
      actions={<Button onClick={() => detectionController.restart()}>Try again</Button>}
    />
  )
}

interface CameraFeedProps {
  /** show the away state inside the frame */
  showAway?: boolean
}

export default function CameraFeed({ showAway = true }: CameraFeedProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [aspect, setAspect] = useState(4 / 3)
  const detection = useAppStore((s) => s.detection)
  const overlay = useAppStore((s) => s.overlay)
  const snapshot = useAppStore((s) => s.snapshot)
  const pause = useAppStore((s) => s.pause)

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onMeta = (): void => {
      if (v.videoWidth > 0 && v.videoHeight > 0) setAspect(v.videoWidth / v.videoHeight)
    }
    v.addEventListener('loadedmetadata', onMeta)
    // share the controller's MediaStream; reattach whenever detection restarts
    const attach = (): void => {
      const stream = detectionController.getStream()
      if (v.srcObject !== stream) {
        v.srcObject = stream
        v.play().catch(() => undefined)
      }
    }
    attach()
    const timer = setInterval(attach, 1000)
    return () => {
      v.removeEventListener('loadedmetadata', onMeta)
      clearInterval(timer)
    }
  }, [detection.running])

  const away = showAway && snapshot?.presence === 'away'

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-[20px] bg-surface ring-1 ring-white/8">
      {detection.cameraError ? (
        <CameraErrorState error={detection.cameraError} />
      ) : (
        <>
          <video
            ref={videoRef}
            muted
            playsInline
            className={`h-full w-full -scale-x-100 object-cover transition-all duration-300 ${
              pause.paused ? 'opacity-40 blur-md saturate-0' : ''
            }`}
          />
          {overlay && !pause.paused && <PoseOverlay landmarks={overlay} aspect={aspect} />}
          {/* plumb line: the calibrated center, the app's alignment motif */}
          {!pause.paused && <div className="absolute inset-y-0 left-1/2 w-px bg-white/10" />}
          {away && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink/60">
              <div className="text-center">
                <p className="font-display text-lg font-semibold text-text-dim">Looks like you stepped away</p>
                <p className="mt-1 text-xs text-text-faint">
                  Monitoring resumes the moment you're back in frame.
                </p>
              </div>
            </div>
          )}
          <div className="absolute top-3 left-3">
            {pause.paused ? (
              <span className="flex items-center gap-1.5 rounded-full bg-ink/70 px-2.5 py-1 text-xs text-slate-cool">
                ⏸ Paused
              </span>
            ) : detection.running ? (
              <span className="flex items-center gap-1.5 rounded-full bg-ink/70 px-2.5 py-1 text-xs text-text-dim">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sage" /> Monitoring
              </span>
            ) : (
              <span className="rounded-full bg-ink/70 px-2.5 py-1 text-xs text-text-faint">● Off</span>
            )}
          </div>
          <div
            className="absolute top-3 right-3 flex items-center gap-1 rounded-full bg-ink/70 px-2.5 py-1 text-[11px] text-text-faint"
            title="All processing happens on this device. Nothing is uploaded — ever."
          >
            <svg width="10" height="10" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M9 1.5l6 2.5v4c0 3.6-2.4 6.4-6 8-3.6-1.6-6-4.4-6-8V4z" />
            </svg>
            on-device
          </div>
        </>
      )}
    </div>
  )
}
