// Regression tests for camera-angle robustness problems found in review: each case
// pins one concrete viewpoint/posture where an earlier version raised false alerts
// or mis-judged a good posture. All simulator-driven and deterministic.

import { describe, expect, it, vi } from 'vitest'
import type { CalibrationBaseline, PostureAlert } from '@shared/posture'
import { INSTRUCTIONS, assessPosture } from '../assess'
import { PostureEngine, computeDeviations, extractOptionsFor } from '../engine'
import { UpEstimator, extractFeatures } from '../features'
import type { PoseFrame, PostureFeatures } from '../types'
import { angleDeg } from '../vec'
import { CONFIRMED, STEP_MS, engineSettings, runEngine, runSetup } from './harness'
import { HallucinatingSim, NO_NOISE, PoseSim, Rng, eyesOnScreen, posture, truth, type CameraParams, type PostureParams } from './sim'

// simulator-heavy: allow for a loaded machine (parallel workers) beyond the 5 s default
vi.setConfig({ testTimeout: 60_000 })

const fmt = (alerts: PostureAlert[]): string[] => alerts.map((a) => `${a.issue}${a.stage}${a.direction ?? ''}`)

function calibrated(
  cam: CameraParams,
  pose: PostureParams = posture(),
  seed = 3,
  simOpts: { deskOcclusion?: boolean } = {}
): { b: CalibrationBaseline; t0: number } {
  // the local judge saves what it can verify; elsewhere a (simulated) cloud reviewer confirms it
  const { state, tMs } = runSetup(new PoseSim(cam, { seed, ...simOpts }), pose, CONFIRMED)
  expect(state.phase).toBe('done')
  return { b: state.baseline!, t0: tMs + STEP_MS }
}

const featWith = (fr: PoseFrame, b: CalibrationBaseline): PostureFeatures =>
  extractFeatures(fr, extractOptionsFor(b))!

/** good posture with micro-motion, a 30° swivel, a 40° head turn and glances down (spec §10 test 4) */
function goodDay(seed: number): (tMs: number) => PostureParams {
  const rng = new Rng(seed)
  const wave = (amp: number): ((t: number) => number) => {
    const per = rng.uniform(7, 23)
    const ph = rng.uniform(0, 2 * Math.PI)
    return (t) => amp * Math.sin((2 * Math.PI * t) / per + ph)
  }
  const [tp, tr, nf, hp, hr, sl, sk] = [wave(3), wave(3), wave(3), wave(3), wave(3), wave(0.01), wave(0.01)]
  const ramp = (t: number, a: number, b: number, c: number, d: number): number =>
    t < a ? 0 : t < b ? (t - a) / (b - a) : t < c ? 1 : t < d ? 1 - (t - c) / (d - c) : 0
  return (tMs) => {
    const t = tMs / 1000
    const glance = t % 45 > 30 && t % 45 < 35 ? 30 : 0
    return posture({
      trunkPitch: tp(t),
      trunkRoll: tr(t),
      neckFlex: nf(t),
      headPitch: hp(t) + glance,
      headRoll: hr(t),
      slide: sl(t),
      sink: sk(t),
      swivel: 30 * ramp(t, 60, 63, 150, 153),
      headYaw: 40 * ramp(t, 200, 201, 240, 241)
    })
  }
}

function goodDayAlerts(cam: CameraParams, seed: number, ms = 600_000): string[] {
  const sim = new PoseSim(cam, { seed })
  const { state, tMs } = runSetup(sim, posture(), CONFIRMED)
  expect(state.phase).toBe('done')
  const engine = new PostureEngine(state.baseline, engineSettings())
  const day = goodDay(seed)
  const t0 = tMs + STEP_MS
  return fmt(runEngine(engine, sim, (t) => day(t - t0), t0, t0 + ms).alerts)
}

// ---------------------------------------------------------------------------

