// Setup step 2 — Posture, the coach (ui-v3.md §7.3–§7.5). The rule: setup never passes
// what it cannot check. The session (posture/calibration.ts) decides; this screen words
// it — one big instruction, the checklist, the essentials counter, the progress ring, the
// AI second opinion and, only after 20 s, "Save this posture anyway — unverified".

import { useEffect, useRef, useState, type JSX } from 'react'
import { detectionController } from '@renderer/detection/controller'
import { Icon } from '@renderer/components/icons'
import { Button, Chip } from '@renderer/components/primitives'
import { plural } from '@renderer/lib/format'
import { REVIEW_MAX_AUTO } from '@renderer/posture/constants'
import { useWindowHeight, type Breakpoint } from '@renderer/lib/hooks'
import { useAppStore, type SetupUiState } from '@renderer/state/store'
import {
  CAMERA_FIX_COPY,
  FORCE_VISIBLE_AFTER_MS,
  GUIDE_LINE,
  HOLD_STILL_COPY,
  aiHintCopy,
  aiLabel,
  aiSetupState,
  cameraFix,
  checkStatusText,
  essentialsChecked,
  guideFocus,
  isCameraFixCopy,
  primaryCopy,
  progressKind,
  rowKind,
  rowStatusText,
  splitInstruction,
  unverifiedEssentials,
  waitingForView,
  type GuideFocus,
  type PrimaryCopy
} from './copy'
import PostureGuide from './PostureGuide'
import { ProgressRing, RowMark, SetupCamera, SetupColumns, StepEyebrow, useDrain, useElapsed, useSettled } from './parts'

interface Props {
  bp: Breakpoint
  /** when step 2 began (or "Start over"): "Save anyway" waits 20 s from here */
  coachSince: number | null
  onOpenAi: () => void
}

export default function StepPosture({ bp, coachSince, onOpenAi }: Props): JSX.Element {
  const view = useAppStore((s) => s.setup.view)
  const compact = bp === 'compact'
  return (
    <SetupColumns
      bp={bp}
      left={
        <>
          <SetupCamera view={view} />
          <TargetCard compact={compact} />
          <AiHint onOpenAi={onOpenAi} />
        </>
      }
      right={<CoachPanel bp={bp} coachSince={coachSince} />}
    />
  )
}

// ───────────────────────────── coach panel ─────────────────────────────

function useCopy(setup: SetupUiState): PrimaryCopy {
  const paused = useAppStore((s) => s.pause.paused)
  const cameraError = useAppStore((s) => s.detection.cameraError !== null)
  const running = useAppStore((s) => s.detection.running)
  const detectorError = useAppStore((s) => s.detectorError)
  const ai = useAppStore((s) => aiSetupState(s.settings))
  return primaryCopy(setup, { paused, cameraError, detectorError, running, ai })
}

