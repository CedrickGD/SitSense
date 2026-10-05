// Self-checks of the 3D posture simulator, so the viewpoint tests rest on solid ground.

import { describe, expect, it } from 'vitest'
import { LM } from '../constants'
import { angleDeg, rotate, type Vec3 } from '../vec'
import { NO_NOISE, PoseSim, Rng, mulberry32, posture, skeleton, truth, viewpointGrid } from './sim'

describe('simulator', () => {
  it('is deterministic for a seed (no Math.random)', () => {
    const a = new PoseSim(viewpointGrid()[7], { seed: 42 }).render(posture())
    const b = new PoseSim(viewpointGrid()[7], { seed: 42 }).render(posture())
    const c = new PoseSim(viewpointGrid()[7], { seed: 43 }).render(posture())
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    const r = mulberry32(1)
    expect(r()).toBe(mulberry32(1)())
    const g = new Rng(5)
    const xs = Array.from({ length: 4000 }, () => g.gauss(2))
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length)
    expect(Math.abs(mean)).toBeLessThan(0.1)
    expect(sd).toBeCloseTo(2, 1)
  })

  it('builds the specified seated skeleton', () => {
    const P = skeleton(posture()).points
    expect(P[LM.leftShoulder]).toEqual([0.18, 0.48, 0])
    expect(P[LM.leftHip]).toEqual([0.09, 0, 0])
    const ear = P[LM.leftEar]
    expect(ear[0]).toBeCloseTo(0.075, 6)
    expect(ear[1]).toBeCloseTo(0.63, 6)
    expect(P[LM.nose][2]).toBeCloseTo(0.1, 6)
    expect(P[LM.leftKnee]).toEqual([0.1, 0, 0.45])
    const t = truth(posture())
    expect(t.neckFwd).toBeCloseTo(0, 6)
    expect(t.trunkFwd).toBeCloseTo(0, 6)
    expect(t.headPitch).toBeCloseTo(14.04, 1)
  })

  it('posture parameters move the body the documented way', () => {
    expect(truth(posture({ trunkPitch: 20 })).trunkFwd).toBeCloseTo(20, 6)
    expect(truth(posture({ neckFlex: 15 })).neckFwd).toBeCloseTo(15, 6)
    expect(truth(posture({ trunkRoll: 10 })).trunkLat).toBeCloseTo(10, 6)
    expect(truth(posture({ headRoll: 10 })).headRollRel).toBeCloseTo(-10, 6)
    expect(truth(posture({ headPitch: 10 })).headPitch).toBeCloseTo(24.04, 1)
    const sw = skeleton(posture({ swivel: 30 }))
    expect(angleDeg(sw.forward, [0, 0, 1])).toBeCloseTo(30, 6)
    expect(sw.forward[0]).toBeGreaterThan(0) // + swivel turns toward the person's left
  })

  it('renders MediaPipe-shaped output: camera-aligned world, person’s left on image-right when facing', () => {
    // cropRay: false = world landmarks in true camera axes (see the crop-ray test below)
    const sim = new PoseSim({ azimuth: 0, elevation: 0, distance: 1.5, roll: 0, hfov: 65, aspect: 16 / 9 }, { noise: NO_NOISE, cropRay: false })
    const fr = sim.render(posture())
    expect(fr.image).toHaveLength(33)
    expect(fr.world).toHaveLength(33)
    expect(fr.image[LM.leftShoulder].x).toBeGreaterThan(0.5)
    expect(fr.world![LM.leftShoulder].x).toBeCloseTo(0.18, 6)
    expect(fr.world![LM.leftShoulder].y).toBeCloseTo(-0.48, 6) // y down
    expect(fr.world![LM.nose].z!).toBeLessThan(0) // closer to the camera than the hips
    const mid = (fr.world![LM.leftHip].x + fr.world![LM.rightHip].x) / 2
    expect(mid).toBeCloseTo(0, 6) // hip-midpoint origin
    expect(fr.image[LM.nose].visibility).toBeGreaterThan(0.9)
  })

  it('occluded and off-frame points get low visibility; off-frame world points are biased', () => {
    const side = new PoseSim({ azimuth: 90, elevation: 0, distance: 1.2, roll: 0, hfov: 65, aspect: 16 / 9 }, { noise: NO_NOISE })
    const fr = side.render(posture())
    expect(fr.image[LM.leftEar].visibility).toBeGreaterThan(0.9) // near side
    expect(fr.image[LM.rightEar].visibility).toBeLessThan(0.2) // far side
    const close = new PoseSim({ azimuth: 0, elevation: 0, distance: 0.45, roll: 0, hfov: 60, aspect: 16 / 9 }, { noise: NO_NOISE })
    const c = close.render(posture())
    expect(c.image[LM.leftHip].y).toBeGreaterThan(1)
    expect(c.image[LM.leftHip].visibility).toBe(0.05)
    const exact = close.toCam([0.09, 0, 0])
    const w = c.world![LM.leftHip]
    const err = Math.hypot(w.x - exact[0] + close.toCam([0, 0, 0])[0], w.y - exact[1] + close.toCam([0, 0, 0])[1], w.z! - exact[2] + close.toCam([0, 0, 0])[2])
    expect(err).toBeGreaterThanOrEqual(0.06)
  })

  it('renders world landmarks in the crop-ray frame: rotated by the angle to the crop centre', () => {
    const cam = { azimuth: 0, elevation: 0, distance: 0.9, roll: 0, hfov: 90, aspect: 16 / 9, aim: [0.5, 0.35, 0] as Vec3 }
    const off = new PoseSim(cam, { noise: NO_NOISE })
    const axes = new PoseSim(cam, { noise: NO_NOISE, cropRay: false })
    const rot = off.cropRotation(posture())!
    // the user sits far left in a wide-FOV picture: the crop ray is ~half the FOV off-axis
    const img = off.render(posture()).image
    expect((img[LM.leftShoulder].x + img[LM.rightShoulder].x) / 2).toBeLessThan(0.3)
    expect(rot.deg).toBeGreaterThan(20)
    const a = off.render(posture()).world!
    const b = axes.render(posture()).world!
    for (const i of [LM.nose, LM.leftEar, LM.leftShoulder, LM.rightShoulder]) {
      const back = rotate([a[i].x, a[i].y, a[i].z!], rot.axis, rot.deg)
      expect(back[0]).toBeCloseTo(b[i].x, 9)
      expect(back[1]).toBeCloseTo(b[i].y, 9)
      expect(back[2]).toBeCloseTo(b[i].z!, 9)
    }
    // a centred user needs (almost) no correction
    const centred = new PoseSim({ ...cam, aim: [0, 0, 0] }, { noise: NO_NOISE })
    expect(centred.cropRotation(posture())?.deg ?? 0).toBeLessThan(1)
  })

  it('the viewpoint grid never uses the assumed 65° field of view', () => {
    expect(viewpointGrid().every((v) => v.hfov !== 65)).toBe(true)
  })
})
