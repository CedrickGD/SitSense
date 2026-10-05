// Camera-roll regressions of the gravity estimate (docs/specs/detection.md, Implementation
// notes, "Gravity"). Webcams are mounted level (|roll| ≲ 3°); body cues must never invent a
// camera roll — not from a turned body's perspective under a pitched camera (the original
// bug: the hip line rises or falls in camera axes from the pitch alone, and the old minimal
// correction read that as 14–43° of roll, drawn as a tilted "true vertical" in the Lines
// overlay and coached as phantom shoulder/lean fixes; a later roll clamp at 12° still drew
// the real recording's vertical 12.4° off), and not from hallucinated hips or knees. The
// estimate is a level-camera one: a pitch, plus at most UP_MAX_ROLL of roll from a hip line
// facing the camera.

import { describe, expect, it, vi } from 'vitest'
import { projectUp } from '@renderer/detection/pose-geometry'
import { SetupSession } from '../calibration'
import { CONFIRMED, runSetup } from './harness'
import { UP_MAX_ROLL } from '../constants'
import { UpEstimator, cameraPitchDeg, cameraRollDeg, estimateUp, extractFeatures } from '../features'
import type { PoseFrame, PostureFeatures } from '../types'
import { DEG, type Vec3 } from '../vec'
import { HallucinatingSim, PoseSim, posture, type CameraParams, type PostureParams } from './sim'

// simulator-heavy: allow for a loaded machine (parallel workers) beyond the 5 s default
vi.setConfig({ testTimeout: 60_000 })

/** The hips are in view, the knees hidden under the desk: gravity from the hip line alone. */
class NoKneesSim extends PoseSim {
  render(p: PostureParams): PoseFrame {
    const fr = super.render(p)
    return { ...fr, image: fr.image.map((l, i) => (i === 25 || i === 26 ? { ...l, visibility: 0.1 } : l)) }
  }
}

/** Angle of an image direction from the image's vertical (deg, + = toward image-right). */
const tilt2d = ([u, v]: [number, number]): number => Math.atan2(u, -v) * DEG

/** How far the drawn true vertical at the shoulders is from the real one there (deg). */
const overlayError = (f: PostureFeatures, trueUp: Vec3, aspect: number): number =>
  Math.abs(tilt2d(projectUp(f, aspect)) - tilt2d(projectUp({ up: trueUp, anchor: f.anchor }, aspect)))

/** "Level" for a level camera: the most roll the estimate may ever show (UP_MAX_ROLL = 3°). */
const LEVEL_DEG = UP_MAX_ROLL
/** The drawn true vertical at the shoulders, for a level camera aimed at the chest: within 3° of upright. */
const DRAWN_DEG = 3

describe('a turned body under a pitched, level camera reads as pitch, not roll', () => {
  const CAMS: CameraParams[] = []
  for (const azimuth of [-60, -45, -30, 30, 45, 60]) {
    for (const elevation of [30, 45, 55, 60]) {
      for (const distance of [0.9, 1.4]) CAMS.push({ azimuth, elevation, distance, roll: 0, hfov: 70, aspect: 16 / 9 })
    }
  }

  it.each([
    ['knees under the desk (hip line only)', NoKneesSim],
    ['knees in view (thighs)', PoseSim]
  ] as const)('%s: small roll, an upright drawn vertical', (_name, Sim) => {
    for (const cam of CAMS) {
      for (const seed of [1, 2]) {
        const sim = new Sim(cam, { seed })
        const est = new UpEstimator()
        let frame = sim.render(posture())
        est.push(frame)
        for (let i = 1; i < 40; i++) est.push((frame = sim.render(posture())))
        const e = est.estimate
        const id = `az${cam.azimuth} el${cam.elevation} d${cam.distance} seed${seed} ${e.source}`
        expect({ id, roll: Math.abs(cameraRollDeg(e.up)) <= LEVEL_DEG }).toEqual({ id, roll: true })
        const f = extractFeatures(frame, { up: e.up, upSource: e.source })
        expect(f).not.toBeNull()
        // the camera is level and aimed at the chest: the true vertical through the
        // shoulders is the image's vertical, and so must the drawn one be
        expect(Math.abs(tilt2d(projectUp({ up: sim.trueUp, anchor: f!.anchor }, cam.aspect)))).toBeLessThan(2)
        expect({ id, drawn: Math.abs(tilt2d(projectUp(f!, cam.aspect))) <= DRAWN_DEG }).toEqual({ id, drawn: true })
        expect({ id, vsTrue: overlayError(f!, sim.trueUp, cam.aspect) <= DRAWN_DEG }).toEqual({ id, vsTrue: true })
        // the hip line alone recovers the pitch from the turned body's perspective (cameras
        // below the 60° tilt bound; at the bound the estimate may fall back to the camera's up)
        if (Sim === NoKneesSim && cam.elevation <= 55) {
          expect({ id, source: e.source }).toEqual({ id, source: 'hips' })
          const dp = Math.abs(cameraPitchDeg(e.up) - cameraPitchDeg(sim.trueUp))
          expect({ id, pitch: dp <= 8 }).toEqual({ id, pitch: true })
        }
      }
    }
  })

  it('the live setup state keeps the vertical upright once the estimate has settled', () => {
    for (const cam of CAMS.filter((c) => c.distance === 1.4)) {
      for (const Sim of [NoKneesSim, PoseSim]) {
        const sim = new Sim(cam, { seed: 7 })
        const session = new SetupSession({ now: () => 0 })
        for (let i = 0; i < 60; i++) {
          const s = session.push(sim.render(posture()), i * 100)
          // the first second (≤ 10 noisy frames) is still settling
          if (i < 20 || s.features === null) continue
          const id = `az${cam.azimuth} el${cam.elevation} frame${i} ${s.up.source}`
          expect({ id, roll: Math.abs(cameraRollDeg(s.up.up)) <= LEVEL_DEG }).toEqual({ id, roll: true })
          expect({ id, drawn: overlayError(s.features, sim.trueUp, cam.aspect) <= DRAWN_DEG }).toEqual({ id, drawn: true })
        }
      }
    }
  })
})

