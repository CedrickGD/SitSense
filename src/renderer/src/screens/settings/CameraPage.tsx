// Settings › Camera & preview (ui-v3 §6.2): device, live preview with the overlay
// style + mesh strength, and the overlay color.

import { useEffect, useId, useRef, useState, type JSX } from 'react'
import {
  MESH_INTENSITY_RANGE,
  OVERLAY_PRESETS,
  type OverlayColor,
  type OverlayPreset,
  type Settings
} from '@shared/settings'
import CameraFeed from '@renderer/components/CameraFeed'
import { Icon } from '@renderer/components/icons'
import { SegmentedControl, Select, Toggle, Tooltip } from '@renderer/components/primitives'
import { detectionController } from '@renderer/detection/controller'
import { STAGE_COLOR } from '@renderer/lib/ui'
import { useAppStore } from '@renderer/state/store'
import { meshDimsBackdrop } from '@renderer/overlay/meshLook'
import { meshPercent, previewStyleOf, STYLE_COPY, type PreviewStyle } from './meta'
import { GroupDivider, Saved, SettingRow, SettingsCard, SettingsGrid, SliderRow, useCommit } from './parts'

export default function CameraPage({ settings }: { settings: Settings }): JSX.Element {
  return (
    <SettingsGrid>
      <CameraCard settings={settings} />
      <PreviewCard settings={settings} />
      <ColorCard settings={settings} />
    </SettingsGrid>
  )
}

// ───────────────────────────── camera ─────────────────────────────

function CameraCard({ settings }: { settings: Settings }): JSX.Element {
  const { commit } = useCommit()
  const cameras = useAppStore((s) => s.cameras)
  const camera = useAppStore((s) => s.camera)
  const selectId = useId()
  const hintId = useId()
  // a picked camera that isn't connected stays visible (and can be cleared with Default camera)
  const picked = settings.cameraDeviceId
  const pickedMissing = !!picked && !cameras.some((c) => c.deviceId === picked)
  const options = [
    { value: '', label: 'Default camera' },
    ...(pickedMissing && picked ? [{ value: picked, label: 'Your chosen camera (not connected)' }] : []),
    ...cameras.map((c) => ({ value: c.deviceId, label: c.label || 'Camera' }))
  ]

  return (
    <SettingsCard span={5} eyebrow="Camera">
      {/* flex-1: the card stretches to the Preview card beside it; the hint sits at the bottom */}
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={selectId} className="type-body font-medium text-text">
              Device
            </label>
            <Saved k="camera" />
          </div>
          <Select
            id={selectId}
            value={picked ?? ''}
            describedBy={hintId}
            className="w-full"
            options={options}
            onChange={(v) => commit('camera', { cameraDeviceId: v || null })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <CameraThumb />
          <div className="flex min-w-0 flex-1 basis-32 flex-col gap-1">
            <p className="type-micro text-text-faint">In use</p>
            <p className="truncate type-body text-text" title={camera.activeLabel ?? undefined}>
              {camera.activeLabel || 'Waiting for the camera…'}
            </p>
            {camera.usingFallback && (
              <p className="type-caption text-amber">The camera you picked isn’t connected — using this one meanwhile.</p>
            )}
          </div>
        </div>
        <p id={hintId} className="mt-auto flex items-start gap-2 type-caption text-text-dim">
          <Icon name="info" size={14} className="mt-px shrink-0 text-text-faint" />
          Any angle works — front, side or in between. Only part of you needs to be in the picture.
        </p>
      </div>
    </SettingsCard>
  )
}

/** 160×90 live thumbnail of the camera in use (shares the detector's stream). */
function CameraThumb(): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const paused = useAppStore((s) => s.pause.paused)
  const error = useAppStore((s) => s.detection.cameraError)
  const [hasStream, setHasStream] = useState(false)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const attach = (): void => {
      const stream = detectionController.getStream()
      setHasStream(!!stream)
      if (v.srcObject !== stream) {
        v.srcObject = stream
        if (stream) v.play().catch(() => undefined)
      }
    }
    attach()
    const t = setInterval(attach, 1000)
    return () => clearInterval(t)
  }, [])
  const note = error ? 'No camera' : paused ? 'Paused' : !hasStream ? 'Starting…' : null
  return (
    <div className="relative h-[90px] w-40 shrink-0 overflow-hidden rounded-xl bg-ink ring-1 ring-white/[0.08]">
      <video
        ref={ref}
        muted
        playsInline
        aria-hidden
        className={`h-full w-full -scale-x-100 object-cover ${note ? 'opacity-0' : ''}`}
      />
      {note && (
        <span className="absolute inset-0 flex items-center justify-center gap-1.5 type-caption text-text-faint">
          <Icon name={error ? 'alert' : paused ? 'pause' : 'camera'} size={14} />
          {note}
        </span>
      )}
    </div>
  )
}

