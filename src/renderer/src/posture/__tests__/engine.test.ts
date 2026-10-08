import { describe, expect, it, vi } from 'vitest'
import type { CalibrationBaseline, PostureAlert } from '@shared/posture'
import { ESC_MIN_GAP_S, HEAD_TURN_HOLD, RECAL_SUGGEST_S, STAGES, SUB_STALE_S, SWIVEL_HOLD } from '../constants'
import { PostureEngine, computeDeviations, extractOptionsFor } from '../engine'
import { extractFeatures } from '../features'
import type { PoseFrame, PostureFeatures } from '../types'
import { CONFIRMED, STEP_MS, engineSettings, runEngine, runSetup } from './harness'
import { NO_NOISE, PoseSim, posture, type CameraParams } from './sim'

// simulator-heavy: allow for a loaded machine (parallel workers) beyond the 5 s default
vi.setConfig({ testTimeout: 60_000 })

const CAM: CameraParams = { azimuth: 15, elevation: 15, distance: 1.6, roll: 2, hfov: 70, aspect: 16 / 9 }
const good = posture()

/** A calibrated engine for CAM; returns the time to continue from. */
function setup(cam: CameraParams = CAM, seed = 1, over = {}): { engine: PostureEngine; sim: PoseSim; t0: number; baseline: CalibrationBaseline } {
  const sim = new PoseSim(cam, { seed })
  // the local judge saves what it can verify; elsewhere a (simulated) cloud reviewer confirms it
  const { state, tMs } = runSetup(sim, good, CONFIRMED)
  expect(state.phase).toBe('done')
  const baseline = state.baseline!
  return { engine: new PostureEngine(baseline, engineSettings(over)), sim, t0: tMs + STEP_MS, baseline }
}

describe('PostureEngine — calibration state', () => {
  it('uncalibrated: reports presence only, never alerts', () => {
    const sim = new PoseSim(CAM, { seed: 2 })
    const engine = new PostureEngine(null, engineSettings())
    const { snapshot, alerts } = runEngine(engine, sim, posture({ neckFlex: 40 }), 0, 30_000)
    expect(alerts).toEqual([])
    expect(snapshot.calibrated).toBe(false)
    expect(snapshot.worstStage).toBe(0)
    expect(snapshot.readout).toBeUndefined()
    expect(engine.lastFeatures).not.toBeNull()
  })

  it('good posture after setup: everything at stage 0 with a readout near zero', () => {
    const { engine, sim, t0 } = setup()
    const { snapshot, alerts } = runEngine(engine, sim, good, t0, t0 + 20_000)
    expect(alerts).toEqual([])
    expect(snapshot.calibrated).toBe(true)
    expect(snapshot.worstStage).toBe(0)
    const r = snapshot.readout!
    expect(r.view).toBe('front')
    expect(Math.abs(r.neckFwd!)).toBeLessThan(5)
    expect(Math.abs(r.drop!)).toBeLessThan(2)
    expect(Math.abs(r.forward!)).toBeLessThan(3)
  })

  it('setBaseline(null) returns to the uncalibrated state', () => {
    const { engine, sim, t0 } = setup()
    engine.setBaseline(null)
    const { snapshot } = runEngine(engine, sim, posture({ neckFlex: 40 }), t0, t0 + 5000)
    expect(snapshot.calibrated).toBe(false)
    expect(snapshot.worstStage).toBe(0)
  })
})

