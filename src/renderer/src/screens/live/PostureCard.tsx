// Live › Posture card (docs/specs/ui-v3.md §3.4): score ring + status (Zone A), the four
// metric gauges (Zone B), and the view / setup age when there is room (Zone C).

import type { JSX, ReactNode } from 'react'
import { ISSUES, type IssueId } from '@shared/posture'
import { useAppStore } from '@renderer/state/store'
import { useLiveScore, useMonitoring } from '@renderer/lib/hooks'
import { fmtRelative, fmtMinutes } from '@renderer/lib/format'
import { goodStreakMinutes, STAGE_COLOR, STAGE_LABEL, VIEW_LABEL } from '@renderer/lib/ui'
import { Card, CardHeader, Chip, Button, Divider, Gauge, ScoreRing, StagePill, Tooltip } from '@renderer/components/primitives'
import { Icon } from '@renderer/components/icons'
import { fmtLiveDuration, gaugeGate, gaugeModels, GAUGE_GATE_COPY, statusView, type StatusKind } from './liveModel'
import { useElementSize } from './useElementSize'

const SCORE_INFO = 'Score 0–100 from how far you are from your saved good posture right now.'

const UNVERIFIED_TIP = "SitSense couldn't confirm your saved posture from this angle. Redo setup for an accurate score."

/**
 * The quiet line under the status word for states without a score. Away, unseen, paused
 * and starting have none: the Zone B placeholder already says it once.
 */
const STATUS_SUB: Partial<Record<StatusKind, string>> = {
  setup: 'SitSense coaches you into a good posture first.',
  camera: "Posture isn't being watched right now.",
  mismatch: 'Your saved posture is for another camera.',
  changed: "Posture isn't judged until you redo setup.",
  restarting: 'Back in a moment.'
}

