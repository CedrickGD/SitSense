import { useEffect, useRef, useState, type JSX } from 'react'
import type { CameraError, Stage } from '@shared/posture'
import { DEFAULT_SETTINGS, OVERLAY_PRESETS, type OverlaySettings } from '@shared/settings'
import { detectionController } from '@renderer/detection/controller'
import { LM } from '@renderer/posture/constants'
import type { Landmark } from '@renderer/posture/types'
import { useAppStore } from '@renderer/state/store'
import { formatCountdown, STAGE_COLOR, useNow } from '@renderer/lib/ui'
import MeshOverlay from './MeshOverlay'
import { Button, EmptyState } from './primitives'

/** CSS color of the overlay for the current settings and posture stage. */
function useOverlayColor(overlay: OverlaySettings): string {
  const stage = useAppStore((s) => (s.snapshot?.presence === 'active' ? s.snapshot.worstStage : 0))
  if (overlay.color === 'posture') return STAGE_COLOR[stage]
  if (overlay.color === 'custom') return overlay.customColor
  return OVERLAY_PRESETS[overlay.color]
}

type BodyPart = 'head' | 'neck' | 'shoulders'

/**
 * With a fixed overlay hue the skeleton would say nothing about posture, so
 * the part each active issue lives on takes that issue's stage color — the
 * same mapping the mesh uses for its problem-area glow.
 */
function useProblemColors(overlay: OverlaySettings): Partial<Record<BodyPart, string>> {
  const stages = useAppStore((s) => {
    const snap = s.snapshot
    if (overlay.color === 'posture' || !snap || snap.presence !== 'active') return '0,0,0'
    const i = snap.issues
    return `${Math.max(i.headForward.stage, i.tooClose.stage)},${i.sink.stage},${i.lean.stage}`
  })
  const [head, neck, shoulders] = stages.split(',').map((n) => Number(n) as Stage)
  const out: Partial<Record<BodyPart, string>> = {}
  if (head > 0) out.head = STAGE_COLOR[head]
  if (neck > 0) out.neck = STAGE_COLOR[neck]
  if (shoulders > 0) out.shoulders = STAGE_COLOR[shoulders]
  return out
}

function PoseOverlay({
  landmarks,
  aspect,
  color,
  problems
}: {
  landmarks: Landmark[]
  aspect: number
  color: string
  problems: Partial<Record<BodyPart, string>>
}): JSX.Element {
  const partColor = (part: BodyPart): string => problems[part] ?? color
  const pointPart = (i: number): BodyPart =>
    i === LM.leftShoulder || i === LM.rightShoulder ? 'shoulders' : 'head'
  // viewBox mirrors the video's intrinsic aspect and 'slice' crops exactly like
  // object-cover, so overlay points land on the pixels they were detected on
  const vw = 100
  const vh = 100 / (aspect || 4 / 3)
  const pts = [LM.nose, LM.leftEyeOuter, LM.rightEyeOuter, LM.leftEar, LM.rightEar, LM.leftShoulder, LM.rightShoulder]
  const seg = (a: number, b: number, stroke: string): JSX.Element | null => {
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
        stroke={stroke}
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
      {seg(LM.leftShoulder, LM.rightShoulder, partColor('shoulders'))}
      {seg(LM.leftEar, LM.rightEar, partColor('head'))}
      {neckVisible && (
        <line
          x1={earMidX * vw}
          y1={earMidY * vh}
          x2={shMidX * vw}
          y2={shMidY * vh}
          stroke={partColor('neck')}
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
            fill={partColor(pointPart(i))}
            opacity={dim ? 0.35 : 0.85}
            strokeDasharray={dim ? '1 1' : undefined}
          />
        )
      })}
    </svg>
  )
}

