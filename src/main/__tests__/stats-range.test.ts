import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localDateKey } from '../../shared/stats'

const h = vi.hoisted(() => ({ dir: '', failReads: 0 }))
vi.mock('electron', () => ({ app: { getPath: () => h.dir } }))
// lets a test make a day file look locked (EBUSY, as during an AV scan at login)
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    if (h.failReads > 0 && /[\\/]stats[\\/]\d{4}-\d{2}-\d{2}\.json$/.test(String(args[0]))) {
      h.failReads--
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    return real.readFileSync(...args)
  }) as typeof real.readFileSync
  return { ...real, readFileSync, default: { ...real, readFileSync } }
})

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
    h.failReads = 0
    __resetStatsForTests()
    __resetPauseForTests()
  })
  afterEach(() => {
    stopStats()
    h.failReads = 0
    vi.useRealTimers()
  })

  const readDay = (key: string): { minutes: { m: number; s: string }[]; alerts: number; breaks: number } =>
    JSON.parse(readFileSync(join(h.dir, 'stats', `${key}.json`), 'utf8'))
  const nowMinute = (): number => Math.floor(Date.now() / 60_000)
  const seeded = (): { m: number; s: string }[] => Array.from({ length: 10 }, (_, i) => ({ m: nowMinute() - 100 + i, s: 'good' }))

  it('a locked day file at startup is merged later, never overwritten', () => {
    const key = dayKey(0)
    const before = seeded()
    writeDay(key, { date: key, minutes: before, alerts: 3, breaks: 2 })
    h.failReads = 3 // both startup reads and the first write's re-read fail
    initStats()
    expect(getTodayStats()).toMatchObject({ alerts: 0, breaks: 0 })
    statsRecordAlert()
    vi.advanceTimersByTime(5_000) // one sample + the scheduled write, which must back off
    expect(readDay(key)).toMatchObject({ minutes: before, alerts: 3, breaks: 2 })
    statsRecordBreak()
    stopStats() // the file is readable now: merge, then write
    const after = readDay(key)
    expect(after.alerts).toBe(4)
    expect(after.breaks).toBe(3)
    expect(after.minutes.slice(0, 10)).toEqual(before)
    expect(after.minutes).toHaveLength(11) // + the minute logged after the restart
  })

  it('a corrupt day file is moved aside before today is written; a BOM is not corruption', () => {
    const key = dayKey(0)
    writeDay(key, {})
    writeFileSync(join(h.dir, 'stats', `${key}.json`), '{"minutes": [')
    initStats()
    statsRecordAlert()
    stopStats()
    const backups = readdirSync(join(h.dir, 'stats')).filter((f) => f.startsWith(`${key}.json.corrupt-`))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(h.dir, 'stats', backups[0]), 'utf8')).toBe('{"minutes": [')
    expect(readDay(key)).toMatchObject({ alerts: 1 })

    __resetStatsForTests()
    writeFileSync(join(h.dir, 'stats', `${key}.json`), '﻿' + JSON.stringify({ date: key, minutes: seeded(), alerts: 5 }))
    initStats()
    expect(getTodayStats()).toMatchObject({ alerts: 5 })
    expect(getTodayStats().minutes.length).toBeGreaterThanOrEqual(10)
  })

  it('setting the clock back to a day that has a file continues that file instead of wiping it', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    const noon = new Date()
    noon.setHours(12, 0, 0, 0)
    vi.setSystemTime(noon)
    const a = dayKey(0)
    const b = dayKey(1)
    const original = Array.from({ length: 30 }, (_, i) => ({ m: minuteOf(a, 9, 0) + i, s: 'good' }))
    writeDay(a, { date: a, minutes: original, alerts: 2, breaks: 1 })
    initStats()
    vi.advanceTimersByTime(5_000)
    // a wrong clock jumps a day ahead, then time sync corrects it
    vi.setSystemTime(new Date(noon.getFullYear(), noon.getMonth(), noon.getDate() + 1, 0, 1))
    vi.advanceTimersByTime(5_000)
    expect(getTodayStats().date).toBe(b)
    vi.setSystemTime(new Date(noon.getFullYear(), noon.getMonth(), noon.getDate(), 12, 5))
    vi.advanceTimersByTime(5_000)
    expect(getTodayStats()).toMatchObject({ date: a, alerts: 2, breaks: 1 })
    statsRecordAlert()
    stopStats()
    const file = readDay(a)
    expect(file).toMatchObject({ alerts: 3, breaks: 1 })
    expect(file.minutes.slice(0, 30)).toEqual(original)
    // one entry per minute, in order
    const ms = file.minutes.map((e) => e.m)
    expect(ms).toEqual([...new Set(ms)].sort((x, y) => x - y))
    expect(existsSync(join(h.dir, 'stats', `${b}.json`))).toBe(true)
  })

  it('prunes files older than 90 days at the day change, not only at startup', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    const start = new Date()
    start.setHours(23, 59, 0, 0)
    vi.setSystemTime(start)
    // 90 days before tomorrow: inside the window today, outside it tomorrow
    const expiring = dayKey(-89, start)
    const kept = dayKey(-88, start)
    writeDay(expiring, goodDay(expiring, 40))
    writeDay(kept, goodDay(kept, 40))
    initStats()
    vi.advanceTimersByTime(5_000)
    expect(existsSync(join(h.dir, 'stats', `${expiring}.json`))).toBe(true)
    // past midnight (2 h margin keeps a DST change inside the window from mattering)
    vi.setSystemTime(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 2, 0))
    vi.advanceTimersByTime(5_000)
    expect(existsSync(join(h.dir, 'stats', `${expiring}.json`))).toBe(false)
    expect(existsSync(join(h.dir, 'stats', `${kept}.json`))).toBe(true)
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

  it('does not count a suspended minute (view changed since setup) as good', async () => {
    initStats()
    statsPostureUpdate({
      presence: 'active',
      issues: { headForward: { issue: 'headForward', stage: 0, activeForMs: null, metric: 0 } } as never,
      worstStage: 0,
      calibrated: true,
      recalibrationSuggested: true,
      suspended: true,
      ts: Date.now()
    })
    vi.advanceTimersByTime(5_000)
    const today = (await getStatsRange(1)).days[0]
    expect(today.goodMinutes).toBe(0)
    expect(today.pausedMinutes).toBe(1)
  })
})
