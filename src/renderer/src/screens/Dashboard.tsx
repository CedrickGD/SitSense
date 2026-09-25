import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react'
import { ISSUE_LABELS, ISSUES, type IssueId, type Stage, type StatMinute } from '@shared/posture'
import {
  formatClock,
  formatCountdown,
  formatDuration,
  STAGE_COLOR,
  STAGE_LABEL,
  useMediaQuery,
  useNow
} from '@renderer/lib/ui'
import { selectBaselineFromOtherCamera, useAppStore } from '@renderer/state/store'
import CameraFeed from '@renderer/components/CameraFeed'
import SpineGlyph from '@renderer/components/SpineGlyph'
import { Button, Menu, StagePill, Toggle } from '@renderer/components/primitives'

function worstIssue(issues: Record<IssueId, { stage: Stage }>): { issue: IssueId; stage: Stage } | null {
  let best: { issue: IssueId; stage: Stage } | null = null
  for (const id of ISSUES) {
    const s = issues[id].stage
    if (s > 0 && (best === null || s > best.stage)) best = { issue: id, stage: s }
  }
  return best
}

type Condition = 'paused' | 'uncalibrated' | 'camera' | 'model' | 'starting' | 'away' | 'issue' | 'good'

/** What the dashboard can honestly say right now, most blocking first. */
function useCondition(): Condition {
  const snapshot = useAppStore((s) => s.snapshot)
  const pause = useAppStore((s) => s.pause)
  const detection = useAppStore((s) => s.detection)
  const hasBaseline = useAppStore((s) => !!s.settings?.calibration)
  if (pause.paused) return 'paused'
  if (!hasBaseline) return 'uncalibrated'
  if (detection.cameraError) return 'camera'
  if (detection.modelError) return 'model'
  if (!detection.running || !snapshot) return 'starting'
  if (snapshot.presence === 'away') return 'away'
  return worstIssue(snapshot.issues) ? 'issue' : 'good'
}