describe('PostureEngine — detection and alerts', () => {
  it('head forward alerts after the dwell, at the right stage, and recovers', () => {
    const { engine, sim, t0 } = setup()
    const bad = posture({ neckFlex: 25, headPitch: -25 })
    const early = runEngine(engine, sim, bad, t0, t0 + 10_000)
    expect(early.alerts).toEqual([])
    expect(early.snapshot.issues.headForward.stage).toBe(2)
    expect(early.snapshot.issues.headForward.activeForMs).toBeGreaterThan(8000)
    const late = runEngine(engine, sim, bad, t0 + 10_000, t0 + 16_000)
    expect(late.alerts).toEqual([expect.objectContaining({ issue: 'headForward', kind: 'initial', stage: 2 })])
    expect(late.snapshot.readout!.neckFwd!).toBeGreaterThan(18)
    const back = runEngine(engine, sim, good, t0 + 16_000, t0 + 30_000)
    expect(back.snapshot.issues.headForward.stage).toBe(0)
    expect(back.snapshot.issues.headForward.activeForMs).toBeNull()
  })

  it.each([
    [12, 'left'],
    [-12, 'right']
  ] as const)('lean %d° is reported toward the person’s %s', (roll, side) => {
    const { engine, sim, t0 } = setup()
    const { snapshot, alerts } = runEngine(engine, sim, posture({ trunkRoll: roll }), t0, t0 + 20_000)
    expect(snapshot.issues.lean.stage).toBeGreaterThanOrEqual(1)
    expect(snapshot.issues.lean.direction).toBe(side)
    expect(alerts.find((a) => a.issue === 'lean')?.direction).toBe(side)
    expect(Math.sign(snapshot.readout!.lateral!)).toBe(side === 'left' ? 1 : -1)
  })

  it('too close: sliding toward the screen', () => {
    const { engine, sim, t0 } = setup()
    const { snapshot, alerts } = runEngine(engine, sim, posture({ slide: 0.17 }), t0, t0 + 15_000)
    expect(snapshot.issues.tooClose.stage).toBeGreaterThanOrEqual(2)
    expect(snapshot.readout!.forward!).toBeGreaterThan(12)
    expect(alerts.some((a) => a.issue === 'tooClose')).toBe(true)
  })

  it('slouching: sinking down in the chair', () => {
    const { engine, sim, t0 } = setup()
    const { snapshot } = runEngine(engine, sim, posture({ sink: 0.12, slump: 0.08 }), t0, t0 + 8000)
    expect(snapshot.issues.sink.stage).toBeGreaterThanOrEqual(2)
    expect(snapshot.readout!.drop!).toBeGreaterThan(8)
  })

  it('a disabled issue stays at stage 0 and never alerts', () => {
    const s = engineSettings()
    s.issues.headForward.enabled = false
    const { engine, sim, t0 } = setup()
    engine.updateSettings(s)
    const { snapshot, alerts } = runEngine(engine, sim, posture({ neckFlex: 35, headPitch: -35 }), t0, t0 + 30_000)
    expect(snapshot.issues.headForward.stage).toBe(0)
    expect(alerts.filter((a) => a.issue === 'headForward')).toEqual([])
  })

  it('sensitivity raises the stage of the same posture', () => {
    const bad = posture({ neckFlex: 14, headPitch: -14 })
    const a = setup()
    const normal = runEngine(a.engine, a.sim, bad, a.t0, a.t0 + 6000).snapshot.issues.headForward.stage
    const s = engineSettings()
    s.issues.headForward.sensitivity = 2
    const b = setup()
    b.engine.updateSettings(s)
    const strict = runEngine(b.engine, b.sim, bad, b.t0, b.t0 + 6000).snapshot.issues.headForward.stage
    expect(strict).toBeGreaterThan(normal)
  })

  it('looking down alone uses the longer pitch-only dwell (glancing at a keyboard is normal)', () => {
    const { engine, sim, t0 } = setup()
    const glance = posture({ headPitch: 28 })
    const r1 = runEngine(engine, sim, glance, t0, t0 + 14_000)
    expect(r1.snapshot.issues.headForward.stage).toBeGreaterThanOrEqual(1)
    expect(r1.alerts).toEqual([]) // a normal 12 s dwell would have fired by now
    const r2 = runEngine(engine, sim, glance, t0 + 14_000, t0 + 22_000)
    expect(r2.alerts.some((a) => a.issue === 'headForward')).toBe(true)
  })
})