describe('neckLat relative to the trunk ignores gravity errors', () => {
  // reclined good posture (20° back, head upright, eyes on the screen) with knees out of frame:
  // up is refined onto the reclined trunk, ~20° off true gravity
  const cam: CameraParams = { azimuth: 0, elevation: 25, distance: 1.0, roll: 0, hfov: 70, aspect: 16 / 9, aim: [0, 0.45, 0] }
  const base = eyesOnScreen({ trunkPitch: -20, neckFlex: 20 }, 0)

  it('a neck aligned with the trunk reads the baseline value under a swivel; a real bend reads its size', () => {
    const { b } = calibrated(cam, posture(base))
    const sim = new PoseSim(cam, { noise: NO_NOISE, seed: 3 })
    for (const sw of [0, 30]) {
      const f = featWith(sim.render(posture({ ...base, swivel: sw })), b)
      expect(f.neckLatRef).toBe('trunk')
      expect({ sw, d: Math.abs(f.neckLat! - b.neckLat!) < 3 }).toEqual({ sw, d: true })
      const bent = featWith(sim.render(posture({ ...base, swivel: sw, neckLat: 10 })), b)
      expect({ sw, bend: Math.abs(bent.neckLat! - b.neckLat! - 10) < 3 }).toEqual({ sw, bend: true })
      const both = featWith(sim.render(posture({ ...base, swivel: sw, trunkRoll: 10, neckLat: -10 })), b)
      expect({ sw, both: Math.abs(both.neckLat! - b.neckLat! + 10) < 3 }).toEqual({ sw, both: true })
    }
  })

  it.each([20, 30])('a %d° swivel raises no lean alert', (sw) => {
    const { b } = calibrated(cam, posture(base))
    const engine = new PostureEngine(b, engineSettings())
    const { alerts } = runEngine(engine, new PoseSim(cam, { seed: 7 }), posture({ ...base, swivel: sw }), 0, 60_000)
    expect(fmt(alerts)).toEqual([])
  })

  it('camera-gravity baseline (hips hidden at setup), hips visible later: a swivel raises no lean alert', () => {
    const c: CameraParams = { azimuth: 0, elevation: 30, distance: 1.4, roll: 0, hfov: 70, aspect: 16 / 9 }
    const { b } = calibrated(c, posture(), 3, { deskOcclusion: true })
    expect(b.upSource).toBe('camera')
    for (const sw of [25, 35]) {
      const engine = new PostureEngine(b, engineSettings())
      const { alerts } = runEngine(engine, new PoseSim(c, { seed: 5 }), posture({ swivel: sw }), 0, 60_000)
      expect({ sw, alerts: fmt(alerts) }).toEqual({ sw, alerts: [] })
    }
  })

  it('the simulator truth of the trunk-relative neck angle is gravity-free', () => {
    expect(truth(posture({ trunkRoll: 10 })).neckLatTrunk).toBeCloseTo(0, 6)
    expect(truth(posture({ trunkRoll: 10, neckLat: 8 })).neckLatTrunk).toBeCloseTo(8, 6)
    expect(truth(posture({ trunkPitch: -25, swivel: 30, trunkRoll: 10, neckLat: -10 })).neckLatTrunk).toBeCloseTo(-10, 0)
  })
})

