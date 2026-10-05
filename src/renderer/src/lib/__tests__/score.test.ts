import { describe, expect, it } from 'vitest'
import type { IssueId, IssueSnapshot, PostureSnapshot, Stage } from '@shared/posture'
import { issuePenalty, levelFromThresholds, postureScore, rawScore, scoreBand, scoreColor, ScoreSmoother } from '../score'

type Issue = IssueSnapshot & { level?: number }

function issues(stages: Partial<Record<IssueId, number>>, levels: Partial<Record<IssueId, number>> = {}): Record<IssueId, Issue> {
  const mk = (issue: IssueId): Issue => ({
    issue,
    stage: (stages[issue] ?? 0) as Stage,
    activeForMs: null,
    metric: 0,
    ...(levels[issue] !== undefined ? { level: levels[issue] } : {})
  })
  return { sink: mk('sink'), headForward: mk('headForward'), lean: mk('lean'), tooClose: mk('tooClose') }
}

function snapshot(over: Partial<PostureSnapshot> = {}): PostureSnapshot {
  return {
    presence: 'active',
    issues: issues({}),
    worstStage: 0,
    calibrated: true,
    recalibrationSuggested: false,
    ts: 0,
    ...over
  } as PostureSnapshot
}

describe('issuePenalty', () => {
  it('matches the spec reference values (w = 1)', () => {
    expect(issuePenalty(0.5)).toBeCloseTo(8)
    expect(issuePenalty(1)).toBeCloseTo(18)
    expect(issuePenalty(2)).toBeCloseTo(44)
    expect(issuePenalty(3)).toBeCloseTo(78)
  })
  it('clamps severity to 0..3.5', () => {
    expect(issuePenalty(-2)).toBe(0)
    expect(issuePenalty(10)).toBeCloseTo(issuePenalty(3.5))
  })
})

describe('rawScore — spec examples', () => {
  it('no issues → 100', () => expect(rawScore(issues({}))).toBe(100))
  it('slight slouch → 82', () => expect(Math.round(rawScore(issues({ sink: 1 })))).toBe(82))
  it('clear head-forward → 56', () => expect(Math.round(rawScore(issues({ headForward: 2 })))).toBe(56))
  it('clear slouch + slight lean → 50', () => expect(Math.round(rawScore(issues({ sink: 2, lean: 1 })))).toBe(50))
  it('severe slouch → 22', () => expect(Math.round(rawScore(issues({ sink: 3 })))).toBe(22))
  it('never below 0', () => {
    expect(rawScore(issues({ sink: 3, headForward: 3, lean: 3, tooClose: 3 }, { sink: 3.5, headForward: 3.5 }))).toBe(0)
  })
  it('prefers the continuous level over the stage', () => {
    expect(rawScore(issues({ sink: 1 }, { sink: 0.5 }))).toBeCloseTo(92)
  })
  it('ignores disabled issues', () => {
    expect(rawScore(issues({ sink: 3 }), { sink: false })).toBe(100)
  })
})

describe('postureScore gate', () => {
  it('scores a live, calibrated, present snapshot', () => {
    expect(postureScore(snapshot({ issues: issues({ sink: 1 }) }))).toBeCloseTo(82)
  })
  it.each([
    ['no snapshot', null, {}],
    ['not calibrated', snapshot({ calibrated: false }), {}],
    ['away', snapshot({ presence: 'away' }), {}],
    ['paused', snapshot(), { paused: true }],
    ['camera error', snapshot(), { cameraError: 'denied' }],
    ['not running', snapshot(), { running: false }],
    ['other camera', snapshot(), { baselineMismatch: true }]
  ])('%s → null', (_, snap, gate) => {
    expect(postureScore(snap as PostureSnapshot | null, {}, gate)).toBeNull()
  })
})

describe('levelFromThresholds', () => {
  const t: [number, number, number] = [10, 18, 28]
  it('is piecewise linear with +1 per band and at most +0.5 beyond T3', () => {
    expect(levelFromThresholds(-3, t)).toBe(0)
    expect(levelFromThresholds(5, t)).toBeCloseTo(0.5)
    expect(levelFromThresholds(10, t)).toBeCloseTo(1)
    expect(levelFromThresholds(14, t)).toBeCloseTo(1.5)
    expect(levelFromThresholds(23, t)).toBeCloseTo(2.5)
    expect(levelFromThresholds(33, t)).toBeCloseTo(3.5)
    expect(levelFromThresholds(100, t)).toBeCloseTo(3.5)
    expect(levelFromThresholds(Number.NaN, t)).toBe(0)
  })
})

describe('bands', () => {
  it('uses ≥85 / ≥65 / ≥40 on the rounded score', () => {
    expect(scoreBand(100)).toBe('aligned')
    expect(scoreBand(84.6)).toBe('aligned')
    expect(scoreBand(84)).toBe('drifting')
    expect(scoreBand(65)).toBe('drifting')
    expect(scoreBand(64)).toBe('strained')
    expect(scoreBand(40)).toBe('strained')
    expect(scoreBand(39)).toBe('poor')
    expect(scoreBand(null)).toBeNull()
    expect(scoreColor(null)).toContain('faint')
    expect(scoreColor(90)).toContain('sage')
  })
})

describe('ScoreSmoother', () => {
  it('seeds from the first value and again after null', () => {
    const s = new ScoreSmoother(2000)
    expect(s.update(80, 0)).toBe(80)
    expect(s.update(null, 100)).toBeNull()
    expect(s.update(40, 200)).toBe(40)
  })
  it('moves 1 − e^(−Δt/τ) toward the raw value', () => {
    const s = new ScoreSmoother(2000)
    s.update(100, 0)
    expect(s.update(50, 2000)).toBeCloseTo(100 - 50 * (1 - Math.exp(-1)))
  })
})
