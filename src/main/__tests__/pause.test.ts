import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { powerSaveBlocker } = vi.hoisted(() => ({
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() }
}))
vi.mock('electron', () => ({ powerSaveBlocker }))

import {
  __resetPauseForTests,
  getPauseState,
  initPauseReconciler,
  initPowerSaveBlocker,
  onPauseChanged,
  reconcilePause,
  setPause
} from '../pause'

describe('pause', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T09:00:00Z'))
    __resetPauseForTests()
    powerSaveBlocker.start.mockClear()
  })
  afterEach(() => {
    __resetPauseForTests()
    vi.useRealTimers()
  })

  it('never holds a power-save blocker, paused or not (regression: kept Windows awake)', () => {
    initPowerSaveBlocker()
    initPauseReconciler()
    setPause(true, 15)
    setPause(false)
    expect(powerSaveBlocker.start).not.toHaveBeenCalled()
  })

  it('timed pause auto-resumes after the given minutes', () => {
    const seen: boolean[] = []
    onPauseChanged((s) => seen.push(s.paused))
    const state = setPause(true, 15)
    expect(state.resumeAt).toBe(Date.now() + 15 * 60_000)
    vi.advanceTimersByTime(15 * 60_000 - 1)
    expect(getPauseState().paused).toBe(true)
    vi.advanceTimersByTime(1)
    expect(getPauseState()).toEqual({ paused: false, resumeAt: null })
    expect(seen).toEqual([true, false])
  })

  it('pause until resumed has no deadline', () => {
    setPause(true, null)
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(getPauseState()).toEqual({ paused: true, resumeAt: null })
  })

  it('re-pausing replaces the previous timer', () => {
    setPause(true, 15)
    setPause(true, 60)
    vi.advanceTimersByTime(15 * 60_000)
    expect(getPauseState().paused).toBe(true)
    vi.advanceTimersByTime(45 * 60_000)
    expect(getPauseState().paused).toBe(false)
  })

  it('reconcilePause honours the wall-clock deadline when timers drifted (sleep)', () => {
    setPause(true, 30)
    // wall clock jumps past the deadline without timers firing (system sleep)
    vi.setSystemTime(Date.now() + 31 * 60_000)
    reconcilePause()
    expect(getPauseState().paused).toBe(false)
  })

  it('the periodic reconciler is started once and catches a drifted deadline', () => {
    initPauseReconciler()
    initPauseReconciler()
    expect(vi.getTimerCount()).toBe(1)
    setPause(true, 30)
    vi.setSystemTime(Date.now() + 40 * 60_000)
    vi.advanceTimersByTime(30_000)
    expect(getPauseState().paused).toBe(false)
  })

  it('rejects invalid IPC input instead of arming a bogus timer', () => {
    expect(() => setPause('yes' as unknown as boolean)).toThrow(TypeError)
    expect(() => setPause(true, Number.NaN)).toThrow(RangeError)
    expect(() => setPause(true, -5)).toThrow(RangeError)
    expect(() => setPause(true, 0)).toThrow(RangeError)
    expect(() => setPause(true, 1e9)).toThrow(RangeError)
    expect(() => setPause(true, '15' as unknown as number)).toThrow(RangeError)
    expect(getPauseState()).toEqual({ paused: false, resumeAt: null })
  })
})