describe('partial view (head + one shoulder): the body frame never follows the head', () => {
  const left: CameraParams = { azimuth: -15, elevation: 5, distance: 0.55, roll: 3, hfov: 60, aspect: 4 / 3, aim: [0.15, 0.55, 0] }
  const right: CameraParams = { azimuth: 40, elevation: 5, distance: 0.55, roll: 3, hfov: 60, aspect: 4 / 3, aim: [-0.15, 0.55, 0] }

  it('a head turn does not read as head-forward', () => {
    for (const [cam, yaws] of [
      [left, [-20, -30, -40]],
      [right, [20, 30, 40]]
    ] as const) {
      const { b } = calibrated(cam, posture(), 41)
      const sim = new PoseSim(cam, { noise: NO_NOISE, seed: 41 })
      for (const headYaw of yaws) {
        const f = featWith(sim.render(posture({ headYaw })), b)
        const d = computeDeviations(f, b).subs
        expect({ headYaw, neck: Math.abs(d.neck ?? 0) < 8 }).toEqual({ headYaw, neck: true })
      }
    }
  })

  it('a held head turn raises no alert', () => {
    const { b, t0 } = calibrated(left, posture(), 41)
    const sim = new PoseSim(left, { seed: 41 })
    const engine = new PostureEngine(b, engineSettings())
    runEngine(engine, sim, posture(), t0, t0 + 5000)
    expect(fmt(runEngine(engine, sim, posture({ headYaw: -35 }), t0 + 5000, t0 + 35_000).alerts)).toEqual([])
  })

  it('a chair swivel does not read as too close (the anchor stays on the swivel axis)', () => {
    const { b, t0 } = calibrated(right, posture(), 41)
    const f = featWith(new PoseSim(right, { noise: NO_NOISE, seed: 41 }).render(posture({ swivel: 30 })), b)
    expect(Math.abs(computeDeviations(f, b).subs.forward!)).toBeLessThan(4)
    const sim = new PoseSim(right, { seed: 41 })
    const engine = new PostureEngine(b, engineSettings())
    runEngine(engine, sim, posture(), t0, t0 + 5000)
    expect(fmt(runEngine(engine, sim, posture({ swivel: 30 }), t0 + 5000, t0 + 35_000).alerts)).toEqual([])
  })

  it('still detects head-forward from the partial view', () => {
    const { b, t0 } = calibrated(right, posture(), 41)
    const sim = new PoseSim(right, { seed: 41 })
    const engine = new PostureEngine(b, engineSettings())
    runEngine(engine, sim, posture(), t0, t0 + 2000)
    const { alerts } = runEngine(engine, sim, posture({ neckFlex: 30, headPitch: -30 }), t0 + 2000, t0 + 20_000)
    expect(alerts.some((a) => a.issue === 'headForward')).toBe(true)
  })

  it.each([
    [{ ...right, azimuth: 40, elevation: 5 }, 31],
    [{ ...right, azimuth: 15, elevation: 5 }, 32],
    [{ ...right, azimuth: 40, elevation: -10 }, 33],
    [{ ...right, azimuth: 40, elevation: 25 }, 34]
  ])('10 minutes of good posture raise no alert (%#)', (cam, seed) => {
    expect(goodDayAlerts(cam, seed)).toEqual([])
  }, 60_000)
})

describe('a chair swivel does not leak camera pitch into sagittal metrics (no thigh gravity)', () => {
  it.each([
    [{ azimuth: -60, elevation: -20, distance: 0.8, roll: 0, hfov: 70, aspect: 16 / 9 }, 1],
    [{ azimuth: -60, elevation: -20, distance: 0.8, roll: 0, hfov: 70, aspect: 16 / 9 }, 2],
    [{ azimuth: -75, elevation: -20, distance: 0.8, roll: 0, hfov: 70, aspect: 16 / 9 }, 1],
    [{ azimuth: -75, elevation: -20, distance: 0.8, roll: 0, hfov: 70, aspect: 16 / 9 }, 3]
  ])('below-camera view %#: 10 minutes of good posture raise no alert', (cam, seed) => {
    expect(goodDayAlerts(cam, seed)).toEqual([])
  }, 60_000)

  it.each([
    [-90, 30],
    [-90, -30],
    [90, -30]
  ])('camera az%d el-30: a %d° swivel raises no sink/head-forward alert', (azimuth, swivel) => {
    const cam: CameraParams = { azimuth, elevation: -30, distance: 1.0, roll: 3, hfov: 70, aspect: 16 / 9 }
    const { b, t0 } = calibrated(cam, posture(), 11)
    const sim = new PoseSim(cam, { seed: 12 })
    const engine = new PostureEngine(b, engineSettings())
    runEngine(engine, sim, posture(), t0, t0 + 5000)
    expect(fmt(runEngine(engine, sim, posture({ swivel }), t0 + 5000, t0 + 65_000).alerts)).toEqual([])
  })
})

