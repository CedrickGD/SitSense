// The camera preview (docs/specs/ui-v3.md §3.2). One component, three looks:
//   hero    — Live: fills its parent, glass chips (status + tracking, privacy), the
//             overlay switcher and the hide button; banners outside carry the notes
//   default — posture setup: 16:9, status + privacy chips
//   compact — Settings previews: 16:9, no chrome
// It shares the controller's MediaStream and never re-renders at detection rate.

import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import type { CameraError } from '@shared/posture'
import { DEFAULT_SETTINGS, OVERLAY_PRESETS, type OverlaySettings, type OverlayStyle, type Settings } from '@shared/settings'
import type { AiConnection } from '@shared/ai'
import { isUsableConnection, usableConnections } from '@renderer/ai/helpers'
import { detectionController } from '@renderer/detection/controller'
import { useAppStore } from '@renderer/state/store'
import { STAGE_COLOR } from '@renderer/lib/ui'
import { fmtCountdown } from '@renderer/lib/format'
import { isSuspended, NOT_JUDGED_COLOR } from '@renderer/lib/score'
import { meshDimsBackdrop } from '@renderer/overlay/meshLook'
import { poseTracking, trackingLevel, TRACKING_COPY, type TrackingLevel } from '@renderer/screens/live/liveModel'
import MeshOverlay from './MeshOverlay'
import PoseLinesOverlay from './PoseLinesOverlay'
import { Button, IconButton, SegmentedControl, StatusDot, Tooltip, type SegmentOption } from './primitives'
import { Icon } from './icons'

/**
 * CSS color of the overlay for the current settings (posture mode follows the worst stage;
 * neutral while the detectors are suspended, since their stage 0 is no judgment).
 */
function useOverlayColor(overlay: OverlaySettings): string {
  // a primitive selector: re-renders only when the worst stage changes (-1 = suspended)
  const stage = useAppStore((s) =>
    s.snapshot?.presence === 'active' ? (isSuspended(s.snapshot) ? -1 : s.snapshot.worstStage) : 0
  )
  if (overlay.color === 'posture') return stage === -1 ? NOT_JUDGED_COLOR : STAGE_COLOR[stage]
  return fixedOverlayColor(overlay)
}

function fixedOverlayColor(overlay: OverlaySettings): string {
  if (overlay.color === 'custom') return overlay.customColor
  if (overlay.color === 'posture') return STAGE_COLOR[0]
  return OVERLAY_PRESETS[overlay.color]
}

// ───────────────────────────── empty states inside the frame ─────────────────────────────

/**
 * An empty state sized for the preview frame (§8.6 look: icon in a card-2 circle, h3,
 * body). The frame can be small (≈ 370×220 at the minimum window), so below 28rem of
 * width it tightens up and, as a last resort, scrolls instead of clipping.
 */
function FrameState({
  icon,
  headline,
  body,
  action,
  tone = 'neutral'
}: {
  icon: ReactNode
  headline: string
  body: string
  action?: ReactNode
  tone?: 'neutral' | 'quiet'
}): JSX.Element {
  return (
    <div
      role={tone === 'neutral' ? 'alert' : 'status'}
      className="absolute inset-0 flex flex-col items-center justify-center-safe gap-4 overflow-y-auto bg-surface p-6 text-center @max-md:gap-2 @max-md:p-3"
    >
      <span className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-full bg-card-2 text-text-dim ring-1 ring-white/[0.06] @max-md:h-12 @max-md:w-12 [&>svg]:h-9 [&>svg]:w-9 @max-md:[&>svg]:h-6 @max-md:[&>svg]:w-6">
        {icon}
      </span>
      <div className="flex flex-col items-center gap-1.5">
        <h2 className="type-h3 text-text @max-md:text-[15px] @max-md:leading-5">{headline}</h2>
        <p className="max-w-[44ch] type-body-lg text-text-dim @max-md:type-caption">{body}</p>
      </div>
      {action && <div className="flex shrink-0 flex-wrap justify-center gap-2">{action}</div>}
    </div>
  )
}

export interface FrameErrorCopy {
  headline: string
  body: string
  /** the retry button's label (every retry goes through detectionController.retryCamera()) */
  action: string
}

