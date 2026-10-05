import { describe, expect, it } from 'vitest'
import type { CalibrationBaseline, IssueId, IssueSnapshot, PostureSnapshot, Stage } from '@shared/posture'
import type { DaySummary, StatsRange } from '@shared/stats'
import {
  baselinePreview,
  buildContext,
  buildLiveContext,
  isLocalConnection,
  liveKey,
  livePreview,
  liveUnavailable,
  todayPreview,
  type CoachContextInputs
} from '../context'
import { DEFAULT_CONTEXT_TOGGLES } from '../types'

const NOW = new Date(2026, 9, 5, 14, 0).getTime()

function issue(id: IssueId, stage: Stage = 0): IssueSnapshot {
  return { issue: id, stage, activeForMs: stage ? 60_000 : null, metric: 0 }
}

function snap(stages: Partial<Record<IssueId, Stage>> = {}, over: Partial<PostureSnapshot> = {}): PostureSnapshot {
  return {
    presence: 'active',
    issues: {
      sink: issue('sink', stages.sink),
      headForward: issue('headForward', stages.headForward),
      lean: issue('lean', stages.lean),
      tooClose: issue('tooClose', stages.tooClose)
    },
    worstStage: (Math.max(0, ...Object.values(stages)) as Stage) ?? 0,
    calibrated: true,
    recalibrationSuggested: false,
    readout: { view: 'side', neckFwd: 4.4, trunkFwd: -1.2, drop: null, forward: null, lateral: null },
    ts: NOW,
    ...over
  }
}

function day(date: string, over: Partial<DaySummary> = {}): DaySummary {
  const zero = { sink: 0, headForward: 0, lean: 0, tooClose: 0 }
  return {
    date,
    hasData: true,
    trackedMinutes: 246,
    goodMinutes: 202,
    minutesByIssue: { ...zero, headForward: 38, sink: 6 },
    minutesByIssueStage: {
      sink: [0, 0, 0],
      headForward: [0, 0, 0],
      lean: [0, 0, 0],
      tooClose: [0, 0, 0]
    } as unknown as DaySummary['minutesByIssueStage'],
    awayMinutes: 30,
    pausedMinutes: 0,
    firstActive: null,
    lastActive: null,
    hourly: [],
    alertsCount: 3,
    breaksTaken: 2,
    ...over
  }
}

const RANGE: StatsRange = {
  days: [day('2026-10-04', { trackedMinutes: 100, goodMinutes: 50 }), day('2026-10-05')],
  streak: { current: 4, best: 6, minAlignedShare: 0.7, minTrackedMinutes: 30 }
}

const BASELINE = {
  version: 2,
  capturedAt: NOW - 2 * 86_400_000,
  view: { kind: 'side', yawDeg: 90, elevationDeg: 0 },
  verified: true,
  neckFwd: 9.04,
  trunkFwd: -3.26,
  headPitch: 4
} as unknown as CalibrationBaseline

function inputs(over: Partial<CoachContextInputs> = {}): CoachContextInputs {
  return {
    snapshot: snap({ headForward: 2 }),
    paused: false,
    live: true,
    calibrated: true,
    sitting: { sittingMinutes: 42, sittingSince: NOW - 42 * 60_000, onBreak: false, breakSince: null, nextReminderAt: null, breaksToday: 2 },
    range: RANGE,
    baseline: BASELINE,
    now: NOW,
    ...over
  }
}

describe('live context', () => {
  it('sends the live readout, issue stages and the sitting stretch', () => {
    expect(buildLiveContext(inputs())).toEqual({
      presence: 'active',
      calibrated: true,
      view: 'side',
      neckFwdDeg: 4,
      trunkFwdDeg: -1,
      issues: { sink: 0, headForward: 2, lean: 0, tooClose: 0 },
      worstStage: 2,
      sittingMinutes: 42
    })
  })

  it('never shares live numbers while paused or without a camera', () => {
    expect(buildLiveContext(inputs({ paused: true }))).toBeUndefined()
    expect(buildLiveContext(inputs({ live: false }))).toBeUndefined()
    expect(buildLiveContext(inputs({ snapshot: null }))).toBeUndefined()
    expect(liveUnavailable(inputs({ paused: true }))).toMatch(/Paused/)
    expect(liveUnavailable(inputs({ live: false }))).toMatch(/Camera off/)
    expect(liveUnavailable(inputs())).toBeNull()
  })

  it('reports only presence when away, and no stages before setup', () => {
    const away = buildLiveContext(inputs({ snapshot: snap({}, { presence: 'away' }) }))
    expect(away?.presence).toBe('away')
    expect(away?.issues).toBeUndefined()
    const noSetup = buildLiveContext(inputs({ calibrated: false }))
    expect(noSetup?.issues).toBeUndefined()
    expect(noSetup?.calibrated).toBe(false)
  })

  it('leaves out issues the user switched off', () => {
    const live = buildLiveContext(inputs({ enabledIssues: { headForward: false } }))
    expect(live?.issues?.headForward).toBeUndefined()
    expect(live?.worstStage).toBe(0)
  })

  it('omits the sitting time when not sitting', () => {
    const live = buildLiveContext(inputs({ sitting: { sittingMinutes: 0, sittingSince: null, onBreak: true, breakSince: NOW - 5 * 60_000, nextReminderAt: null, breaksToday: 0 } }))
    expect(live?.sittingMinutes).toBeUndefined()
  })
})

