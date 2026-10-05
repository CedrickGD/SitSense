import { describe, expect, it } from 'vitest'
import { STAGE_COLOR } from '@renderer/lib/ui'
import { LM } from '@renderer/posture/constants'
import type { Landmark } from '@renderer/posture/types'
import type { PoseOverlayData } from '@renderer/state/store'
import { SIDE_SWITCH_FRAMES, linesGeometry, nextSide, segmentColors } from '../PoseLinesOverlay'

const HIDDEN: Landmark = { x: 0.5, y: 0.5, z: 0, visibility: 0.05 }

function pose(points: Partial<Record<number, [number, number]>>, extra: Partial<PoseOverlayData> = {}): PoseOverlayData {
  const image: Landmark[] = Array.from({ length: 33 }, () => ({ ...HIDDEN }))
  for (const [i, p] of Object.entries(points)) image[Number(i)] = { x: p![0], y: p![1], z: 0, visibility: 0.95 }
  return {
    image,
    aspect: 16 / 9,
    guide: null,
    segments: { head: 0, neck: 0, trunk: 0, shoulders: 0 },
    ...extra
  }
}

describe('linesGeometry', () => {
  it('draws the near-side chain of a profile view, with no shoulder/head line', () => {
    // right side facing the camera, hips at the bottom edge (half visible user)
    const g = linesGeometry(
      pose(
        { [LM.rightEar]: [0.55, 0.3], [LM.rightShoulder]: [0.52, 0.55], [LM.rightHip]: [0.5, 0.98] },
        { guide: { up2d: [0, -1], nearSide: 'right', shoulder: { x: 0.52, y: 0.55 } } }
      )
    )!
    expect(g.side).toBe('right')
    expect(g.neck).not.toBeNull()
    expect(g.trunk).not.toBeNull()
    expect(g.shoulderLine).toBeNull()
    expect(g.headLine).toBeNull()
    // viewBox space: x·100, y·100/aspect
    expect(g.shoulder![0]).toBeCloseTo(52, 6)
    expect(g.shoulder![1]).toBeCloseTo(0.55 * (100 / (16 / 9)), 6)
    // the vertical passes through the shoulder, top above it
    const [top, bottom] = g.vertical!
    expect(top[0]).toBeCloseTo(52, 6)
    expect(bottom[0]).toBeCloseTo(52, 6)
    expect(top[1]).toBeLessThan(g.ear![1])
    expect(bottom[1]).toBeGreaterThan(g.shoulder![1])
  })

  it('follows a tilted true vertical (camera from above / rolled)', () => {
    const up: [number, number] = [Math.sin(0.2), -Math.cos(0.2)]
    const g = linesGeometry(
      pose(
        { [LM.leftEar]: [0.4, 0.3], [LM.leftShoulder]: [0.42, 0.6] },
        { guide: { up2d: up, nearSide: 'left', shoulder: { x: 0.42, y: 0.6 } } }
      )
    )!
    const [top, bottom] = g.vertical!
    const dx = top[0] - bottom[0]
    const dy = top[1] - bottom[1]
    expect(Math.atan2(dx, -dy)).toBeCloseTo(0.2, 6)
    expect(g.trunk).toBeNull() // hip out of frame
  })

  it('draws shoulder and head lines in a frontal view; no guide → no vertical', () => {
    const g = linesGeometry(
      pose({
        [LM.leftEar]: [0.58, 0.3],
        [LM.rightEar]: [0.42, 0.3],
        [LM.leftShoulder]: [0.68, 0.6],
        [LM.rightShoulder]: [0.32, 0.6]
      })
    )!
    expect(g.shoulderLine).not.toBeNull()
    expect(g.headLine).not.toBeNull()
    expect(g.vertical).toBeNull()
  })

  it('ignores off-frame and low-visibility landmarks, and returns null with nothing in view', () => {
    expect(linesGeometry(pose({}))).toBeNull()
    const g = linesGeometry(pose({ [LM.leftShoulder]: [0.5, 0.6], [LM.leftHip]: [0.5, 1.4] }))!
    expect(g.hip).toBeNull()
    expect(g.trunk).toBeNull()
  })

  it('anchors the vertical at the drawn near shoulder in an angled view with both shoulders seen', () => {
    // 45° camera: both shoulders rated ~0.99, so the guide's (visibility-weighted) shoulder
    // sits near the midpoint — the line must still go through the near shoulder dot
    const p = pose(
      {
        [LM.leftEar]: [0.47, 0.3],
        [LM.leftShoulder]: [0.45, 0.6],
        [LM.rightShoulder]: [0.6, 0.58],
        [LM.leftHip]: [0.47, 0.98]
      },
      { guide: { up2d: [0, -1], nearSide: 'left', shoulder: { x: 0.525, y: 0.59 } } }
    )
    p.image[LM.leftShoulder].visibility = 0.99
    p.image[LM.rightShoulder].visibility = 0.99
    const g = linesGeometry(p, 'left')!
    expect(g.shoulder![0]).toBeCloseTo(45, 6)
    const [top, bottom] = g.vertical!
    expect(top[0]).toBeCloseTo(45, 6)
    expect(bottom[0]).toBeCloseTo(45, 6)
    // the vertical line passes through the shoulder dot itself
    const t = (g.shoulder![1] - top[1]) / (bottom[1] - top[1])
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThan(1)
  })

  it("falls back to the guide's shoulder when the near shoulder isn't seen", () => {
    const g = linesGeometry(
      pose({ [LM.leftEar]: [0.4, 0.3] }, { guide: { up2d: [0, -1], nearSide: 'left', shoulder: { x: 0.42, y: 0.6 } } }),
      'left'
    )!
    expect(g.shoulder).toBeNull()
    expect(g.vertical![0][0]).toBeCloseTo(42, 6)
  })

  it('draws the side it is given, whatever the guide says', () => {
    const p = pose(
      { [LM.leftShoulder]: [0.6, 0.6], [LM.rightShoulder]: [0.4, 0.6], [LM.leftEar]: [0.55, 0.3], [LM.rightEar]: [0.45, 0.3] },
      { guide: { up2d: [0, -1], nearSide: 'right', shoulder: { x: 0.5, y: 0.6 } } }
    )
    const g = linesGeometry(p, 'left')!
    expect(g.side).toBe('left')
    expect(g.shoulder![0]).toBeCloseTo(60, 6)
  })

  it('survives a bad aspect', () => {
    const g = linesGeometry(pose({ [LM.leftShoulder]: [0.5, 0.5] }, { aspect: 0 }))!
    expect(g.vh).toBeCloseTo(75, 6)
  })
})