/**
 * One copy table for camera trouble, shared by the preview frame and Live's hidden-preview
 * panel so the two never drift apart.
 */
export const CAMERA_ERROR_COPY: Record<Exclude<CameraError, null>, FrameErrorCopy> = {
  'not-found': {
    headline: 'No camera detected',
    body: 'Connect a webcam, then scan again. SitSense needs one to see your posture.',
    action: 'Scan for cameras'
  },
  denied: {
    headline: 'Camera access is off',
    body: 'Windows is blocking camera access for desktop apps. Allow it under Privacy & security → Camera, then check again.',
    action: 'Check again'
  },
  'in-use': {
    headline: 'Your camera is busy',
    body: 'Another app is using the camera, or the Windows camera switch is off. Close the other app, or pick a different camera.',
    action: 'Try again'
  }
}

/** The posture model failed to load (same table idea as CAMERA_ERROR_COPY). */
export const MODEL_ERROR_COPY: FrameErrorCopy = {
  headline: "The posture model didn't load",
  body: "SitSense keeps retrying on its own and won't turn the camera on until it works. Switching the processing mode in Settings can help.",
  action: 'Try now'
}

/** No WebGL at all on this PC: the on-device AI cannot run until graphics are available. */
export const NO_WEBGL_COPY: FrameErrorCopy = {
  headline: "This PC's graphics can't run the posture AI",
  body: 'SitSense needs WebGL, which Windows normally provides even without a graphics card. It is switched off or broken here — updating the graphics driver usually fixes it. The camera stays off until then.',
  action: 'Check again'
}

/** The copy for the 'model' detector state, by reason. */
export function modelErrorCopy(reason: 'no-webgl' | null): FrameErrorCopy {
  return reason === 'no-webgl' ? NO_WEBGL_COPY : MODEL_ERROR_COPY
}

/** Camera problems. Every button goes through retryCamera(): it re-probes right away, or resumes if paused. */
export function CameraErrorState({ error }: { error: Exclude<CameraError, null> }): JSX.Element {
  const camIcon = (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="5.5" width="11" height="9" rx="2" />
      <path d="M13.5 9l4-2.2v6.4l-4-2.2" />
      {error === 'denied' && <path d="M3 17L17 3" stroke="var(--color-amber)" />}
      {error === 'in-use' && <circle cx="8" cy="10" r="2" stroke="var(--color-amber)" />}
    </svg>
  )
  const c = CAMERA_ERROR_COPY[error]
  return (
    <FrameState
      icon={camIcon}
      headline={c.headline}
      body={c.body}
      action={
        <Button variant="primary" ringOn="surface" onClick={() => detectionController.retryCamera()}>
          {c.action}
        </Button>
      }
    />
  )
}

/** The posture model failed to load (the camera stays off until it does). */
function ModelErrorState(): JSX.Element {
  const copy = modelErrorCopy(useAppStore((s) => s.detectorErrorReason))
  return (
    <FrameState
      icon={<Icon name="cpu" size={36} />}
      headline={copy.headline}
      body={copy.body}
      action={
        <Button variant="primary" ringOn="surface" onClick={() => detectionController.retryCamera()}>
          {copy.action}
        </Button>
      }
    />
  )
}

// ───────────────────────────── chips ─────────────────────────────

/** Glass chip over the camera (§3.2): scrim + blur, 26 px, caption. */
const GLASS_CHIP = 'surface-glass inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-full px-2.5 type-caption'

/** `Paused · 12:41` — ticks once a second, isolated so the feed doesn't re-render. */
function PausedLabel(): JSX.Element {
  const resumeAt = useAppStore((s) => s.pause.resumeAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (resumeAt === null) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [resumeAt])
  return (
    <>
      <StatusDot color="var(--color-slate-cool)" size={7} />
      <span className="text-slate-cool">Paused</span>
      {resumeAt !== null && <span className="font-mono text-[12px] text-slate-cool tabular-nums">· {fmtCountdown(resumeAt - now)}</span>}
    </>
  )
}