describe('buildContext', () => {
  it('builds today, history and baseline from the same inputs', () => {
    const ctx = buildContext(inputs(), DEFAULT_CONTEXT_TOGGLES)
    expect(ctx?.today).toEqual({
      trackedMinutes: 246,
      goodMinutes: 202,
      awayMinutes: 30,
      minutesByIssue: { sink: 6, headForward: 38 },
      alertsCount: 3,
      breaksTaken: 2
    })
    expect(ctx?.history).toEqual({ days: 2, alignedShare: Math.round((252 / 346) * 100) / 100, streakDays: 4 })
    expect(ctx?.baseline).toEqual({ capturedAt: BASELINE.capturedAt, view: 'side', verified: true, neckFwdDeg: 9, trunkFwdDeg: -3.3, headPitchDeg: 4 })
  })

  it('respects each toggle', () => {
    expect(buildContext(inputs(), { live: false, today: true, baseline: true })?.live).toBeUndefined()
    const noToday = buildContext(inputs(), { live: true, today: false, baseline: true })
    expect(noToday?.today).toBeUndefined()
    expect(noToday?.history).toBeUndefined()
    expect(buildContext(inputs(), { live: true, today: true, baseline: false })?.baseline).toBeUndefined()
    expect(buildContext(inputs(), { live: false, today: false, baseline: false })).toBeUndefined()
  })

  it('skips today when there is no data yet, and history without any data', () => {
    const empty: StatsRange = { days: [day('2026-10-05', { hasData: false, trackedMinutes: 0, goodMinutes: 0 })], streak: RANGE.streak }
    const ctx = buildContext(inputs({ range: empty, baseline: null, paused: true }), DEFAULT_CONTEXT_TOGGLES)
    expect(ctx).toBeUndefined()
  })
})

describe('previews', () => {
  it('live: status word, signed numbers with the real minus, view and sitting', () => {
    expect(livePreview(inputs()).lines).toEqual(['Head forward · clear · Neck +4° · Back −1°', 'Side view · sitting 42 min'])
    expect(livePreview(inputs({ snapshot: snap() })).lines[0]).toBe('Aligned · Neck +4° · Back −1°')
    expect(livePreview(inputs({ paused: true }))).toEqual({ available: false, lines: ['Paused — live numbers aren’t shared'] })
    expect(livePreview(inputs({ calibrated: false })).lines).toEqual(['In view · posture not set up yet'])
  })

  it('today: aligned share and time, the worst issue and breaks', () => {
    expect(todayPreview(inputs()).lines).toEqual(['82% aligned · 4h 06m', 'Head forward 38 min · 2 breaks'])
    expect(todayPreview(inputs({ range: null })).available).toBe(false)
  })

  it('baseline: view, verified and age', () => {
    expect(baselinePreview(inputs()).lines).toEqual(['Side view · verified', 'Set up 2 days ago'])
    expect(baselinePreview(inputs({ baseline: null }))).toEqual({ available: false, lines: ['Not set up yet'] })
  })

  it('liveKey changes when the state changes a lot', () => {
    const a = liveKey(inputs())
    expect(liveKey(inputs({ snapshot: snap({ headForward: 2 }, { readout: { view: 'side', neckFwd: 6, trunkFwd: 0, drop: null, forward: null, lateral: null } }) }))).toBe(a)
    expect(liveKey(inputs({ snapshot: snap() }))).not.toBe(a)
    expect(liveKey(inputs({ paused: true }))).toBeNull()
  })
})

describe('isLocalConnection', () => {
  it('detects localhost servers', () => {
    expect(isLocalConnection({ baseUrl: 'http://localhost:11434/v1' })).toBe(true)
    expect(isLocalConnection({ baseUrl: 'http://127.0.0.1:1234/v1' })).toBe(true)
    expect(isLocalConnection({ baseUrl: null }, 'https://api.openai.com/v1')).toBe(false)
    expect(isLocalConnection({ baseUrl: 'not a url' })).toBe(false)
    expect(isLocalConnection({ baseUrl: null })).toBe(false)
  })
})