function CoachPanel({ bp, coachSince }: { bp: Breakpoint; coachSince: number | null }): JSX.Element {
  const compact = bp === 'compact'
  const setup = useAppStore((s) => s.setup)
  const copy = useCopy(setup)
  // the instruction only changes after the new one held for 0.6 s; the hold copy and
  // blocked/failed states show at once. The whole copy settles (text, sub, attribution),
  // so a waiting instruction never borrows the next one's sub-line or source.
  const settledText = useSettled(copy.text, 600, copy.text === HOLD_STILL_COPY || copy.tone !== 'normal')
  const last = useRef(copy)
  if (copy.text === settledText) last.current = copy
  const shown: PrimaryCopy = last.current
  const { head, sub } = splitInstruction(shown.text)
  const subLine = shown.sub ?? sub
  const waiting = waitingForView(setup)
  // "Suggested by …" only under a live instruction — not while a reviewer is asked (the
  // card says who) and not on hold (the headline already names the model)
  const coaching =
    shown.tone === 'normal' &&
    !waiting &&
    setup.phase !== 'idle' &&
    setup.phase !== 'reviewing' &&
    setup.autoCapture &&
    !isCameraFixCopy(shown.text)
  // the second-opinion card takes the progress slot; on short windows the rows that are
  // already good fold into one line so nothing has to scroll
  const reviewCard = hasReviewCard(setup)
  const short = useWindowHeight() < 760
  // "Save anyway" never before 20 s of coaching (§7.3), and only when the session allows it
  const forceShown = useElapsed(coachSince, FORCE_VISIBLE_AFTER_MS) && setup.canForce

  return (
    <div className="flex min-h-0 flex-col">
      <p className="sr-only" aria-live="polite">
        {shown.text}
        {subLine ? ` ${subLine}` : ''}
      </p>
      <StepEyebrow n={2} />
      <h1
        id="setup-primary"
        className={`mt-2 ${compact ? 'type-h2' : 'type-h1'} ${shown.tone === 'fail' ? 'text-amber' : 'text-text'}`}
      >
        <span key={head} className="block motion-safe:animate-[ss-fade_200ms_ease-out]">
          {head}
        </span>
      </h1>
      {subLine && (
        <p
          key={subLine}
          className={`mt-2 max-w-[46ch] text-text-dim motion-safe:animate-[ss-fade_200ms_ease-out] ${compact ? 'type-body' : 'type-body-lg'}`}
        >
          {subLine}
        </p>
      )}
      {coaching && (
        <p className="mt-2 flex items-center gap-1.5 type-caption text-text-faint">
          <Icon name="spark" size={12} className="text-sage" />
          {shown.attribution ?? 'Suggested by on-device AI'}
        </p>
      )}
      {shown.tone === 'blocked' && <BlockedAction />}

      {shown.tone !== 'blocked' && (
        <>
          <Checklist setup={setup} compact={compact} primary={copy.text} collapse={(reviewCard || forceShown) && short} />
          <div
            className={`flex flex-col border-t border-white/[0.06] ${compact ? 'mt-3 gap-2.5 pt-3' : 'mt-4 gap-3 pt-4'}`}
          >
            <ReviewArea setup={setup} />
            {(!reviewCard || !setup.autoCapture || setup.phase === 'holding' || setup.phase === 'capturing') && (
              <Progress setup={setup} compact={compact} />
            )}
            {setup.reviewNote && setup.phase !== 'reviewing' && (
              <p className="flex gap-2 type-caption text-text-dim">
                <Icon name="info" size={14} className="mt-px shrink-0 text-text-faint" />
                <span>{setup.reviewNote}</span>
              </p>
            )}
            {forceShown && <ForceSave />}
          </div>
        </>
      )}
    </div>
  )
}

function BlockedAction(): JSX.Element | null {
  const paused = useAppStore((s) => s.pause.paused || s.setup.suspended === 'paused')
  const detectorError = useAppStore((s) => s.detectorError)
  if (paused) {
    return (
      <Button variant="primary" size="lg" icon="play" ringOn="setup" className="mt-6 self-start" onClick={() => void window.sitsense.setPause(false)}>
        Resume monitoring
      </Button>
    )
  }
  if (detectorError === 'model') {
    return (
      <Button size="lg" icon="refresh" ringOn="setup" className="mt-6 self-start" onClick={() => detectionController.retryCamera()}>
        Try again now
      </Button>
    )
  }
  // camera errors: the preview shows its own fix-it panel with retry buttons
  return null
}

// ───────────────────────────── checklist ─────────────────────────────

const goodLine = (n: number): string => `${plural(n, 'check')} ${n === 1 ? 'looks' : 'look'} good`

/** The second-opinion card is showing (pending, or a verdict still on screen). */
function hasReviewCard(setup: SetupUiState): boolean {
  if (setup.phase === 'reviewing') return true
  const r = setup.reviewResult
  return r !== null && (r.verdict === 'adjust' || setup.phase === 'done')
}

