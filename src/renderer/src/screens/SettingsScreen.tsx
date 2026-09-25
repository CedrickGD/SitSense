import { createContext, Fragment, useContext, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ISSUE_LABELS, ISSUES, type IssueId } from '@shared/posture'
import {
  DEFAULT_SETTINGS,
  OVERLAY_PRESETS,
  PRESET_FPS,
  type OverlayColor,
  type OverlayPreset,
  type OverlayStyle,
  type PerformancePreset,
  type Settings
} from '@shared/settings'
import { STAGE_COLOR } from '@renderer/lib/ui'
import { useAppStore } from '@renderer/state/store'
import CameraFeed from '@renderer/components/CameraFeed'
import SpineGlyph from '@renderer/components/SpineGlyph'
import { Button, SegmentedControl, Slider, Toggle } from '@renderer/components/primitives'

const SENSITIVITY_STEPS = [0.5, 0.75, 1.0, 1.5, 2.0]
const SENSITIVITY_HINTS = [
  'Relaxed — only flags big departures from your baseline.',
  'Easygoing — lets small drifts slide.',
  'Balanced — the recommended middle ground.',
  'Attentive — notices moderate drift early.',
  'Strict — flags small departures from your baseline.'
]

const SECTIONS = [
  { id: 'camera', title: 'Camera' },
  { id: 'overlay', title: 'Camera overlay' },
  { id: 'detection', title: 'Detection' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'general', title: 'General' }
] as const
type SectionId = (typeof SECTIONS)[number]['id']

/** The control that was saved last — its row flashes a quiet "Saved". */
const SavedContext = createContext<{ key: string; at: number } | null>(null)

function SavedMark({ savedKey }: { savedKey?: string }): JSX.Element | null {
  const saved = useContext(SavedContext)
  const [visible, setVisible] = useState(false)
  const hit = !!savedKey && saved?.key === savedKey
  useEffect(() => {
    if (!hit) return
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), 1200)
    return () => clearTimeout(timer)
  }, [hit, saved?.at])
  if (!visible) return null
  return (
    <span className="text-xs text-text-faint motion-safe:animate-[fadeOut_1.2s_ease-in_forwards]" aria-live="polite">
      Saved
    </span>
  )
}

