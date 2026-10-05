import { describe, expect, it } from 'vitest'
import type { PostureSnapshot } from '@shared/posture'
import { extractFeatures } from '@renderer/posture/features'
import { PoseSim, posture } from '@renderer/posture/__tests__/sim'
import type { PoseFrame } from '@renderer/posture/types'
import { overlayGuide, projectUp, segmentStages, shoulderPoint } from '../pose-geometry'

type Id = 'sink' | 'headForward' | 'lean' | 'tooClose'

const snap = (stages: Partial<Record<Id, 0 | 1 | 2 | 3>>, presence: 'active' | 'away' = 'active'): PostureSnapshot => {
  const issue = (id: Id): PostureSnapshot['issues'][Id] => ({ issue: id, stage: stages[id] ?? 0, activeForMs: null, metric: 0 })
  return {
    presence,
    issues: { sink: issue('sink'), headForward: issue('headForward'), lean: issue('lean'), tooClose: issue('tooClose') },
    worstStage: 0,
    calibrated: true,
    recalibrationSuggested: false,
    ts: 0
  }
}

describe('projectUp', () => {
  it('is straight up for an upright camera at the image center', () => {
    const [u, v] = projectUp({ up: [0, -1, 0], anchor: [0, 0, 1] }, 16 / 9)
    expect(u).toBeCloseTo(0, 6)
    expect(v).toBeCloseTo(-1, 6)
  })

  it('falls back to the orthographic direction without depth, normalized', () => {
    const [u, v] = projectUp({ up: [0.3, -0.9, 0.2], anchor: null }, 4 / 3)
    expect(Math.hypot(u, v)).toBeCloseTo(1, 6)
    expect(u / v).toBeCloseTo(0.3 / -0.9, 6)
  })

  it('converges verticals for a camera looking down (perspective)', () => {
    // camera pitched down 30°: world up has a component toward the camera (−z)
    const up: [number, number, number] = [0, -Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6)]
    const right = projectUp({ up, anchor: [0.4, 0.1, 1] }, 16 / 9)
    const left = projectUp({ up, anchor: [-0.4, 0.1, 1] }, 16 / 9)
    expect(right[1]).toBeLessThan(0)
    // upward lines lean away from the center on both sides (they meet below the image)
    expect(right[0]).toBeGreaterThan(0.05)
    expect(left[0]).toBeLessThan(-0.05)
  })

  it('draws the vertical of a level camera, whatever the body cues say about roll (sim)', () => {
    // (was: "tracks a rolled camera" — a 12°-rolled camera's vertical drawn rotated by the
    // roll the hip line implied. Webcams are mounted level (|roll| ≲ 3°), and that hip-line
    // roll is exactly what turned bodies under a pitched camera and hallucinated hips fake:
    // it drew a real elevated webcam's vertical 41° off. The gravity estimate is now a
    // level-camera one: the drawn vertical is upright up to the camera pitch's perspective,
    // which is nil at the image centre column.)
    for (const roll of [0, 3, 12]) {
      const sim = new PoseSim(
        { azimuth: 0, elevation: 5, distance: 1.1, roll, hfov: 65, aspect: 16 / 9 },
        { seed: 3, noise: { image: 0, worldXY: 0, worldZ: 0 } }
      )
      const frame = sim.render(posture()) as PoseFrame
      const f = extractFeatures(frame)
      expect(f).not.toBeNull()
      const g = overlayGuide(frame, f)
      expect(g).not.toBeNull()
      const angle = (Math.atan2(g!.up2d[0], -g!.up2d[1]) * 180) / Math.PI
      expect({ roll, upright: Math.abs(angle) < 1 }).toEqual({ roll, upright: true })
    }
  })
})

describe('segmentStages', () => {
  it('maps issues to their body segment', () => {
    expect(segmentStages(snap({ headForward: 2, sink: 1, lean: 3, tooClose: 1 }))).toEqual({
      neck: 2,
      trunk: 1,
      shoulders: 3,
      head: 1
    })
  })
  it('is all zero while away or without a snapshot', () => {
    expect(segmentStages(snap({ headForward: 2 }, 'away'))).toEqual({ head: 0, neck: 0, trunk: 0, shoulders: 0 })
    expect(segmentStages(null)).toEqual({ head: 0, neck: 0, trunk: 0, shoulders: 0 })
  })
})

describe('shoulderPoint', () => {
  it('weights the more visible shoulder', () => {
    const image = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }))
    image[11] = { x: 0.4, y: 0.6, visibility: 0.95 }
    image[12] = { x: 0.6, y: 0.6, visibility: 0.55 }
    const p = shoulderPoint(image)!
    expect(p.x).toBeLessThan(0.5)
    expect(p.x).toBeGreaterThan(0.4)
    expect(p.y).toBeCloseTo(0.6, 6)
  })
  it('uses the best shoulder when none is seen', () => {
    const image = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }))
    image[11] = { x: 0.3, y: 0.7, visibility: 0.2 }
    image[12] = { x: 0.6, y: 0.6, visibility: 0.1 }
    expect(shoulderPoint(image)).toEqual({ x: 0.3, y: 0.7 })
  })
})