describe('hallucinated hips and knees never tilt the vertical by more than 3° (level camera)', () => {
  /** The roll a hip line implies when read the old way (its tilt in the image plane), deg. */
  const hipLineTilt = (fr: PoseFrame): number => {
    const w = fr.world!
    let hx = w[23].x - w[24].x
    let hy = w[23].y - w[24].y
    if (hx < 0) [hx, hy] = [-hx, -hy]
    return Math.abs(Math.atan2(hy, hx) * DEG)
  }

  it('per frame, accumulated, and live during setup', () => {
    let worstHipTilt = 0
    for (const azimuth of [0, 30, -45, 70]) {
      for (const elevation of [0, 15, 35]) {
        for (const seed of [1, 2, 3, 4]) {
          const cam: CameraParams = { azimuth, elevation, distance: 1.1, roll: 0, hfov: 70, aspect: 16 / 9 }
          const sim = new HallucinatingSim(cam, { seed, deskOcclusion: true })
          const est = new UpEstimator()
          const session = new SetupSession({ now: () => 0 })
          for (let i = 0; i < 60; i++) {
            const fr = sim.render(posture())
            worstHipTilt = Math.max(worstHipTilt, hipLineTilt(fr))
            const id = `az${azimuth} el${elevation} seed${seed} frame${i}`
            const one = estimateUp(fr)
            expect({ id, frame: Math.abs(cameraRollDeg(one.up)) <= UP_MAX_ROLL + 1e-9 }).toEqual({ id, frame: true })
            est.push(fr)
            const s = session.push(fr, i * 100)
            expect({ id, live: Math.abs(cameraRollDeg(s.up.up)) <= UP_MAX_ROLL + 1e-9 }).toEqual({ id, live: true })
            // the drawn line is the vertical at the shoulders (was ≤ UP_MAX_ROLL + 1 with a 12°
            // clamp; the requirement is 3° for a level camera, roll and wrong pitch together)
            if (s.features) {
              expect({ id, drawn: overlayError(s.features, sim.trueUp, cam.aspect) <= DRAWN_DEG }).toEqual({ id, drawn: true })
              expect({ id, upright: Math.abs(tilt2d(projectUp(s.features, cam.aspect))) <= DRAWN_DEG }).toEqual({ id, upright: true })
            }
          }
          const e = est.estimate
          expect(Math.abs(cameraRollDeg(e.up))).toBeLessThanOrEqual(UP_MAX_ROLL + 1e-9)
        }
      }
    }
    // the hallucinated hip lines really are far off (the level-camera model is what holds them)
    expect(worstHipTilt).toBeGreaterThan(4 * UP_MAX_ROLL)
  })
})

describe('a hip line that contradicts a level camera leaves the horizontal unconfirmed', () => {
  const cam = (roll: number): CameraParams => ({ azimuth: 0, elevation: 15, distance: 1.4, roll, hfov: 70, aspect: 16 / 9 })

  it.each([
    ['knees under the desk (hip line only)', NoKneesSim],
    ['knees in view (thighs)', PoseSim]
  ] as const)('%s: a camera rolled 8° keeps a level estimate, shoulders unknown, setup completes', (_name, Sim) => {
    for (const roll of [-8, 8]) {
      const est = new UpEstimator()
      const sim = new Sim(cam(roll), { seed: 3 })
      for (let i = 0; i < 40; i++) est.push(sim.render(posture()))
      expect({ roll, consistent: est.levelConsistent }).toEqual({ roll, consistent: false })
      expect(Math.abs(cameraRollDeg(est.estimate.up))).toBeLessThan(1e-9)
      // (a frontal camera without thigh gravity cannot verify the back angle: the simulated cloud
      // reviewer confirms the capture; the local judge must not coach anything on the way)
      const { state } = runSetup(new Sim(cam(roll), { seed: 3 }), posture(), CONFIRMED)
      expect({ roll, phase: state.phase }).toEqual({ roll, phase: 'done' })
      expect(state.assessment.byId.shouldersLevel.status).toBe('unknown')
    }
  })

  it.each([
    ['knees under the desk (hip line only)', NoKneesSim],
    ['knees in view (thighs)', PoseSim]
  ] as const)('%s: a level (or ≤ 3° rolled) camera is confirmed, and a raised shoulder is coached', (_name, Sim) => {
    for (const roll of [0, -UP_MAX_ROLL, UP_MAX_ROLL]) {
      const est = new UpEstimator()
      const sim = new Sim(cam(roll), { seed: 3 })
      for (let i = 0; i < 40; i++) est.push(sim.render(posture()))
      expect({ roll, consistent: est.levelConsistent }).toEqual({ roll, consistent: true })
      const session = new SetupSession({ now: () => 0 })
      const raised = new Sim(cam(roll), { seed: 4 })
      let s = session.state
      for (let i = 0; i < 40; i++) s = session.push(raised.render(posture({ shrugL: 0.1 })), i * 100)
      expect({ roll, check: s.assessment.byId.shouldersLevel.status }).toEqual({ roll, check: 'adjust' })
    }
  })
})
