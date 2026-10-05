// Settings › Posture detection (ui-v3 §6.2): per-issue cards, speed, processing, setup.

import { useId, type JSX } from 'react'
import { ISSUE_LABELS, ISSUES, type IssueId } from '@shared/posture'
import { PRESET_FPS, type PerformancePreset, type Settings } from '@shared/settings'
import SpineGlyph from '@renderer/components/SpineGlyph'
import { SegmentedControl, Toggle } from '@renderer/components/primitives'
import { useAppStore } from '@renderer/state/store'
import {
  DELEGATE_LABEL,
  ISSUE_WATCHES,
  SENSITIVITY_HINTS,
  SENSITIVITY_NAMES,
  SENSITIVITY_STEPS,
  sensitivityIndex
} from './meta'
import PostureSetupCard from './PostureSetupCard'
import { CardFooter, Saved, SettingsCard, SettingsGrid, SliderRow, useCommit } from './parts'

export default function DetectionPage({ settings }: { settings: Settings }): JSX.Element {
  return (
    <SettingsGrid>
      {ISSUES.map((issue) => (
        <IssueCard key={issue} issue={issue} settings={settings} />
      ))}
      <SpeedCard settings={settings} />
      <ProcessingCard settings={settings} />
      <PostureSetupCard />
    </SettingsGrid>
  )
}

function IssueCard({ issue, settings }: { issue: IssueId; settings: Settings }): JSX.Element {
  const { commit } = useCommit()
  const cfg = settings.issues[issue]
  const idx = sensitivityIndex(cfg.sensitivity)
  const key = `issue-${issue}`
  const titleId = useId()
  return (
    <SettingsCard span={6}>
      <div className="mb-4 flex items-center gap-3">
        {/* the issue's shape at full deformation so the four read apart; neutral sage, not a
            stage color — stage colors are for live state only, and this page is calm */}
        <span
          aria-hidden
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-card-2 ring-1 ring-white/[0.06] transition-opacity duration-150 ${
            cfg.enabled ? '' : 'opacity-50'
          }`}
        >
          <SpineGlyph
            size={40}
            issue={issue}
            stage={3}
            mode={cfg.enabled ? 'normal' : 'off'}
            breathing={false}
            className={cfg.enabled ? '[&_rect]:fill-sage' : ''}
          />
        </span>
        <h3 id={titleId} className={`min-w-0 flex-1 truncate type-title ${cfg.enabled ? 'text-text' : 'text-text-dim'}`}>
          {ISSUE_LABELS[issue]}
        </h3>
        <Saved k={`${key}-on`} />
        <Toggle
          label={`Watch for ${ISSUE_LABELS[issue].toLowerCase()}`}
          checked={cfg.enabled}
          onChange={(v) => commit(`${key}-on`, { issues: { [issue]: { enabled: v } } })}
        />
      </div>
      {cfg.enabled ? (
        <SliderRow
          label="Sensitivity"
          value={idx}
          min={0}
          max={SENSITIVITY_STEPS.length - 1}
          step={1}
          notches
          startLabel="Relaxed"
          endLabel="Strict"
          format={(i) => SENSITIVITY_NAMES[i] ?? '—'}
          description={SENSITIVITY_HINTS[idx]}
          savedKey={key}
          onCommit={(i) => commit(key, { issues: { [issue]: { sensitivity: SENSITIVITY_STEPS[i] } } })}
        />
      ) : (
        <p className="flex min-h-[86px] items-center justify-center rounded-xl border border-dashed border-hairline-strong type-body text-text-dim">
          Not watched.
        </p>
      )}
      <CardFooter>{ISSUE_WATCHES[issue]}</CardFooter>
    </SettingsCard>
  )
}

function SpeedCard({ settings }: { settings: Settings }): JSX.Element {
  const { commit } = useCommit()
  const hintId = useId()
  return (
    <SettingsCard span={6} eyebrow="Speed" action={<Saved k="performance" />}>
      <div className="flex flex-1 flex-col gap-3">
        <p className="type-body font-medium text-text">Performance</p>
        <SegmentedControl<PerformancePreset>
          ariaLabel="Performance"
          describedBy={hintId}
          fullWidth
          value={settings.performancePreset}
          onChange={(v) => commit('performance', { performancePreset: v })}
          options={(['efficient', 'balanced', 'responsive'] as const).map((p) => ({
            value: p,
            label: `${p[0].toUpperCase()}${p.slice(1)}`,
            sub: `${PRESET_FPS[p]} fps`
          }))}
        />
        <p id={hintId} className="mt-auto type-caption text-text-dim">
          Higher settings react faster and use more CPU.
        </p>
      </div>
    </SettingsCard>
  )
}

function ProcessingCard({ settings }: { settings: Settings }): JSX.Element {
  const { commit } = useCommit()
  const running = useAppStore((s) => s.detection.delegate)
  const hintId = useId()
  const inUse = running ?? settings.resolvedDelegate
  return (
    <SettingsCard span={6} eyebrow="Processing" action={<Saved k="delegate" />}>
      <div className="flex flex-1 flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="type-body font-medium text-text">Run the model on</p>
          <p className="type-caption text-text-dim">
            In use: <span className="type-value text-text">{inUse ?? '—'}</span>
          </p>
        </div>
        <SegmentedControl<Settings['delegate']>
          ariaLabel="Run the model on"
          describedBy={hintId}
          fullWidth
          value={settings.delegate}
          onChange={(v) => commit('delegate', { delegate: v })}
          options={(['auto', 'GPU', 'CPU'] as const).map((d) => ({ value: d, label: DELEGATE_LABEL[d] }))}
        />
        <p id={hintId} className="mt-auto type-caption text-text-dim">
          Auto uses the graphics card when it works. Pick Processor if detection won’t start.
        </p>
      </div>
    </SettingsCard>
  )
}
