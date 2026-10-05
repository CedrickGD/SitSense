import { describe, expect, it } from 'vitest'
import {
  DASH,
  MINUS,
  fmtAngle,
  fmtCm,
  fmtCountdown,
  fmtDate,
  fmtDayLabel,
  fmtDuration,
  fmtMinutes,
  fmtPercent,
  fmtRelative,
  fmtScore,
  parseDateKey,
  plural
} from '../format'

describe('durations', () => {
  it('formats hours, minutes and seconds per the spec', () => {
    expect(fmtDuration(4 * 3600_000 + 6 * 60_000)).toBe('4h 06m')
    expect(fmtDuration(38 * 60_000)).toBe('38 min')
    expect(fmtDuration(42_000, { live: true })).toBe('42s')
    expect(fmtDuration(42_000)).toBe('<1 min')
    expect(fmtMinutes(0)).toBe('0 min')
    expect(fmtMinutes(300)).toBe('5h 00m')
  })
  it('never shows NaN or negative durations', () => {
    expect(fmtDuration(Number.NaN)).toBe(DASH)
    expect(fmtDuration(-5)).toBe(DASH)
    expect(fmtDuration(null)).toBe(DASH)
    expect(fmtMinutes(undefined)).toBe(DASH)
  })
  it('counts down as m:ss', () => {
    expect(fmtCountdown(12 * 60_000 + 41_000)).toBe('12:41')
    expect(fmtCountdown(-1)).toBe('0:00')
  })
})

describe('values', () => {
  it('percent, score, angles, cm, plurals', () => {
    expect(fmtPercent(82.4)).toBe('82%')
    expect(fmtPercent(0.82, { share: true })).toBe('82%')
    expect(fmtPercent(null)).toBe(DASH)
    expect(fmtScore(86.4)).toBe('86')
    expect(fmtScore(120)).toBe('100')
    expect(fmtScore(null)).toBe(DASH)
    expect(fmtAngle(4.2, { signed: true })).toBe('+4°')
    expect(fmtAngle(-3, { signed: true })).toBe(`${MINUS}3°`)
    expect(fmtAngle(0.3, { signed: true })).toBe('0°')
    expect(fmtAngle(-7)).toBe('7°')
    expect(fmtCm(-5.4)).toBe('5 cm')
    expect(plural(1, 'break')).toBe('1 break')
    expect(plural(3, 'break')).toBe('3 breaks')
  })
})

describe('dates', () => {
  const now = new Date(2026, 9, 5, 14, 0) // Mon 5 Oct 2026
  it('formats weekday, day, month and the day labels', () => {
    expect(fmtDate('2026-10-05')).toMatch(/\b5\b/)
    expect(fmtDayLabel('2026-10-05', now)).toMatch(/^Today, /)
    expect(fmtDayLabel('2026-10-04', now)).toMatch(/^Yesterday, /)
    expect(fmtDayLabel('2026-10-01', now)).not.toMatch(/Today|Yesterday/)
    expect(fmtDate('nope')).toBe(DASH)
    expect(parseDateKey('2026-10-05')?.getDate()).toBe(5)
  })
  it('relative times', () => {
    expect(fmtRelative(now.getTime() - 10_000, now)).toBe('just now')
    expect(fmtRelative(now.getTime() - 2 * 60_000, now)).toBe('2 min ago')
    expect(fmtRelative(now.getTime() - 3 * 3600_000, now)).toBe('3 h ago')
    expect(fmtRelative(new Date(2026, 9, 4, 9), now)).toBe('yesterday')
    expect(fmtRelative(new Date(2026, 9, 3, 9), now)).toBe('2 days ago')
  })
})