describe('nextSide', () => {
  // a frontal pose; visibilities set per side
  function front(visL: number, visR: number): Landmark[] {
    const p = pose({
      [LM.leftEar]: [0.58, 0.3],
      [LM.rightEar]: [0.42, 0.3],
      [LM.leftShoulder]: [0.68, 0.6],
      [LM.rightShoulder]: [0.32, 0.6]
    })
    const image = p.image as Landmark[]
    image[LM.leftEar].visibility = visL
    image[LM.leftShoulder].visibility = visL
    image[LM.rightEar].visibility = visR
    image[LM.rightShoulder].visibility = visR
    return image
  }

  it('does not flip on noise from the front', () => {
    let st = nextSide(front(0.97, 0.96), null)
    expect(st.side).toBe('left')
    const noisy: Array<[number, number]> = [
      [0.95, 0.98],
      [0.96, 0.97],
      [0.94, 0.99],
      [0.97, 0.95],
      [0.93, 0.99],
      [0.95, 0.98]
    ]
    for (const [l, r] of noisy) {
      st = nextSide(front(l, r), st)
      expect(st.side).toBe('left')
    }
  })

  it(`switches after the other side clearly wins ${SIDE_SWITCH_FRAMES} updates in a row`, () => {
    let st = nextSide(front(0.97, 0.96), null)
    for (let i = 1; i < SIDE_SWITCH_FRAMES; i++) {
      st = nextSide(front(0.6, 0.99), st) // right ahead by 0.78 (> margin)
      expect(st.side).toBe('left')
    }
    // an interruption resets the count
    st = nextSide(front(0.97, 0.96), st)
    expect(st.streak).toBe(0)
    for (let i = 1; i < SIDE_SWITCH_FRAMES; i++) st = nextSide(front(0.6, 0.99), st)
    expect(st.side).toBe('left')
    st = nextSide(front(0.6, 0.99), st)
    expect(st.side).toBe('right')
  })

  it("switches at once when the drawn side's shoulder is lost and the other is seen", () => {
    let st = nextSide(front(0.97, 0.96), null)
    st = nextSide(front(0.3, 0.97), st)
    expect(st.side).toBe('right')
  })

  it('starts on the side whose shoulder is seen', () => {
    expect(nextSide(front(0.3, 0.9), null).side).toBe('right')
  })
})

describe('segmentColors', () => {
  const segs = { head: 0, neck: 2, trunk: 0, shoulders: 1 } as const

  it('posture mode paints everything in the worst stage color', () => {
    const c = segmentColors(segs, 'posture', '#ffffff')
    expect(new Set(Object.values(c))).toEqual(new Set([STAGE_COLOR[2]]))
  })

  it('a fixed hue lights up only the segments with active issues', () => {
    const c = segmentColors(segs, 'fixed', '#44d7f0')
    expect(c.head).toBe('#44d7f0')
    expect(c.trunk).toBe('#44d7f0')
    expect(c.neck).toBe(STAGE_COLOR[2])
    expect(c.shoulders).toBe(STAGE_COLOR[1])
  })
})