/** Inline camera switcher for the error states ("pick a different camera"). */
function CameraPicker(): JSX.Element | null {
  const cameras = useAppStore((s) => s.cameras)
  const current = useAppStore((s) => s.settings?.cameraDeviceId ?? '')
  const patchSettings = useAppStore((s) => s.patchSettings)
  if (cameras.length < 2) return null
  return (
    <select
      aria-label="Choose another camera"
      value={current}
      onChange={(e) => {
        const id = e.target.value || null
        void patchSettings({ cameraDeviceId: id, cameraLabel: cameras.find((c) => c.deviceId === id)?.label ?? null })
      }}
      className="max-w-48 truncate rounded-[10px] bg-ink px-3 py-2 text-[13px] text-text ring-1 ring-white/8 focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none"
    >
      <option value="">Default camera</option>
      {cameras.map((c) => (
        <option key={c.deviceId} value={c.deviceId}>
          {c.label}
        </option>
      ))}
    </select>
  )
}

function CameraErrorState({ error }: { error: Exclude<CameraError, null> }): JSX.Element {
  const cameraName = useAppStore((s) => {
    const id = s.settings?.cameraDeviceId
    return s.cameras.find((c) => c.deviceId === id)?.label ?? null
  })
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
        actions={
          <>
            <Button onClick={() => detectionController.restart()}>Scan for cameras</Button>
            <Button variant="ghost" onClick={() => window.sitsense.openSystemSettings('camera')}>
              Open camera settings
            </Button>
          </>
        }
      />
    )
  }
  if (error === 'denied') {
    return (
      <EmptyState
        icon={camIcon}
        headline="Camera access is off"
        body="Windows is blocking camera access for desktop apps. Allow it in Privacy settings — SitSense checks again when you come back."
        actions={
          <>
            <Button variant="primary" onClick={() => window.sitsense.openSystemSettings('camera-privacy')}>
              Open privacy settings
            </Button>
            <Button onClick={() => detectionController.restart()}>Check again</Button>
          </>
        }
      />
    )
  }
  return (
    <EmptyState
      icon={camIcon}
      headline="Your camera is busy"
      body={`Another app is using ${cameraName ?? 'the camera'}, or the Windows camera toggle is off. Close the other app or pick a different camera.`}
      actions={
        <>
          <Button onClick={() => detectionController.restart()}>Try again</Button>
          <CameraPicker />
        </>
      }
    />
  )
}

function ModelErrorState(): JSX.Element {
  return (
    <EmptyState
      icon={
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <circle cx="32" cy="32" r="22" />
          <path d="M32 20v14M32 42v2" stroke="var(--color-amber)" />
        </svg>
      }
      headline="Couldn't start posture detection"
      body="The posture model failed to load on this machine. SitSense keeps retrying; reinstalling usually fixes a damaged install."
      actions={<Button onClick={() => detectionController.restart()}>Retry now</Button>}
    />
  )
}

interface CameraFeedProps {
  /** show the away state inside the frame */
  showAway?: boolean
  /** smaller chrome for embedded previews (settings) */
  compact?: boolean
}