/** The tracking level for the chip — one selector returning a primitive (re-renders only on change). */
function useTracking(): TrackingLevel {
  return useAppStore((s) => trackingLevel(s.settings?.calibration ? s.snapshot : null, poseTracking(s.pose?.image)))
}

function TrackingText(): JSX.Element {
  const level = useTracking()
  const copy = TRACKING_COPY[level]
  return (
    <Tooltip content={copy.tip} placement="bottom" align="start">
      <span tabIndex={0} className="inline-flex min-w-0 items-center gap-1.5 rounded-full text-text/85 outline-none focus-visible:ring-2 focus-visible:ring-sage/70">
        {level === 'changed' && <StatusDot color="var(--color-amber)" size={7} />}
        <span className="truncate @max-[34rem]:hidden">{copy.text}</span>
        <span className="hidden truncate @max-[34rem]:inline">{copy.short}</span>
      </span>
    </Tooltip>
  )
}

/**
 * Top-left status chip: `● Monitoring │ Seeing head & shoulders`, `Paused · 12:41`,
 * `Starting the camera…`, or — when nothing is being judged — `● Not set up` /
 * `● Nudges off · new camera` in amber. When not paused the controller always wants the
 * camera on, so a stopped camera means it is still starting — never "off". In the setup
 * screen's preview (not hero) an uncalibrated camera just reads `Camera on`.
 */
function StatusChip({
  paused,
  running,
  tracking,
  hero
}: {
  paused: boolean
  running: boolean
  tracking: boolean
  hero: boolean
}): JSX.Element {
  const calibrated = useAppStore((s) => !!s.settings?.calibration)
  const mismatch = useAppStore((s) => s.baselineCameraMismatch)
  if (paused) {
    return (
      <span className={GLASS_CHIP} role="status">
        <PausedLabel />
      </span>
    )
  }
  if (!running) {
    return (
      <span className={`${GLASS_CHIP} text-text-dim`} role="status">
        <span className="h-3 w-3 shrink-0 rounded-full border-[1.5px] border-current border-t-transparent motion-safe:animate-[spin_0.9s_linear_infinite]" aria-hidden />
        Starting the camera…
      </span>
    )
  }
  // "Monitoring" only when posture is actually judged (nudges on)
  const notJudged = !calibrated ? (hero ? 'Not set up' : 'Camera on') : mismatch ? 'Nudges off · new camera' : null
  if (notJudged) {
    const amber = hero || calibrated
    return (
      <span className={`${GLASS_CHIP} text-text`} role="status">
        <StatusDot color={amber ? 'var(--color-amber)' : 'var(--color-sage)'} size={7} />
        <span className="shrink-0">{notJudged}</span>
        {tracking && (
          <>
            <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-white/15" />
            <TrackingText />
          </>
        )}
      </span>
    )
  }
  return (
    <span className={`${GLASS_CHIP} text-text`}>
      <StatusDot color="var(--color-sage)" pulse size={7} />
      <span className="shrink-0">Monitoring</span>
      {tracking && (
        <>
          <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-white/15" />
          <TrackingText />
        </>
      )}
    </span>
  )
}

// the single usability predicate lives in ai/helpers (re-exported for existing importers)
export { isUsableConnection, usableConnections }

export const ON_DEVICE_TIP = 'All processing happens on this device. Nothing about you or your posture leaves it unless you turn on an AI model in Settings.'

/**
 * The privacy promise for the current settings: the model a request would really reach
 * (null = nothing can leave the device) and the exact disclosure text. Shared with the
 * sidebar's privacy badge so the two never disagree.
 */
export function privacyNotice(settings: Pick<Settings, 'ai'> | null): { ai: AiConnection | null; tip: string } {
  const ai = usableConnections(settings)[0] ?? null
  return { ai, tip: ai && settings ? aiDisclosure(settings, ai.label, ai.model) : ON_DEVICE_TIP }
}

