import { describe, expect, it } from 'vitest'
import { extractFeatures } from '@renderer/posture/features'
import { PoseSim, posture } from '@renderer/posture/__tests__/sim'
import type { PoseFrame } from '@renderer/posture/types'
import { planSketch, reviewImageSize } from '../review-image'

describe('reviewImageSize', () => {
  it('keeps the camera aspect with the long side at 640', () => {
    expect(reviewImageSize(16 / 9)).toEqual({ w: 640, h: 360 })
    expect(reviewImageSize(4 / 3)).toEqual({ w: 640, h: 480 })
    expect(reviewImageSize(9 / 16)).toEqual({ w: 360, h: 640 })
  })
})

describe('planSketch', () => {
  const sim = new PoseSim({ azimuth: 35, elevation: 20, distance: 1.1, roll: 0, hfov: 65, aspect: 16 / 9 }, { seed: 5 })
  const frame = sim.render(posture()) as PoseFrame
  const f = extractFeatures(frame)

  it('draws only seen points, not mirrored, with a vertical through the shoulder', () => {
    const plan = planSketch(frame, f)
    expect(plan.w).toBe(640)
    expect(plan.h).toBe(360)
    expect(plan.lines.length).toBeGreaterThan(4)
    for (const seg of plan.lines) for (const v of seg) expect(Number.isFinite(v)).toBe(true)
    // not mirrored: a seen shoulder keeps its raw image x
    const ls = frame.image[11]
    const rs = frame.image[12]
    const near = (p: { x: number; y: number }): boolean =>
      plan.joints.some(([x, y]) => Math.abs(x - p.x * 640) < 1e-6 && Math.abs(y - p.y * 360) < 1e-6)
    expect(near(ls) || near(rs)).toBe(true)
    // the dashed vertical is a long, mostly up/down line
    const v = plan.vertical
    expect(v).not.toBeNull()
    const dx = v![2] - v![0]
    const dy = v![3] - v![1]
    expect(Math.abs(dy)).toBeGreaterThan(Math.abs(dx))
    expect(Math.hypot(dx, dy)).toBeGreaterThan(640)
  })

  it('has no vertical without features', () => {
    expect(planSketch(frame, null).vertical).toBeNull()
  })
})
