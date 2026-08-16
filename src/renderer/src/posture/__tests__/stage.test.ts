import { describe, expect, it } from 'vitest'
import { stageOf } from '../stage'

const SINK: readonly [number, number, number] = [0.14, 0.28, 0.45]
const CLOSE: readonly [number, number, number] = [1.12, 1.25, 1.4]

describe('stageOf (linear metrics)', () => {
  it('maps values to stages at default sensitivity', () => {
    expect(stageOf(0.1, SINK, 1, 'linear', 'trigger')).toBe(0)
    expect(stageOf(0.14, SINK, 1, 'linear', 'trigger')).toBe(1)
    expect(stageOf(0.3, SINK, 1, 'linear', 'trigger')).toBe(2)
    expect(stageOf(0.5, SINK, 1, 'linear', 'trigger')).toBe(3)
  })

  it('higher sensitivity lowers the effective thresholds', () => {
    // σ=2 → thr_eff(slight) = 0.07
    expect(stageOf(0.08, SINK, 2, 'linear', 'trigger')).toBe(1)
    expect(stageOf(0.08, SINK, 1, 'linear', 'trigger')).toBe(0)
  })

  it('recovery thresholds sit at HYST × trigger', () => {
    // rec_eff(slight) = 0.75 × 0.14 = 0.105
    expect(stageOf(0.11, SINK, 1, 'linear', 'recovery')).toBe(1)
    expect(stageOf(0.1, SINK, 1, 'linear', 'recovery')).toBe(0)
  })
})

describe('stageOf (ratio metric: too close)', () => {
  it('scales only the excess over 1 with sensitivity', () => {
    // σ=2 → thr_eff(slight) = 1 + 0.12/2 = 1.06
    expect(stageOf(1.07, CLOSE, 2, 'ratio', 'trigger')).toBe(1)
    expect(stageOf(1.07, CLOSE, 1, 'ratio', 'trigger')).toBe(0)
    expect(stageOf(1.26, CLOSE, 1, 'ratio', 'trigger')).toBe(2)
  })

  it('applies hysteresis to the excess only', () => {
    // rec_eff(slight) = 1 + 0.75×0.12 = 1.09
    expect(stageOf(1.1, CLOSE, 1, 'ratio', 'recovery')).toBe(1)
    expect(stageOf(1.08, CLOSE, 1, 'ratio', 'recovery')).toBe(0)
  })
})