function PauseControls(): JSX.Element {
  const pause = useAppStore((s) => s.pause)
  const now = useNow(1000, pause.paused && pause.resumeAt !== null)
  return (
    <div className="w-full rounded-2xl bg-card p-4 ring-1 ring-white/8">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-text">Monitoring</span>
        <Toggle label="Monitoring" checked={!pause.paused} onChange={(on) => window.sitsense.setPause(!on, null)} />
      </div>
      <div className="mt-3">
        {pause.paused ? (
          <Button variant="primary" className="w-full" onClick={() => window.sitsense.setPause(false)}>
            {pause.resumeAt ? `Resume — ${formatCountdown(pause.resumeAt - now)}` : 'Resume monitoring'}
          </Button>
        ) : (
          <div className="flex">
            <Button className="flex-1 rounded-r-none" onClick={() => window.sitsense.setPause(true, 15)}>
              Pause 15 min
            </Button>
            <Menu
              label="More pause options"
              align="right"
              triggerClassName="rounded-l-none border-l border-hairline px-2"
              trigger="▾"
              items={[
                { label: '15 minutes', onClick: () => window.sitsense.setPause(true, 15) },
                { label: '30 minutes', onClick: () => window.sitsense.setPause(true, 30) },
                { label: '60 minutes', onClick: () => window.sitsense.setPause(true, 60) },
                { label: 'Until I resume', onClick: () => window.sitsense.setPause(true, null) }
              ]}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function StatusColumn(): JSX.Element {
  const snapshot = useAppStore((s) => s.snapshot)
  const pause = useAppStore((s) => s.pause)
  const setRoute = useAppStore((s) => s.setRoute)
  const condition = useCondition()
  const short = useMediaQuery('(max-height: 680px)')
  const cameraChanged = useAppStore(selectBaselineFromOtherCamera)

  // "47 min in good posture": remember when the current good stretch began
  const isGood = condition === 'good'
  const [goodSince, setGoodSince] = useState<number | null>(null)
  useEffect(() => setGoodSince(isGood ? Date.now() : null), [isGood])
  const now = useNow(condition === 'paused' ? 1000 : 15_000, condition === 'good' || (condition === 'paused' && pause.resumeAt !== null))

  const worst = snapshot && condition === 'issue' ? worstIssue(snapshot.issues) : null
  const watching = condition === 'issue' || condition === 'good'
  const activeIssues = snapshot && watching ? ISSUES.map((id) => snapshot.issues[id]).filter((i) => i.stage > 0) : []

  const statusWord: Record<Condition, string> = {
    paused: 'Paused',
    uncalibrated: 'Not calibrated',
    camera: 'Camera unavailable',
    model: "Can't start",
    starting: 'Starting…',
    away: 'Away',
    issue: worst ? ISSUE_LABELS[worst.issue] : '',
    good: 'Good'
  }
  const sub: Partial<Record<Condition, string>> = {
    paused: pause.resumeAt ? `${formatCountdown(pause.resumeAt - now)} left` : 'until you resume',
    camera: 'Monitoring resumes as soon as the camera is back.',
    model: "The posture model couldn't load. Retrying…",
    away: 'Time away isn’t counted against your day.',
    // the clock only ticks every 15 s — a seconds count would just stutter
    good:
      goodSince !== null && now - goodSince >= 60_000
        ? `${formatDuration(now - goodSince)} in good posture`
        : 'Sitting well.'
  }

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <SpineGlyph
        size={short ? 64 : 96}
        issue={worst?.issue ?? null}
        stage={worst?.stage ?? 0}
        direction={worst?.issue === 'lean' ? snapshot?.issues.lean.direction : undefined}
        mode={condition === 'paused' ? 'paused' : watching ? 'normal' : 'away'}
      />
      {/* announce the state, not the per-second counters shown below it */}
      <span className="sr-only" aria-live="polite">
        {statusWord[condition]}
        {worst ? `, ${STAGE_LABEL[worst.stage]}` : ''}
      </span>
      <div className="text-center">
        <h1
          className={`font-display leading-tight font-semibold tracking-tight text-text ${short ? 'text-[26px]' : 'text-[34px]'}`}
        >
          {statusWord[condition]}
        </h1>
        {worst && (
          <div className="mt-1 flex items-center justify-center gap-2">
            <StagePill label={STAGE_LABEL[worst.stage]} color={STAGE_COLOR[worst.stage]} />
            {snapshot?.issues[worst.issue].activeForMs != null && (
              <span className="font-mono text-[13px] text-text-dim">
                for {formatDuration(snapshot.issues[worst.issue].activeForMs!)}
              </span>
            )}
          </div>
        )}
        {sub[condition] && (
          <p className={`mt-1 max-w-56 ${condition === 'paused' || condition === 'good' ? 'font-mono text-[13px] text-text-dim' : 'text-xs text-text-faint'}`}>
            {sub[condition]}
          </p>
        )}
        {condition === 'uncalibrated' && (
          <p className="mt-1 max-w-52 text-xs text-text-faint">
            SitSense needs a baseline of your upright posture before it can watch over you.
          </p>
        )}
      </div>

      {condition === 'uncalibrated' && (
        <Button variant="primary" className="w-full" onClick={() => setRoute('calibrate')}>
          Calibrate now
        </Button>
      )}

      {/* controls first: they must stay reachable however much is shown below */}
      <PauseControls />

      {watching && cameraChanged && !snapshot?.recalibrationSuggested && (
        <div className="w-full rounded-2xl bg-card p-4 ring-1 ring-amber/30">
          <p className="text-[13px] text-text">Different camera</p>
          <p className="mt-0.5 text-xs text-text-dim">
            Your baseline was captured with another camera — recalibrate for accurate readings.
          </p>
          <Button variant="primary" className="mt-2" onClick={() => setRoute('calibrate')}>
            Recalibrate
          </Button>
        </div>
      )}

      {watching && snapshot?.recalibrationSuggested && (
        <div className="w-full rounded-2xl bg-card p-4 ring-1 ring-amber/30">
          <p className="text-[13px] text-text">The view has changed</p>
          <p className="mt-0.5 text-xs text-text-dim">
            Your camera angle no longer matches your baseline, so nudges are on hold until you recalibrate.
          </p>
          <Button variant="primary" className="mt-2" onClick={() => setRoute('calibrate')}>
            Recalibrate
          </Button>
        </div>
      )}

      {watching && (
        <div className="w-full rounded-2xl bg-card p-4 ring-1 ring-white/8">
          <p className="mb-2 text-xs font-medium text-text-faint uppercase">Detected now</p>
          {activeIssues.length === 0 ? (
            <p className="text-[13px] text-text-faint">Nothing detected — sitting well.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {activeIssues.map((i) => (
                <li key={i.issue} className="flex items-center gap-2 text-[13px] text-text">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: STAGE_COLOR[i.stage] }} />
                  {ISSUE_LABELS[i.issue]}
                  {i.activeForMs != null && (
                    <span className="ml-auto font-mono text-xs text-text-dim">{formatDuration(i.activeForMs)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

interface Run {
  from: number
  to: number
  state: StatMinute['s']
}

function mergeRuns(minutes: StatMinute[]): Run[] {
  const runs: Run[] = []
  for (const m of minutes) {
    const last = runs[runs.length - 1]
    if (last && last.state === m.s && m.m - last.to <= 1) {
      last.to = m.m
    } else {
      // minutes the app wasn't running must occupy real width, not collapse
      if (last && m.m - last.to > 1) runs.push({ from: last.to + 1, to: m.m - 1, state: 'paused' })
      runs.push({ from: m.m, to: m.m, state: m.s })
    }
  }
  return runs
}

function runColor(state: StatMinute['s']): string {
  if (state === 'good') return 'var(--color-sage-deep)'
  if (state === 'away' || state === 'paused') return 'transparent'
  const stage = Number(state.split(':')[1] ?? 1) as Stage
  return STAGE_COLOR[stage]
}

function runLabel(state: StatMinute['s']): string {
  if (state === 'good') return 'Good posture'
  if (state === 'away') return 'Away'
  if (state === 'paused') return 'Not monitoring'
  const [issue, stage] = state.split(':')
  return `${ISSUE_LABELS[issue as IssueId]} (${STAGE_LABEL[Number(stage) as Stage]})`
}

const runText = (r: Run): string => `${formatClock(r.from)} – ${formatClock(r.to + 1)} · ${runLabel(r.state)}`

function TodayStrip(): JSX.Element {
  const today = useAppStore((s) => s.today)
  const windowVisible = useAppStore((s) => s.windowVisible)
  const [focus, setFocus] = useState<{ run: number; x: number } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // only while someone can see it
  useEffect(() => {
    if (!windowVisible) return
    const load = (): void => {
      window.sitsense.getTodayStats().then((today) => useAppStore.setState({ today }))
    }
    load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [windowVisible])

  const derived = useMemo(() => {
    if (!today || today.minutes.length === 0) return null
    const good = today.minutes.filter((m) => m.s === 'good').length
    const bad = today.minutes.filter((m) => m.s !== 'good' && m.s !== 'away' && m.s !== 'paused').length
    const tracked = good + bad
    return {
      runs: mergeRuns(today.minutes),
      first: today.minutes[0].m,
      last: today.minutes[today.minutes.length - 1].m,
      good,
      bad,
      pct: tracked > 0 ? Math.round((good / tracked) * 100) : null
    }
  }, [today])

  if (!derived) {
    return (
      <div className="rounded-2xl bg-card p-4 ring-1 ring-white/8">
        <p className="text-xs font-medium text-text-faint uppercase">Today</p>
        <p className="mt-1 text-[13px] text-text-faint">
          Your day’s timeline appears here once SitSense has watched for a minute.
        </p>
      </div>
    )
  }
  const span = Math.max(1, derived.last - derived.first + 1)
  // the reload every 30 s can merge runs (the current minute's state settles),
  // so a remembered index may point past the end
  const focusedRun = focus ? derived.runs[focus.run] : undefined
  const runAt = (clientX: number): { run: number; x: number } | null => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return null
    const x = Math.min(Math.max(0, clientX - rect.left), rect.width)
    const minute = derived.first + (x / rect.width) * span
    const run = derived.runs.findIndex((r) => minute >= r.from && minute < r.to + 1)
    return run >= 0 ? { run, x } : null
  }
  const centerOf = (i: number): number => {
    const r = derived.runs[i]
    const width = barRef.current?.getBoundingClientRect().width ?? 0
    return ((r.from - derived.first + (r.to - r.from + 1) / 2) / span) * width
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const last = derived.runs.length - 1
    const cur = focusedRun ? focus!.run : e.key === 'ArrowLeft' ? last + 1 : -1
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? last : Math.min(last, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)))
    setFocus({ run: next, x: centerOf(next) })
  }

  return (
    <div className="flex items-center gap-6 rounded-2xl bg-card p-4 ring-1 ring-white/8">
      <div className="shrink-0">
        <p className="text-xs font-medium text-text-faint uppercase">Today</p>
        {derived.pct === null ? (
          <p className="font-display text-lg font-semibold text-text-dim">No tracked time yet</p>
        ) : (
          <>
            <p className="font-display text-2xl font-semibold text-text">
              {derived.pct}% <span className="text-sm font-normal text-text-dim">aligned</span>
            </p>
            <p className="font-mono text-xs text-text-dim">
              {formatDuration(derived.good * 60_000)} good · {formatDuration(derived.bad * 60_000)} poor posture
            </p>
          </>
        )}
      </div>
      <div className="relative min-w-0 flex-1">
        <div
          ref={barRef}
          role="group"
          tabIndex={0}
          aria-label="Today's posture timeline — use the arrow keys to step through it"
          onPointerMove={(e: PointerEvent<HTMLDivElement>) => setFocus(runAt(e.clientX))}
          onPointerLeave={() => setFocus(null)}
          onKeyDown={onKey}
          onBlur={() => setFocus(null)}
          className="flex h-6 w-full overflow-hidden rounded-md bg-ink focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none motion-safe:origin-left motion-safe:animate-[growIn_400ms_ease-out]"
        >
          {derived.runs.map((r, i) => (
            <div
              key={i}
              className={`${r.state === 'away' || r.state === 'paused' ? 'border-t border-dotted border-hairline' : ''} ${
                focus?.run === i ? 'brightness-125' : ''
              }`}
              style={{
                width: `${((r.to - r.from + 1) / span) * 100}%`,
                backgroundColor: runColor(r.state)
              }}
            />
          ))}
        </div>
        {focusedRun && focus && (
          <div
            className="pointer-events-none absolute bottom-full mb-1.5 -translate-x-1/2 rounded-md bg-card px-2 py-1 font-mono text-xs whitespace-nowrap text-text shadow-lg ring-1 ring-white/10"
            style={{
              left: Math.min(Math.max(focus.x, 90), (barRef.current?.clientWidth ?? 0) - 90)
            }}
          >
            {runText(focusedRun)}
          </div>
        )}
        <span className="sr-only" aria-live="polite">
          {focusedRun ? runText(focusedRun) : ''}
        </span>
        <div className="mt-1 flex justify-between font-mono text-[11px] text-text-faint">
          <span>{formatClock(derived.first)}</span>
          <span>now</span>
        </div>
      </div>
    </div>
  )
}

export default function Dashboard(): JSX.Element {
  const hidePreview = useAppStore((s) => s.settings?.general.hidePreview ?? false)
  const patchSettings = useAppStore((s) => s.patchSettings)
  const detection = useAppStore((s) => s.detection)
  const paused = useAppStore((s) => s.pause.paused)
  const snapshot = useAppStore((s) => s.snapshot)
  const condition = useCondition()
  const worst = snapshot && condition === 'issue' ? worstIssue(snapshot.issues) : null
  // a problem must never hide behind a hidden preview
  const showPlaceholder = hidePreview && !detection.cameraError && !detection.modelError

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex min-h-0 flex-1 gap-6">
        <div className="flex min-w-0 flex-[3] flex-col gap-2">
          {showPlaceholder ? (
            <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-[20px] bg-surface ring-1 ring-white/8">
              <SpineGlyph
                size={72}
                issue={worst?.issue ?? null}
                stage={worst?.stage ?? 0}
                mode={paused ? 'paused' : condition === 'issue' || condition === 'good' ? 'normal' : 'away'}
              />
              <p className="text-xs text-text-faint">
                {paused ? 'Preview hidden — monitoring is paused' : 'Preview hidden — monitoring continues'}
              </p>
            </div>
          ) : (
            <CameraFeed />
          )}
          <button
            type="button"
            onClick={() => patchSettings({ general: { hidePreview: !hidePreview } })}
            className="self-end rounded text-xs text-text-faint hover:text-text-dim focus-visible:ring-2 focus-visible:ring-sage/70 focus-visible:outline-none"
          >
            {hidePreview ? 'Show preview' : paused ? 'Hide preview' : 'Hide preview (monitoring continues)'}
          </button>
        </div>
        <div className="w-64 shrink-0 overflow-y-auto xl:w-72">
          <StatusColumn />
        </div>
      </div>
      <TodayStrip />
    </div>
  )
}
