// docs/specs/detection.md §10 "Required tests" over a grid of ≥ 40 virtual viewpoints.
// "Measurable" is decided per viewpoint by an oracle that is independent of the
// bad posture under test: the same pipeline is run noise-free on the GOOD posture,
// and a check/issue counts as measurable there when it is reported at all and its
// value is within tolerance of the simulator's ground truth. Coverage assertions
// make sure the oracle cannot hollow the tests out (e.g. lateral checks must be
// measurable in every frontal view, and must be 'unknown' in a true profile).

import { describe, expect, it, vi } from 'vitest'
import { ISSUES, type IssueId, type PostureSnapshot, type Stage } from '@shared/posture'
import { INSTRUCTIONS, assessPosture, type CheckId, type PostureAssessment } from '../assess'
import { SetupSession, medianFeatures } from '../calibration'
import { PostureEngine, type SubMetricId } from '../engine'
import { LAT_MAX_YAW, UP_MAX_ROLL } from '../constants'
import { projectUp } from '@renderer/detection/pose-geometry'
import { UpEstimator, cameraRollDeg, extractFeatures, focalLength, isGoodFrame } from '../features'
import { DEG, RAD, angleDeg, type Vec3 } from '../vec'
import { CONFIRMED, STEP_MS, engineSettings, runEngine, runSetup } from './harness'
import {
  NO_NOISE,
  PoseSim,
  ROLLED_GRID_ROLLS,
  Rng,
  posture,
  skeleton,
  truth,
  viewpointGrid,
  type PostureParams,
  type Truth,
  type Viewpoint
} from './sim'

// simulator-heavy: allow for a loaded machine (parallel workers) beyond the 5 s default
vi.setConfig({ testTimeout: 60_000 })

/** stress-test with other noise draws: SIM_SEED_OFFSET=1000 npx vitest run … */
const OFF = Number(process.env.SIM_SEED_OFFSET ?? 0)
const GRID = viewpointGrid()
const good = posture()
/**
 * Seated thighs are rarely level: tests 3 and 4 give every viewpoint its own thigh
 * slope in −10…+10° (thigh gravity assumes level thighs; deviations from the baseline
 * must not care).
 */
const thighSlopeFor = (i: number): number => ((i * 7) % 21) - 10

function inView(vp: Viewpoint): boolean {
  return isGoodFrame(new PoseSim(vp, { noise: NO_NOISE }).render(good))
}
const IN_VIEW = GRID.filter(inView)

/** Live assessment the way the setup session does it: gravity from good frames, median of ~1 s. */
function assessAt(sim: PoseSim, p: PostureParams, frames = 10): PostureAssessment {
  const est = new UpEstimator()
  for (let i = 0; i < 20; i++) est.push(sim.render(good))
  const up = est.estimate
  const feats = []
  for (let i = 0; i < frames; i++) {
    const f = extractFeatures(sim.render(p), { up: up.up, upSource: up.source })
    if (f) feats.push(f)
  }
  return assessPosture(feats.length ? medianFeatures(feats) : null)
}

function truthFor(id: CheckId, t: Truth, relative: boolean): number | null {
  switch (id) {
    case 'trunkUpright':
      return t.trunkFwd
    case 'headOverShoulders':
      return relative ? t.neckFwd - t.trunkFwd : t.neckFwd
    case 'sideLean':
      return t.trunkLat
    case 'shouldersLevel':
      return t.shoulderTilt
    case 'headLevel':
      return t.headRollRel
    case 'gaze':
      return relative ? t.headPitch - t.trunkFwd : t.headPitch
    default:
      return null
  }
}

/**
 * What the viewing-ray correction leaves over when the true FOV is not the assumed one:
 * it estimates the crop ray's angle from its image position with the assumed focal
 * length (0 for a centred user or when the FOV matches).
 */
function rayResidualDeg(sim: PoseSim, p: PostureParams = good): number {
  const r = sim.cropRotation(p)
  if (!r) return 0
  const est = Math.atan((Math.tan(r.deg * RAD) * sim.focal) / focalLength(sim.cam.aspect)) * DEG
  return Math.abs(r.deg - est)
}

const ORACLE_TOL = 10
const LATERAL = new Set<CheckId>(['sideLean', 'shouldersLevel', 'headLevel'])
const cleanYaw = (vp: Viewpoint): number => extractFeatures(new PoseSim(vp, { noise: NO_NOISE }).render(good))?.view.yawDeg ?? NaN

/**
 * Is `id` measurable from this viewpoint? Noise-free: the good posture's value must be
 * within ORACLE_TOL of the truth (gravity good enough here), and the check must be
 * reported at all for the posture under test (it can move landmarks out of view).
 */
function checkMeasurable(vp: Viewpoint, id: CheckId, p: PostureParams = good): boolean {
  const clean = new PoseSim(vp, { noise: NO_NOISE })
  const a = assessAt(clean, good, 3)
  const c = a.byId[id]
  if (c.status === 'unknown' || c.value === null) return false
  const tv = truthFor(id, truth(good), a.headRelativeToTrunk)
  if (tv === null || Math.abs(c.value - tv) > ORACLE_TOL) return false
  return p === good || assessAt(clean, p, 3).byId[id].status !== 'unknown'
}