/** "on-device", or "on-device · AI: <label>" with an exact disclosure while a cloud model is ready. */
function PrivacyChip(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const tipId = useId()
  // Escape hides the tooltip until the pointer or focus leaves (WCAG 1.4.13: dismissible)
  const [dismissed, setDismissed] = useState(false)
  const { ai, tip } = privacyNotice(settings)
  const label = ai ? `on-device · AI: ${ai.label}` : 'on-device'
  return (
    <span
      className="group relative flex"
      onMouseLeave={() => setDismissed(false)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDismissed(false)
      }}
    >
      <span
        tabIndex={0}
        aria-label={label}
        aria-describedby={tipId}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !dismissed) {
            e.stopPropagation()
            setDismissed(true)
          }
        }}
        className={`${GLASS_CHIP} max-w-[16rem] text-text-dim outline-none focus-visible:ring-2 focus-visible:ring-sage/70 @max-[34rem]:px-[6px]`}
      >
        <Icon name="shield" size={14} />
        <span className="truncate @max-[34rem]:hidden">{label}</span>
      </span>
      {/* Hoverable (WCAG 1.4.13): no pointer-events-none, and the gap under the chip is the
          tooltip's own transparent top padding, so moving onto the text keeps it open. */}
      <span
        id={tipId}
        role="tooltip"
        className={`invisible absolute top-full right-0 z-10 w-[260px] max-w-[70cqw] pt-1.5 opacity-0 motion-safe:transition-opacity motion-safe:duration-150 ${
          dismissed
            ? ''
            : 'group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100'
        }`}
      >
        <span className="surface-popover block rounded-[10px] px-2.5 py-1.5 text-left type-caption text-text">{tip}</span>
      </span>
    </span>
  )
}

/** Exactly when data leaves the device, and what. (Also the sidebar's privacy badge.) */
export function aiDisclosure(settings: Pick<Settings, 'ai'>, label: string, model: string): string {
  const what =
    settings.ai.share === 'snapshot' ? 'a small camera snapshot' : 'a pose sketch (lines and dots — no camera image)'
  const imageWhen = settings.ai.useInSetup ? 'When you check your posture or run posture setup' : 'When you check your posture'
  // only models a request would really reach (main's isUsable), not every enabled one
  const fallbacks = usableConnections(settings).length > 1
  return (
    `Your posture is watched on this device. Only when you message your coach, SitSense sends your words and your ` +
    `posture numbers to ${label}${model ? ` (${model})` : ''}. ${imageWhen}, it also sends ${what}.` +
    `${fallbacks ? ' If it doesn’t answer, your next enabled model is asked instead.' : ''} Nothing is sent in the background.`
  )
}

/** "Using X — Y isn't connected" while the camera chosen in Settings is missing (Live shows it as a banner). */
export function useFallbackCameraNote(): string | null {
  const usingFallback = useAppStore((s) => s.camera.usingFallback)
  const activeLabel = useAppStore((s) => s.camera.activeLabel)
  const preferredId = useAppStore((s) => s.settings?.cameraDeviceId ?? null)
  const preferredLabel = useAppStore((s) => s.cameras.find((c) => c.deviceId === preferredId)?.label ?? null)
  if (!usingFallback) return null
  return `Using ${activeLabel || 'another camera'} — ${preferredLabel || 'your chosen camera'} isn’t connected.`
}

function FallbackNote(): JSX.Element | null {
  const note = useFallbackCameraNote()
  if (!note) return null
  return (
    <div className="absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)]" role="status">
      <span className={`${GLASS_CHIP} text-amber`}>
        <span className="truncate">{note}</span>
      </span>
    </div>
  )
}

// ───────────────────────────── overlay switcher (§3.2 bottom-left) ─────────────────────────────

type SwitcherValue = 'skeleton' | 'mesh' | 'off'