// ───────────────────────────── preview ─────────────────────────────

const STYLE_OPTIONS: { value: PreviewStyle; label: string; icon: 'lines' | 'mesh' | 'eye-off' }[] = [
  { value: 'skeleton', label: 'Lines', icon: 'lines' },
  { value: 'mesh', label: 'Mesh', icon: 'mesh' },
  { value: 'off', label: 'Off', icon: 'eye-off' }
]

function PreviewCard({ settings }: { settings: Settings }): JSX.Element {
  const { commit } = useCommit()
  const meshUnavailable = useAppStore((s) => s.meshUnavailable)
  const style = settings.overlay.style
  const picked = previewStyleOf(style)
  const dimId = useId()
  const styleDescId = useId()
  const isMesh = picked === 'mesh'

  return (
    <SettingsCard span={7} eyebrow="Preview" action={<Saved k="style" />} className="-order-1 @min-[600px]:order-none">
      <div className="flex flex-col gap-4">
        <CameraFeed showAway={false} compact />
        <div className="flex flex-col gap-2">
          <SegmentedControl<PreviewStyle>
            ariaLabel="Overlay style"
            describedBy={styleDescId}
            fullWidth
            value={picked}
            onChange={(v) => commit('style', { overlay: { style: v } })}
            options={STYLE_OPTIONS}
          />
          <p id={styleDescId} className="min-h-4 type-caption text-text-dim">
            {meshUnavailable && isMesh
              ? 'This computer can’t run the body outline model — showing Lines instead.'
              : STYLE_COPY[picked]}
          </p>
        </div>
        {isMesh && (
          <>
            <GroupDivider />
            <SliderRow
              label="Mesh strength"
              value={settings.overlay.meshIntensity}
              min={MESH_INTENSITY_RANGE.min}
              max={MESH_INTENSITY_RANGE.max}
              step={0.05}
              format={meshPercent}
              startLabel="Subtle"
              endLabel="Dense"
              savedKey="mesh"
              disabled={meshUnavailable}
              onCommit={(v) => commit('mesh', { overlay: { meshIntensity: Math.round(v * 100) / 100 } })}
            />
            <SettingRow
              label="Dim camera behind mesh"
              description="Darkens the picture so the wireframe glows."
              descriptionId={dimId}
              savedKey="dim"
              muted={meshUnavailable}
              control={
                <Toggle
                  label="Dim camera behind mesh"
                  describedBy={dimId}
                  disabled={meshUnavailable}
                  checked={meshDimsBackdrop(settings.overlay)}
                  onChange={(v) => commit('dim', { overlay: { style: 'mesh', meshBackdrop: v ? 'dim' : 'camera' } })}
                />
              }
            />
          </>
        )}
      </div>
    </SettingsCard>
  )
}

// ───────────────────────────── color ─────────────────────────────

const PRESET_LABELS: Record<OverlayPreset, string> = {
  ice: 'Ice',
  cyan: 'Cyan',
  violet: 'Violet',
  magenta: 'Magenta',
  lime: 'Lime',
  gold: 'Gold',
  white: 'White'
}