describe('PostureEngine — presence', () => {
  it('starts away: an empty chair at launch is never reported as someone sitting', () => {
    const { engine, sim, t0 } = setup()
    const fresh = new PostureEngine(engine['baseline'], engineSettings())
    const empty = runEngine(fresh, sim, null, t0, t0 + 1000)
    expect(empty.snapshot.presence).toBe('away')
    // the very first snapshot of a person too: presence needs 1.5 s of real landmarks
    const first = fresh.processFrame(sim.render(good), t0 + 1000)
    expect(first.snapshot.presence).toBe('away')
    const seen = runEngine(fresh, sim, good, t0 + 1000 + 100, t0 + 3000)
    expect(seen.snapshot.presence).toBe('active')
  })

  it('a long gap without frames needs the person confirmed again', () => {
    const { engine, sim, t0 } = setup()
    runEngine(engine, sim, good, t0, t0 + 3000)
    expect(engine.presenceState).toBe('active')
    const resume = t0 + 3000 + 10 * 60_000
    // e.g. after a pause or sleep, with nobody in the chair any more
    expect(engine.processFrame(null, resume).snapshot.presence).toBe('away')
    expect(engine.processFrame(sim.render(good), resume + 100).snapshot.presence).toBe('away')
    expect(runEngine(engine, sim, good, resume + 200, resume + 2500).snapshot.presence).toBe('active')
  })

  it('goes away after 2 s without the user and comes back after 1.5 s', () => {
    const { engine, sim, t0 } = setup()
    const away = runEngine(engine, sim, null, t0, t0 + 2500)
    expect(away.snapshot.presence).toBe('away')
    expect(engine.presenceState).toBe('away')
    expect(engine.lastFeatures).toBeNull()
    const back = runEngine(engine, sim, good, t0 + 2500, t0 + 4500)
    expect(back.snapshot.presence).toBe('active')
  })

  it('a user the model drops every other frame (poor light) is still confirmed; a rare sighting is not', () => {
    const { engine, sim, t0 } = setup()
    runEngine(engine, sim, null, t0, t0 + 3000)
    expect(engine.presenceState).toBe('away')
    /** frames every STEP_MS from `from`, the user seen where `seen(i)`; returns when presence went active */
    const flicker = (from: number, ms: number, seen: (i: number) => boolean): number | null => {
      for (let i = 0, t = from; t < from + ms; i++, t += STEP_MS) {
        engine.processFrame(seen(i) ? sim.render(good) : null, t)
        if (engine.presenceState === 'active') return t - from
      }
      return null
    }
    // seen in 3 of every 5 frames (the real dim-room recordings: 50–65%): confirmed within ~4 s
    const at = flicker(t0 + 3000, 10_000, (i) => i % 5 < 3)
    expect(at).not.toBeNull()
    expect(at!).toBeLessThan(5000)
    // gone again, then seen in only 1 of every 4 frames: never confirmed
    runEngine(engine, sim, null, t0 + 20_000, t0 + 23_000)
    expect(engine.presenceState).toBe('away')
    expect(flicker(t0 + 23_000, 30_000, (i) => i % 4 === 0)).toBeNull()
  })

  it('a long break resets running episodes (no alert right after returning)', () => {
    const { engine, sim, t0 } = setup()
    const bad = posture({ neckFlex: 25, headPitch: -25 })
    runEngine(engine, sim, bad, t0, t0 + 10_000)
    runEngine(engine, sim, null, t0 + 10_000, t0 + 50_000)
    const back = runEngine(engine, sim, bad, t0 + 50_000, t0 + 58_000)
    // the 10 s of dwell before the break do not count: no alert within 8 s of returning
    expect(back.alerts).toEqual([])
    expect(back.snapshot.issues.headForward.stage).toBe(2)
  })

  it('a long gap without any frames (pause, sleep) counts as a long break', () => {
    const { engine, sim, t0 } = setup()
    const bad = posture({ neckFlex: 25, headPitch: -25 })
    const first = runEngine(engine, sim, bad, t0, t0 + 16_000)
    expect(first.alerts.filter((a) => a.issue === 'headForward')).toHaveLength(1)
    // 60 min with no processFrame calls, then the user is still slouched
    const resume = t0 + 16_000 + 60 * 60_000
    const back = runEngine(engine, sim, bad, resume, resume + 10_000)
    expect(back.alerts).toEqual([])
    expect(back.snapshot.issues.headForward.activeForMs).toBeLessThan(11_000)
    // a fresh dwell later it nudges again (the old episode did not swallow it)
    const later = runEngine(engine, sim, bad, resume + 10_000, resume + 16_000)
    expect(later.alerts).toEqual([expect.objectContaining({ issue: 'headForward', kind: 'initial' })])
  })
})