/** `[lines] Lines · [mesh] Mesh · [eye-off] Off` — writes overlay.style. Shared with Settings. */
export function OverlaySwitcher({ tone = 'glass' }: { tone?: 'glass' | 'default' }): JSX.Element {
  const style = useAppStore((s) => s.settings?.overlay.style ?? DEFAULT_SETTINGS.overlay.style)
  const meshUnavailable = useAppStore((s) => s.meshUnavailable)
  const patchSettings = useAppStore((s) => s.patchSettings)
  // 'hologram' is a legacy value: it reads as Mesh (the dim backdrop is a Mesh option)
  const value: SwitcherValue = style === 'hologram' ? 'mesh' : (style as SwitcherValue)
  const options: SegmentOption<SwitcherValue>[] = [
    { value: 'skeleton', label: 'Lines', icon: 'lines', title: 'Ear, shoulder and hip joined by a line, next to true vertical' },
    {
      value: 'mesh',
      label: 'Mesh',
      icon: 'mesh',
      disabled: meshUnavailable,
      title: meshUnavailable
        ? "The body mesh isn't available on this PC"
        : 'Wireframe over your body — adjust strength in Settings › Camera & preview'
    },
    { value: 'off', label: 'Off', icon: 'eye-off', title: 'Just the camera image' }
  ]
  return (
    <SegmentedControl
      options={options}
      value={value}
      size="sm"
      tone={tone === 'glass' ? 'glass' : 'default'}
      ariaLabel="Overlay"
      onChange={(v) => {
        if (v !== value) void patchSettings({ overlay: { style: v } })
      }}
    />
  )
}

// ───────────────────────────── the feed ─────────────────────────────

interface CameraFeedProps {
  /** show the away state inside the frame */
  showAway?: boolean
  /** no chrome at all (Settings previews) */
  compact?: boolean
  /** override the overlay style from Settings (e.g. posture setup always shows 'skeleton' = Lines) */
  overlayStyle?: OverlayStyle
  /**
   * Live's camera hero (§3.2): fills its parent (the parent sets the size), glass chips with
   * the tracking text, the overlay switcher and a hide button calling `onHide`. The
   * fallback-camera note moves out of the frame (Live shows it as a banner).
   */
  hero?: boolean
  onHide?: () => void
}

