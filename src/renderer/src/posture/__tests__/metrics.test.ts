import { describe, expect, it } from 'vitest'
import { LM } from '../constants'
import { computeGeometry, computeRawMetrics, computeUnifiedScale } from '../metrics'
import { makeFrame, uprightBaseline } from './fixtures'

describe('computeGeometry', () => {
  it('finds all groups on a full upright frame', () => {
    const geo = computeGeometry(makeFrame())
    expect(geo.good).toBe(true)
    expect(geo.groups).toEqual({ shoulders: true, ears: true, eyes: true, head: true })
    expect(geo.shMid).toEqual({ x: 0.5, y: 0.62 })
    expect(geo.headMid).toEqual({ x: 0.5, y: 0.32 })
    expect(geo.sSh).toBeCloseTo(0.3, 6)
    expect(geo.sEar).toBeCloseTo(0.12, 6)
    expect(geo.sEye).toBeCloseTo(0.09, 6)
  })

  it('drops the shoulders group when one shoulder is below the visibility gate', () => {
    const geo = computeGeometry(makeFrame({ visibility: { [LM.leftShoulder]: 0.3 } }))
    expect(geo.groups.shoulders).toBe(false)
    expect(geo.groups.head).toBe(true)
    expect(geo.good).toBe(true)
    expect(geo.shMid).toBeNull()
  })

  it('uses eye midpoint for the head when ears are not usable', () => {
    const geo = computeGeometry(makeFrame({ visibility: { [LM.leftEar]: 0.1, [LM.rightEar]: 0.1 } }))
    expect(geo.groups.ears).toBe(false)
    expect(geo.groups.head).toBe(true)
    expect(geo.headMid).toEqual({ x: 0.5, y: 0.34 })
  })

  it('marks the frame bad when neither head nor shoulders are available', () => {
    const geo = computeGeometry(
      makeFrame({
        visibility: {
          [LM.nose]: 0,
          [LM.leftEar]: 0,
          [LM.rightEar]: 0,
          [LM.leftEyeOuter]: 0,
          [LM.rightEyeOuter]: 0,
          [LM.leftShoulder]: 0,
          [LM.rightShoulder]: 0
        }
      })
    )
    expect(geo.good).toBe(false)
  })

  it('marks a null frame (no pose) bad', () => {
    expect(computeGeometry(null).good).toBe(false)
  })
})

describe('computeUnifiedScale', () => {
  const baseline = uprightBaseline()

  it('uses shoulder width when shoulders are visible', () => {
    const s = computeUnifiedScale(computeGeometry(makeFrame()), baseline)
    expect(s).toBeCloseTo(0.3, 6)
  })

  it('falls back to ear distance × REar without shoulders', () => {
    const geo = computeGeometry(
      makeFrame({ visibility: { [LM.leftShoulder]: 0, [LM.rightShoulder]: 0 } })
    )
    expect(computeUnifiedScale(geo, baseline)).toBeCloseTo(0.12 * 2.5, 6)
  })

  it('falls back to eye distance × REye without shoulders and ears', () => {
    const geo = computeGeometry(
      makeFrame({
        visibility: {
          [LM.leftShoulder]: 0,
          [LM.rightShoulder]: 0,
          [LM.leftEar]: 0,
          [LM.rightEar]: 0
        }
      })
    )
    expect(computeUnifiedScale(geo, baseline)).toBeCloseTo(0.09 * (0.3 / 0.09), 6)
  })
})