describe('PostureEngine — smoothing, outliers and drift', () => {
  it('a single glitched frame (scale jump) is discarded', () => {
    const { engine, sim, t0 } = setup()
    const before = runEngine(engine, sim, good, t0, t0 + 5000).snapshot.readout!
    // zoom the image 1.6× about the centre for one frame
    const fr = sim.render(good)
    const zoomed: PoseFrame = { ...fr, image: fr.image.map((l) => ({ ...l, x: 0.5 + (l.x - 0.5) * 1.6, y: 0.5 + (l.y - 0.5) * 1.6 })) }
    const r = engine.processFrame(zoomed, t0 + 5000)
    expect(r.snapshot.readout!.forward).toBeCloseTo(before.forward!, 0)
    expect(r.snapshot.issues.tooClose.stage).toBe(0)
  })

  it('suggests recalibration when the distance stays far off for 10 s, and pauses detection', () => {
    const { engine, sim, t0 } = setup({ ...CAM, azimuth: 0, distance: 0.9 })
    // the user moved far back (scale < 0.5× the calibrated one)
    const far = posture({ slide: -1.2 })
    const r1 = runEngine(engine, sim, far, t0, t0 + (RECAL_SUGGEST_S - 2) * 1000)
    expect(r1.snapshot.recalibrationSuggested).toBe(false)
    const r2 = runEngine(engine, sim, far, t0 + (RECAL_SUGGEST_S - 2) * 1000, t0 + (RECAL_SUGGEST_S + 4) * 1000)
    expect(r2.snapshot.recalibrationSuggested).toBe(true)
    expect(r2.snapshot.worstStage).toBe(0)
    const alerts: PostureAlert[] = runEngine(engine, sim, far, t0 + 20_000, t0 + 60_000).alerts
    expect(alerts).toEqual([])
  })

  it('computeDeviations is zero for the baseline posture and signs lean toward the left as +', () => {
    const { baseline, sim, engine, t0 } = setup()
    // single noisy frames scatter (σ ≈ 7° for a frontal neck under the simulator's depth
    // noise): their mean and the smoothed engine readout must sit well below stage 1
    const subs = Array.from(
      { length: 200 },
      () => computeDeviations(extractFeatures(sim.render(good), extractOptionsFor(baseline))!, baseline).subs
    )
    const mean = (k: 'neck' | 'pitch' | 'drop' | 'forward' | 'trunkFwd' | 'trunkLat' | 'neckLat'): number =>
      subs.reduce((a, d) => a + (d[k] ?? 0), 0) / subs.length
    expect(Math.abs(mean('neck'))).toBeLessThan(2)
    expect(Math.abs(mean('pitch'))).toBeLessThan(2)
    expect(Math.abs(mean('trunkFwd'))).toBeLessThan(2)
    expect(Math.abs(mean('trunkLat'))).toBeLessThan(2)
    expect(Math.abs(mean('neckLat'))).toBeLessThan(2)
    expect(Math.abs(mean('drop'))).toBeLessThan(1)
    expect(Math.abs(mean('forward'))).toBeLessThan(1.5)
    const r = runEngine(engine, sim, good, t0, t0 + 3000).snapshot
    expect(Math.abs(r.readout!.neckFwd!)).toBeLessThan(STAGES.headForward.neck[0] / 2)
    expect(Math.abs(r.readout!.lateral!)).toBeLessThan(STAGES.lean.trunkLat[0] / 2)
    expect(r.worstStage).toBe(0)
    const e = new PostureEngine(baseline, engineSettings())
    e.processFrame(new PoseSim(CAM, { noise: { image: 0, worldXY: 0, worldZ: 0 } }).render(posture({ trunkRoll: 12 })), 0)
    const lean = computeDeviations(e.lastFeatures!, baseline).subs
    expect(lean.trunkLat!).toBeGreaterThan(8)
    // the left shoulder drops when leaning left; the sub-metric still reads "+ = toward the left"
    expect(lean.shoulderTilt!).toBeGreaterThan(8)
  })
})