function StatusZone({ ringSize }: { ringSize: number }): JSX.Element {
  const m = useMonitoring()
  const snapshot = useAppStore((s) => s.snapshot)
  const verified = useAppStore((s) => s.settings?.calibration?.verified ?? true)
  const minutes = useAppStore((s) => s.today?.minutes)
  const openSetup = useAppStore((s) => s.openSetup)
  const { score } = useLiveScore()

  const view = statusView({
    paused: m.paused,
    running: m.running,
    cameraError: m.cameraError,
    detectorError: m.detectorError,
    calibrated: m.calibrated,
    mismatch: m.mismatch,
    snapshot
  })

  let sub: ReactNode = null
  if (view.kind === 'issue' && view.worst && snapshot) {
    const ms = snapshot.issues[view.worst.issue].activeForMs
    sub = (
      <>
        <StagePill label={STAGE_LABEL[view.worst.stage]} color={STAGE_COLOR[view.worst.stage]} />
        {ms != null && <span className="type-value text-text-dim">for {fmtLiveDuration(ms)}</span>}
      </>
    )
  } else if (view.kind === 'good') {
    const streak = minutes ? goodStreakMinutes(minutes, Math.floor(Date.now() / 60_000)) : 0
    sub = <span className="type-value text-text-dim">{streak > 0 ? `${fmtMinutes(streak)} aligned` : 'aligned with your setup'}</span>
  } else if (STATUS_SUB[view.kind]) {
    // pretty: no lone word ("first.") on a second line
    sub = <span className="type-caption text-pretty text-text-dim">{STATUS_SUB[view.kind]}</span>
  }

  return (
    <div className="flex items-center gap-4">
      {/* 88 px ring: the 44 px score face would overflow its 68 px hole, so it steps down to h1 size */}
      <ScoreRing value={view.kind === 'good' || view.kind === 'issue' ? score : null} size={ringSize} className={ringSize < 100 ? '[&_.type-score]:text-[32px] [&_.type-score]:leading-[32px]' : ''} />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        {/* a stable live region (a freshly mounted one is often not announced); the key on
            the h3 only restarts the fade */}
        <div aria-live="polite" aria-atomic="true">
          <h3
            key={view.word}
            className={`type-h2 text-balance motion-safe:animate-[fadeIn_200ms_ease-out] ${view.kind === 'good' || view.kind === 'issue' ? 'text-text' : 'text-text-dim'}`}
          >
            {view.word}
          </h3>
        </div>
        {sub && <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{sub}</div>}
        {m.calibrated && !verified && (
          <Tooltip content={UNVERIFIED_TIP} placement="bottom">
            <span className="mt-0.5 inline-flex">
              <Chip tone="outline-amber" icon="alert" onClick={() => openSetup()} ariaLabel={`Unverified baseline. ${UNVERIFIED_TIP}`}>
                Unverified baseline
              </Chip>
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

function GaugeZone({ showTracks }: { showTracks: boolean }): JSX.Element {
  const m = useMonitoring()
  const snapshot = useAppStore((s) => s.snapshot)
  const issues = useAppStore((s) => s.settings?.issues)
  const openSettings = useAppStore((s) => s.openSettings)
  const openSetup = useAppStore((s) => s.openSetup)
  const view = statusView({
    paused: m.paused,
    running: m.running,
    cameraError: m.cameraError,
    detectorError: m.detectorError,
    calibrated: m.calibrated,
    mismatch: m.mismatch,
    snapshot
  })
  const gate = gaugeGate(view.kind)

  if (gate !== null || !snapshot) {
    const g = gate ?? 'starting'
    return (
      <div className="flex min-h-24 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/[0.08] px-4 py-5 text-center">
        <Icon
          name={
            g === 'paused'
              ? 'pause'
              : g === 'setup' || g === 'mismatch' || g === 'changed'
                ? 'setup'
                : g === 'camera'
                  ? 'camera'
                  : g === 'restarting'
                    ? 'refresh'
                    : 'live'
          }
          size={20}
          className="text-text-faint"
        />
        <p className="max-w-[30ch] type-body text-text-dim">{GAUGE_GATE_COPY[g]}</p>
        {(g === 'setup' || g === 'mismatch' || g === 'changed') && (
          <Button variant="primary" size="sm" icon="setup" ringOn="card" onClick={() => openSetup()}>
            {g === 'setup' ? 'Set up posture' : 'Redo posture setup'}
          </Button>
        )}
      </div>
    )
  }

  const sensitivity: Partial<Record<IssueId, number>> = {}
  if (issues) for (const id of ISSUES) sensitivity[id] = issues[id].sensitivity
  const models = gaugeModels(snapshot.readout, sensitivity)
  return (
    <div role="group" className={`flex flex-col ${showTracks ? 'gap-3' : 'gap-2'}`} aria-label="Live measurements compared with your saved posture">
      {models.map((g) => (
        <Gauge
          key={g.key}
          label={g.label}
          value={g.value}
          valueText={g.valueText}
          range={g.range}
          ticks={g.ticks}
          stage={snapshot.issues[g.issue].stage}
          twoSided={g.twoSided}
          unavailableReason={g.unavailableReason}
          disabled={issues ? !issues[g.issue].enabled : false}
          onTurnOn={() => openSettings('detection')}
          hideTrack={!showTracks}
        />
      ))}
    </div>
  )
}

/** Zone C: view chip + setup age — only when the card is tall enough (> 420 px). */
function SetupZone(): JSX.Element | null {
  const baseline = useAppStore((s) => s.settings?.calibration ?? null)
  const viewKind = useAppStore((s) => s.snapshot?.readout?.view ?? null)
  if (!baseline) return null
  const kind = viewKind ?? baseline.view.kind
  return (
    <div className="mt-auto flex items-center justify-between gap-2 pt-4">
      <Chip tone="neutral" icon="camera">
        {VIEW_LABEL[kind]}
      </Chip>
      <span className="type-caption text-text-faint">Setup {fmtRelative(baseline.capturedAt)}</span>
    </div>
  )
}

export default function PostureCard({ ringSize, showTracks }: { ringSize: number; showTracks: boolean }): JSX.Element {
  const [ref, size] = useElementSize<HTMLDivElement>()
  return (
    <Card dense as="section" aria-labelledby="live-posture" className="flex h-full min-w-0 flex-col">
      <div ref={ref} className="flex min-h-0 flex-1 flex-col">
        <CardHeader id="live-posture" eyebrow="Posture" info={SCORE_INFO} />
        <StatusZone ringSize={ringSize} />
        <Divider />
        <GaugeZone showTracks={showTracks} />
        {size.height > 388 && <SetupZone />}
      </div>
    </Card>
  )
}