describe('computeRawMetrics', () => {
  const baseline = uprightBaseline()

  it('reports zero-ish metrics on the baseline pose itself', () => {
    const m = computeRawMetrics(computeGeometry(makeFrame()), baseline)
    expect(m.sink).toBeCloseTo(0, 6)
    expect(m.fwdGap).toBeCloseTo(0, 6)
    expect(m.fwdFace).toBeCloseTo(0, 6)
    expect(m.fwdPitch).toBeCloseTo(0, 6)
    expect(m.leanRoll).toBeCloseTo(0, 6)
    expect(m.leanTilt).toBeCloseTo(0, 6)
    expect(m.leanLateral).toBeCloseTo(0, 6)
    expect(m.scale).toBeCloseTo(0.3, 6)
  })

  it('measures sinking as weighted drop of shoulders and head in U0 units', () => {
    // everything drops 0.06 = 0.2·U0 → M_sink = 0.6·0.2 + 0.4·0.2 = 0.2
    const drop = 0.06
    const m = computeRawMetrics(
      computeGeometry(
        makeFrame({
          nose: [0.5, 0.38 + drop],
          leftEye: [0.455, 0.34 + drop],
          rightEye: [0.545, 0.34 + drop],
          leftEar: [0.44, 0.32 + drop],
          rightEar: [0.56, 0.32 + drop],
          leftShoulder: [0.35, 0.62 + drop],
          rightShoulder: [0.65, 0.62 + drop]
        })
      ),
      baseline
    )
    expect(m.sink).toBeCloseTo(0.2, 6)
  })

  it('uses head drop alone for sink when shoulders are hidden', () => {
    const drop = 0.06
    const m = computeRawMetrics(
      computeGeometry(
        makeFrame({
          nose: [0.5, 0.38 + drop],
          leftEar: [0.44, 0.32 + drop],
          rightEar: [0.56, 0.32 + drop],
          leftEye: [0.455, 0.34 + drop],
          rightEye: [0.545, 0.34 + drop],
          visibility: { [LM.leftShoulder]: 0, [LM.rightShoulder]: 0 }
        })
      ),
      baseline
    )
    expect(m.sink).toBeCloseTo(0.2, 6)
  })

  it('measures head-forward gap shrink as fraction of baseline gap', () => {
    // head drops 0.09 while shoulders stay: h = (0.62-0.41)/0.3 = 0.7 → G = 0.3
    const m = computeRawMetrics(
      computeGeometry(
        makeFrame({
          nose: [0.5, 0.47],
          leftEar: [0.44, 0.41],
          rightEar: [0.56, 0.41],
          leftEye: [0.455, 0.43],
          rightEye: [0.545, 0.43]
        })
      ),
      baseline
    )
    expect(m.fwdGap).toBeCloseTo(0.3, 6)
  })

  it('measures face growth relative to shoulders', () => {
    // ears 25% wider, shoulders unchanged → r = 0.15/0.3 = 0.5 → F = 0.5/0.4 − 1 = 0.25
    const m = computeRawMetrics(
      computeGeometry(makeFrame({ leftEar: [0.425, 0.32], rightEar: [0.575, 0.32] })),
      baseline
    )
    expect(m.fwdFace).toBeCloseTo(0.25, 6)
  })

  it('measures pitch as nose dropping below the ear line', () => {
    // nose 0.06 lower → p = (0.44-0.32)/0.12 = 1.0 → Pd = 0.5
    const m = computeRawMetrics(computeGeometry(makeFrame({ nose: [0.5, 0.44] })), baseline)
    expect(m.fwdPitch).toBeCloseTo(0.5, 6)
  })

  it('pitch reads ~zero on the upright pose when ears drop out (eye fallback, no bias)', () => {
    const m = computeRawMetrics(
      computeGeometry(makeFrame({ visibility: { [LM.leftEar]: 0.2, [LM.rightEar]: 0.2 } })),
      baseline
    )
    expect(m.fwdPitch).toBeCloseTo(0, 6)
  })

  it('eye-fallback pitch converts the delta into ear-scale units', () => {
    // nose 0.06 lower, ears hidden: eye-referenced p = (0.44-0.34)/0.09 = 1.111…
    // Pd_eye = 1.111… − 0.444… = 0.666…; ×(sEye0/sEar0 = 0.75) = 0.5 — same as ear path
    const m = computeRawMetrics(
      computeGeometry(
        makeFrame({ nose: [0.5, 0.44], visibility: { [LM.leftEar]: 0.2, [LM.rightEar]: 0.2 } })
      ),
      baseline
    )
    expect(m.fwdPitch).toBeCloseTo(0.5, 6)
  })

  it('measures head roll from the ear line angle', () => {
    // ears tilted: dy=-0.04 over dx=-0.12 → |Δroll| ≈ 18.435°
    const m = computeRawMetrics(
      computeGeometry(makeFrame({ leftEar: [0.44, 0.3], rightEar: [0.56, 0.34] })),
      baseline
    )
    expect(m.leanRoll).toBeCloseTo(18.435, 2)
  })

  it('measures shoulder tilt from the shoulder line angle', () => {
    // dy = -0.06 over dx = -0.3 → ≈ 11.31°
    const m = computeRawMetrics(
      computeGeometry(makeFrame({ leftShoulder: [0.35, 0.59], rightShoulder: [0.65, 0.65] })),
      baseline
    )
    expect(m.leanTilt).toBeCloseTo(11.31, 2)
  })

  it('measures lateral head offset with direction', () => {
    // whole head shifts +0.09 x → ΔL = 0.09/0.3 = 0.3, positive sign
    const m = computeRawMetrics(
      computeGeometry(
        makeFrame({
          nose: [0.59, 0.38],
          leftEar: [0.53, 0.32],
          rightEar: [0.65, 0.32],
          leftEye: [0.545, 0.34],
          rightEye: [0.635, 0.34]
        })
      ),
      baseline
    )
    expect(m.leanLateral).toBeCloseTo(0.3, 6)
    expect(m.leanSigned).toBeGreaterThan(0)
  })

  it('reports a larger unified scale when the user moves closer', () => {
    // 25% closer: all distances ×1.25 around center
    const g = 1.25
    const cx = 0.5
    const sx = (x: number): number => cx + (x - cx) * g
    const m = computeRawMetrics(
      computeGeometry(
        makeFrame({
          nose: [0.5, 0.38],
          leftEar: [sx(0.44), 0.32],
          rightEar: [sx(0.56), 0.32],
          leftEye: [sx(0.455), 0.34],
          rightEye: [sx(0.545), 0.34],
          leftShoulder: [sx(0.35), 0.62],
          rightShoulder: [sx(0.65), 0.62]
        })
      ),
      baseline
    )
    expect(m.scale).toBeCloseTo(0.375, 6)
  })
})
