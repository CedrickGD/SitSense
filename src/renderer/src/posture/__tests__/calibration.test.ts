import { describe, expect, it } from 'vitest'
import { assessPlacement, CalibrationSession } from '../calibration'
import { LM } from '../constants'
import type { Frame } from '../types'
import { makeFrame } from './fixtures'

/** Feed `frames` at ~12.5fps over the capture window. */
function runSession(frames: Frame[]): CalibrationSession {
  const session = new CalibrationSession(0)
  frames.forEach((f, i) => session.addFrame(f, i * 80))
  return session
}

const uprightFrames = (n: number): Frame[] => Array.from({ length: n }, () => makeFrame())

describe('CalibrationSession', () => {
  it('produces a baseline matching the upright pose', () => {
    const result = runSession(uprightFrames(60)).finish()
    if (!result.ok) throw new Error(`expected success, got ${result.reason}`)
    const b = result.baseline
    expect(b.U0).toBeCloseTo(0.3, 6)
    expect(b.sSh0).toBeCloseTo(0.3, 6)
    expect(b.sEar0).toBeCloseTo(0.12, 6)
    expect(b.ySh0).toBeCloseTo(0.62, 6)
    expect(b.yHd0).toBeCloseTo(0.32, 6)
    expect(b.h0).toBeCloseTo(1.0, 6)
    expect(b.r0).toBeCloseTo(0.4, 6)
    expect(b.p0).toBeCloseTo(0.5, 6)
    expect(b.o0).toBeCloseTo(0, 6)
    expect(b.REar).toBeCloseTo(2.5, 6)
    expect(b.capabilities).toEqual({ shoulders: true, ears: true, eyes: true })
  })

  it('fails with not-enough-frames when the user is barely visible', () => {
    const result = runSession(uprightFrames(10)).finish()
    expect(result).toEqual({ ok: false, reason: 'not-enough-frames' })
  })

  it('fails as unstable when the user keeps moving', () => {
    // shoulder width alternating ±10% → CV ≈ 0.09 > 0.06
    const frames = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0
        ? makeFrame()
        : makeFrame({ leftShoulder: [0.32, 0.62], rightShoulder: [0.68, 0.62] })
    )
    const result = runSession(frames).finish()
    expect(result).toEqual({ ok: false, reason: 'unstable' })
  })

  it('a few glitched frames do not shift the median baseline', () => {
    const frames = [
      ...uprightFrames(50),
      ...Array.from({ length: 5 }, () =>
        makeFrame({ leftShoulder: [0.42, 0.7], rightShoulder: [0.58, 0.7] })
      )
    ]
    const result = runSession(frames).finish()
    if (!result.ok) throw new Error(`expected success, got ${result.reason}`)
    expect(result.baseline.U0).toBeCloseTo(0.3, 6)
    expect(result.baseline.ySh0).toBeCloseTo(0.62, 6)
  })

  it('calibrates in face-only mode when shoulders are never visible', () => {
    const frames = Array.from({ length: 60 }, () =>
      makeFrame({ visibility: { [LM.leftShoulder]: 0, [LM.rightShoulder]: 0 } })
    )
    const result = runSession(frames).finish()
    if (!result.ok) throw new Error(`expected success, got ${result.reason}`)
    const b = result.baseline
    expect(b.capabilities.shoulders).toBe(false)
    expect(b.sSh0).toBeNull()
    // U0 = K_SH_PER_EAR × sEar0 = 2.4 × 0.12
    expect(b.U0).toBeCloseTo(0.288, 6)
    expect(b.REar).toBeCloseTo(2.4, 6)
    expect(b.h0).toBeNull()
    expect(b.p0).toBeCloseTo(0.5, 6)
  })

  it('captures eye-referenced baselines even when ears are visible', () => {
    const result = runSession(uprightFrames(60)).finish()
    if (!result.ok) throw new Error(`expected success, got ${result.reason}`)
    // pEye = (0.38-0.34)/0.09; phiEye0 from the eye line — both must exist so
    // the runtime can switch reference lines the moment ears drop out
    expect(result.baseline.pEye0).toBeCloseTo(0.4 / 0.9, 6)
    expect(result.baseline.phiEye0).not.toBeNull()
  })

  it('reports completion once the capture window has elapsed', () => {
    const session = new CalibrationSession(1000)
    expect(session.isComplete(5500)).toBe(false)
    expect(session.isComplete(6000)).toBe(true)
  })
})

describe('assessPlacement', () => {
  it('rates a full upright view as good', () => {
    const p = assessPlacement(makeFrame())
    expect(p.faceVisible).toBe(true)
    expect(p.shouldersVisible).toBe(true)
    expect(p.verdict).toBe('good')
  })

  it('rates face-only as workable', () => {
    const p = assessPlacement(
      makeFrame({ visibility: { [LM.leftShoulder]: 0, [LM.rightShoulder]: 0 } })
    )
    expect(p.shouldersVisible).toBe(false)
    expect(p.verdict).toBe('workable')
  })

  it('rates no usable head as unusable', () => {
    const p = assessPlacement(null)
    expect(p.verdict).toBe('unusable')
  })
})
