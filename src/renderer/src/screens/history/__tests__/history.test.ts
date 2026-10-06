import { describe, expect, it } from 'vitest'
import type { StatMinute } from '@shared/posture'
import { emptyDay, summarizeDay, type DaySummary } from '@shared/stats'
import {
  addDays,
  alignedPct,
  anyTracked,
  bestWorstHours,
  buildTimeline,
  dayKpis,
  hourCells,
  hourTicks,
  hourTooltip,
  issueRows,
  longStretchCount,
  pctDelta,
  pooledPct,
  previousKeys,
  segmentLabel,
  sittingStretches,
  stageSplitText,
  stageTotals,
  streakKpi,
  sumDays,
  weekKeys,
  weekKpis,
  weekLabel,
  weekStart
} from '../history'

/** epoch minute of a local clock time on 2026-10-05 (a Monday) */
const at = (h: number, m = 0, day = 5): number => Math.floor(new Date(2026, 9, day, h, m).getTime() / 60_000)

/** a run of `n` minutes in state `s` starting at `from` */
const run = (from: number, n: number, s: StatMinute['s']): StatMinute[] => Array.from({ length: n }, (_, i) => ({ m: from + i, s }))

function day(partial: Partial<DaySummary> & { date?: string }): DaySummary {
  return { ...emptyDay(partial.date ?? '2026-10-05'), ...partial }
}

