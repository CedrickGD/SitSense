// features.ts: sign conventions, gravity estimation, presence, scale — pinned with
// noise-free simulator frames and a few hand-built frames.

import { describe, expect, it } from 'vitest'
import { LM, UP_MAX_ROLL } from '../constants'
import {
  CAM_UP,
  UpEstimator,
  cameraPitchDeg,
  cameraRollDeg,
  estimateUp,
  extractFeatures,
  hipLineUp,
  hipPerspectiveWeight,
  isGoodFrame,
  limitRoll
} from '../features'
import type { Landmark, PoseFrame } from '../types'
import { angleDeg, dot, norm, reject, unit, type Vec3 } from '../vec'
import { NO_NOISE, PoseSim, posture, type CameraParams, type PostureParams } from './sim'

const cam = (over: Partial<CameraParams> = {}): CameraParams => ({
  azimuth: 0,
  elevation: 0,
  distance: 1.6,
  roll: 0,
  hfov: 65,
  aspect: 16 / 9,
  ...over
})
const clean = (c: Partial<CameraParams> = {}): PoseSim => new PoseSim(cam(c), { noise: NO_NOISE })
const feat = (sim: PoseSim, p: Partial<PostureParams> = {}, opts = {}) => {
  const f = extractFeatures(sim.render(posture(p)), opts)
  expect(f).not.toBeNull()
  return f!
}
const near = (v: Vec3, w: Vec3, deg = 2): void => expect(angleDeg(v, w)).toBeLessThanOrEqual(deg)

describe('sign conventions (person facing the camera)', () => {
  const sim = clean()
  const f = feat(sim)

  it('the person’s left is image-right, forward is toward the camera (−Z), up is camera-up', () => {
    const fr = sim.render(posture())
    expect(fr.image[LM.leftEar].x).toBeGreaterThan(fr.image[LM.rightEar].x)
    expect(fr.image[LM.leftShoulder].x).toBeGreaterThan(fr.image[LM.rightShoulder].x)
    near(f.left, [1, 0, 0])
    near(f.forward, [0, 0, -1])
    near(f.up, CAM_UP)
    expect(f.view.yawDeg).toBeLessThan(3)
    expect(f.view.kind).toBe('front')
    expect(f.labelsSwapped).toBe(false)
  })

  it('body frame is right-handed: forward = left × up', () => {
    const c: Vec3 = [
      f.left[1] * f.up[2] - f.left[2] * f.up[1],
      f.left[2] * f.up[0] - f.left[0] * f.up[2],
      f.left[0] * f.up[1] - f.left[1] * f.up[0]
    ]
    near(c, f.forward, 0.5)
    expect(Math.abs(dot(f.left, f.up))).toBeLessThan(1e-6)
  })

  it('good upright posture reads neutral', () => {
    expect(f.neckFwd).toBeCloseTo(0, 0)
    expect(f.trunkFwd!).toBeCloseTo(0, 0)
    expect(f.trunkLat!).toBeCloseTo(0, 0)
    expect(f.neckLat!).toBeCloseTo(0, 0)
    expect(f.shoulderTilt!).toBeCloseTo(0, 0)
    expect(f.headRollRel!).toBeCloseTo(0, 0)
    // the nose sits 2.5 cm below and 10 cm ahead of the ear midpoint: atan(2.5/10)
    expect(f.headPitch!).toBeCloseTo(14, 0)
  })

  it.each([
    ['ears ahead of shoulders → neckFwd +', { neckFlex: 20 }, (g: ReturnType<typeof feat>) => g.neckFwd, 20],
    ['leaning forward → trunkFwd +', { trunkPitch: 20 }, (g: ReturnType<typeof feat>) => g.trunkFwd!, 20],
    ['reclining → trunkFwd −', { trunkPitch: -20 }, (g: ReturnType<typeof feat>) => g.trunkFwd!, -20],
    ['looking down → headPitch +', { headPitch: 20 }, (g: ReturnType<typeof feat>) => g.headPitch! - 14, 20],
    ['leaning to the left → trunkLat +', { trunkRoll: 10 }, (g: ReturnType<typeof feat>) => g.trunkLat!, 10],
    ['neck tilted to the left → neckLat +', { neckLat: 12 }, (g: ReturnType<typeof feat>) => g.neckLat!, 12],
    ['left ear higher → headRollRel +', { headRoll: -12 }, (g: ReturnType<typeof feat>) => g.headRollRel!, 12],
    ['turning the face to the left → headYaw +', { headYaw: 30 }, (g: ReturnType<typeof feat>) => g.headYaw!, 30]
  ] as const)('%s', (_name, p, get, expected) => {
    expect(get(feat(sim, p))).toBeCloseTo(expected, 0)
  })

  it('left shoulder raised → shoulderTilt + (needs a non-camera gravity source)', () => {
    const g = feat(sim, { shrugL: 0.06 })
    expect(g.upSource).not.toBe('camera')
    expect(g.shoulderTilt!).toBeCloseTo((Math.asin(0.06 / Math.hypot(0.36, 0.06)) * 180) / Math.PI, 0)
  })

  it('camera above → elevation +, camera below → elevation − (with known gravity)', () => {
    const above = clean({ elevation: 30 })
    const below = clean({ elevation: -15 })
    expect(feat(above, {}, { up: above.trueUp, upSource: 'body' }).view.elevationDeg).toBeGreaterThan(15)
    expect(feat(below, {}, { up: below.trueUp, upSource: 'body' }).view.elevationDeg).toBeLessThan(-5)
  })
})