function Checklist({
  setup,
  compact,
  primary,
  collapse
}: {
  setup: SetupUiState
  compact: boolean
  primary: string
  /** fold the rows that are already good into one summary row */
  collapse?: boolean
}): JSX.Element {
  const waiting = waitingForView(setup)
  const { done, total } = essentialsChecked(setup.checks)
  const rows = setup.checks.map((c) => ({ c, kind: rowKind(c, waiting) }))
  const folded = collapse ? rows.filter((r) => r.kind === 'good' || r.kind === 'na') : []
  const visible = collapse ? rows.filter((r) => r.kind !== 'good' && r.kind !== 'na') : rows
  return (
    <div className={compact ? 'mt-3' : 'mt-6'}>
      <ul aria-label="Posture checklist" className="flex flex-col">
        {folded.length > 0 && (
          <li className={`flex items-center gap-3 border-b border-white/[0.04] ${compact ? 'h-7' : 'h-9'}`}>
            <RowMark kind="good" />
            <span className={`min-w-0 flex-1 truncate text-text-dim ${compact ? 'type-body' : 'type-body-lg'}`}>
              {goodLine(folded.filter((r) => r.kind === 'good').length)}
            </span>
          </li>
        )}
        {visible.map(({ c, kind }) => {
          const status = rowStatusText(kind, c)
          return (
            <li
              key={c.id}
              className={`flex items-center gap-3 border-b border-white/[0.04] last:border-b-0 ${compact ? 'h-7' : 'h-9'}`}
              title={kind === 'adjust' && c.instruction && c.instruction !== primary ? c.instruction : undefined}
            >
              <RowMark kind={kind} />
              <span
                className={`min-w-0 flex-1 truncate transition-colors duration-150 ${compact ? 'type-body' : 'type-body-lg'} ${
                  kind === 'pending' || kind === 'na' ? 'text-text-dim' : 'text-text'
                }`}
              >
                {c.label}
              </span>
              <span className="sr-only">: {checkStatusText(kind)}</span>
              {status && (
                <span
                  key={status}
                  aria-hidden
                  className={`shrink-0 type-caption motion-safe:animate-[fadeIn_150ms_ease-out] ${
                    kind === 'adjust' || kind === 'unverified' ? 'text-amber' : 'text-text-faint'
                  }`}
                >
                  {status}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <p className={`type-caption text-text-dim ${compact ? 'mt-1.5' : 'mt-3'}`}>
        Essentials checked:{' '}
        <span className="text-text">
          <span className="font-mono tabular-nums">{waiting ? 0 : done}</span> of{' '}
          <span className="font-mono tabular-nums">{total}</span>
        </span>
      </p>
    </div>
  )
}

// ───────────────────────────── progress ─────────────────────────────

function Progress({ setup, compact }: { setup: SetupUiState; compact: boolean }): JSX.Element | null {
  const kind = progressKind(setup)
  const value = kind === 'hold' ? setup.holdProgress : kind === 'capture' ? setup.captureProgress : 0
  const drain = useDrain(setup.phase, value)
  const settings = useAppStore((s) => s.settings)
  const ai = aiSetupState(settings)
  const unverified = unverifiedEssentials(setup)
  const size = compact ? 44 : 56

  if (kind === 'review' || setup.phase === 'failed' || setup.phase === 'done') return null

  let label: string
  let note: string
  if (kind === 'hold') {
    label = 'Hold it…'
    note = 'Keep this posture — SitSense is making sure it’s steady.'
  } else if (kind === 'capture') {
    label = 'Capturing your posture…'
    note = 'Stay still for a moment longer.'
  } else if (!setup.autoCapture) {
    label = 'Saving is on hold'
    note = `${setup.reviewResult?.label ?? 'Your AI model'} turned this posture down ${plural(REVIEW_MAX_AUTO, 'time')}. Change what it asks, then start over.`
  } else if (unverified.length > 0 && ai === 'on') {
    label = 'Waiting for a good posture'
    note = `Once everything visible checks out, ${aiLabel(settings) ?? 'your AI model'} double-checks the rest.`
  } else if (unverified.length > 0 || setup.needsVerification) {
    label = 'Can’t confirm this from here yet'
    const fix = cameraFix(setup)
    note = fix ? CAMERA_FIX_COPY[fix].note : 'SitSense only saves a posture it could check. Follow the instruction above.'
  } else {
    label = 'Waiting for a good posture'
    note = 'SitSense saves it by itself once every essential check is good.'
  }

  return (
    <div className="flex items-center gap-4" key={drain?.key}>
      <ProgressRing
        value={value}
        size={size}
        label={kind ? label : undefined}
        drainFrom={drain && !kind ? drain.from : undefined}
      >
        {!kind && !drain && unverified.length > 0 && ai !== 'on' ? (
          <Icon name="alert" size={compact ? 16 : 18} className="text-amber" />
        ) : !kind && !drain ? (
          <Icon name="spine" size={compact ? 16 : 18} className="text-text-faint" />
        ) : null}
      </ProgressRing>
      <div className="min-w-0">
        <p className={`text-text ${compact ? 'type-body' : 'type-title'}`}>{label}</p>
        <p className="mt-0.5 type-caption text-text-dim">{note}</p>
        {!setup.autoCapture && (
          <Button variant="secondary" size="md" icon="refresh" ringOn="setup" className="mt-2.5" onClick={() => detectionController.restartSetup()}>
            Start over
          </Button>
        )}
      </div>
    </div>
  )
}

// ───────────────────────────── AI second opinion (§7.5) ─────────────────────────────

function ReviewArea({ setup }: { setup: SetupUiState }): JSX.Element | null {
  const result = setup.reviewResult
  if (setup.phase === 'reviewing') return <ReviewPending setup={setup} />
  if (!result) return null
  if (result.verdict === 'good' && setup.phase !== 'done') return null
  // a one-item list that only repeats the headline (on hold, or the reviewer's fix shown big) adds nothing
  const repeatsPrimary =
    result.instructions.length === 1 && (!setup.autoCapture || setup.instruction === result.instructions[0])
  return (
    <section aria-label="Second opinion" className="surface-raised rounded-xl p-4 motion-safe:animate-[rowIn_150ms_ease-out]">
      <ReviewHeader label={result.label} model={result.model} />
      <div className="mt-3 flex items-start gap-2.5">
        <Chip tone={result.verdict === 'good' ? 'sage' : 'amber'} icon={result.verdict === 'good' ? 'check' : 'alert'}>
          {result.verdict === 'good' ? 'Looks good' : 'Adjust'}
        </Chip>
        <p className="min-w-0 type-body text-text">“{result.summary}”</p>
      </div>
      {result.verdict === 'adjust' && !repeatsPrimary && result.instructions.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1.5">
          {result.instructions.map((ins, i) => (
            <li key={ins} className="flex gap-2.5 type-body text-text-dim">
              <span className="w-4 shrink-0 text-right font-mono text-text-faint tabular-nums">{i + 1}</span>
              <span>{ins}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function ReviewHeader({ label, model }: { label: string; model: string | null }): JSX.Element {
  return (
    <header className="flex items-center gap-2">
      <Icon name="spark" size={16} className="text-sage" />
      <span className="type-title text-text">Second opinion</span>
      <span className="min-w-0 truncate type-caption text-text-faint">
        {label}
        {model ? ` · ${model}` : ''}
      </span>
    </header>
  )
}

function ReviewPending({ setup }: { setup: SetupUiState }): JSX.Element {
  const label = setup.reviewing?.label ?? 'your AI model'
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8000)
    return () => clearTimeout(t)
  }, [])
  const unverified = setup.unverifiedChecks.length > 0
  return (
    <section aria-label="Second opinion" className="surface-raised rounded-xl p-4 motion-safe:animate-[rowIn_150ms_ease-out]">
      <ReviewHeader label={label} model={null} />
      <div
        role="progressbar"
        aria-label={`Asking ${label} for a second opinion`}
        className="relative mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]"
      >
        <div className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-sage/70 motion-safe:animate-[shimmerSlide_1.4s_ease-in-out_infinite] motion-reduce:w-full motion-reduce:opacity-40" />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="min-w-0 type-body text-text-dim" aria-live="polite">
          {slow ? 'Still looking — some models take a moment.' : `Asking ${label} for a second opinion…`}
        </p>
        <Button variant="ghost" size="sm" ringOn="card-2" onClick={() => detectionController.skipSetupReview()}>
          Skip
        </Button>
      </div>
      {unverified && (
        <p className="mt-1 type-caption text-text-faint">Skipping means this posture isn’t saved — the camera can’t confirm it alone.</p>
      )}
    </section>
  )
}

// ───────────────────────────── left column ─────────────────────────────

function TargetCard({ compact }: { compact: boolean }): JSX.Element {
  const focus: GuideFocus = useAppStore((s) => guideFocus(s.setup))
  const settled = useSettled(focus, 600)
  const line = GUIDE_LINE[settled ?? 'none']
  return (
    <section
      aria-label="What a good posture looks like"
      className={`surface-card flex items-center rounded-2xl ${compact ? 'gap-3 p-3' : 'gap-6 px-6 py-4'}`}
    >
      <PostureGuide focus={settled} size={compact ? 112 : 196} />
      <div className="min-w-0">
        <p className="type-micro text-text-faint">Target</p>
        <p key={line} className={`mt-1 text-text motion-safe:animate-[ss-fade_200ms_ease-out] ${compact ? 'type-body' : 'type-body-lg'}`}>
          {line}
        </p>
        {!compact && (
          <p className="mt-2 flex items-center gap-3 type-caption text-text-faint">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-[3px] w-4 rounded-full bg-sage" /> good posture
            </span>
            {settled && settled !== 'hips' && settled !== 'verify' && settled !== 'side' && (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-4 border-t-2 border-dashed border-amber" /> you now
              </span>
            )}
          </p>
        )}
      </div>
    </section>
  )
}

/** An essential can't be checked and no reviewer runs: offer one (§7.4.4). */
function AiHint({ onOpenAi }: { onOpenAi: () => void }): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const show = useAppStore((s) => {
    const st = s.setup
    if (st.phase === 'done' || st.phase === 'reviewing' || st.phase === 'idle') return false
    return !!st.needsVerification || unverifiedEssentials(st).length > 0
  })
  const patchSettings = useAppStore((s) => s.patchSettings)
  const ai = aiSetupState(settings)
  const copy = aiHintCopy(ai, aiLabel(settings))
  if (!show || !copy) return null
  return (
    <section
      aria-label="AI second opinion"
      className="surface-raised flex items-start gap-3 rounded-xl px-4 py-3 motion-safe:animate-[rowIn_150ms_ease-out]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sage-soft text-sage">
        <Icon name="spark" size={16} />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-[200px] flex-1 type-body text-text-dim">{copy.text}</p>
        <Button
          variant="secondary"
          size="sm"
          ringOn="card-2"
          onClick={() => (ai === 'off-in-setup' ? void patchSettings({ ai: { useInSetup: true } }) : onOpenAi())}
        >
          {copy.action}
        </Button>
      </div>
    </section>
  )
}

/** "Save this posture anyway — unverified": ghost, never before 20 s of coaching (§7.3). */
function ForceSave(): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-0.5 border-t border-white/[0.06] pt-3 motion-safe:animate-[rowIn_150ms_ease-out]">
      <Button variant="ghost" ringOn="setup" className="-ml-3.5" onClick={() => detectionController.forceSetup()}>
        Save this posture anyway — unverified
      </Button>
      <p className="max-w-[52ch] type-caption text-text-faint">
        SitSense couldn’t confirm it. Your score will be marked unverified until you redo setup.
      </p>
    </div>
  )
}