function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }): JSX.Element {
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="scroll-mt-14 rounded-2xl bg-card p-5 ring-1 ring-white/8">
      <h2 id={`settings-${id}-title`} className="mb-4 text-[15px] font-medium text-text">
        {title}
      </h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

function Row({
  label,
  sub,
  control,
  savedKey
}: {
  label: string
  sub?: string
  control: ReactNode
  savedKey?: string
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <p className="text-[13px] text-text">{label}</p>
        {sub && <p className="mt-0.5 text-xs text-text-faint">{sub}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SavedMark savedKey={savedKey} />
        {control}
      </div>
    </div>
  )
}

/** Sticky jump list; highlights the section in view. */
function SectionNav(): JSX.Element {
  const [current, setCurrent] = useState<SectionId>('camera')
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (top) setCurrent(top.target.id.replace('settings-', '') as SectionId)
      },
      { rootMargin: '-10% 0px -70% 0px' }
    )
    for (const s of SECTIONS) {
      const el = document.getElementById(`settings-${s.id}`)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [])
  return (
    <nav aria-label="Settings sections" className="sticky top-0 z-10 -mx-6 bg-ink/95 px-6 py-2 backdrop-blur">
      <ul className="flex flex-wrap gap-1">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              aria-current={current === s.id ? 'true' : undefined}
              onClick={() => {
                document.getElementById(`settings-${s.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                setCurrent(s.id)
              }}
              className={`rounded-lg px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none ${
                current === s.id ? 'bg-card text-text ring-1 ring-white/8' : 'text-text-dim hover:text-text'
              }`}
            >
              {s.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

const STYLE_HINTS: Record<OverlayStyle, string> = {
  mesh: 'A wireframe that wraps your whole silhouette, denser on the face.',
  hologram: 'The same wireframe with the camera image dimmed, so it glows.',
  skeleton: 'Minimal markers on head and shoulders.',
  off: 'Just the camera image — detection keeps running either way.'
}

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
  `relative h-7 w-7 shrink-0 cursor-pointer rounded-full transition-transform focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:ring-offset-2 focus-visible:ring-offset-card focus-visible:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sage/70 ${
    selected ? 'scale-110 ring-2 ring-text ring-offset-2 ring-offset-card' : 'ring-1 ring-white/15 hover:scale-105'
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
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      className={swatchClass(selected)}
      style={{ background }}
    />
  )
}

function OverlayColorPicker({
  color,
  customColor,
  onChange
}: {
  color: OverlayColor
  customColor: string
  onChange: (patch: { color: OverlayColor; customColor?: string }) => void
}): JSX.Element {
  const [draft, setDraft] = useState(customColor)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => setDraft(customColor), [customColor])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  /** a preset click must not be overridden by a custom pick still waiting to commit */
  const pick = (c: OverlayColor): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    onChange({ color: c })
  }

  const postureGradient = `conic-gradient(${[0, 1, 2, 3, 0].map((st) => STAGE_COLOR[st as 0 | 1 | 2 | 3]).join(', ')})`
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <Swatch
        label="Posture — follows your stage colors"
        selected={color === 'posture'}
        background={postureGradient}
        onClick={() => pick('posture')}
      />
      <span className="mx-0.5 h-5 w-px bg-hairline" />
      {(Object.keys(OVERLAY_PRESETS) as OverlayPreset[]).map((p) => (
        <Swatch
          key={p}
          label={PRESET_LABELS[p]}
          selected={color === p}
          background={OVERLAY_PRESETS[p]}
          onClick={() => pick(p)}
        />
      ))}
      <label
        title="Custom color"
        className={swatchClass(color === 'custom')}
        style={{ background: color === 'custom' ? draft : 'conic-gradient(#f66, #fd5, #6e8, #5cf, #a8f, #f6c, #f66)' }}
      >
        <input
          type="color"
          value={draft}
          aria-label={color === 'custom' ? 'Custom color (selected)' : 'Custom color'}
          className="sr-only"
          // exactly one click reaches the input for a mouse click on the label
          // and for Space/Enter on the focused input, so re-selecting the saved
          // color works without having to pick a new one
          onClick={() => {
            if (color !== 'custom') onChange({ color: 'custom', customColor: draft })
          }}
          onChange={(e) => {
            const next = e.target.value
            setDraft(next)
            // the native picker streams values while dragging — commit at a calmer pace
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => onChange({ color: 'custom', customColor: next }), 120)
          }}
        />
      </label>
    </div>
  )
}

function sensitivityIndex(v: number): number {
  let best = 0
  SENSITIVITY_STEPS.forEach((s, i) => {
    if (Math.abs(s - v) < Math.abs(SENSITIVITY_STEPS[best] - v)) best = i
  })
  return best
}

/** notifyStages → threshold model: contiguous [k..3] reads as "from stage k". */
function notifyFrom(stages: [boolean, boolean, boolean]): 1 | 2 | 3 | 'custom' | 'none' {
  const key = stages.map((b) => (b ? '1' : '0')).join('')
  if (key === '111') return 1
  if (key === '011') return 2
  if (key === '001') return 3
  if (key === '000') return 'none'
  return 'custom'
}