describe('sign conventions from the side and from behind-left', () => {
  it('camera on the person’s left: forward is image-left, near side left, profile view', () => {
    const f = feat(clean({ azimuth: 90 }))
    near(f.forward, [-1, 0, 0], 3)
    near(f.left, [0, 0, -1], 3)
    expect(f.view.kind).toBe('side')
    expect(f.view.yawDeg).toBeGreaterThan(80)
    expect(f.nearSide).toBe('left')
  })

  it('camera on the person’s right: forward is image-right, near side right', () => {
    const f = feat(clean({ azimuth: -90 }))
    near(f.forward, [1, 0, 0], 3)
    expect(f.nearSide).toBe('right')
  })

  it('an angled view keeps the same anatomical signs', () => {
    const sim = clean({ azimuth: 40, elevation: 20 })
    expect(feat(sim).view.kind).toBe('angled')
    expect(feat(sim, { trunkRoll: 10 }).trunkLat!).toBeGreaterThan(7)
    expect(feat(sim, { trunkRoll: -10 }).trunkLat!).toBeLessThan(-7)
    expect(feat(sim, { neckFlex: 20 }).neckFwd).toBeGreaterThan(15)
  })

  it('profile views do not guess lateral angles', () => {
    const f = feat(clean({ azimuth: 90 }), { trunkRoll: 10 })
    expect(f.trunkLat).toBeNull()
    expect(f.neckLat).toBeNull()
    expect(f.shoulderTilt).toBeNull()
    expect(f.headRollRel).toBeNull()
    expect(f.neckFwd).toBeCloseTo(0, 0)
  })
})

describe('MediaPipe left/right label swaps', () => {
  it('are detected and corrected from the nose direction', () => {
    const sim = new PoseSim(cam({ azimuth: 20 }), { noise: NO_NOISE, swapLabels: true })
    const f = extractFeatures(sim.render(posture({ trunkRoll: 10, shrugL: 0.05 })))!
    expect(f.labelsSwapped).toBe(true)
    near(f.forward, feat(clean({ azimuth: 20 })).forward, 3)
    expect(f.trunkLat!).toBeGreaterThan(7)
  })
})

