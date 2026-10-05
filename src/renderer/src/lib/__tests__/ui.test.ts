import { describe, expect, it } from 'vitest'
import type { IssueId, PostureReadout, Stage, StatMinute } from '@shared/posture'
import { aiErrorLine, goodStreakMinutes, mentionsSettings, mergeRuns, readoutItems, summarizeToday } from '../ui'

const stages = (p: Partial<Record<IssueId, Stage>> = {}): Record<IssueId, { stage: Stage }> => ({
  sink: { stage: p.sink ?? 0 },
  headForward: { stage: p.headForward ?? 0 },
  lean: { stage: p.lean ?? 0 },
  tooClose: { stage: p.tooClose ?? 0 }
})

const readout = (p: Partial<PostureReadout> = {}): PostureReadout => ({
  view: 'angled',
  neckFwd: null,
  trunkFwd: null,
  drop: null,
  forward: null,
  lateral: null,
  ...p
})

const mins = (start: number, states: StatMinute['s'][]): StatMinute[] => states.map((s, i) => ({ m: start + i, s }))

describe('readoutItems', () => {
  it('skips unavailable values and keeps the default order', () => {
    const items = readoutItems(readout({ neckFwd: 4.4, trunkFwd: 2, forward: 3.2, lateral: 1 }), stages())
    expect(items.map((i) => `${i.label} ${i.value}`)).toEqual(['Neck +4°', 'Trunk +2°', 'Distance 3 cm closer'])
  })

  it('puts flagged values first and colors them by their issue stage', () => {
    const items = readoutItems(readout({ neckFwd: 1, trunkFwd: 2, forward: -3, lateral: -9 }), stages({ lean: 2 }))
    expect(items[0]).toMatchObject({ key: 'lateral', value: '9° right', stage: 2 })
    expect(items).toHaveLength(3)
  })

  it('formats signs, zero and directions plainly', () => {
    const items = readoutItems(readout({ neckFwd: -3.6, trunkFwd: 0.2, forward: -2.6, lateral: 5, drop: 2 }), stages(), 5)
    expect(items.map((i) => i.value)).toEqual(['\u22124°', '0°', '3 cm farther', '5° left', '2 cm lower'])
  })

  it('returns nothing when no value is measurable', () => {
    expect(readoutItems(readout(), stages())).toEqual([])
  })
})

describe('aiErrorLine', () => {
  it('rewrites a single failed connection and points to Settings', () => {
    expect(aiErrorLine('AI review failed — Google Gemini: bad key.', true)).toBe(
      "Couldn't reach Google Gemini: bad key — check Settings → AI models."
    )
  })

  it('keeps messages that already mention Settings', () => {
    const m = 'No connected AI model is ready — add or enable one in Settings → AI models.'
    expect(aiErrorLine(m, true)).toBe(m)
    expect(mentionsSettings(m)).toBe(true)
  })

  it('does not point local messages to Settings', () => {
    expect(aiErrorLine('Monitoring is paused — resume it to ask.', false)).toBe('Monitoring is paused — resume it to ask.')
  })
})

describe('summarizeToday', () => {
  it('returns null (not 100% aligned) when nothing was tracked', () => {
    expect(summarizeToday([])).toBeNull()
    expect(summarizeToday(mins(100, ['away', 'paused', 'paused', 'away']))).toBeNull()
  })

  it('starts the timeline at the first tracked minute', () => {
    const leading = mins(0, Array<StatMinute['s']>(540).fill('away'))
    const work = mins(540, [...Array<StatMinute['s']>(45).fill('good'), ...Array<StatMinute['s']>(15).fill('sink:2')])
    const s = summarizeToday([...leading, ...work])!
    expect(s.first).toBe(540)
    expect(s.last).toBe(599)
    expect(s.goodMin).toBe(45)
    expect(s.badMin).toBe(15)
    expect(s.pct).toBe(75)
    expect(s.runs).toEqual([
      { from: 540, to: 584, state: 'good' },
      { from: 585, to: 599, state: 'sink:2' }
    ])
  })

  it('keeps away time after the first activity', () => {
    const s = summarizeToday(mins(10, ['good', 'away', 'away', 'good']))!
    expect(s.pct).toBe(100)
    expect(s.runs.map((r) => r.state)).toEqual(['good', 'away', 'good'])
  })
})

describe('mergeRuns', () => {
  it('fills minutes the app was not running with one paused gap', () => {
    const runs = mergeRuns([
      { m: 0, s: 'good' },
      { m: 5, s: 'paused' },
      { m: 6, s: 'good' }
    ])
    expect(runs).toEqual([
      { from: 0, to: 0, state: 'good' },
      { from: 1, to: 5, state: 'paused' },
      { from: 6, to: 6, state: 'good' }
    ])
  })
})

describe('goodStreakMinutes', () => {
  it('counts the trailing run of good minutes up to now', () => {
    expect(goodStreakMinutes(mins(0, ['sink:1', 'good', 'good', 'good']), 4)).toBe(3)
  })

  it('is 0 when the latest minute is old or not good', () => {
    expect(goodStreakMinutes(mins(0, ['good', 'good']), 10)).toBe(0)
    expect(goodStreakMinutes(mins(0, ['good', 'headForward:2']), 2)).toBe(0)
    expect(goodStreakMinutes([], 0)).toBe(0)
  })

  it('stops at a gap in the log', () => {
    expect(goodStreakMinutes([...mins(0, ['good', 'good']), ...mins(5, ['good'])], 5)).toBe(1)
  })
})