describe('gravity from the thighs', () => {
  it.each([
    [{ azimuth: 0, elevation: 15 }, 15],
    [{ azimuth: 30, elevation: 15 }, 15],
    [{ azimuth: -40, elevation: 30 }, 15],
    [{ azimuth: 60, elevation: 0 }, 15],
    [{ azimuth: 90, elevation: 10 }, 15],
    [{ azimuth: 0, elevation: 15 }, -15],
    [{ azimuth: -40, elevation: 30 }, -15]
  ])('an upright user with sloped thighs passes setup (%o, slope %d°)', (c, thighSlope) => {
    const cam: CameraParams = { ...c, distance: 1.4, roll: 0, hfov: 70, aspect: 16 / 9 }
    const { state } = runSetup(new PoseSim(cam, { seed: 5 }), posture({ thighSlope }), CONFIRMED)
    expect(state.phase).toBe('done')
  })

  it.each([
    [20, 62],
    [45, 62],
    [20, 65],
    [45, 60]
  ])('a steep camera (az%d el%d) does not select a truncated thigh estimate', (azimuth, elevation) => {
    const cam: CameraParams = { azimuth, elevation, distance: 1.1, roll: 0, hfov: 60, aspect: 4 / 3 }
    for (const seed of [101, 102, 103, 104]) {
      const sim = new PoseSim(cam, { seed })
      const est = new UpEstimator()
      for (let i = 0; i < 50; i++) est.push(sim.render(posture()))
      const e = est.estimate
      // (a truncated estimate is far off; ≈1° of this budget is the viewing-ray correction's
      // noise and FOV residual)
      if (e.source === 'body') expect(angleDeg(e.up, sim.trueUp)).toBeLessThan(6)
      const { state } = runSetup(new PoseSim(cam, { seed }), posture(), CONFIRMED)
      expect({ seed, phase: state.phase }).toEqual({ seed, phase: 'done' })
    }
  })
})

describe('hallucinated hips (desk occlusion reported with high visibility)', () => {
  it.each([
    [{ azimuth: 0, elevation: 15 }, 1],
    [{ azimuth: 0, elevation: 15 }, 2],
    [{ azimuth: 30, elevation: 25 }, 1],
    [{ azimuth: 70, elevation: 20 }, 1]
  ])('good posture still passes setup (%o seed %d)', (c, seed) => {
    const cam: CameraParams = { ...c, distance: 1.1, roll: 0, hfov: 70, aspect: 16 / 9 }
    const { state } = runSetup(new HallucinatingSim(cam, { seed, deskOcclusion: true }), posture(), CONFIRMED)
    expect({ phase: state.phase, primary: state.assessment.primary?.id ?? null }).toEqual({ phase: 'done', primary: null })
  })
})

describe('views from behind the profile', () => {
  it.each([130, -130, 120])('az%d el-30: good posture passes setup', (azimuth) => {
    const cam: CameraParams = { azimuth, elevation: -30, distance: 1.2, roll: 0, hfov: 70, aspect: 16 / 9 }
    for (const seed of [1, 2]) {
      const { state } = runSetup(new PoseSim(cam, { seed }), posture(), CONFIRMED)
      expect({ seed, phase: state.phase }).toEqual({ seed, phase: 'done' })
    }
  })

  it('the trunk is not judged absolutely from behind without thigh gravity', () => {
    const sim = new PoseSim({ azimuth: 130, elevation: 30, distance: 1.2, roll: 0, hfov: 70, aspect: 16 / 9 }, { noise: NO_NOISE })
    const est = new UpEstimator()
    for (let i = 0; i < 20; i++) est.push(sim.render(posture()))
    const f = extractFeatures(sim.render(posture({ trunkPitch: 30 })), { up: est.estimate.up, upSource: est.estimate.source })!
    expect(f.view.opticalYawDeg).toBeGreaterThan(105)
    if (est.estimate.source !== 'body') expect(assessPosture(f).byId.trunkUpright.status).toBe('unknown')
  })
})

