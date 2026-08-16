import { useEffect, useMemo, type JSX } from 'react'
import { ISSUE_LABELS, ISSUES, type IssueId, type Stage, type StatMinute } from '@shared/posture'
import { formatClock, formatCountdown, formatDuration, ISSUE_SHORT, STAGE_COLOR, STAGE_LABEL } from '@renderer/lib/ui'
import { useAppStore } from '@renderer/state/store'
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

function StatusColumn(): JSX.Element {
  const snapshot = useAppStore((s) => s.snapshot)
  const pause = useAppStore((s) => s.pause)
  const settings = useAppStore((s) => s.settings)
  const setRoute = useAppStore((s) => s.setRoute)

  const worst = snapshot ? worstIssue(snapshot.issues) : null
  const away = snapshot?.presence === 'away'
  const mode = pause.paused ? 'paused' : away ? 'away' : 'normal'
  const activeIssues = snapshot
    ? ISSUES.map((id) => snapshot.issues[id]).filter((i) => i.stage > 0)
    : []

  const statusWord = pause.paused
    ? 'Paused'
    : away
      ? 'Away'
      : !snapshot?.calibrated
        ? 'Not calibrated'
        : worst
          ? ISSUE_LABELS[worst.issue]
          : 'Good'

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <SpineGlyph
        size={96}
        issue={worst?.issue ?? null}
        stage={pause.paused || away ? 0 : (worst?.stage ?? 0)}
        direction={worst?.issue === 'lean' ? snapshot?.issues.lean.direction : undefined}
        mode={mode}
      />
      <div className="text-center">
        <h1 className="font-display text-[34px] leading-tight font-semibold tracking-tight text-text">
          {statusWord}
        </h1>
        {worst && !pause.paused && !away && (
          <div className="mt-1 flex items-center justify-center gap-2">
            <StagePill label={STAGE_LABEL[worst.stage]} color={STAGE_COLOR[worst.stage]} />
            {snapshot?.issues[worst.issue].activeForMs != null && (
              <span className="font-mono text-[13px] text-text-dim">
                for {formatDuration(snapshot.issues[worst.issue].activeForMs!)}
              </span>
            )}
          </div>
        )}
        {!snapshot?.calibrated && !pause.paused && (
          <p className="mt-1 max-w-52 text-xs text-text-faint">
            SitSense needs a baseline of your upright posture before it can watch over you.
          </p>
        )}
      </div>

      {snapshot?.calibrated && (
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

      {snapshot?.recalibrationSuggested && (
        <div className="w-full rounded-2xl bg-card p-4 ring-1 ring-amber/30">
          <p className="text-[13px] text-text">The view has changed</p>
          <p className="mt-0.5 text-xs text-text-dim">
            Your camera angle no longer matches your baseline, so readings may be off.
          </p>
          <Button variant="primary" className="mt-2" onClick={() => setRoute('calibrate')}>
            Recalibrate
          </Button>
        </div>
      )}

      <div className="w-full rounded-2xl bg-card p-4 ring-1 ring-white/8">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-text">Monitoring</span>
          <Toggle
            label="Monitoring"
            checked={!pause.paused}
            onChange={(on) => window.sitsense.setPause(!on, null)}
          />
        </div>
        <div className="mt-3">
          {pause.paused ? (
            <Button
              variant="primary"
              className="w-full"
              onClick={() => window.sitsense.setPause(false)}
            >
              {pause.resumeAt ? `Resume — ${formatCountdown(pause.resumeAt - Date.now())}` : 'Resume monitoring'}
            </Button>
          ) : (
            <div className="flex">
              <Button className="flex-1 rounded-r-none" onClick={() => window.sitsense.setPause(true, 15)}>
                Pause 15 min
              </Button>
              <Menu
                align="right"
                trigger={
                  <Button className="rounded-l-none border-l border-hairline px-2" title="More pause options">
                    ▾
                  </Button>
                }
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

      {settings && !settings.calibration && (
        <Button variant="primary" className="w-full" onClick={() => setRoute('calibrate')}>
          Calibrate now
        </Button>
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
    if (last && last.state === m.s && m.m - last.to <= 1) last.to = m.m
    else runs.push({ from: m.m, to: m.m, state: m.s })
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
  if (state === 'paused') return 'Paused'
  const [issue, stage] = state.split(':')
  return `${ISSUE_SHORT[issue as IssueId]} (${STAGE_LABEL[Number(stage) as Stage]})`
}

function TodayStrip(): JSX.Element | null {
  const today = useAppStore((s) => s.today)

  useEffect(() => {
    const load = (): void => {
      window.sitsense.getTodayStats().then((today) => useAppStore.setState({ today }))
    }
    load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [])

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
      pct: tracked > 0 ? Math.round((good / tracked) * 100) : 100
    }
  }, [today])

  if (!derived) return null
  const span = Math.max(1, derived.last - derived.first + 1)

  return (
    <div className="flex items-center gap-6 rounded-2xl bg-card p-4 ring-1 ring-white/8">
      <div className="shrink-0">
        <p className="text-xs font-medium text-text-faint uppercase">Today</p>
        <p className="font-display text-2xl font-semibold text-text">
          {derived.pct}% <span className="text-sm font-normal text-text-dim">aligned</span>
        </p>
        <p className="font-mono text-xs text-text-dim">
          {formatDuration(derived.good * 60_000)} good · {formatDuration(derived.bad * 60_000)} slouching
        </p>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex h-6 w-full overflow-hidden rounded-md bg-ink motion-safe:origin-left motion-safe:animate-[growIn_400ms_ease-out]">
          {derived.runs.map((r, i) => (
            <div
              key={i}
              title={`${formatClock(r.from)} – ${formatClock(r.to + 1)} · ${runLabel(r.state)}`}
              className={r.state === 'away' || r.state === 'paused' ? 'border-t border-dotted border-hairline' : ''}
              style={{
                width: `${((r.to - r.from + 1) / span) * 100}%`,
                backgroundColor: runColor(r.state)
              }}
            />
          ))}
        </div>
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

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex min-h-0 flex-1 gap-6">
        <div className="flex min-w-0 flex-[3] flex-col gap-2">
          {hidePreview ? (
            <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-[20px] bg-surface ring-1 ring-white/8">
              <SpineGlyph size={72} issue={null} stage={0} />
              <p className="text-xs text-text-faint">Preview hidden — monitoring continues</p>
            </div>
          ) : (
            <CameraFeed />
          )}
          <button
            type="button"
            onClick={() => patchSettings({ general: { hidePreview: !hidePreview } })}
            className="self-end text-xs text-text-faint hover:text-text-dim"
          >
            {hidePreview ? 'Show preview' : 'Hide preview (monitoring continues)'}
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