describe('dates', () => {
  it('steps days across month ends and DST', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30')
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26') // EU DST ends 25 Oct
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('weeks start on Monday', () => {
    expect(weekStart('2026-10-05')).toBe('2026-10-05') // Mon
    expect(weekStart('2026-10-04')).toBe('2026-09-28') // Sun → previous Mon
    expect(weekStart('2026-10-07')).toBe('2026-10-05')
    expect(weekKeys('2026-10-01')).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
  })
  it('labels a week', () => {
    expect(weekLabel('2026-10-01')).toMatch(/^28 \S+ – 4 \S+$/)
  })
  it('lists the 7 previous keys oldest first', () => {
    expect(previousKeys('2026-10-05')).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
  })
})

describe('aligned %', () => {
  it('is good / active, rounded, hidden under 5 active minutes', () => {
    expect(alignedPct(41, 50)).toBe(82)
    expect(alignedPct(3, 4)).toBeNull()
    expect(alignedPct(0, 0)).toBeNull()
    expect(alignedPct(5, 5)).toBe(100)
    expect(alignedPct(Number.NaN, 10)).toBeNull()
  })
  it('pools several days', () => {
    expect(pooledPct([day({ goodMinutes: 30, trackedMinutes: 60 }), day({ goodMinutes: 60, trackedMinutes: 60 })])).toBe(75)
    expect(pooledPct([])).toBeNull()
  })
  it('formats the delta with tone', () => {
    expect(pctDelta(82, 76, 'avg')).toEqual({ text: '+6 vs avg', tone: 'good' })
    expect(pctDelta(70, 76, 'avg')).toEqual({ text: '−6 vs avg', tone: 'warn' })
    expect(pctDelta(77, 76, 'avg')).toEqual({ text: '+1 vs avg', tone: 'faint' })
    expect(pctDelta(76, 76, 'last week')).toEqual({ text: 'same as last week', tone: 'faint' })
    expect(pctDelta(76, null, 'avg')).toBeNull()
  })
})

describe('by issue', () => {
  const d = day({
    minutesByIssueStage: { sink: [18, 10, 3], headForward: [10, 4, 0], lean: [6, 0, 0], tooClose: [0, 0, 0] }
  })
  it('lists all four issues sorted by minutes', () => {
    const rows = issueRows(d)
    expect(rows.map((r) => r.issue)).toEqual(['sink', 'headForward', 'lean', 'tooClose'])
    expect(rows[0].total).toBe(31)
    expect(rows[3].total).toBe(0)
  })
  it('sums stages and writes the split', () => {
    expect(stageTotals(d)).toEqual([34, 14, 3])
    expect(stageSplitText([18, 10, 3])).toBe('slight 18 · clear 10 · severe 3 min')
  })
})

describe('by hour', () => {
  const hourly = Array.from({ length: 24 }, () => ({ good: 0, bad: 0 }))
  hourly[10] = { good: 50, bad: 2 }
  hourly[15] = { good: 20, bad: 30 }
  hourly[16] = { good: 4, bad: 2 }
  const cells = hourCells(hourly)
  it('colors by band and fades by activity', () => {
    expect(cells[10].pct).toBe(96)
    expect(cells[10].band).toBe('aligned')
    expect(cells[10].opacity).toBe(1)
    expect(cells[15].band).toBe('strained')
    expect(cells[16].opacity).toBeCloseTo(0.35 + 0.65 * (6 / 30))
    expect(cells[3]).toMatchObject({ hasData: false, opacity: 0, pct: null, band: null })
  })
  it('writes the tooltip', () => {
    expect(hourTooltip(cells[15])).toBe('15:00–16:00 · 40% aligned · 50 min tracked')
    expect(hourTooltip(cells[3])).toBe('03:00–04:00 · nothing tracked')
  })
  it('ranks only hours with ≥ 15 active minutes', () => {
    expect(bestWorstHours(cells)).toEqual({ best: 10, worst: 15 })
    expect(bestWorstHours(hourCells([]))).toEqual({ best: null, worst: null })
    const one = hourCells(hourly.map((b, h) => (h === 10 ? b : { good: 0, bad: 0 })))
    expect(bestWorstHours(one)).toEqual({ best: 10, worst: null })
  })
})

describe('timeline', () => {
  const minutes: StatMinute[] = [
    ...run(at(9), 30, 'good'),
    ...run(at(9, 30), 5, 'sink:2'),
    ...run(at(9, 35), 2, 'away'), // short gap → idle
    ...run(at(9, 37), 10, 'good'),
    // 09:47–10:20 nothing logged → break (33 min)
    ...run(at(10, 20), 20, 'headForward:1'),
    ...run(at(10, 40), 5, 'away') // trailing away → not part of the span
  ]
  const segs = buildTimeline(minutes, 3)
  it('spans first to last active minute and merges runs', () => {
    expect(segs[0]).toMatchObject({ from: at(9), to: at(9, 30), kind: 'good' })
    expect(segs[1]).toMatchObject({ kind: 'clear', issue: 'sink' })
    expect(segs[2]).toMatchObject({ kind: 'idle', idle: 'away', from: at(9, 35), to: at(9, 37) })
    expect(segs[4]).toMatchObject({ kind: 'break', from: at(9, 47), to: at(10, 20), idle: 'none' })
    expect(segs[segs.length - 1]).toMatchObject({ kind: 'slight', to: at(10, 40) })
  })
  it('labels segments for the tooltip', () => {
    expect(segmentLabel(segs[4])).toMatch(/· Break · 33 min$/)
    expect(segmentLabel(segs[1])).toMatch(/· Slouching \(clear\) · 5 min$/)
  })
  it('is empty without active minutes, and ignores junk', () => {
    expect(buildTimeline([])).toEqual([])
    expect(buildTimeline(run(at(9), 10, 'away'))).toEqual([])
    expect(buildTimeline([{ m: Number.NaN, s: 'good' } as StatMinute, { m: at(9), s: 'good' }])).toHaveLength(1)
  })
  it('measures sitting stretches between breaks (short gaps keep counting)', () => {
    expect(sittingStretches(segs)).toEqual([47, 20])
    expect(longStretchCount([47, 20, 120], 50)).toBe(1)
    expect(longStretchCount([100], 50)).toBe(0)
  })
  it('places hour ticks and thins them', () => {
    const t = hourTicks(at(8, 30), at(17, 10))
    expect(t.map((x) => x.label)).toEqual(['09', '10', '11', '12', '13', '14', '15', '16', '17'])
    expect(hourTicks(at(0), at(23, 59), 6).length).toBeLessThanOrEqual(6)
    expect(hourTicks(at(9), at(9))).toEqual([])
  })
})

describe('KPI tiles', () => {
  const file = { date: '2026-10-05', minutes: [...run(at(9), 240, 'good'), ...run(at(13), 60, 'sink:1')], alerts: 6, breaks: 4 }
  const d = summarizeDay('2026-10-05', file)
  const prev = [day({ date: '2026-10-04', goodMinutes: 76, trackedMinutes: 100 })]
  it('fills the day tiles', () => {
    const k = dayKpis({ day: d, previous: prev, stretches: [300], everyMinutes: 50, isToday: true })
    expect(k.aligned).toMatchObject({ value: '80%', sub: '+4 vs avg', tone: 'good' })
    expect(k.sitting).toMatchObject({ value: '5h 00m', sub: '1 long stretch' })
    expect(k.breaks).toMatchObject({ value: '4', sub: 'every 1h 00m' })
    expect(k.nudges).toMatchObject({ value: '6', sub: '1 per hour' })
  })
  it('uses the clock span for a past day without minute data', () => {
    const k = dayKpis({ day: d, previous: [], stretches: null, everyMinutes: 50, isToday: false })
    expect(k.sitting.sub).toMatch(/^\d\d:\d\d–\d\d:\d\d$/)
    expect(k.aligned.sub).toBe('no average yet')
  })
  it('mutes a day with no data', () => {
    const k = dayKpis({ day: emptyDay('2026-10-01'), previous: prev, stretches: null, everyMinutes: 50, isToday: false })
    for (const t of Object.values(k)) {
      expect(t.value).toBe('—')
      expect(t.muted).toBe(true)
    }
  })
  it('fills the week tiles against the previous week', () => {
    const week = [d, emptyDay('2026-10-06')]
    const k = weekKpis(week, prev)
    expect(k.aligned).toMatchObject({ value: '80%', sub: '+4 vs last week' })
    expect(k.sitting.sub).toBe('5h 00m a day')
    expect(weekKpis([emptyDay('2026-10-06')], []).aligned.value).toBe('—')
  })
  it('only calls zero nudges "none needed" on a day that was actually aligned', () => {
    // nudges switched off / filtered: no toast was shown although the user slouched a lot
    const slouched = summarizeDay('2026-10-05', { date: '2026-10-05', minutes: [...run(at(9), 45, 'good'), ...run(at(10), 55, 'sink:2')], alerts: 0 })
    expect(dayKpis({ day: slouched, previous: [], stretches: null, everyMinutes: 50, isToday: false }).nudges).toMatchObject({
      value: '0',
      sub: 'none',
      tone: 'faint'
    })
    expect(weekKpis([slouched], []).nudges).toMatchObject({ sub: 'none', tone: 'faint' })
    const aligned = summarizeDay('2026-10-05', { date: '2026-10-05', minutes: [...run(at(9), 90, 'good'), ...run(at(11), 10, 'sink:1')], alerts: 0 })
    expect(dayKpis({ day: aligned, previous: [], stretches: null, everyMinutes: 50, isToday: false }).nudges).toMatchObject({
      value: '0',
      sub: 'none needed',
      tone: 'good'
    })
    expect(weekKpis([aligned], []).nudges).toMatchObject({ sub: 'none needed', tone: 'good' })
  })
  it('formats the streak', () => {
    expect(streakKpi({ current: 3, best: 9 })).toMatchObject({ value: '3 days', sub: 'best 9', tone: 'good' })
    expect(streakKpi({ current: 1, best: 1 }).value).toBe('1 day')
    expect(streakKpi({ current: 0, best: 0 })).toMatchObject({ value: '0 days', sub: 'no good day yet', muted: true })
    expect(streakKpi(null).value).toBe('—')
  })
})

describe('sumDays / anyTracked', () => {
  it('adds every field', () => {
    const a = summarizeDay('2026-10-05', { minutes: run(at(9), 10, 'good'), alerts: 1, breaks: 2 })
    const b = summarizeDay('2026-10-06', { minutes: run(at(10, 0, 6), 5, 'lean:3'), alerts: 2 })
    const s = sumDays([a, b])
    expect(s).toMatchObject({ trackedMinutes: 15, goodMinutes: 10, alertsCount: 3, breaksTaken: 2, hasData: true })
    expect(s.minutesByIssueStage.lean).toEqual([0, 0, 5])
    expect(s.hourly[9].good).toBe(10)
    expect(s.hourly[10].bad).toBe(5)
    expect(anyTracked([a])).toBe(true)
    expect(anyTracked([emptyDay('2026-10-01')])).toBe(false)
  })
})

describe('perHour', () => {
  it('rates nudges per tracked hour', async () => {
    const { perHour } = await import('../history')
    expect(perHour(6, 300)).toBe('1 per hour')
    expect(perHour(12, 300)).toBe('2 per hour')
    expect(perHour(5, 600)).toBe('1 every 2h 00m')
    expect(perHour(2, 45)).toBe('3 per hour')
    expect(perHour(0, 300)).toBe('—')
    expect(perHour(3, 0)).toBe('—')
  })
})

describe('weekLabel (same month)', () => {
  it('shortens a week inside one month', () => {
    expect(weekLabel('2026-10-07')).toMatch(/^5–11 \S+$/)
  })
})
