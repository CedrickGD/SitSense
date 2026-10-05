import { describe, expect, it } from 'vitest'
import type { BreakSettings } from '../../shared/settings'
import { BREAK_MIN_MS, BreakTracker, REPEAT_MS, type SittingInput } from '../break-tracker'

const MIN = 60_000

function setup(settings: BreakSettings = { enabled: true, intervalMinutes: 50 }) {
  const reminders: number[] = []
  let breaks = 0
  const s = { ...settings }
  const t = new BreakTracker({ settings: () => s, remind: (m) => reminders.push(m), breakTaken: () => breaks++ })
  let now = 1_000_000_000
  /** advance in 15 s ticks */
  const run = (ms: number, input: SittingInput): void => {
    const end = now + ms
    while (now < end) {
      now = Math.min(end, now + 15_000)
      t.tick(now, input)
    }
  }
  return { t, s, reminders, breaks: () => breaks, run, now: () => now, jump: (ms: number) => (now += ms) }
}

describe('BreakTracker', () => {
  it('counts continuous sitting and reminds once the interval is reached', () => {
    const k = setup()
    k.run(49 * MIN, 'sitting')
    expect(k.reminders).toEqual([])
    expect(k.t.state(k.now(), 0)).toMatchObject({ sittingMinutes: 48, onBreak: false })
    k.run(1.5 * MIN, 'sitting')
    expect(k.reminders).toEqual([50])
  })

  it('repeats an ignored reminder every 15 min and honours snooze', () => {
    const k = setup()
    k.run(51 * MIN, 'sitting')
    expect(k.reminders).toHaveLength(1)
    k.run(REPEAT_MS - MIN, 'sitting')
    expect(k.reminders).toHaveLength(1)
    k.run(1.5 * MIN, 'sitting')
    expect(k.reminders).toHaveLength(2)
    k.t.snooze(k.now(), 10)
    expect(k.t.state(k.now(), 0).nextReminderAt).toBe(k.now() + 10 * MIN)
    k.t.snooze(k.now(), 30)
    expect(k.t.state(k.now(), 0).nextReminderAt).toBe(k.now() + 30 * MIN)
    k.run(29 * MIN, 'sitting')
    expect(k.reminders).toHaveLength(2)
    k.run(2 * MIN, 'sitting')
    expect(k.reminders).toHaveLength(3)
  })

  it('short absences do not interrupt the stretch; 3 min away is a counted break', () => {
    const k = setup()
    k.run(30 * MIN, 'sitting')
    k.run(2 * MIN, 'absent')
    // the stretch started at the first tick, 15 s in
    // the absence began at the first absent tick, 2 min ago
    expect(k.t.state(k.now(), 0)).toMatchObject({ onBreak: true, breakSince: k.now() - 2 * MIN + 15_000, sittingMinutes: 31 })
    k.run(10 * MIN, 'sitting')
    expect(k.t.state(k.now(), 0)).toMatchObject({ sittingMinutes: 41, onBreak: false, breakSince: null })
    k.run(BREAK_MIN_MS + 15_000, 'absent')
    expect(k.breaks()).toBe(1)
    // after the stretch ends the break still runs from when the user left
    const breakStart = k.now() - BREAK_MIN_MS
    expect(k.t.state(k.now(), 1)).toEqual({
      sittingMinutes: 0,
      sittingSince: null,
      onBreak: true,
      breakSince: breakStart,
      nextReminderAt: null,
      breaksToday: 1
    })
    k.run(10 * MIN, 'absent')
    expect(k.t.state(k.now(), 1).breakSince).toBe(breakStart)
    k.run(MIN + 15_000, 'sitting')
    expect(k.t.state(k.now(), 1)).toMatchObject({ sittingMinutes: 1, onBreak: false, breakSince: null })
  })

  it('an empty chair before anyone sat down is not a break', () => {
    const k = setup()
    k.run(10 * MIN, 'absent')
    expect(k.t.state(k.now(), 0)).toMatchObject({ onBreak: false, breakSince: null, sittingSince: null })
  })

  it('a break after a short stretch resets the timer but is not counted', () => {
    const k = setup()
    k.run(10 * MIN, 'sitting')
    k.run(5 * MIN, 'absent')
    expect(k.breaks()).toBe(0)
    expect(k.t.state(k.now(), 0).sittingSince).toBeNull()
  })

  it('reminds on return when the user was briefly away at the due time', () => {
    const k = setup({ enabled: true, intervalMinutes: 20 })
    k.run(19 * MIN, 'sitting')
    k.run(2 * MIN, 'absent')
    expect(k.reminders).toEqual([])
    k.run(15_000, 'sitting')
    expect(k.reminders).toEqual([21])
  })

  it('a system sleep ends the stretch (counted from the last tick)', () => {
    const k = setup()
    k.run(40 * MIN, 'sitting')
    k.jump(2 * 60 * MIN)
    k.t.tick(k.now(), 'sitting')
    expect(k.breaks()).toBe(1)
    expect(k.t.state(k.now(), 1).sittingMinutes).toBe(0)
  })

  it('reminders off: no toast and no due time, sitting still tracked; interval changes apply at once', () => {
    const k = setup({ enabled: false, intervalMinutes: 50 })
    k.run(90 * MIN, 'sitting')
    expect(k.reminders).toEqual([])
    expect(k.t.state(k.now(), 0)).toMatchObject({ sittingMinutes: 89, nextReminderAt: null })
    k.s.enabled = true
    k.s.intervalMinutes = 120
    const since = k.t.state(k.now(), 0).sittingSince as number
    expect(k.t.state(k.now(), 0).nextReminderAt).toBe(since + 120 * MIN)
  })
})