const swatchClass = (selected: boolean): string =>
  `relative h-7 w-7 shrink-0 cursor-pointer rounded-full transition-[transform,box-shadow] duration-150 focus-visible:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sage/70 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-card ${
    selected
      ? 'ring-2 ring-sage ring-offset-2 ring-offset-card'
      : 'ring-1 ring-white/15 hover:scale-110 focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:ring-offset-2 focus-visible:ring-offset-card'
  }`

function Swatch({
  label,
  selected,
  background,
  onClick
}: {
  label: string
  selected: boolean
  background: string
  onClick: () => void
}): JSX.Element {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        onClick={onClick}
        className={swatchClass(selected)}
        style={{ background }}
      >
        {selected && (
          <span className="absolute inset-0 flex items-center justify-center text-ink/80">
            <Icon name="check" size={14} strokeWidth={2.4} />
          </span>
        )}
      </button>
    </Tooltip>
  )
}

function ColorCard({ settings }: { settings: Settings }): JSX.Element {
  const { commit } = useCommit()
  const { color, customColor, style } = settings.overlay
  const [draft, setDraft] = useState(customColor)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => setDraft(customColor), [customColor])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const pick = (c: OverlayColor, custom?: string): void => {
    // a preset click must not be overridden by a custom pick still waiting to commit
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    commit('color', { overlay: custom ? { color: c, customColor: custom } : { color: c } })
  }
  const postureGradient = `conic-gradient(${[0, 1, 2, 3, 0].map((st) => STAGE_COLOR[st as 0 | 1 | 2 | 3]).join(', ')})`
  const off = style === 'off'

  return (
    <SettingsCard span={12} eyebrow="Overlay color" action={<Saved k="color" />}>
      <div className={`flex flex-wrap items-center gap-x-8 gap-y-3 ${off ? 'opacity-50' : ''}`}>
        <div role="group" aria-label="Overlay color" className="flex flex-wrap items-center gap-2.5">
          <Swatch
            label="Posture — follows your stage colors"
            selected={color === 'posture'}
            background={postureGradient}
            onClick={() => pick('posture')}
          />
          <span aria-hidden className="mx-0.5 h-5 w-px bg-hairline" />
          {(Object.keys(OVERLAY_PRESETS) as OverlayPreset[]).map((p) => (
            <Swatch
              key={p}
              label={PRESET_LABELS[p]}
              selected={color === p}
              background={OVERLAY_PRESETS[p]}
              onClick={() => pick(p)}
            />
          ))}
          <Tooltip content="Custom color">
            <label
              className={swatchClass(color === 'custom')}
              style={{ background: color === 'custom' ? draft : 'conic-gradient(#f66, #fd5, #6e8, #5cf, #a8f, #f6c, #f66)' }}
            >
              <input
                type="color"
                value={draft}
                aria-label={color === 'custom' ? 'Custom color (selected)' : 'Custom color'}
                className="sr-only"
                // exactly one click reaches the input for a mouse click on the label and for
                // Space/Enter on the focused input, so re-selecting the saved color works
                onClick={() => {
                  if (color !== 'custom') pick('custom', draft)
                }}
                onChange={(e) => {
                  const next = e.target.value
                  setDraft(next)
                  // the native picker streams values while dragging — commit at a calmer pace
                  if (timer.current) clearTimeout(timer.current)
                  timer.current = setTimeout(() => commit('color', { overlay: { color: 'custom', customColor: next } }), 120)
                }}
              />
              {color === 'custom' && (
                <span className="absolute inset-0 flex items-center justify-center text-ink/80">
                  <Icon name="check" size={14} strokeWidth={2.4} />
                </span>
              )}
            </label>
          </Tooltip>
        </div>
        <p className="min-w-0 flex-1 basis-56 type-caption text-text-dim">
          {off
            ? 'The overlay is off — pick Lines or Mesh to see the color.'
            : color === 'posture'
              ? 'Follows your posture: sage when aligned, amber to coral as it slips.'
              : 'Your color, always — the problem area still lights up in its warning color.'}
        </p>
      </div>
    </SettingsCard>
  )
}