export default function CameraFeed({ showAway = true, compact = false, overlayStyle, hero = false, onHide }: CameraFeedProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  // narrow, primitive selectors: this component must not re-render at detection rate
  const running = useAppStore((s) => s.detection.running)
  const cameraError = useAppStore((s) => s.detection.cameraError)
  const paused = useAppStore((s) => s.pause.paused)
  const detectorError = useAppStore((s) => s.detectorError)
  const overlaySettings = useAppStore((s) => s.settings?.overlay) ?? DEFAULT_SETTINGS.overlay
  const meshUnavailable = useAppStore((s) => s.meshUnavailable)
  const awayNow = useAppStore((s) => s.snapshot?.presence === 'away')
  const calibrated = useAppStore((s) => !!s.settings?.calibration)
  const mismatch = useAppStore((s) => s.baselineCameraMismatch)
  const overlayColor = useOverlayColor(overlaySettings)

  const chosen = overlayStyle ?? overlaySettings.style
  const wantsMesh = chosen === 'mesh' || chosen === 'hologram'
  const style = wantsMesh && meshUnavailable ? 'skeleton' : chosen
  // a stale camera error is never shown over a paused preview (retry would resume anyway)
  const error = paused ? null : cameraError
  const modelBroken = !paused && !error && detectorError === 'model'
  const live = !paused && !error && !modelBroken
  // the dim backdrop is its own setting (meshBackdrop), so Lines → Mesh brings it back
  const hologram = live && (style === 'hologram' || (style === 'mesh' && meshDimsBackdrop(overlaySettings)))
  const showMesh = (style === 'mesh' || style === 'hologram') && live

  useEffect(() => {
    if (!showMesh) return
    return detectionController.acquireMesh()
  }, [showMesh])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    // share the controller's MediaStream; reattach whenever detection restarts
    const attach = (): void => {
      const stream = detectionController.getStream()
      if (v.srcObject !== stream) {
        v.srcObject = stream
        if (stream) v.play().catch(() => undefined)
      }
    }
    attach()
    const timer = setInterval(attach, 1000)
    return () => clearInterval(timer)
  }, [running, error, modelBroken])

  const away = showAway && awayNow && live && running
  const starting = live && !running
  const frame = hero
    ? 'h-full w-full rounded-[20px] bg-black [clip-path:inset(0_round_20px)]'
    : 'aspect-video w-full rounded-[20px] bg-surface [clip-path:inset(0_round_20px)]'

  return (
    <div className={`@container relative isolate overflow-hidden ${frame}`}>
      {error ? (
        <CameraErrorState error={error} />
      ) : modelBroken ? (
        <ModelErrorState />
      ) : (
        <>
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label="Your camera preview (mirrored)"
            className={`h-full w-full -scale-x-100 rounded-[20px] object-cover motion-safe:transition-[filter,opacity] motion-safe:duration-[250ms] ${
              paused ? 'opacity-40 blur-md saturate-0' : hologram ? 'brightness-[.32] contrast-125 saturate-[.35]' : ''
            } ${starting ? 'opacity-0' : ''}`}
          />
          {hologram && (
            <>
              <div
                className="pointer-events-none absolute inset-0 mix-blend-screen motion-safe:transition-colors motion-safe:duration-500"
                style={{ backgroundColor: `color-mix(in srgb, ${overlayColor} 10%, transparent)` }}
              />
              <div className="hologram-scanlines pointer-events-none absolute inset-0" />
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.55)_100%)]" />
            </>
          )}
          {showMesh && <MeshOverlay />}
          {style === 'skeleton' && live && (
            <PoseLinesOverlay
              mode={overlaySettings.color === 'posture' ? 'posture' : 'fixed'}
              color={fixedOverlayColor(overlaySettings)}
            />
          )}
          {/* chips sit on video: a soft top/bottom shade keeps them readable on any image */}
          {hero && !starting && (
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,rgb(0_0_0/0.28),transparent_22%,transparent_74%,rgb(0_0_0/0.32))]" />
          )}
          {paused && (
            <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
              <p className="type-body text-text-dim">Monitoring is paused — the camera is off.</p>
            </div>
          )}
          {starting && (
            <div className="absolute inset-0 bg-surface motion-safe:animate-[shimmer_1.4s_ease-in-out_infinite]" role="status">
              {!hero && (
                <p className="absolute inset-0 flex items-center justify-center type-body text-text-faint">Starting the camera…</p>
              )}
              {hero && <span className="sr-only">Starting the camera…</span>}
            </div>
          )}
          {live && detectorError === 'inference' && (
            <div className="absolute inset-x-0 bottom-14 flex justify-center px-3" role="status">
              <span className={`${GLASS_CHIP} text-amber`}>Detection is restarting — back in a moment.</span>
            </div>
          )}
          {away && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink/35 p-4">
              <div className="surface-glass max-w-[30rem] rounded-2xl px-6 py-4 text-center" role="status">
                <p className="type-h3 text-text">Looks like you stepped away</p>
                <p className="mt-1 type-body text-text-dim">
                  {!calibrated
                    ? 'Sit in view of the camera, then set up your posture.'
                    : mismatch
                      ? // nothing resumes on its own: the saved posture is for another camera
                        'Your saved posture is for another camera — sit in view, then redo setup or keep it for this camera.'
                      : "Monitoring resumes the moment you're back in frame."}
                </p>
              </div>
            </div>
          )}
          {!compact && !hero && live && detectorError !== 'inference' && <FallbackNote />}
        </>
      )}
      {!compact && !error && !modelBroken && (
        <div className="pointer-events-none absolute inset-x-2.5 top-2.5 flex items-start justify-between gap-2">
          <div className="pointer-events-auto flex min-w-0">
            <StatusChip paused={paused} running={running} tracking={hero && live} hero={hero} />
          </div>
          <div className="pointer-events-auto shrink-0">
            <PrivacyChip />
          </div>
        </div>
      )}
      {hero && !error && !modelBroken && (
        <div className="pointer-events-none absolute inset-x-2.5 bottom-2.5 flex items-end justify-between gap-2">
          <div className="pointer-events-auto min-w-0">{live && <OverlaySwitcher />}</div>
          {onHide && (
            <span className="pointer-events-auto">
              <IconButton
                icon="eye-off"
                label="Hide preview (monitoring continues)"
                size={28}
                variant="glass"
                ringOn="ink"
                onClick={onHide}
              />
            </span>
          )}
        </div>
      )}
      {/* the hairline ring drawn inside (clip-path would cut an outer ring) */}
      <div aria-hidden className={`pointer-events-none absolute inset-0 rounded-[20px] ring-1 ring-inset ${hero ? 'ring-white/[0.06]' : 'ring-white/8'}`} />
    </div>
  )
}