describe('assessment bounds', () => {
  const side = { upSource: 'camera' as const, view: { yawDeg: 85, elevationDeg: 0, kind: 'side' as const, opticalYawDeg: 85 } }
  const base = extractFeatures(new PoseSim({ azimuth: 90, elevation: 0, distance: 1.2, roll: 0, hfov: 65, aspect: 16 / 9 }, { noise: NO_NOISE }).render(posture()))!

  it('the reclined limit (−25°) is not widened by the gravity tolerance; past −32° it is lying in the chair', () => {
    // (the head on the trunk stays as captured: upright, the base posture's)
    expect(assessPosture({ ...base, ...side, trunkFwd: -24 }).byId.trunkUpright.status).toBe('good')
    expect(assessPosture({ ...base, ...side, trunkFwd: -27 }).byId.trunkUpright).toMatchObject({
      status: 'adjust',
      instruction: INSTRUCTIONS.trunkBack
    })
    expect(assessPosture({ ...base, ...side, trunkFwd: -40 }).byId.trunkUpright).toMatchObject({
      status: 'adjust',
      instruction: INSTRUCTIONS.lying
    })
  })

  it('the chin-up limit (−15°) is not widened by the gravity tolerance', () => {
    const front = { yawDeg: 5, elevationDeg: 0, kind: 'front' as const, opticalYawDeg: 5 }
    const a = assessPosture({ ...base, view: front, upSource: 'camera', trunkFwd: null, trunkLat: null, torsoLen: null, headPitch: -22 })
    expect(a.headRelativeToTrunk).toBe(false)
    expect(a.byId.gaze).toMatchObject({ status: 'adjust', instruction: INSTRUCTIONS.gazeUp })
  })
})

describe('setup cannot silently verify what it cannot see', () => {
  it.each([
    [{ azimuth: 0, elevation: 10, distance: 0.9 }, { trunkPitch: 35, neckFlex: 10 }],
    [{ azimuth: 20, elevation: 15, distance: 1.0 }, { trunkPitch: 30 }],
    [{ azimuth: 0, elevation: 25, distance: 0.8 }, { trunkPitch: 25, neckFlex: 15, headPitch: -10 }]
  ])('a hunch from a frontal camera without thigh gravity is never stamped verified (%o)', (c, p) => {
    const cam: CameraParams = { ...c, roll: 0, hfov: 70, aspect: 16 / 9 }
    // knees out of the picture (under the desk)
    class NoKnees extends PoseSim {
      render(q: PostureParams): PoseFrame {
        const fr = super.render(q)
        const hide = (l: (typeof fr.image)[number], i: number): typeof l => (i === 25 || i === 26 ? { ...l, visibility: 0.1 } : l)
        return { ...fr, image: fr.image.map(hide) }
      }
    }
    // without a reviewer nothing is saved on the local judge's word: it keeps coaching
    const { state, phases } = runSetup(new NoKnees(cam, { seed: 4 }), posture(p))
    expect(phases).not.toContain('done')
    expect(phases).not.toContain('capturing')
    expect(state.instruction).toMatch(/\S/)
    // with an AI reviewer available ('auto'), it never ends 'done' without the reviewer
    const r = runSetup(new NoKnees(cam, { seed: 4 }), posture(p), { review: 'auto' })
    expect(r.state.phase).not.toBe('done')
  })

  it("review: 'auto' skips the cloud review when the local judge verified everything", () => {
    const cam: CameraParams = { azimuth: 90, elevation: 10, distance: 1.0, roll: 0, hfov: 70, aspect: 16 / 9 }
    const { state } = runSetup(new PoseSim(cam, { seed: 42 }), posture(), { review: 'auto' })
    expect(state.phase).toBe('done')
    expect(state.baseline!.verified).toBe(true)
    expect(state.unverifiedChecks).toEqual([])
  })
})

describe('lean metrics compare like with like', () => {
  it('a baseline neckLat measured against the trunk is not compared with a gravity-referenced one', () => {
    const cam: CameraParams = { azimuth: 0, elevation: 15, distance: 1.4, roll: 0, hfov: 70, aspect: 16 / 9 }
    const { b } = calibrated(cam)
    expect(b.neckLatRef).toBe('trunk')
    // hips hidden now: neckLat falls back to gravity, which must not be subtracted from a trunk-relative baseline
    const f = featWith(new PoseSim(cam, { noise: NO_NOISE, seed: 3, deskOcclusion: true }).render(posture({ trunkRoll: 10 })), b)
    expect(f.neckLatRef).toBe('gravity')
    expect(computeDeviations(f, b).subs.neckLat).toBeUndefined()
  })
})

