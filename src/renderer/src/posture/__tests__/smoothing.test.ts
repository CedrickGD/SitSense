import { describe, expect, it } from 'vitest'
import { MetricSmoother, ScaleOutlierGate } from '../smoothing'

describe('MetricSmoother (median-of-3 + fps-adaptive EMA)', () => {
  it('seeds directly from the first sample', () => {
    const s = new MetricSmoother(0.6)
    expect(s.push(5, 0.1)).toBe(5)
    expect(s.value).toBe(5)
  })

  it('moves by α = 1 − exp(−dt/τ) per sample', () => {
    const s = new MetricSmoother(0.6)
    s.push(0, 0.1)
    s.push(0, 0.1)
    s.push(0, 0.1)
    // buffer now [0,0,1] → median 0; then [0,1,1] → median 1 moves the EMA
    s.push(1, 0.3)
    const v = s.push(1, 0.3) // α = 1 − e^(−0.3/0.6) ≈ 0.3935, from 0 toward 1
    expect(v).toBeCloseTo(0.3935, 3)
  })

  it('caps dt at 0.5s so a stall cannot teleport the EMA', () => {
    const s = new MetricSmoother(0.6)
    s.push(0, 0.1)
    s.push(0, 0.1)
    s.push(0, 0.1)
    s.push(1, 10)
    const v = s.push(1, 10) // dt capped at 0.5 → α = 1 − e^(−0.5/0.6) ≈ 0.5654
    expect(v).toBeCloseTo(0.5654, 3)
  })

  it('a single-frame spike never reaches the EMA', () => {
    const s = new MetricSmoother(0.6)
    s.push(0, 0.1)
    s.push(0, 0.1)
    s.push(100, 0.1) // buffer [0,0,100] → median 0
    const v = s.push(0, 0.1) // buffer [0,100,0] → median 0
    expect(v).toBe(0)
  })

  it('reseed clears history so the next sample seeds fresh', () => {
    const s = new MetricSmoother(0.6)
    s.push(10, 0.1)
    s.reseed()
    expect(s.value).toBeNull()
    expect(s.push(3, 0.1)).toBe(3)
  })
})

describe('ScaleOutlierGate', () => {
  it('accepts the first sample and small changes', () => {
    const g = new ScaleOutlierGate()
    expect(g.check(0.3)).toBe(true)
    expect(g.check(0.35)).toBe(true)
  })

  it('rejects a >35% single-frame jump, then accepts the return to normal', () => {
    const g = new ScaleOutlierGate()
    g.check(0.3)
    expect(g.check(1.0)).toBe(false)
    expect(g.check(0.3)).toBe(true)
  })

  it('accepts a persistent change after 3 consecutive discards', () => {
    const g = new ScaleOutlierGate()
    g.check(0.3)
    expect(g.check(0.5)).toBe(false)
    expect(g.check(0.5)).toBe(false)
    expect(g.check(0.5)).toBe(false)
    expect(g.check(0.5)).toBe(true) // the change is real
    expect(g.check(0.52)).toBe(true) // and the new level is the reference now
  })
})