describe('invariance', () => {
  it('angles do not depend on the video aspect ratio or the true field of view', () => {
    // the viewing-ray correction needs the focal length: exact when the FOV is known…
    const p = { neckFlex: 15, trunkPitch: 8 }
    const a = feat(clean({ aspect: 16 / 9, hfov: 55 }), p, { hfovDeg: 55 })
    const b = feat(clean({ aspect: 4 / 3, hfov: 85 }), p, { hfovDeg: 85 })
    expect(a.neckFwd).toBeCloseTo(b.neckFwd, 0)
    expect(a.trunkFwd!).toBeCloseTo(b.trunkFwd!, 0)
    // …and only a small residual (a fraction of the crop-ray angle) with the assumed one
    const a65 = feat(clean({ aspect: 16 / 9, hfov: 55 }), p)
    const b65 = feat(clean({ aspect: 4 / 3, hfov: 85 }), p)
    expect(Math.abs(a65.neckFwd - b65.neckFwd)).toBeLessThan(3)
    expect(Math.abs(a65.trunkFwd! - b65.trunkFwd!)).toBeLessThan(3)
  })

  it('a body swivel and a head turn do not change the neck/trunk angles (thigh gravity)', () => {
    const sim = clean({ distance: 2, elevation: 15 })
    const base = feat(sim)
    expect(base.upSource).toBe('body')
    for (const p of [{ swivel: 30 }, { swivel: -30 }, { headYaw: 40 }]) {
      const f = feat(sim, p, { up: base.up, upSource: base.upSource })
      expect(f.neckFwd).toBeCloseTo(base.neckFwd, 0)
      expect(f.trunkFwd!).toBeCloseTo(base.trunkFwd!, 0)
    }
  })

  it('scale: ppm ≈ f_true / Z (independent of the assumed field of view)', () => {
    for (const hfov of [55, 85]) {
      const sim = clean({ hfov, distance: 1.2 })
      const f = feat(sim)
      const sh = sim.toCam([0 - sim.position[0], 0.48 - sim.position[1], 0 - sim.position[2]])
      expect(f.ppm! * sh[2]).toBeCloseTo(sim.focal, 1)
    }
  })

  it('hips crossing the bottom frame edge do not swing the angles (crop ray stays on the hips)', () => {
    // fixed world landmarks; only the reported image hips move across the edge, as with
    // hip jitter at the bottom of a desk webcam's frame. The crop ray follows the hip
    // midpoint smoothly (BlazePose's ROI centre), so the angles move by about the small
    // change in ray angle (~2.5 deg over this range), never by a switch to another point.
    for (const elevation of [0, 15]) {
      for (const distance of [0.85, 1.0]) {
        const sim = new PoseSim(cam({ elevation, distance }), { noise: NO_NOISE, cropRay: false })
        const fr = sim.render(posture())
        const opts = { up: sim.trueUp, upSource: 'camera' as const }
        const neck: number[] = []
        const trunk: number[] = []
        for (const y of [0.95, 0.97, 0.985, 0.995, 1.005, 1.01, 1.03]) {
          const image = fr.image.map((l, i) => (i === LM.leftHip || i === LM.rightHip ? { ...l, y } : l))
          const f = extractFeatures({ ...fr, image }, opts)
          expect(f).not.toBeNull()
          neck.push(f!.neckFwd)
          if (f!.trunkFwd !== null) trunk.push(f!.trunkFwd)
        }
        for (let i = 1; i < neck.length; i++) expect(Math.abs(neck[i] - neck[i - 1])).toBeLessThan(2)
        expect(Math.max(...neck) - Math.min(...neck)).toBeLessThan(5)
        if (trunk.length > 1) expect(Math.max(...trunk) - Math.min(...trunk)).toBeLessThan(5)
      }
    }
  })

  it('the anchor does not move when the body swivels or the head turns', () => {
    const sim = clean({ azimuth: -60, elevation: 30, distance: 1.2 })
    const base = feat(sim)
    for (const p of [{ swivel: 20 }, { swivel: -30 }, { headYaw: 40 }]) {
      const a = feat(sim, p, { up: base.up, upSource: base.upSource }).anchor!
      expect(norm([a[0] - base.anchor![0], a[1] - base.anchor![1], a[2] - base.anchor![2]])).toBeLessThan(0.015)
    }
  })
})