describe('PostureEngine — stages, escalation, cooldown', () => {
  it('only the enabled notification stages trigger an alert', () => {
    const s = engineSettings()
    s.issues.headForward.notifyStages = [false, true, true]
    const { engine, sim, t0 } = setup()
    engine.updateSettings(s)
    // stage 1 is shown but never alerts
    const slight = runEngine(engine, sim, posture({ neckFlex: 14, headPitch: -14 }), t0, t0 + 30_000)
    expect(slight.snapshot.issues.headForward.stage).toBe(1)
    expect(slight.alerts.filter((a) => a.issue === 'headForward')).toEqual([])
    // stage 2 does
    const clear = runEngine(engine, sim, posture({ neckFlex: 25, headPitch: -25 }), t0 + 30_000, t0 + 50_000)
    expect(clear.alerts).toEqual([expect.objectContaining({ issue: 'headForward', kind: 'initial', stage: 2 })])
  })

  it('escalates to a worse stage after the minimum gap, and only when escalation is on', () => {
    for (const escalation of [true, false]) {
      const { engine, sim, t0 } = setup(CAM, 1, { escalation })
      const a = runEngine(engine, sim, posture({ neckFlex: 14, headPitch: -14 }), t0, t0 + 15_000)
      expect(a.alerts).toEqual([expect.objectContaining({ issue: 'headForward', kind: 'initial', stage: 1 })])
      const t1 = t0 + 15_000
      const b = runEngine(engine, sim, posture({ neckFlex: 35, headPitch: -35 }), t1, t1 + (ESC_MIN_GAP_S + 10) * 1000)
      const esc = b.alerts.filter((x) => x.issue === 'headForward')
      if (escalation) expect(esc).toEqual([expect.objectContaining({ kind: 'escalation', stage: 3 })])
      else expect(esc).toEqual([])
    }
  })

  it('after a recovered episode the cooldown suppresses a new alert', () => {
    const { engine, sim, t0 } = setup()
    const bad = posture({ neckFlex: 25, headPitch: -25 })
    expect(runEngine(engine, sim, bad, t0, t0 + 15_000).alerts.length).toBe(1)
    runEngine(engine, sim, good, t0 + 15_000, t0 + 30_000) // recovers → cooldown (3 min)
    expect(runEngine(engine, sim, bad, t0 + 30_000, t0 + 90_000).alerts).toEqual([])
    // once the cooldown is over, the same posture alerts again
    runEngine(engine, sim, good, t0 + 90_000, t0 + 220_000)
    expect(runEngine(engine, sim, bad, t0 + 220_000, t0 + 240_000).alerts.length).toBe(1)
  })
})