/** True body yaw relative to the camera (0 = facing it), from the simulator geometry. */
function trueYaw(vp: Viewpoint): number {
  const sim = new PoseSim(vp, { noise: NO_NOISE })
  const chest: Vec3 = [0, 0.35, 0]
  const toCam: Vec3 = [sim.position[0] - chest[0], 0, sim.position[2] - chest[2]]
  return angleDeg([0, 0, 1], toCam)
}

describe('viewpoint grid', () => {
  it('has ≥ 40 viewpoints spanning the required ranges', () => {
    expect(GRID.length).toBeGreaterThanOrEqual(40)
    const az = GRID.map((v) => v.azimuth)
    const el = GRID.map((v) => v.elevation)
    const d = GRID.map((v) => v.distance)
    expect(Math.min(...az)).toBe(-90)
    expect(Math.max(...az)).toBe(90)
    expect(Math.min(...el)).toBe(-20)
    expect(Math.max(...el)).toBe(50)
    expect(Math.min(...d)).toBeLessThanOrEqual(0.5)
    expect(Math.max(...d)).toBeGreaterThanOrEqual(2.0)
    expect(new Set(GRID.map((v) => v.aspect)).size).toBe(2)
    expect(GRID.every((v) => v.hfov >= 55 && v.hfov <= 85 && v.hfov !== 65)).toBe(true)
    // camera rolls span the level-mount prior (|roll| ≲ 3°, UP_MAX_ROLL). They were ±8°: the
    // gravity estimate is now a level-camera one (it estimates pitch, not roll), and absolute
    // lateral accuracy from an 8°-rolled camera with no horizontal cue is not physically
    // available. Rolled cameras keep their own graceful-degradation tests below.
    expect(GRID.some((v) => v.roll === -UP_MAX_ROLL) && GRID.some((v) => v.roll === UP_MAX_ROLL)).toBe(true)
    expect(GRID.every((v) => Math.abs(v.roll) <= UP_MAX_ROLL)).toBe(true)
  })

  it('most viewpoints see the user (the rest are too close to fit head + shoulder)', () => {
    expect(IN_VIEW.length).toBeGreaterThanOrEqual(36)
    for (const vp of GRID.filter((v) => !inView(v))) expect(vp.distance).toBeLessThanOrEqual(0.6)
  })
})

// ---------------------------------------------------------------------------
// 1. good posture passes setup

/**
 * Required 1 under the strict judge: from every viewpoint in view, good posture is either
 * verified and saved by the local judge (every essential check measurable: thigh gravity or a
 * near-profile view, with a hip in view), or — where the camera cannot show the back angle —
 * never coached wrongly: the session waits (needsVerification) with a camera/sit-up instruction,
 * offers "Save this posture anyway", and a cloud reviewer's confirmation saves it.
 */