describe('gravity estimate (§3.2)', () => {
  it("uses the thighs ('body') when hips and a knee are clearly seen", () => {
    const sim = clean({ distance: 2, elevation: 30 })
    const est = estimateUp(sim.render(posture()))
    expect(est.source).toBe('body')
    near(est.up, sim.trueUp, 1)
  })

  /** hips in view, knees hidden (e.g. under the desk) */
  const noKnees = (fr: PoseFrame): PoseFrame => ({
    ...fr,
    image: fr.image.map((l, i) => (i === LM.leftKnee || i === LM.rightKnee ? { ...l, visibility: 0.2 } : l))
  })

  it("falls back to the hip line ('hips') for a level camera", () => {
    // (was: a camera rolled 8°, with the roll removed. Webcams are mounted level (|roll| ≲ 3°)
    // and the level-camera model never rolls the estimate — see the next two tests)
    const sim = clean({ distance: 1.4 })
    const est = estimateUp(noKnees(sim.render(posture())))
    expect(est.source).toBe('hips')
    near(est.up, sim.trueUp, 1)
  })

  it('never rolls the estimate; a hip line needing more roll than a level camera has leaves the horizontal unconfirmed', () => {
    for (const roll of [-8, -3, 3, 8]) {
      const sim = clean({ distance: 1.4, roll })
      const fr = noKnees(sim.render(posture()))
      const est = estimateUp(fr)
      expect(est.source).toBe('hips')
      expect(Math.abs(cameraRollDeg(est.up))).toBeLessThan(1e-9)
      // the error is the camera's own roll, never more
      expect(Math.abs(angleDeg(est.up, sim.trueUp) - Math.abs(roll))).toBeLessThan(0.5)
      const acc = new UpEstimator()
      for (let i = 0; i < 10; i++) acc.push(fr)
      expect({ roll, consistent: acc.levelConsistent }).toEqual({ roll, consistent: Math.abs(roll) <= 2 * UP_MAX_ROLL })
    }
  })

  it("uses the camera's up when no hips are seen", () => {
    const sim = new PoseSim(cam({ distance: 1.2 }), { noise: NO_NOISE, deskOcclusion: true })
    expect(estimateUp(sim.render(posture())).source).toBe('camera')
  })

  it('rejects estimates more than 60° from the camera up', () => {
    const sim = clean({ distance: 1.4 })
    const fr = noKnees(sim.render(posture()))
    // tip the hip line 70° out of horizontal
    const world = fr.world!.map((l) => ({ ...l }))
    world[LM.leftHip] = { ...world[LM.leftHip], x: 0.03, y: -0.085 }
    world[LM.rightHip] = { ...world[LM.rightHip], x: -0.03, y: 0.085 }
    expect(estimateUp({ ...fr, world }).source).toBe('camera')
  })

  it('UpEstimator averages and only switches to a better source after enough frames', () => {
    const hipsSim = clean({ distance: 1.4 })
    const bodySim = clean({ distance: 2, elevation: 30 })
    const est = new UpEstimator()
    for (let i = 0; i < 10; i++) est.push(noKnees(hipsSim.render(posture())))
    expect(est.estimate.source).toBe('hips')
    est.push(bodySim.render(posture()))
    expect(est.estimate.source).toBe('hips')
    for (let i = 0; i < 5; i++) est.push(bodySim.render(posture()))
    expect(est.estimate.source).toBe('body')
    expect(norm(est.estimate.up)).toBeCloseTo(1, 6)
    est.reset()
    expect(est.estimate.source).toBe('camera')
    expect(est.frameCount).toBe(0)
  })

  it('a fixed up passed in opts is used as-is (runtime uses the baseline’s)', () => {
    const sim = clean()
    const tilted: Vec3 = [0, -Math.cos(0.2), -Math.sin(0.2)]
    const f = feat(sim, {}, { up: tilted, upSource: 'hips' })
    near(f.up, tilted, 0.01)
    expect(f.upSource).toBe('hips')
  })
})