describe('PostureEngine — holds', () => {
  it('a sub-metric that stays unavailable stops driving its issue (hidden nose)', () => {
    const { engine, sim, t0 } = setup()
    const down = posture({ headPitch: 32 })
    expect(runEngine(engine, sim, down, t0, t0 + 5000).snapshot.issues.headForward.stage).toBeGreaterThanOrEqual(1)
    // the nose disappears (e.g. a hand in front of the face): its stale pitch must not keep the stage
    const noNose = (): PoseFrame => {
      const fr = sim.render(down)
      return { ...fr, image: fr.image.map((l, i) => (i <= 6 || i === 9 || i === 10 ? { ...l, visibility: 0.05 } : l)) }
    }
    let snap = engine.processFrame(noNose(), t0 + 5000).snapshot
    for (let t = t0 + 5000 + STEP_MS; t < t0 + 5000 + (SUB_STALE_S + 1) * 1000; t += STEP_MS) snap = engine.processFrame(noNose(), t).snapshot
    expect(snap.presence).toBe('active')
    expect(snap.issues.headForward.stage).toBe(0)
  })

  it('swiveled beyond SWIVEL_HOLD: gravity-referenced metrics are held (camera gravity)', () => {
    const cam: CameraParams = { azimuth: 0, elevation: 30, distance: 1.4, roll: 0, hfov: 70, aspect: 16 / 9 }
    const sim = new PoseSim(cam, { seed: 3, deskOcclusion: true })
    const { state } = runSetup(sim, good, CONFIRMED)
    const b = state.baseline!
    expect(b.upSource).toBe('camera')
    const clean = new PoseSim(cam, { noise: NO_NOISE, seed: 3, deskOcclusion: true })
    const dev = (swivel: number): ReturnType<typeof computeDeviations> => {
      const f = extractFeatures(clean.render(posture({ swivel, shrugL: 0.04 })), extractOptionsFor(b))!
      return computeDeviations(f, b)
    }
    const small = dev(SWIVEL_HOLD - 10)
    expect(small.subs.shoulderTilt).toBeDefined()
    expect(small.subs.neckLat).toBeDefined()
    expect(small.subs.neck).toBeDefined()
    const big = dev(30)
    expect(big.swivelDeg).toBeGreaterThan(SWIVEL_HOLD)
    expect(big.subs.shoulderTilt).toBeUndefined()
    expect(big.subs.neckLat).toBeUndefined()
    // …and so are the sagittal ones (the camera tilt is unknown); position metrics stay
    expect(big.subs.neck).toBeUndefined()
    expect(big.subs.pitch).toBeUndefined()
    expect(big.subs.drop).toBeDefined()
    expect(big.subs.forward).toBeDefined()
    // a held swivel raises no alert
    const engine = new PostureEngine(b, engineSettings())
    expect(runEngine(engine, sim, posture({ swivel: 30 }), 0, 60_000).alerts).toEqual([])
  })

  it('with one ear in the frame, head metrics are held while the head is turned', () => {
    const { baseline, sim } = setup()
    const f = extractFeatures(sim.render(good), extractOptionsFor(baseline))!
    const oneEar = (headYaw: number | null): PostureFeatures => ({ ...f, earsBoth: false, headYaw })
    expect(computeDeviations(oneEar(HEAD_TURN_HOLD - 10), baseline).subs.neck).toBeDefined()
    for (const yaw of [HEAD_TURN_HOLD + 10, -(HEAD_TURN_HOLD + 10), null]) {
      const d = computeDeviations(oneEar(yaw), baseline).subs
      expect(d.neck).toBeUndefined()
      expect(d.pitch).toBeUndefined()
      expect(d.neckDrop).toBeUndefined()
    }
    // both ears in view: the ear midpoint does not move with a head turn, the neck is not held
    expect(computeDeviations({ ...f, headYaw: 35 }, baseline).subs.neck).toBeDefined()
  })

  it('detection resumes after a recalibration suspension once the distance is back in range', () => {
    const { engine, sim, t0 } = setup({ ...CAM, azimuth: 0, distance: 0.9 })
    const far = posture({ slide: -1.2 })
    const r1 = runEngine(engine, sim, far, t0, t0 + (RECAL_SUGGEST_S + 4) * 1000)
    expect(r1.snapshot.recalibrationSuggested).toBe(true)
    expect(r1.snapshot.worstStage).toBe(0)
    // the suspension is emitted for the UI (score.ts isSuspended, liveModel statusView)
    expect((r1.snapshot as { suspended?: boolean }).suspended).toBe(true)
    // back at the calibrated distance, with the head forward: detected and alerted again
    const bad = posture({ neckFlex: 25, headPitch: -25 })
    const r2 = runEngine(engine, sim, bad, t0 + 20_000, t0 + 40_000)
    expect(r2.snapshot.issues.headForward.stage).toBeGreaterThanOrEqual(1)
    expect(r2.alerts.some((a) => a.issue === 'headForward')).toBe(true)
    // 20 s back in range (> RECAL_SUGGEST_S): the view matches setup again, the hint is withdrawn
    expect(r2.snapshot.recalibrationSuggested).toBe(false)
    expect((r2.snapshot as { suspended?: boolean }).suspended).toBeFalsy()
  })

  it('the recalibration hint is withdrawn only after RECAL_SUGGEST_S back in range, and stays while the view is off', () => {
    const { engine, sim, t0 } = setup({ ...CAM, azimuth: 0, distance: 0.9 })
    const far = posture({ slide: -1.2 })
    // a camera that really moved: the hint stays up for as long as the view is off
    const r1 = runEngine(engine, sim, far, t0, t0 + 60_000)
    expect(r1.snapshot.recalibrationSuggested).toBe(true)
    // briefly back (shorter than RECAL_SUGGEST_S), then off again: not withdrawn in between
    const back = posture()
    const r2 = runEngine(engine, sim, back, t0 + 60_000, t0 + 60_000 + (RECAL_SUGGEST_S - 4) * 1000)
    expect(r2.snapshot.recalibrationSuggested).toBe(true)
    expect((r2.snapshot as { suspended?: boolean }).suspended).toBe(false)
    const t1 = t0 + 60_000 + (RECAL_SUGGEST_S - 4) * 1000
    const r3 = runEngine(engine, sim, far, t1, t1 + 5000)
    expect(r3.snapshot.recalibrationSuggested).toBe(true)
    expect((r3.snapshot as { suspended?: boolean }).suspended).toBe(true)
    // back for good: withdrawn after RECAL_SUGGEST_S (plus the scale smoother's settling)
    const r4 = runEngine(engine, sim, back, t1 + 5000, t1 + 5000 + (RECAL_SUGGEST_S + 3) * 1000)
    expect(r4.snapshot.recalibrationSuggested).toBe(false)
  })
})