const locallyVerified = new Set<string>()
describe('required 1: good posture passes setup from every viewpoint in view', () => {
  it.each(GRID.map((vp, i) => ({ ...vp, seed: OFF + 100 + i })))('$name', (vp) => {
    const sim = new PoseSim(vp, { seed: vp.seed })
    // the local judge alone (no reviewer)
    const { state, phases } = runSetup(sim, good)
    if (!inView(vp)) {
      expect(state.phase).toBe('searching')
      expect(state.assessment.byId.inView.status).toBe('adjust')
      return
    }
    if (state.phase !== 'done') {
      // the camera cannot verify an essential check: no capture, nothing saved, no wrong advice
      expect(phases).not.toContain('capturing')
      const s2 = new PoseSim(vp, { seed: vp.seed })
      const session = new SetupSession({ now: () => 0 })
      let needs = 0
      let adjustFrames = 0
      let frames = 0
      let st = session.state
      for (let t = 0; t < 25_000; t += STEP_MS) {
        st = session.push(s2.render(good), t)
        if (st.phase === 'searching') continue
        frames++
        if (st.needsVerification) {
          needs++
          expect(st.instruction).toBe(st.assessment.viewInstruction)
          expect(st.assessment.unverified.length).toBeGreaterThan(0)
        }
        // what the essential checks measure never asks a good posture to change. (The lateral
        // checks flicker on the simulator's noise in steep close views, as before; an
        // 'estimate' — the neck against an unconfirmed gravity — assumes a roughly level camera.)
        const p = st.assessment.primary
        if (p && ['trunkUpright', 'headOverShoulders'].includes(p.id) && p.basis !== 'estimate') adjustFrames++
      }
      expect({ vp: vp.name, waited: needs > frames * 0.4, wrong: adjustFrames }).toEqual({ vp: vp.name, waited: true, wrong: 0 })
      expect(st.canForce).toBe(true)
      expect(st.phase).toBe('coaching')
      // a connected cloud reviewer confirms the capture
      const r = runSetup(new PoseSim(vp, { seed: vp.seed }), good, CONFIRMED)
      expect(r.state.phase).toBe('done')
      expect(r.state.baseline!.verified).toBe(true)
      return
    }
    locallyVerified.add(vp.name)
    const b = state.baseline!
    expect(b.version).toBe(2)
    // the local judge saves only what it verified
    expect(b.verified).toBe(true)
    expect(state.unverifiedChecks).toEqual([])
    // the capture itself only runs while the AI judges the posture good (verified)
    expect(phases).toEqual(expect.arrayContaining(['holding', 'capturing', 'done']))

    if (b.upSource === 'body') {
      // with thigh gravity, every captured angle is within ±6° of the truth (plus the
      // viewing-ray correction's residual from the unknown FOV)
      const t = truth(good)
      const tol = 6 + rayResidualDeg(sim)
      const close = (name: string, v: number | null, tv: number): void => {
        if (v !== null) expect({ name, ok: Math.abs(v - tv) <= tol, v }).toMatchObject({ name, ok: true })
      }
      close('neckFwd', b.neckFwd, t.neckFwd)
      close('trunkFwd', b.trunkFwd, t.trunkFwd)
      close('headPitch', b.headPitch, t.headPitch)
      close('trunkLat', b.trunkLat, t.trunkLat)
      close('shoulderTilt', b.shoulderTilt, t.shoulderTilt)
      close('headRollRel', b.headRollRel, t.headRollRel)
      close('neckLat', b.neckLat, t.neckLatTrunk)
      // the up vector also carries the camera's own roll (|roll| ≤ UP_MAX_ROLL in the grid):
      // the level-camera estimate does not recover it (there is no roll cue a turned or
      // profile body can give), and it is orthogonal to the pitch error the ±6° budget covers
      expect(angleDeg(b.up, sim.trueUp)).toBeLessThanOrEqual(Math.hypot(tol, Math.abs(vp.roll)))
    }
  })

  it('the local judge verifies good posture wherever the camera shows what it needs (coverage)', () => {
    // every view with thigh gravity or a near-profile camera that sees a hip — about half the grid
    expect(locallyVerified.size).toBeGreaterThanOrEqual(18)
    // a near profile with the hips in view always verifies
    for (const vp of IN_VIEW.filter((v) => Math.abs(v.azimuth) === 90 && v.elevation <= 30)) {
      const f = extractFeatures(new PoseSim(vp, { noise: NO_NOISE }).render(good))
      if (f?.trunkFwd !== null) expect({ vp: vp.name, verified: locallyVerified.has(vp.name) }).toEqual({ vp: vp.name, verified: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 2. each bad posture fails its own check with the right instruction

interface BadCase {
  name: string
  p: Partial<PostureParams>
  check: CheckId
  instruction: string
  direction?: string
}
const BAD: BadCase[] = [
  { name: 'leaning forward', p: { trunkPitch: 28 }, check: 'trunkUpright', instruction: INSTRUCTIONS.trunkForward },
  // (the narrow −25…−32° band that is coached as "leaning far back" is unit-tested in assess.test.ts)
  { name: 'reclined far back', p: { trunkPitch: -60 }, check: 'trunkUpright', instruction: INSTRUCTIONS.lying },
  {
    name: 'head forward (level gaze)',
    p: { neckFlex: 45, headPitch: -30 },
    check: 'headOverShoulders',
    instruction: INSTRUCTIONS.headForward
  },
  { name: 'leaning left', p: { trunkRoll: 18 }, check: 'sideLean', instruction: INSTRUCTIONS.sideLean('left'), direction: 'left' },
  { name: 'leaning right', p: { trunkRoll: -18 }, check: 'sideLean', instruction: INSTRUCTIONS.sideLean('right'), direction: 'right' },
  {
    name: 'left shoulder raised',
    p: { shrugL: 0.1 },
    check: 'shouldersLevel',
    instruction: INSTRUCTIONS.shoulderRaised('left'),
    direction: 'left'
  },
  {
    name: 'right shoulder raised',
    p: { shrugR: 0.1 },
    check: 'shouldersLevel',
    instruction: INSTRUCTIONS.shoulderRaised('right'),
    direction: 'right'
  },
  { name: 'head tilted left', p: { headRoll: 22 }, check: 'headLevel', instruction: INSTRUCTIONS.headTilt('left'), direction: 'left' },
  { name: 'head tilted right', p: { headRoll: -22 }, check: 'headLevel', instruction: INSTRUCTIONS.headTilt('right'), direction: 'right' },
  { name: 'looking down', p: { headPitch: 50 }, check: 'gaze', instruction: INSTRUCTIONS.gazeDown },
  { name: 'chin up', p: { headPitch: -55 }, check: 'gaze', instruction: INSTRUCTIONS.gazeUp }
]

describe('required 2: each bad posture fails its own check with the right instruction', () => {
  const measurable = new Map<string, boolean>()
  const key = (vp: Viewpoint, id: CheckId): string => `${vp.name}|${id}`
  for (const vp of IN_VIEW) for (const id of new Set(BAD.map((b) => b.check))) measurable.set(key(vp, id), checkMeasurable(vp, id))
  const count = (id: CheckId, pred: (vp: Viewpoint) => boolean = () => true): number =>
    IN_VIEW.filter((vp) => pred(vp) && measurable.get(key(vp, id))).length

  it.each(BAD)('$name → $check', (bc) => {
    let tested = 0
    IN_VIEW.forEach((vp, i) => {
      if (!measurable.get(key(vp, bc.check)) || !checkMeasurable(vp, bc.check, posture(bc.p))) return
      tested++
      const a = assessAt(new PoseSim(vp, { seed: OFF + 300 + i }), posture(bc.p))
      const c = a.byId[bc.check]
      // lateral checks switch off at LAT_MAX_YAW; right at that boundary noise may legitimately flip it
      if (c.status === 'unknown' && LATERAL.has(bc.check) && Math.abs(cleanYaw(vp) - LAT_MAX_YAW) < 5) return
      expect({ vp: vp.name, status: c.status, instruction: c.instruction }).toEqual({
        vp: vp.name,
        status: 'adjust',
        instruction: bc.instruction
      })
      if (bc.direction) expect(c.direction).toBe(bc.direction)
    })
    expect(tested).toBeGreaterThan(0)
  })

  it('checks are measurable wherever the geometry allows (coverage)', () => {
    const frontal = (vp: Viewpoint): boolean => trueYaw(vp) <= 45
    const nFrontal = IN_VIEW.filter(frontal).length
    // the head is judged from most views: on the trunk wherever a hip and an ear are in view,
    // absolutely with thigh gravity or from the side. (With neither, the neck angle carries the
    // camera's unknown pitch: it is not verified, only called out far past any plausible tilt.)
    expect(count('headOverShoulders')).toBeGreaterThanOrEqual(Math.ceil(IN_VIEW.length * 0.7))
    expect(count('gaze')).toBeGreaterThanOrEqual(Math.ceil(IN_VIEW.length * 0.7))
    // head roll is body-relative: every frontal view that sees both shoulders and both ears (or eyes)
    const bothSides = (vp: Viewpoint): boolean => {
      const f = extractFeatures(new PoseSim(vp, { noise: NO_NOISE }).render(good))
      return f !== null && f.vis.shoulders === 2 && (f.vis.ears === 2 || f.vis.eyes === 2)
    }
    expect(count('headLevel', frontal)).toBeGreaterThanOrEqual(IN_VIEW.filter((vp) => frontal(vp) && bothSides(vp)).length)
    expect(IN_VIEW.filter((vp) => frontal(vp) && bothSides(vp)).length).toBeGreaterThanOrEqual(nFrontal - 3)
    // trunk lean needs absolute gravity: thighs in view or a near-profile camera
    expect(count('trunkUpright')).toBeGreaterThanOrEqual(15)
    // side lean: every frontal view that sees both hips
    const hipsBoth = (vp: Viewpoint): boolean => {
      const f = extractFeatures(new PoseSim(vp, { noise: NO_NOISE }).render(good))
      return f !== null && f.vis.hips === 2
    }
    expect(count('sideLean', frontal)).toBe(IN_VIEW.filter((vp) => frontal(vp) && hipsBoth(vp)).length)
    expect(count('shouldersLevel', frontal)).toBeGreaterThanOrEqual(Math.ceil(nFrontal * 0.6))
  })

  it('lateral checks are unknown (never guessed) in a true profile', () => {
    for (const vp of IN_VIEW.filter((v) => trueYaw(v) >= 85)) {
      const a = assessAt(new PoseSim(vp, { seed: OFF + 5 }), posture({ trunkRoll: 12, headRoll: 16, shrugL: 0.07 }))
      for (const id of ['sideLean', 'shouldersLevel', 'headLevel'] as const) {
        expect({ vp: vp.name, id, status: a.byId[id].status }).toEqual({ vp: vp.name, id, status: 'unknown' })
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 3. after setup, every issue at every stage magnitude is detected

interface Magnitude {
  p: Partial<PostureParams>
  expected: Stage
  /** lean direction to expect (default from trunkRoll); null = not checked (a shrug is ambiguous) */
  dir?: 'left' | 'right' | null
  /** the sub-metric this case exercises: measurable only where that one is (default: the issue) */
  sub?: SubMetricId
}
const MAGNITUDES: Record<IssueId, Magnitude[]> = {
  sink: [
    { p: { sink: 0.075 }, expected: 1 },
    { p: { sink: 0.13 }, expected: 2 },
    { p: { sink: 0.2 }, expected: 3 },
    // per sub-metric: trunk lean (trunkFwd) and torso compression (torso)
    { p: { trunkPitch: 14 }, expected: 1, sub: 'trunkFwd' },
    { p: { trunkPitch: 22 }, expected: 2, sub: 'trunkFwd' },
    { p: { slump: 0.1 }, expected: 1, sub: 'torso' },
    { p: { slump: 0.15 }, expected: 2, sub: 'torso' }
  ],
  headForward: [
    { p: { neckFlex: 14, headPitch: -14 }, expected: 1 },
    { p: { neckFlex: 23, headPitch: -23 }, expected: 2 },
    { p: { neckFlex: 35, headPitch: -35 }, expected: 3 },
    // head pitch alone
    { p: { headPitch: 20 }, expected: 1, sub: 'pitch' },
    { p: { headPitch: 30 }, expected: 2, sub: 'pitch' }
  ],
  lean: [
    { p: { trunkRoll: 8.5 }, expected: 1 },
    { p: { trunkRoll: -14 }, expected: 2 },
    { p: { trunkRoll: 21 }, expected: 3 },
    // per sub-metric: a raised shoulder, a tilted head, a bent neck
    { p: { shrugL: 0.045 }, expected: 1, dir: null, sub: 'shoulderTilt' },
    { p: { headRoll: 10 }, expected: 1, dir: 'left', sub: 'headRoll' },
    { p: { headRoll: -16 }, expected: 2, dir: 'right', sub: 'headRoll' },
    { p: { neckLat: 12 }, expected: 1, dir: 'left', sub: 'neckLat' }
  ],
  tooClose: [
    { p: { slide: 0.1 }, expected: 1 },
    { p: { slide: 0.16 }, expected: 2 },
    { p: { slide: 0.23 }, expected: 3 }
  ]
}

describe('required 3: issues are detected at the expected stage after setup', () => {
  const calibrated = IN_VIEW.map((vp, i) => {
    const sim = new PoseSim(vp, { seed: OFF + 500 + i })
    const thighSlope = thighSlopeFor(i)
    let { state, tMs, session } = runSetup(sim, posture({ thighSlope }), CONFIRMED)
    // A capture of a perfectly still user fails its stability check ~1% of the time under the
    // simulator's neck-angle noise (~8°/frame, ~10× real jitter; measured 10 of 1170 still
    // captures, independent of gravity and of the camera angle). The app then shows "Hold still
    // for a moment" and the user retries (restart()): so does this setup, once.
    if (state.phase === 'failed' && state.failReason === 'unstable') {
      session.restart()
      ;({ state, tMs } = runSetup(sim, posture({ thighSlope }), { ...CONFIRMED, session, startMs: tMs + STEP_MS }))
    }
    return { vp, sim, seed: OFF + 500 + i, baseline: state.baseline, t0: tMs + STEP_MS, thighSlope }
  })

  it('setup succeeded everywhere in view', () => {
    for (const c of calibrated) expect({ vp: c.vp.name, ok: c.baseline !== null }).toEqual({ vp: c.vp.name, ok: true })
  })

  it.each(ISSUES)('%s', (issue) => {
    let detectedViews = 0
    let measurableViews = 0
    let thresholdViews = 0
    for (const { vp, sim: setupSim, seed, baseline, t0, thighSlope } of calibrated) {
      if (!baseline) continue
      // position metrics depend on gravity: measurable when the baseline's up is close to the truth
      const gravityErr = angleDeg(baseline.up, setupSim.trueUp)
      let anyMeasurable = false
      let anyDetected = false
      let maxExpected = 0
      for (const m of MAGNITUDES[issue]) {
        // every case gets the same noise sequence (and off-frame biases) as the setup, so a
        // case's outcome does not depend on how many frames earlier cases rendered
        const sim = new PoseSim(vp, { seed })
        const engine = new PostureEngine(baseline, engineSettings())
        runEngine(engine, sim, posture({ thighSlope }), t0, t0 + 2000)
        const bad = posture({ thighSlope, ...m.p })
        runEngine(engine, sim, bad, t0 + 2000, t0 + 5000)
        // measurable = the issue had data consistently (≥ 80% of the last 3 s), not by flicker
        // at a view-angle boundary
        let availFrames = 0
        let frames = 0
        const stages: number[] = []
        const dirs: string[] = []
        for (let t = t0 + 5000; t < t0 + 8000; t += STEP_MS) {
          const snap: PostureSnapshot = engine.processFrame(sim.render(bad), t).snapshot
          frames++
          if (m.sub ? engine.subMetrics[m.sub] !== undefined : engine.availability[issue]) availFrames++
          // the sustained stage over the last 2 s (the instantaneous one may flicker by noise)
          if (t >= t0 + 6000) {
            stages.push(snap.issues[issue].stage)
            if (snap.issues[issue].direction) dirs.push(snap.issues[issue].direction as string)
          }
        }
        stages.sort((a, b) => a - b)
        const sustained = stages[stages.length >> 1]
        const avail = availFrames >= frames * 0.8
        const inViewNow = isGoodFrame(new PoseSim(vp, { noise: NO_NOISE }).render(bad))
        const positional = issue === 'sink' || issue === 'tooClose'
        const measurable = avail && inViewNow && (!positional || gravityErr <= 25)
        if (!measurable) continue
        anyMeasurable = true
        maxExpected = Math.max(maxExpected, m.expected)
        const st = sustained
        expect({ vp: vp.name, p: m.p, stage: st, ok: Math.abs(st - m.expected) <= 1 }).toMatchObject({ vp: vp.name, p: m.p, ok: true })
        if (st >= 1) anyDetected = true
        if (issue === 'lean' && st >= 1 && m.dir !== null) {
          const want = m.dir ?? ((m.p.trunkRoll as number) > 0 ? 'left' : 'right')
          const majority = dirs.filter((d) => d === want).length * 2 > dirs.length ? want : 'other'
          expect({ vp: vp.name, p: m.p, direction: majority }).toEqual({ vp: vp.name, p: m.p, direction: want })
        }
      }
      if (anyMeasurable) {
        measurableViews++
        // A view where only a stage-1 magnitude stays in frame (the larger ones leave it)
        // and the true FOV is not the assumed one: depth and the crop-ray angle are both
        // estimated with the wrong focal length, so a case placed just above the stage-1
        // threshold may read just below it (the ±1 stage check above still applies).
        // Allowed in at most one view per issue.
        const fovOff = Math.abs(setupSim.focal / focalLength(vp.aspect) - 1) > 0.05
        if (!anyDetected && maxExpected === 1 && fovOff) thresholdViews++
        else expect({ vp: vp.name, detected: anyDetected }).toEqual({ vp: vp.name, detected: true })
        if (anyDetected) detectedViews++
      }
    }
    expect(thresholdViews).toBeLessThanOrEqual(1)
    // coverage: lean needs a frontal-ish view; everything else is measurable nearly everywhere
    const minViews = issue === 'lean' ? 15 : Math.ceil(calibrated.length * 0.75)
    expect(measurableViews).toBeGreaterThanOrEqual(minViews)
    expect(detectedViews).toBe(measurableViews - thresholdViews)
  }, 30_000)

  it('lean is reported unavailable (not silently 0) in a true profile', () => {
    for (const { vp, sim, baseline, t0 } of calibrated) {
      if (!baseline || trueYaw(vp) < 85) continue
      const engine = new PostureEngine(baseline, engineSettings())
      runEngine(engine, sim, posture({ trunkRoll: 15 }), t0, t0 + 3000)
      expect({ vp: vp.name, lean: engine.availability.lean }).toEqual({ vp: vp.name, lean: false })
      expect(engine.availability.headForward).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. no false alerts in 10 simulated minutes of good posture

/** good posture with micro-motion (±3°, ±1 cm), a 30° swivel, a 40° head turn and 5 s glances down */
function goodDay(seed: number, thighSlope = 0): (tMs: number) => PostureParams {
  const rng = new Rng(seed)
  const wave = (amp: number): ((t: number) => number) => {
    const per = rng.uniform(7, 23)
    const ph = rng.uniform(0, 2 * Math.PI)
    return (t) => amp * Math.sin((2 * Math.PI * t) / per + ph)
  }
  const tp = wave(3)
  const tr = wave(3)
  const nf = wave(3)
  const hp = wave(3)
  const hr = wave(3)
  const sl = wave(0.01)
  const sk = wave(0.01)
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
      headYaw: 40 * ramp(t, 200, 201, 240, 241),
      thighSlope
    })
  }
}

describe('required 4: no false alerts over 10 simulated minutes of good posture', () => {
  it.each(IN_VIEW.map((vp, i) => ({ ...vp, seed: OFF + 700 + i, thighSlope: thighSlopeFor(i + 3) })))('$name', (vp) => {
    const sim = new PoseSim(vp, { seed: vp.seed })
    const { state, tMs } = runSetup(sim, posture({ thighSlope: vp.thighSlope }), CONFIRMED)
    expect(state.phase).toBe('done')
    const engine = new PostureEngine(state.baseline, engineSettings())
    const day = goodDay(vp.seed, vp.thighSlope)
    const t0 = tMs + STEP_MS
    const { alerts } = runEngine(engine, sim, (t) => day(t - t0), t0, t0 + 600_000)
    expect(alerts).toEqual([])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// cameras rolled past the level-mount prior (the grid's former ±5–8° rolls)

describe('cameras rolled past the level-mount prior degrade gracefully', () => {
  // the same viewpoints as the grid, with its former rolls; only those beyond UP_MAX_ROLL
  const ROLLED = viewpointGrid(ROLLED_GRID_ROLLS)
    .map((vp, k) => ({ ...vp, seed: OFF + 100 + k }))
    .filter((vp) => Math.abs(vp.roll) > UP_MAX_ROLL && inView(vp))
  const tilt2d = ([u, v]: [number, number]): number => Math.atan2(u, -v) * DEG

  it('covers them (rolls of 5–8° at every azimuth band)', () => {
    expect(ROLLED.length).toBeGreaterThanOrEqual(12)
    expect(ROLLED.some((v) => Math.abs(v.roll) === 8) && ROLLED.some((v) => Math.abs(v.roll) === 5)).toBe(true)
  })

  it.each(ROLLED)('$name: setup completes, no roll is invented, no false alerts in 10 minutes', (vp) => {
    const sim = new PoseSim(vp, { seed: vp.seed })
    const { state, tMs, phases } = runSetup(sim, good, CONFIRMED)
    // no phantom lateral coaching keeps setup from finishing: the lateral checks are lenient
    // enough or 'unknown' (a facing hip line that contradicts a level camera leaves the
    // absolute horizontal unconfirmed) — a capture runs only while every check is good
    expect(state.phase).toBe('done')
    expect(phases).toContain('capturing')
    const b = state.baseline!
    // the estimate stays level: the roll is not recovered without a cue, and never invented
    expect(Math.abs(cameraRollDeg(b.up))).toBeLessThanOrEqual(UP_MAX_ROLL)
    // the drawn true vertical is off by the camera's own roll at most (+1° perspective)
    const f = extractFeatures(sim.render(good), { up: b.up, upSource: b.upSource })!
    const drawnErr = Math.abs(tilt2d(projectUp(f, vp.aspect)) - tilt2d(projectUp({ up: sim.trueUp, anchor: f.anchor }, vp.aspect)))
    expect(drawnErr).toBeLessThanOrEqual(Math.abs(vp.roll) + 1)
    // and the engine (deviations from the baseline: a constant roll cancels) stays quiet
    const engine = new PostureEngine(b, engineSettings())
    const day = goodDay(vp.seed)
    const t0 = tMs + STEP_MS
    expect(runEngine(engine, sim, (t) => day(t - t0), t0, t0 + 600_000).alerts).toEqual([])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 5. partial view and true profile

describe('required 5: partial views still work', () => {
  it('head plus one shoulder (frame cut off): GOOD frames, setup, head-forward detection', () => {
    const vp = { azimuth: -15, elevation: 5, distance: 0.55, roll: 3, hfov: 60, aspect: 4 / 3, aim: [0.15, 0.55, 0] as Vec3 }
    const clean = new PoseSim(vp, { noise: NO_NOISE }).render(good)
    // the right shoulder and both hips are outside the picture
    expect(clean.image[12].x < 0 || clean.image[12].x > 1 || clean.image[12].y > 1).toBe(true)
    expect(clean.image[23].y > 1 || clean.image[24].y > 1).toBe(true)
    expect(isGoodFrame(clean)).toBe(true)

    const sim = new PoseSim(vp, { seed: OFF + 41 })
    const { state, tMs } = runSetup(sim, good, CONFIRMED)
    expect(state.phase).toBe('done')
    const engine = new PostureEngine(state.baseline, engineSettings())
    const t0 = tMs + STEP_MS
    runEngine(engine, sim, good, t0, t0 + 2000)
    const { alerts } = runEngine(engine, sim, posture({ neckFlex: 30, headPitch: -30 }), t0 + 2000, t0 + 18_000)
    const stages: number[] = []
    for (let t = t0 + 18_000; t < t0 + 20_000; t += STEP_MS) {
      const s = engine.processFrame(sim.render(posture({ neckFlex: 30, headPitch: -30 })), t).snapshot
      expect(s.presence).toBe('active')
      stages.push(s.issues.headForward.stage)
    }
    stages.sort((a, b) => a - b)
    expect(stages[stages.length >> 1]).toBeGreaterThanOrEqual(2)
    expect(alerts.some((a) => a.issue === 'headForward')).toBe(true)
  })

  it('true profile: GOOD frames, setup, head-forward detection, lateral unknown', () => {
    const vp = { azimuth: 90, elevation: 10, distance: 1.0, roll: 0, hfov: 70, aspect: 16 / 9 }
    const sim = new PoseSim(vp, { seed: OFF + 42 })
    const { state, tMs } = runSetup(sim, good, CONFIRMED)
    expect(state.phase).toBe('done')
    expect(state.baseline!.view.kind).toBe('side')
    expect(state.baseline!.neckLat).toBeNull()
    expect(state.assessment.byId.sideLean.status).toBe('unknown')
    expect(state.assessment.byId.headLevel.status).toBe('unknown')
    const engine = new PostureEngine(state.baseline, engineSettings())
    const t0 = tMs + STEP_MS
    runEngine(engine, sim, good, t0, t0 + 2000)
    const { snapshot, alerts } = runEngine(engine, sim, posture({ neckFlex: 30, headPitch: -30 }), t0 + 2000, t0 + 20_000)
    expect(snapshot.issues.headForward.stage).toBeGreaterThanOrEqual(2)
    expect(alerts.some((a) => a.issue === 'headForward')).toBe(true)
    expect(engine.availability.lean).toBe(false)
  })

  it('works when MediaPipe swaps the left/right labels (directions stay anatomical)', () => {
    const vp = { azimuth: 10, elevation: 15, distance: 1.4, roll: 0, hfov: 70, aspect: 16 / 9 }
    const sim = new PoseSim(vp, { seed: OFF + 43, swapLabels: true })
    const { state, tMs } = runSetup(sim, good, CONFIRMED)
    expect(state.phase).toBe('done')
    const f = extractFeatures(sim.render(posture({ trunkRoll: 12 })), {
      up: state.baseline!.up,
      upSource: state.baseline!.upSource
    })!
    expect(f.labelsSwapped).toBe(true)
    const engine = new PostureEngine(state.baseline, engineSettings())
    const t0 = tMs + STEP_MS
    const { snapshot } = runEngine(engine, sim, posture({ trunkRoll: 14 }), t0, t0 + 6000)
    expect(snapshot.issues.lean.stage).toBeGreaterThanOrEqual(1)
    expect(snapshot.issues.lean.direction).toBe('left')
  })
})

// ---------------------------------------------------------------------------
// off-centre users in a wide-FOV webcam: the model's world frame is the crop's, rotated
// against the camera by up to half the FOV (features.ts rayCorrected)

describe('off-centre user near the frame edge, wide FOV (viewing-ray correction)', () => {
  const EDGE: Array<Viewpoint> = [
    { azimuth: 0, elevation: 10, distance: 0.9, roll: 0, hfov: 90, aspect: 16 / 9, aim: [0.55, 0.35, 0], name: 'user at the left edge' },
    { azimuth: 0, elevation: 10, distance: 0.9, roll: 0, hfov: 90, aspect: 16 / 9, aim: [-0.55, 0.35, 0], name: 'user at the right edge' },
    { azimuth: 25, elevation: 20, distance: 0.8, roll: 0, hfov: 90, aspect: 16 / 9, aim: [0.4, 0.8, 0], name: 'user low in a corner' }
  ]
  const POSES: Array<Partial<PostureParams>> = [{}, { neckFlex: 20, headPitch: 10 }, { trunkPitch: 12, neckFlex: 10 }, { swivel: 20 }]
  const forwardOf = (sim: PoseSim, p: PostureParams): Vec3 => sim.toCam(skeleton(p).forward)

  it.each(EDGE)('$name: the crop ray is far off-axis but the user is in view', (vp) => {
    const sim = new PoseSim(vp, { noise: NO_NOISE })
    expect(sim.cropRotation(good)!.deg).toBeGreaterThan(20)
    expect(isGoodFrame(sim.render(good))).toBe(true)
  })

  it.each(EDGE)('$name: with the true FOV, body angles and axes match the truth', (vp) => {
    const sim = new PoseSim(vp, { noise: NO_NOISE })
    for (const q of POSES) {
      const p = posture(q)
      const t = truth(p)
      // true gravity, so any error is the world frame's own
      const f = extractFeatures(sim.render(p), { up: sim.trueUp, upSource: 'body', hfovDeg: vp.hfov })!
      expect(angleDeg(f.forward, forwardOf(sim, p))).toBeLessThan(1)
      expect(Math.abs(f.neckFwd - t.neckFwd)).toBeLessThan(1)
      if (f.trunkFwd !== null) expect(Math.abs(f.trunkFwd - t.trunkFwd)).toBeLessThan(1)
      if (f.headPitch !== null) expect(Math.abs(f.headPitch - t.headPitch)).toBeLessThan(1.5)
      if (f.trunkLat !== null) expect(Math.abs(f.trunkLat - t.trunkLat)).toBeLessThan(1)
    }
  })

  it.each(EDGE)('$name: with the assumed FOV, only the focal-length residual remains', (vp) => {
    const sim = new PoseSim(vp, { noise: NO_NOISE })
    const res = rayResidualDeg(sim)
    // the residual is a fraction of the uncorrected error (the full crop-ray angle)
    expect(res).toBeLessThan(0.5 * sim.cropRotation(good)!.deg)
    for (const q of POSES) {
      const p = posture(q)
      const t = truth(p)
      const f = extractFeatures(sim.render(p), { up: sim.trueUp, upSource: 'body' })!
      expect(angleDeg(f.forward, forwardOf(sim, p))).toBeLessThan(res + 1)
      expect(Math.abs(f.neckFwd - t.neckFwd)).toBeLessThan(res + 1)
      if (f.trunkFwd !== null) expect(Math.abs(f.trunkFwd - t.trunkFwd)).toBeLessThan(res + 1)
    }
    // thigh gravity is read in the same (corrected) frame
    const est = new UpEstimator()
    est.push(sim.render(good))
    if (est.estimate.source === 'body') expect(angleDeg(est.estimate.up, sim.trueUp)).toBeLessThan(res + 1)
  })

  it.each(EDGE.map((vp, i) => ({ ...vp, seed: OFF + 60 + i })))('$name: setup passes, good posture stays quiet, head forward alerts', (vp) => {
    const sim = new PoseSim(vp, { seed: vp.seed })
    const { state, tMs } = runSetup(sim, good, CONFIRMED)
    expect(state.phase).toBe('done')
    const engine = new PostureEngine(state.baseline, engineSettings())
    const t0 = tMs + STEP_MS
    const calm = runEngine(engine, sim, good, t0, t0 + 20_000)
    expect(calm.alerts).toEqual([])
    const { alerts } = runEngine(engine, sim, posture({ neckFlex: 30, headPitch: -30 }), t0 + 20_000, t0 + 40_000)
    expect(alerts.some((a) => a.issue === 'headForward')).toBe(true)
  })
})
