import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localDateKey } from '../../shared/stats'

const h = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.dir } }))

import { __resetPauseForTests } from '../pause'
import {
  __resetStatsForTests,
  getBreaksToday,
  getStatsRange,
  getTodayStats,
  initStats,
  normalizeRangeDays,
  statsPostureUpdate,
  statsRecordAlert,
  statsRecordBreak,
  stopStats
} from '../stats'

const dayKey = (offset: number, base = new Date()): string => localDateKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 12))
const minuteOf = (key: string, h24: number, m: number): number => {
  const [y, mo, d] = key.split('-').map(Number)
  return Math.floor(new Date(y, mo - 1, d, h24, m).getTime() / 60_000)
}
const writeDay = (key: string, body: unknown): void => {
  mkdirSync(join(h.dir, 'stats'), { recursive: true })
  writeFileSync(join(h.dir, 'stats', `${key}.json`), JSON.stringify(body))
}
const goodDay = (key: string, good: number, bad = 0): unknown => ({
  date: key,
  minutes: [
    ...Array.from({ length: good }, (_, i) => ({ m: minuteOf(key, 9, 0) + i, s: 'good' })),
    ...Array.from({ length: bad }, (_, i) => ({ m: minuteOf(key, 15, 0) + i, s: 'sink:2' }))
  ],
  alerts: bad > 0 ? 2 : 0,
  breaks: 1
})

describe('stats range', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    h.dir = mkdtempSync(join(tmpdir(), 'sitsense-stats-'))
    __resetStatsForTests()
    __resetPauseForTests()
  })
  afterEach(() => {
    stopStats()
    vi.useRealTimers()
  })

  it('validates the day count', () => {
    expect(normalizeRangeDays(7)).toBe(7)
    expect(normalizeRangeDays(0)).toBe(1)
    expect(normalizeRangeDays(500)).toBe(90)
    expect(normalizeRangeDays(6.6)).toBe(7)
    for (const bad of ['7', NaN, null, undefined, {}]) expect(() => normalizeRangeDays(bad)).toThrow(TypeError)
  })

  it('returns one summary per day, oldest first, with gaps as empty days and a streak', async () => {
    writeDay(dayKey(-3), goodDay(dayKey(-3), 50, 50))
    writeDay(dayKey(-2), goodDay(dayKey(-2), 90, 10))
    writeDay(dayKey(-1), goodDay(dayKey(-1), 80, 5))
    writeFileSync(join(h.dir, 'stats', `${dayKey(-4)}.json`), '{not json')
    initStats()
    const r = await getStatsRange(5)
    expect(r.days.map((d) => d.date)).toEqual([dayKey(-4), dayKey(-3), dayKey(-2), dayKey(-1), dayKey(0)])
    expect(r.days[0].hasData).toBe(false)
    expect(r.days[1]).toMatchObject({ hasData: true, trackedMinutes: 100, goodMinutes: 50, alertsCount: 2, breaksTaken: 1 })
    expect(r.days[1].minutesByIssueStage.sink).toEqual([0, 50, 0])
    expect(r.days[1].hourly[9].good).toBe(50)
    expect(r.days[4]).toMatchObject({ date: dayKey(0), trackedMinutes: 0 })
    // -3 is 50 %, -2 and -1 qualify, today is unfinished
    expect(r.streak).toMatchObject({ current: 2, best: 2 })
  })

  it('counts alerts and breaks for today, persists them and reloads them', async () => {
    initStats()
    statsRecordAlert()
    statsRecordAlert()
    statsRecordBreak()
    expect(getTodayStats()).toMatchObject({ alerts: 2, breaks: 1 })
    expect(getBreaksToday()).toBe(1)
    const today = (await getStatsRange(1)).days[0]
    expect(today).toMatchObject({ alertsCount: 2, breaksTaken: 1 })
    stopStats()
    const file = JSON.parse(readFileSync(join(h.dir, 'stats', `${dayKey(0)}.json`), 'utf8'))
    expect(file).toMatchObject({ date: dayKey(0), alerts: 2, breaks: 1 })
    __resetStatsForTests()
    initStats()
    expect(getTodayStats()).toMatchObject({ alerts: 2, breaks: 1 })
  })

  it('includes the minute in progress for today', async () => {
    initStats()
    statsPostureUpdate({
      presence: 'active',
      issues: { headForward: { issue: 'headForward', stage: 2, activeForMs: 1, metric: 0 } } as never,
      worstStage: 2,
      calibrated: true,
      recalibrationSuggested: false,
      ts: Date.now()
    })
    vi.advanceTimersByTime(5_000)
    const today = (await getStatsRange(1)).days[0]
    expect(today.minutesByIssue.headForward).toBe(1)
  })
})