export default function CameraFeed({ showAway = true, compact = false }: CameraFeedProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [aspect, setAspect] = useState(4 / 3)
  const detection = useAppStore((s) => s.detection)
  const overlayStyleSetting = useAppStore((s) => s.settings?.overlay.style)
  // per-frame landmarks only matter to the skeleton style — don't re-render for them otherwise
  const overlay = useAppStore((s) => (overlayStyleSetting === 'skeleton' || s.meshUnavailable ? s.overlay : null))
  const snapshot = useAppStore((s) => s.snapshot)
  const pause = useAppStore((s) => s.pause)
  const overlaySettings = useAppStore((s) => s.settings?.overlay) ?? DEFAULT_SETTINGS.overlay
  const meshUnavailable = useAppStore((s) => s.meshUnavailable)
  const windowVisible = useAppStore((s) => s.windowVisible)
  const overlayColor = useOverlayColor(overlaySettings)
  const problemColors = useProblemColors(overlaySettings)

  const wantsMesh = overlaySettings.style === 'mesh' || overlaySettings.style === 'hologram'
  const style = wantsMesh && meshUnavailable ? 'skeleton' : overlaySettings.style
  const hologram = style === 'hologram' && !pause.paused
  const error = pause.paused ? null : detection.cameraError ? 'camera' : detection.modelError ? 'model' : null
  const showMesh = (style === 'mesh' || style === 'hologram') && !pause.paused && !error
  const now = useNow(1000, pause.paused && pause.resumeAt !== null && !compact)

  useEffect(() => {
    if (!showMesh) return
    return detectionController.acquireMesh()
  }, [showMesh])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onMeta = (): void => {
      if (v.videoWidth > 0 && v.videoHeight > 0) setAspect(v.videoWidth / v.videoHeight)
    }
    v.addEventListener('loadedmetadata', onMeta)
    // share the controller's MediaStream; reattach whenever detection restarts.
    // While the window is hidden the preview is detached, so the compositor
    // isn't decoding and painting a camera feed nobody can see.
    const attach = (): void => {
      const stream = windowVisible ? detectionController.getStream() : null
      if (v.srcObject !== stream) {
        v.srcObject = stream
        if (stream) v.play().catch(() => undefined)
      }
    }
    attach()
    const timer = windowVisible ? setInterval(attach, 1000) : undefined
    return () => {
      v.removeEventListener('loadedmetadata', onMeta)
      clearInterval(timer)
    }
  }, [detection.running, windowVisible])

  const away = showAway && snapshot?.presence === 'away'

  return (
    <div className="@container relative aspect-video w-full overflow-hidden rounded-[20px] bg-surface ring-1 ring-white/8">
      {error === 'camera' && detection.cameraError ? (
        <CameraErrorState error={detection.cameraError} />
      ) : error === 'model' ? (
        <ModelErrorState />
      ) : (
        <>
          <video
            ref={videoRef}
            muted
            playsInline
            className={`h-full w-full -scale-x-100 object-cover transition-all duration-300 ${
              pause.paused ? 'opacity-40 blur-md saturate-0' : hologram ? 'brightness-[.32] contrast-125 saturate-[.35]' : ''
            }`}
          />
          {hologram && (
            <>
              <div
                className="pointer-events-none absolute inset-0 mix-blend-screen transition-colors duration-500"
                style={{ backgroundColor: `color-mix(in srgb, ${overlayColor} 10%, transparent)` }}
              />
              <div className="hologram-scanlines pointer-events-none absolute inset-0" />
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.55)_100%)]" />
            </>
          )}
          {showMesh && <MeshOverlay />}
          {style === 'skeleton' && overlay && !pause.paused && (
            <PoseOverlay landmarks={overlay} aspect={aspect} color={overlayColor} problems={problemColors} />
          )}
          {/* plumb line: the calibrated center, the app's alignment motif */}
          {!pause.paused && <div className="absolute inset-y-0 left-1/2 w-px bg-white/10" />}
          {pause.paused && !compact && (
            // the camera is released while paused — say so instead of showing a blank frame
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-text-faint" aria-hidden>
                <path d="M3 7h3l2-2.5h8L18 7h3v12H3z" />
                <circle cx="12" cy="13" r="3.5" />
                <path d="M3 3l18 18" />
              </svg>
              <p className="text-[13px] text-text-dim">Camera is off while paused</p>
            </div>
          )}
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
          <div className={`absolute top-3 left-3 ${compact ? 'hidden' : ''}`}>
            {pause.paused ? (
              <span className="flex items-center gap-1.5 rounded-full bg-ink/70 px-2.5 py-1 text-xs text-slate-cool">
                ⏸ Paused{pause.resumeAt ? ` · ${formatCountdown(pause.resumeAt - now)} left` : ''}
              </span>
            ) : detection.running ? (
              <span className="flex items-center gap-1.5 rounded-full bg-ink/70 px-2.5 py-1 text-xs text-text-dim">
                <span className="h-1.5 w-1.5 rounded-full bg-sage motion-safe:animate-pulse" /> Monitoring
              </span>
            ) : (
              <span className="rounded-full bg-ink/70 px-2.5 py-1 text-xs text-text-faint">● Off</span>
            )}
          </div>
          <div
            className={`absolute top-3 right-3 flex items-center gap-1 rounded-full bg-ink/70 px-2.5 py-1 text-[11px] text-text-faint ${
              compact ? 'hidden' : ''
            }`}
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
