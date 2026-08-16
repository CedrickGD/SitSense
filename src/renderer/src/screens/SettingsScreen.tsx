import { useState, type JSX, type ReactNode } from 'react'
import { ISSUE_LABELS, ISSUES, type IssueId } from '@shared/posture'
import { PRESET_FPS, type PerformancePreset, type Settings } from '@shared/settings'
import { STAGE_COLOR } from '@renderer/lib/ui'
import { useAppStore } from '@renderer/state/store'
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

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="rounded-2xl bg-card p-5 ring-1 ring-white/8">
      <h2 className="mb-4 text-[15px] font-medium text-text">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

function Row({ label, sub, control }: { label: string; sub?: string; control: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <p className="text-[13px] text-text">{label}</p>
        {sub && <p className="mt-0.5 text-xs text-text-faint">{sub}</p>}
      </div>
      <div className="shrink-0">{control}</div>
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
  const patchSettings = useAppStore((s) => s.patchSettings)
  const setRoute = useAppStore((s) => s.setRoute)
  const appVersion = useAppStore((s) => s.appVersion)
  const [fineTune, setFineTune] = useState(false)

  if (!settings) return <div className="p-6 text-text-dim">Loading…</div>

  const patchIssue = (issue: IssueId, patch: Partial<Settings['issues'][IssueId]>): void => {
    void patchSettings({ issues: { [issue]: patch } })
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <Section title="Camera">
        <Row
          label="Camera"
          sub="Any connected camera works — SitSense uses whatever it can see."
          control={
            <select
              value={settings.cameraDeviceId ?? ''}
              onChange={(e) => void patchSettings({ cameraDeviceId: e.target.value || null })}
              className="rounded-[10px] bg-ink px-3 py-2 text-[13px] text-text ring-1 ring-white/8 focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none"
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
            settings.calibration
              ? `Last calibrated ${new Date(settings.calibration.capturedAt).toLocaleString()}. Recommended after moving your camera or desk.`
              : 'Not calibrated yet — SitSense needs this to start watching.'
          }
          control={<Button onClick={() => setRoute('calibrate')}>{settings.calibration ? 'Recalibrate' : 'Calibrate'}</Button>}
        />
      </Section>

      <Section title="Detection">
        {ISSUES.map((issue) => {
          const cfg = settings.issues[issue]
          const idx = sensitivityIndex(cfg.sensitivity)
          return (
            <div key={issue} className={`rounded-xl bg-ink/60 p-3 ring-1 ring-white/5 ${cfg.enabled ? '' : 'opacity-40'}`}>
              <div className="flex items-center gap-3">
                <SpineGlyph size={22} issue={issue} stage={2} breathing={false} />
                <span className="flex-1 text-[13px] text-text">{ISSUE_LABELS[issue]}</span>
                <Toggle label={`${ISSUE_LABELS[issue]} detection`} checked={cfg.enabled} onChange={(v) => patchIssue(issue, { enabled: v })} />
              </div>
              {cfg.enabled && (
                <div className="mt-3 pl-9">
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] text-text-faint">Relaxed</span>
                    <Slider
                      value={idx}
                      min={0}
                      max={4}
                      step={1}
                      onChange={(i) => patchIssue(issue, { sensitivity: SENSITIVITY_STEPS[i] })}
                    />
                    <span className="text-[11px] text-text-faint">Strict</span>
                  </div>
                  <p className="mt-1 text-xs text-text-faint">{SENSITIVITY_HINTS[idx]}</p>
                </div>
              )}
            </div>
          )
        })}
        <Row
          label="Performance"
          sub="Higher settings react faster and use more CPU."
          control={
            <SegmentedControl<PerformancePreset>
              value={settings.performancePreset}
              onChange={(v) => void patchSettings({ performancePreset: v })}
              options={(['efficient', 'balanced', 'responsive'] as const).map((p) => ({
                value: p,
                label: `${p[0].toUpperCase()}${p.slice(1)} (${PRESET_FPS[p]} fps)`
              }))}
            />
          }
        />
      </Section>

      <Section title="Notifications">
        <Row
          label="Notifications"
          sub="Windows toasts when your posture needs a nudge."
          control={
            <Toggle
              label="Notifications"
              checked={settings.notifications.enabled}
              onChange={(v) => void patchSettings({ notifications: { enabled: v } })}
            />
          }
        />
        {settings.notifications.enabled && (
          <>
            <div className="flex flex-col gap-2">
              {ISSUES.map((issue) => {
                const cfg = settings.issues[issue]
                const from = notifyFrom(cfg.notifyStages)
                return (
                  <div key={issue} className={`flex items-center justify-between gap-4 ${cfg.enabled ? '' : 'opacity-40'}`}>
                    <span className="text-[13px] text-text">{ISSUE_LABELS[issue]}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-text-faint">Nudge me from:</span>
                      {from === 'custom' ? (
                        <Button variant="ghost" className="text-xs" onClick={() => patchIssue(issue, { notifyStages: [true, true, true] })}>
                          Custom — reset
                        </Button>
                      ) : (
                        <SegmentedControl<'1' | '2' | '3'>
                          value={from === 'none' ? null : (String(from) as '1' | '2' | '3')}
                          onChange={(v) => {
                            const k = Number(v)
                            patchIssue(issue, { notifyStages: [k <= 1, k <= 2, true] })
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
                onClick={() => setFineTune((v) => !v)}
                className="self-start text-xs text-text-faint hover:text-text-dim"
              >
                Fine-tune per stage {fineTune ? '▴' : '▾'}
              </button>
              {fineTune && (
                <div className="rounded-xl bg-ink/60 p-3 ring-1 ring-white/5">
                  <div className="grid grid-cols-[1fr_repeat(3,64px)] gap-y-2 text-center">
                    <span />
                    {(['slight', 'clear', 'severe'] as const).map((s, i) => (
                      <span key={s} className="text-[11px]" style={{ color: STAGE_COLOR[(i + 1) as 1 | 2 | 3] }}>
                        {s}
                      </span>
                    ))}
                    {ISSUES.map((issue) => (
                      <>
                        <span key={`${issue}-label`} className="text-left text-[13px] text-text">
                          {ISSUE_LABELS[issue]}
                        </span>
                        {[0, 1, 2].map((k) => (
                          <label key={`${issue}-${k}`} className="flex items-center justify-center">
                            <input
                              type="checkbox"
                              checked={settings.issues[issue].notifyStages[k]}
                              onChange={(e) => {
                                const next = [...settings.issues[issue].notifyStages] as [boolean, boolean, boolean]
                                next[k] = e.target.checked
                                patchIssue(issue, { notifyStages: next })
                              }}
                              className="h-4 w-4 accent-[var(--color-sage)]"
                            />
                          </label>
                        ))}
                      </>
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
              sub="How long poor posture must persist before the first toast."
              control={
                <Slider
                  value={settings.notifications.dwellSeconds}
                  min={5}
                  max={30}
                  step={1}
                  onChange={(v) => void patchSettings({ notifications: { dwellSeconds: v } })}
                  format={(v) => `${v} s`}
                />
              }
            />
            <Row
              label="Quiet period between nudges"
              sub="Per issue — a re-nudge waits at least this long."
              control={
                <Slider
                  value={settings.notifications.cooldownMinutes}
                  min={1}
                  max={10}
                  step={1}
                  onChange={(v) => void patchSettings({ notifications: { cooldownMinutes: v } })}
                  format={(v) => `${v} min`}
                />
              }
            />
            <Row
              label="Escalate if it gets worse"
              sub="A worsening stage notifies immediately, even during the quiet period."
              control={
                <Toggle
                  label="Escalation"
                  checked={settings.notifications.escalation}
                  onChange={(v) => void patchSettings({ notifications: { escalation: v } })}
                />
              }
            />
            <Row
              label="Sound"
              sub="Play the system notification sound with each nudge."
              control={
                <Toggle
                  label="Sound"
                  checked={settings.notifications.sound}
                  onChange={(v) => void patchSettings({ notifications: { sound: v } })}
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

      <Section title="General">
        <Row
          label="Start with Windows"
          sub="Launches minimized into the tray at sign-in."
          control={
            <Toggle
              label="Start with Windows"
              checked={settings.general.launchOnStartup}
              onChange={(v) => void patchSettings({ general: { launchOnStartup: v } })}
            />
          }
        />
        <Row
          label="Start minimized to tray"
          sub="The window stays hidden when SitSense starts."
          control={
            <Toggle
              label="Start minimized"
              checked={settings.general.startHidden}
              onChange={(v) => void patchSettings({ general: { startHidden: v } })}
            />
          }
        />
        <div className="flex items-center justify-between border-t border-hairline pt-3">
          <span className="text-xs text-text-faint">SitSense {appVersion}</span>
          <Button variant="danger" onClick={() => window.sitsense.quitApp()}>
            Quit SitSense
          </Button>
        </div>
      </Section>
    </div>
  )
}