export default function SettingsScreen(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const cameras = useAppStore((s) => s.cameras)
  const activeCameraId = useAppStore((s) => s.activeCameraId)
  const detection = useAppStore((s) => s.detection)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const setRoute = useAppStore((s) => s.setRoute)
  const appVersion = useAppStore((s) => s.appVersion)
  const meshUnavailable = useAppStore((s) => s.meshUnavailable)
  const [fineTune, setFineTune] = useState(false)
  const [saved, setSaved] = useState<{ key: string; at: number } | null>(null)

  if (!settings) return <div className="p-6 text-text-dim">Loading…</div>

  /** Commit a patch and flash "Saved" next to the control it came from. */
  const save = (key: string, patch: unknown): void => {
    void patchSettings(patch).then(() => setSaved({ key, at: Date.now() }))
  }
  const patchIssue = (issue: IssueId, key: string, patch: Partial<Settings['issues'][IssueId]>): void => {
    save(key, { issues: { [issue]: patch } })
  }

  const baselineCamera = settings.calibration?.cameraDeviceId ?? null
  const cameraChanged = !!settings.calibration && !!baselineCamera && !!activeCameraId && baselineCamera !== activeCameraId
  const activeCamera = cameras.find((c) => c.deviceId === activeCameraId)

  const resetAll = (): void => {
    if (!window.confirm('Reset all settings to their defaults? Your baseline and camera choice are kept.')) return
    const { calibration, cameraDeviceId, cameraLabel } = settings
    save('reset', { ...structuredClone(DEFAULT_SETTINGS), calibration, cameraDeviceId, cameraLabel, onboarded: true })
  }

  return (
    <SavedContext.Provider value={saved}>
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 pb-6">
        <SectionNav />
        <Section id="camera" title="Camera">
          <Row
            label="Camera"
            savedKey="camera"
            sub={
              activeCamera && settings.cameraDeviceId && activeCamera.deviceId !== settings.cameraDeviceId
                ? `The chosen camera isn't available — using ${activeCamera.label} for now.`
                : 'Any connected camera works — SitSense uses whatever it can see.'
            }
            control={
              <select
                aria-label="Camera"
                value={settings.cameraDeviceId ?? ''}
                onChange={(e) => {
                  const id = e.target.value || null
                  save('camera', { cameraDeviceId: id, cameraLabel: cameras.find((c) => c.deviceId === id)?.label ?? null })
                }}
                className="max-w-60 truncate rounded-[10px] bg-ink px-3 py-2 text-[13px] text-text ring-1 ring-white/8 focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none"
              >
                <option value="">Default camera</option>
                {cameras.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label}
                  </option>
                ))}
              </select>
            }
          />
          <Row
            label="Baseline"
            sub={
              !settings.calibration
                ? 'Not calibrated yet — SitSense needs this to start watching.'
                : cameraChanged
                  ? 'Your baseline was captured with a different camera — recalibrate for accurate readings.'
                  : `Last calibrated ${new Date(settings.calibration.capturedAt).toLocaleString()}. Recommended after moving your camera or desk.`
            }
            control={
              <Button variant={!settings.calibration || cameraChanged ? 'primary' : 'secondary'} onClick={() => setRoute('calibrate')}>
                {settings.calibration ? 'Recalibrate' : 'Calibrate'}
              </Button>
            }
          />
        </Section>

        <Section id="overlay" title="Camera overlay">
          <div className="overflow-hidden rounded-[20px]">
            <CameraFeed showAway={false} compact />
          </div>
          <Row
            label="Style"
            savedKey="overlay-style"
            sub={
              meshUnavailable && (settings.overlay.style === 'mesh' || settings.overlay.style === 'hologram')
                ? 'This machine can’t run the body outline model — showing the skeleton instead.'
                : STYLE_HINTS[settings.overlay.style]
            }
            control={
              <SegmentedControl<OverlayStyle>
                label="Overlay style"
                value={settings.overlay.style}
                onChange={(v) => save('overlay-style', { overlay: { style: v } })}
                options={[
                  { value: 'mesh', label: 'Mesh' },
                  { value: 'hologram', label: 'Hologram' },
                  { value: 'skeleton', label: 'Skeleton' },
                  { value: 'off', label: 'Off' }
                ]}
              />
            }
          />
          {settings.overlay.style !== 'off' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <div>
                  <p className="text-[13px] text-text">Color</p>
                  <p className="mt-0.5 text-xs text-text-faint">
                    {settings.overlay.color === 'posture'
                      ? 'Follows your posture: sage when aligned, amber to coral as it slips.'
                      : 'Your color, always — the problem area still lights up in its warning color.'}
                  </p>
                </div>
                <SavedMark savedKey="overlay-color" />
              </div>
              <OverlayColorPicker
                color={settings.overlay.color}
                customColor={settings.overlay.customColor}
                onChange={(patch) => save('overlay-color', { overlay: patch })}
              />
            </div>
          )}
        </Section>

        <Section id="detection" title="Detection">
          {ISSUES.map((issue) => {
            const cfg = settings.issues[issue]
            const idx = sensitivityIndex(cfg.sensitivity)
            return (
              <div key={issue} className={`rounded-xl bg-ink/60 p-3 ring-1 ring-white/5 ${cfg.enabled ? '' : 'opacity-40'}`}>
                <div className="flex items-center gap-3">
                  <SpineGlyph size={22} issue={issue} stage={2} breathing={false} />
                  <span className="flex-1 text-[13px] text-text">{ISSUE_LABELS[issue]}</span>
                  <SavedMark savedKey={`issue-${issue}`} />
                  <Toggle
                    label={`${ISSUE_LABELS[issue]} detection`}
                    checked={cfg.enabled}
                    onChange={(v) => patchIssue(issue, `issue-${issue}`, { enabled: v })}
                  />
                </div>
                {cfg.enabled && (
                  <div className="mt-3 pl-9">
                    <div className="flex items-center gap-3">
                      <span className="text-[11px] text-text-faint" aria-hidden>
                        Relaxed
                      </span>
                      <Slider
                        label={`${ISSUE_LABELS[issue]} sensitivity`}
                        valueText={(i) => SENSITIVITY_HINTS[i].split(' — ')[0]}
                        value={idx}
                        min={0}
                        max={4}
                        step={1}
                        onChange={(i) => patchIssue(issue, `issue-${issue}`, { sensitivity: SENSITIVITY_STEPS[i] })}
                      />
                      <span className="text-[11px] text-text-faint" aria-hidden>
                        Strict
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-text-faint">{SENSITIVITY_HINTS[idx]}</p>
                  </div>
                )}
              </div>
            )
          })}
          <Row
            label="Performance"
            savedKey="performance"
            sub={
              detection.running && detection.delegate
                ? `Higher settings react faster and use more CPU. Running on the ${detection.delegate} at ${detection.measuredFps} fps.`
                : 'Higher settings react faster and use more CPU.'
            }
            control={
              <SegmentedControl<PerformancePreset>
                label="Performance"
                value={settings.performancePreset}
                onChange={(v) => save('performance', { performancePreset: v })}
                options={(['efficient', 'balanced', 'responsive'] as const).map((p) => ({
                  value: p,
                  label: `${p[0].toUpperCase()}${p.slice(1)} (${PRESET_FPS[p]} fps)`
                }))}
              />
            }
          />
        </Section>

        <Section id="notifications" title="Notifications">
          <Row
            label="Notifications"
            savedKey="notifications"
            sub="Windows toasts when your posture needs a nudge."
            control={
              <Toggle
                label="Notifications"
                checked={settings.notifications.enabled}
                onChange={(v) => save('notifications', { notifications: { enabled: v } })}
              />
            }
          />
          {settings.notifications.enabled && (
            <>
              <div className="flex flex-col gap-2">
                {ISSUES.map((issue) => {
                  const cfg = settings.issues[issue]
                  const from = notifyFrom(cfg.notifyStages)
                  const key = `notify-${issue}`
                  return (
                    <div key={issue} className={`flex items-center justify-between gap-4 ${cfg.enabled ? '' : 'opacity-40'}`}>
                      <span className="text-[13px] text-text">{ISSUE_LABELS[issue]}</span>
                      <div className="flex items-center gap-2">
                        <SavedMark savedKey={key} />
                        <span className="text-[11px] text-text-faint">Nudge me from:</span>
                        {from === 'custom' || from === 'none' ? (
                          <>
                            <span className="text-xs text-text-dim">{from === 'none' ? 'Never' : 'Custom'}</span>
                            <Button
                              variant="ghost"
                              className="text-xs"
                              onClick={() => patchIssue(issue, key, { notifyStages: [true, true, true] })}
                            >
                              Reset
                            </Button>
                          </>
                        ) : (
                          <SegmentedControl<'1' | '2' | '3'>
                            label={`Nudge me from, ${ISSUE_LABELS[issue]}`}
                            value={String(from) as '1' | '2' | '3'}
                            onChange={(v) => {
                              const k = Number(v)
                              patchIssue(issue, key, { notifyStages: [k <= 1, k <= 2, true] })
                            }}
                            options={[
                              { value: '1', label: 'slight', color: 'var(--color-amber)' },
                              { value: '2', label: 'clear', color: 'var(--color-ember)' },
                              { value: '3', label: 'severe', color: 'var(--color-coral)' }
                            ]}
                          />
                        )}
                      </div>
                    </div>
                  )
                })}
                <button
                  type="button"
                  aria-expanded={fineTune}
                  aria-controls="settings-fine-tune"
                  onClick={() => setFineTune((v) => !v)}
                  className="self-start rounded text-xs text-text-faint hover:text-text-dim focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none"
                >
                  Fine-tune per stage {fineTune ? '▴' : '▾'}
                </button>
                {fineTune && (
                  <div id="settings-fine-tune" className="rounded-xl bg-ink/60 p-3 ring-1 ring-white/5">
                    <div className="grid grid-cols-[1fr_repeat(3,64px)] gap-y-2 text-center">
                      <span />
                      {(['slight', 'clear', 'severe'] as const).map((st, i) => (
                        <span key={st} className="text-[11px]" style={{ color: STAGE_COLOR[(i + 1) as 1 | 2 | 3] }}>
                          {st}
                        </span>
                      ))}
                      {ISSUES.map((issue) => (
                        <Fragment key={issue}>
                          <span className="text-left text-[13px] text-text">{ISSUE_LABELS[issue]}</span>
                          {[0, 1, 2].map((k) => (
                            <label key={k} className="flex items-center justify-center">
                              <input
                                type="checkbox"
                                aria-label={`${ISSUE_LABELS[issue]} — notify at ${['slight', 'clear', 'severe'][k]}`}
                                checked={settings.issues[issue].notifyStages[k]}
                                onChange={(e) => {
                                  const next = [...settings.issues[issue].notifyStages] as [boolean, boolean, boolean]
                                  next[k] = e.target.checked
                                  patchIssue(issue, `notify-${issue}`, { notifyStages: next })
                                }}
                                className="h-4 w-4 accent-[var(--color-sage)]"
                              />
                            </label>
                          ))}
                        </Fragment>
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] text-text-faint">
                      Unchecked stages are still tracked and shown on the dashboard — they just don't notify.
                    </p>
                  </div>
                )}
              </div>

              <Row
                label="Wait before nudging"
                savedKey="dwell"
                sub="How long poor posture must persist before the first toast."
                control={
                  <Slider
                    label="Wait before nudging"
                    value={settings.notifications.dwellSeconds}
                    min={5}
                    max={30}
                    step={1}
                    onChange={(v) => save('dwell', { notifications: { dwellSeconds: v } })}
                    format={(v) => `${v} s`}
                  />
                }
              />
              <Row
                label="Quiet period between nudges"
                savedKey="cooldown"
                sub="Per issue — a re-nudge waits at least this long."
                control={
                  <Slider
                    label="Quiet period between nudges"
                    value={settings.notifications.cooldownMinutes}
                    min={1}
                    max={10}
                    step={1}
                    onChange={(v) => save('cooldown', { notifications: { cooldownMinutes: v } })}
                    format={(v) => `${v} min`}
                  />
                }
              />
              <Row
                label="Escalate if it gets worse"
                savedKey="escalation"
                sub="A worsening stage notifies immediately, even during the quiet period."
                control={
                  <Toggle
                    label="Escalation"
                    checked={settings.notifications.escalation}
                    onChange={(v) => save('escalation', { notifications: { escalation: v } })}
                  />
                }
              />
              <Row
                label="Sound"
                savedKey="sound"
                sub="Play the system notification sound with each nudge."
                control={
                  <Toggle
                    label="Sound"
                    checked={settings.notifications.sound}
                    onChange={(v) => save('sound', { notifications: { sound: v } })}
                  />
                }
              />
              <Row
                label="Test notification"
                sub="If nothing appears, check Windows notification settings for SitSense."
                control={<Button onClick={() => window.sitsense.testNotification()}>Send test</Button>}
              />
            </>
          )}
        </Section>

        <Section id="general" title="General">
          <Row
            label="Start with Windows"
            savedKey="autostart"
            sub="Launches minimized into the tray at sign-in."
            control={
              <Toggle
                label="Start with Windows"
                checked={settings.general.launchOnStartup}
                onChange={(v) => save('autostart', { general: { launchOnStartup: v } })}
              />
            }
          />
          <Row
            label="Start minimized to tray"
            savedKey="start-hidden"
            sub="The window stays hidden when SitSense starts."
            control={
              <Toggle
                label="Start minimized"
                checked={settings.general.startHidden}
                onChange={(v) => save('start-hidden', { general: { startHidden: v } })}
              />
            }
          />
          <Row
            label="Keep running when the window is closed"
            savedKey="close-to-tray"
            sub="Closing the window keeps SitSense watching from the tray. Off: closing quits."
            control={
              <Toggle
                label="Keep running when the window is closed"
                checked={settings.general.closeToTray}
                onChange={(v) => save('close-to-tray', { general: { closeToTray: v } })}
              />
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
            <span className="text-xs text-text-faint">SitSense {appVersion}</span>
            <div className="flex items-center gap-2">
              <SavedMark savedKey="reset" />
              <Button variant="ghost" className="text-coral" onClick={resetAll}>
                Reset all settings
              </Button>
              <Button variant="danger" onClick={() => window.sitsense.quitApp()}>
                Quit SitSense
              </Button>
            </div>
          </div>
        </Section>
      </div>
    </SavedContext.Provider>
  )
}
