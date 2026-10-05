import { describe, expect, it } from 'vitest'
import type { StatMinute } from '../posture'
import { alignedShare, computeStreak, emptyDay, lastDateKeys, localDateKey, summarizeDay } from '../stats'

/** epoch minute of a local time on 2026-03-10 */
const at = (h: number, m: number): number => Math.floor(new Date(2026, 2, 10, h, m).getTime() / 60_000)

describe('summarizeDay', () => {
  it('returns an empty day for a missing file', () => {
    const d = summarizeDay('2026-03-10', null)
    expect(d).toEqual(emptyDay('2026-03-10'))
    expect(d.hasData).toBe(false)
    expect(d.hourly).toHaveLength(24)
  })

  it('totals minutes by state, issue and stage, hour buckets and first/last active', () => {
    const minutes: StatMinute[] = [
      { m: at(8, 59), s: 'paused' },
      { m: at(9, 0), s: 'good' },
      { m: at(9, 1), s: 'good' },
      { m: at(9, 2), s: 'sink:1' },
      { m: at(9, 3), s: 'sink:3' },
      { m: at(10, 0), s: 'away' },
      { m: at(14, 30), s: 'headForward:2' },
      { m: at(14, 31), s: 'good' }
    ]
    const d = summarizeDay('2026-03-10', { date: '2026-03-10', minutes, alerts: 4, breaks: 2 })
    expect(d).toMatchObject({
      hasData: true,
      trackedMinutes: 6,
      goodMinutes: 3,
      awayMinutes: 1,
      pausedMinutes: 1,
      alertsCount: 4,
      breaksTaken: 2,
      firstActive: at(9, 0) * 60_000,
      lastActive: at(14, 31) * 60_000
    })
    expect(d.minutesByIssue).toEqual({ sink: 2, headForward: 1, lean: 0, tooClose: 0 })
    expect(d.minutesByIssueStage.sink).toEqual([1, 0, 1])
    expect(d.minutesByIssueStage.headForward).toEqual([0, 1, 0])
    expect(d.hourly[9]).toEqual({ good: 2, bad: 2 })
    expect(d.hourly[14]).toEqual({ good: 1, bad: 1 })
    expect(d.hourly[10]).toEqual({ good: 0, bad: 0 })
    expect(alignedShare(d)).toBe(0.5)
  })

  it('skips junk entries, de-duplicates minutes and ignores bad counters', () => {
    const d = summarizeDay('2026-03-10', {
      minutes: [{ m: at(9, 0), s: 'sink:2' }, { m: at(9, 0), s: 'good' }, { m: 'x', s: 'good' }, { m: at(9, 1), s: 'sink:9' }, null] as never,
      alerts: -3,
      breaks: 'many' as never
    })
    expect(d).toMatchObject({ trackedMinutes: 1, goodMinutes: 1, alertsCount: 0, breaksTaken: 0 })
    expect(alignedShare(emptyDay('x'))).toBeNull()
  })
})

describe('computeStreak', () => {
  const day = (good: number, tracked: number) => ({ goodMinutes: good, trackedMinutes: tracked })

  it('counts consecutive qualifying days ending today', () => {
    expect(computeStreak([day(80, 100), day(90, 100), day(75, 100)])).toMatchObject({ current: 3, best: 3 })
    expect(computeStreak([day(80, 100), day(10, 100), day(75, 100)])).toMatchObject({ current: 1, best: 1 })
  })

  it('an unfinished today does not break the streak', () => {
    expect(computeStreak([day(80, 100), day(90, 100), day(0, 5)]).current).toBe(2)
    expect(computeStreak([day(80, 100), day(0, 0), day(0, 0)]).current).toBe(0)
  })

  it('needs enough tracked time and honours a custom rule', () => {
    expect(computeStreak([day(20, 20)]).current).toBe(0)
    expect(computeStreak([day(20, 20)], 0.7, 10).current).toBe(1)
    expect(computeStreak([day(60, 100), day(60, 100)], 0.5)).toMatchObject({ current: 2, minAlignedShare: 0.5 })
    expect(computeStreak([])).toMatchObject({ current: 0, best: 0 })
  })

  it('best is the longest run in the range', () => {
    expect(computeStreak([day(80, 100), day(80, 100), day(80, 100), day(0, 100), day(80, 100)])).toMatchObject({ current: 1, best: 3 })
  })
})

describe('date keys', () => {
  it('lists local days oldest first, across month ends and DST changes', () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(lastDateKeys(new Date(2026, 2, 2, 0, 30), 4)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
    expect(lastDateKeys(new Date(2026, 2, 30, 23, 59), 3)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30'])
    expect(lastDateKeys(new Date(2026, 9, 26, 1), 1)).toEqual(['2026-10-26'])
  })
})