describe('gravity from a hip line alone (hipLineUp, level-camera prior)', () => {
  const R = Math.PI / 180
  /**
   * A level hip line and the true up in camera coordinates, for a body turned `yaw` from
   * the camera and a camera pitched `pitch` (+ = looking down) and rolled `roll` about its
   * optical axis (the simulator's convention).
   */
  const seen = (yaw: number, pitch: number, roll: number): { H: Vec3; up: Vec3 } => {
    const [s, c] = [Math.sin(yaw * R), Math.cos(yaw * R)]
    const [sp, cp] = [Math.sin(pitch * R), Math.cos(pitch * R)]
    const [sr, cr] = [Math.sin(roll * R), Math.cos(roll * R)]
    const h: Vec3 = [c, -s * sp, s * cp]
    return { H: [h[0] * cr + h[1] * sr, h[1] * cr - h[0] * sr, h[2]], up: [-cp * sr, -cp * cr, -sp] }
  }

  it('a hip line along the image axis shows neither pitch nor (in this model) roll', () => {
    // (was: it corrected the roll in full, ±8°. A level-mounted webcam's roll is ≲ 3°, and a
    // facing hip line's tilt is as likely hallucinated hips or a tilted pelvis: the estimate
    // stays level, and a large tilt only leaves the horizontal unconfirmed)
    for (const roll of [-8, -3, 0, 3, 8]) {
      const { H } = seen(0, 25, roll)
      const u = hipLineUp(H)!
      expect(Math.abs(cameraRollDeg(u))).toBeLessThan(1e-9)
      expect(Math.abs(cameraPitchDeg(u))).toBeLessThan(0.5)
    }
  })

  it('a turned hip line under a pitched level camera is perspective: no roll, the pitch recovered', () => {
    for (const yaw of [25, 40, 60, -40]) {
      for (const pitch of [-15, 20, 40, 55]) {
        const { H, up } = seen(yaw, pitch, 0)
        // the minimal correction from camUp (the old rule) reads it as a large roll
        const old = unit(reject(CAM_UP, unit(H)!))!
        if (Math.abs(yaw) >= 40 && Math.abs(pitch) >= 40) expect(Math.abs(cameraRollDeg(old))).toBeGreaterThan(20)
        const u = hipLineUp(H)!
        expect({ yaw, pitch, roll: Math.abs(cameraRollDeg(u)) < 1 }).toEqual({ yaw, pitch, roll: true })
        expect({ yaw, pitch, err: angleDeg(u, up) < 1.5 }).toEqual({ yaw, pitch, err: true })
      }
    }
  })

  it('a near-frontal hip line with a small tilt error does not invent a pitch', () => {
    // a 2° (hallucinated) tilt on a body turned 5°: read as perspective it would claim a
    // camera looking ~20° up
    const { H } = seen(5, 0, 0)
    const t: Vec3 = [H[0] * Math.cos(2 * R) - H[1] * Math.sin(2 * R), H[0] * Math.sin(2 * R) + H[1] * Math.cos(2 * R), H[2]]
    expect(hipPerspectiveWeight(t)).toBe(0)
    const u = hipLineUp(t)!
    expect(Math.abs(cameraPitchDeg(u))).toBeLessThan(0.5)
    expect(Math.abs(cameraRollDeg(u))).toBeLessThan(1e-9)
  })

  it('no estimate for a hip line no supported camera tilt makes horizontal', () => {
    // standing up in the picture: every up ⟂ to it is ≥ 75° from the camera's up
    expect(hipLineUp([0.26, -0.97, 0])).toBeNull()
    expect(hipLineUp([0, 0, 0])).toBeNull()
  })

  it('limitRoll clamps the camera roll and keeps the pitch', () => {
    const tilted: Vec3 = [Math.sin(20 * R) * Math.cos(30 * R), -Math.cos(20 * R) * Math.cos(30 * R), -Math.sin(30 * R)]
    const c = limitRoll(tilted)
    expect(cameraRollDeg(c)).toBeCloseTo(UP_MAX_ROLL, 6)
    expect(cameraPitchDeg(c)).toBeCloseTo(30, 6)
    expect(norm(c)).toBeCloseTo(1, 9)
    expect(cameraRollDeg(limitRoll(tilted, 0))).toBeCloseTo(0, 9)
    // (was 5°: UP_MAX_ROLL is now 3°)
    const small: Vec3 = [Math.sin(2 * R) * Math.cos(30 * R), -Math.cos(2 * R) * Math.cos(30 * R), -Math.sin(30 * R)]
    expect(angleDeg(limitRoll(small), small)).toBeLessThan(1e-6)
  })
})

describe('presence (§2)', () => {
  const sim = clean()
  const good = sim.render(posture())

  it('a pose with head and shoulders is GOOD', () => {
    expect(isGoodFrame(good)).toBe(true)
  })

  it('no pose, no world landmarks, or too few landmarks is BAD', () => {
    expect(isGoodFrame(null)).toBe(false)
    expect(extractFeatures(null)).toBeNull()
    expect(isGoodFrame({ ...good, world: null })).toBe(false)
    expect(isGoodFrame({ ...good, image: good.image.slice(0, 20) })).toBe(false)
  })

  const hide = (fr: PoseFrame, idx: number[]): PoseFrame => {
    const image: Landmark[] = fr.image.map((l, i) => (idx.includes(i) ? { ...l, visibility: 0.05 } : l))
    return { ...fr, image }
  }

  it('without a visible head the frame is BAD', () => {
    expect(isGoodFrame(hide(good, [LM.nose, LM.leftEar, LM.rightEar]))).toBe(false)
  })

  it('without a visible shoulder the frame is BAD', () => {
    expect(isGoodFrame(hide(good, [LM.leftShoulder, LM.rightShoulder]))).toBe(false)
  })

  it('one shoulder and the head are enough (no hips, no second shoulder, no centering)', () => {
    const fr = hide(good, [LM.rightShoulder, LM.leftHip, LM.rightHip, LM.leftKnee, LM.rightKnee])
    expect(isGoodFrame(fr)).toBe(true)
    const f = extractFeatures(fr)!
    expect(f.trunkFwd).toBeNull()
    expect(f.neckFwd).toBeCloseTo(0, 0)
  })
})
