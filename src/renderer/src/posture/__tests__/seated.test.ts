// The strict posture judge (docs/specs/detection.md, "Posture judge v3"): realistic good and
// bad seated postures from the simulator, judged from every viewpoint of the grid.
//
// - Setup never accepts a bad posture (lying in the chair, slumped, a perched hunch) as good:
//   the local judge never saves one, from any camera, with or without a cloud reviewer.
// - Good postures (upright, or reclined 5–15° with the head stacked) are verified by the local
//   judge wherever the camera shows what it needs, and elsewhere wait for verification without
//   being coached wrongly.
// - The head-on-trunk angles behind the strict judge are gravity-free (exact from any camera,
//   with any gravity estimate and an unknown FOV).
// - At runtime, lying back in the chair relative to a good baseline raises Slouching.

import { describe, expect, it, vi } from 'vitest'
import { INSTRUCTIONS, assessPosture } from '../assess'
import { SetupSession, buildBaseline } from '../calibration'
import { STAGES, UNVERIFIED_FORCE_AFTER_S, UP_MAX_ROLL } from '../constants'
import { PostureEngine, computeDeviations, extractOptionsFor } from '../engine'
import { CAM_UP, extractFeatures, isGoodFrame } from '../features'
import type { PoseFrame, PostureBaseline } from '../types'
import { CONFIRMED, STEP_MS, engineSettings, runEngine, runSetup } from './harness'
import {
  BAD_SEATED,
  GOOD_SEATED,
  NOSE_DROP_DEG,
  NO_NOISE,
  PoseSim,
  ROLLED_GRID_ROLLS,
  eyesOnScreen,
  posture,
  skeleton,
  truth,
  viewpointGrid,
  type CameraParams,
  type PostureParams,
  type Viewpoint
} from './sim'

// simulator-heavy: allow for a loaded machine (parallel workers) beyond the 5 s default
vi.setConfig({ testTimeout: 120_000 })

/** stress-test with other noise draws: SIM_SEED_OFFSET=1000 npx vitest run … */
const OFF = Number(process.env.SIM_SEED_OFFSET ?? 0)
const GRID = viewpointGrid()
const inView = (vp: Viewpoint, p: PostureParams): boolean => isGoodFrame(new PoseSim(vp, { noise: NO_NOISE }).render(p))
const IN_VIEW = GRID.filter((vp) => inView(vp, posture()))
const headOnTrunkTruth = (p: PostureParams): number => truth(p).headPitch - truth(p).trunkFwd
const neckOnTrunkTruth = (p: PostureParams): number => truth(p).neckFwd - truth(p).trunkFwd

// ---------------------------------------------------------------------------
// the simulator's realistic postures

describe('simulator: realistic seated postures', () => {
  it('eyesOnScreen pitches the head so its Frankfort plane sits at the requested angle', () => {
    for (const base of [{}, { trunkPitch: -40, neckFlex: 48 }, { trunkPitch: 30, neckFlex: 10 }, { trunkPitch: -15, swivel: 25 }]) {
      for (const frankfort of [-10, 0, 8]) {
        expect(truth(eyesOnScreen(base, frankfort)).headPitch).toBeCloseTo(NOSE_DROP_DEG + frankfort, 1)
      }
    }
  })

  it('rounded shoulders move the shoulder joints forward and inward; the neck still rises from the trunk', () => {
    const a = skeleton(posture())
    const b = skeleton(posture({ shoulderRound: 0.05 }))
    expect(b.points[11][2] - a.points[11][2]).toBeCloseTo(0.05, 6)
    expect(a.points[11][0] - b.points[11][0]).toBeCloseTo(0.0175, 6)
    // the ears do not move
    expect(b.points[7]).toEqual(a.points[7])
    // …so the ears read less far ahead of the shoulders, and the trunk chord leans forward
    expect(truth(posture({ shoulderRound: 0.05 })).neckFwd).toBeLessThan(-15)
    expect(truth(posture({ shoulderRound: 0.05 })).trunkFwd).toBeGreaterThan(5)
  })

  it('the good postures are within the ergonomic reference; the bad ones clearly outside it', () => {
    for (const g of GOOD_SEATED) {
      const t = truth(g.p)
      // trunk 0–15° reclined (or leaning in ≤ 5°), ears over the shoulders, eyes on the screen
      expect({ name: g.name, ok: t.trunkFwd >= -15.01 && t.trunkFwd <= 5.01 && t.neckFwd >= -0.01 && t.neckFwd <= 8.01 }).toEqual({ name: g.name, ok: true })
      expect({ name: g.name, ok: neckOnTrunkTruth(g.p) <= 20.01 && headOnTrunkTruth(g.p) <= 33.5 && headOnTrunkTruth(g.p) >= 18.99 }).toEqual({
        name: g.name,
        ok: true
      })
    }
    for (const b of BAD_SEATED) {
      const t = truth(b.p)
      const lying = b.family === 'lying' && t.trunkFwd <= -26 && headOnTrunkTruth(b.p) >= 45
      const forward = (b.family === 'slumped' || b.family === 'hunch') && (t.trunkFwd >= 20 || neckOnTrunkTruth(b.p) >= 35)
      expect({ name: b.name, clearlyBad: lying || forward }).toEqual({ name: b.name, clearlyBad: true })
    }
    expect(new Set(BAD_SEATED.map((b) => b.family))).toEqual(new Set(['lying', 'slumped', 'hunch']))
  })
})

// ---------------------------------------------------------------------------
// gravity-free head-on-trunk angles

describe('the head-on-trunk angles are gravity-free', () => {
  const POSES = [GOOD_SEATED[0], GOOD_SEATED[7], BAD_SEATED[0], BAD_SEATED[4], BAD_SEATED[8]]

  it('match the truth from every viewpoint with the assumed FOV, whatever gravity is used', () => {
    let measured = 0
    for (const vp of IN_VIEW) {
      const sim = new PoseSim(vp, { noise: NO_NOISE })
      for (const sp of POSES) {
        const fr = sim.render(sp.p)
        // the true gravity, and the camera's own up (wrong by the camera's pitch, up to 50°)
        for (const up of [sim.trueUp, CAM_UP]) {
          const f = extractFeatures(fr, { up, upSource: 'camera' })
          if (!f || typeof f.neckOnTrunk !== 'number') continue
          measured++
          expect({ vp: vp.name, p: sp.name, err: Math.abs(f.neckOnTrunk - neckOnTrunkTruth(sp.p)) < 0.5 }).toEqual({
            vp: vp.name,
            p: sp.name,
            err: true
          })
          if (typeof f.headOnTrunk === 'number') {
            expect({ vp: vp.name, p: sp.name, err: Math.abs(f.headOnTrunk - headOnTrunkTruth(sp.p)) < 0.5 }).toEqual({
              vp: vp.name,
              p: sp.name,
              err: true
            })
          }
        }
      }
    }
    // measured from most of the grid (a hip and an ear reliably in the frame)
    expect(measured).toBeGreaterThan(IN_VIEW.length * POSES.length)
  })

  it('are not reported without a hip, or with the ears grazing the frame edge', () => {
    const noHips: CameraParams = { azimuth: -60, elevation: -20, distance: 0.8, roll: 0, hfov: 70, aspect: 16 / 9 }
    const f = extractFeatures(new PoseSim(noHips, { noise: NO_NOISE }).render(posture()))!
    expect(f.trunkFwd).toBeNull()
    expect(f.neckOnTrunk).toBeNull()
    expect(f.headOnTrunk).toBeNull()
    expect(f.vis.hipsInFrame).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// setup: bad postures are never accepted

/** Run a setup session on a fixed posture; returns every phase reached and the final state. */
function hold(vp: Viewpoint, p: PostureParams, seed: number, review: boolean | 'auto', ms = 20_000) {
  const sim = new PoseSim(vp, { seed })
  const session = new SetupSession({ now: () => 0, review })
  const phases = new Set<string>()
  let state = session.state
  for (let t = 0; t < ms && state.phase !== 'done' && state.phase !== 'reviewing'; t += STEP_MS) {
    state = session.push(sim.render(p), t)
    phases.add(state.phase)
  }
  return { phases, state }
}

describe('setup never accepts a bad posture, from any viewpoint', () => {
  it.each(BAD_SEATED.map((b, i) => ({ ...b, k: i })))('$family: $name', (bp) => {
    let coached = 0
    let views = 0
    IN_VIEW.forEach((vp, i) => {
      if (!inView(vp, bp.p)) return
      views++
      // the local judge alone: never saved
      const local = hold(vp, bp.p, OFF + 900 + 41 * bp.k + i, false)
      expect({ vp: vp.name, done: local.phases.has('done') }).toEqual({ vp: vp.name, done: false })
      expect(local.state.baseline).toBeNull()
      // with a cloud reviewer: never saved on the local judge's word ('auto' sends anything the
      // local judge cannot verify to the review — a capture it verified would end 'done')
      const auto = hold(vp, bp.p, OFF + 900 + 41 * bp.k + i, 'auto')
      expect({ vp: vp.name, done: auto.phases.has('done') }).toEqual({ vp: vp.name, done: false })
      // where the trunk (or the head) is measurable, the user is told what to change
      if (local.state.assessment.primary) coached++
    })
    expect(views).toBeGreaterThanOrEqual(IN_VIEW.length * 0.5)
    // most views coach the posture itself; the rest wait for a camera that can verify it
    expect(coached).toBeGreaterThanOrEqual(views * 0.5)
  })

  it('lying in the chair is told to sit up wherever the camera shows the head on the trunk', () => {
    for (const bp of BAD_SEATED.filter((b) => b.family === 'lying')) {
      // views where the trunk's own lean is known (thighs, near profile), and the others
      const told = { known: 0, unknown: 0 }
      const views = { known: 0, unknown: 0 }
      IN_VIEW.forEach((vp, i) => {
        const clean = extractFeatures(new PoseSim(vp, { noise: NO_NOISE }).render(bp.p))
        if (!clean || typeof clean.headOnTrunk !== 'number') return
        const { state } = hold(vp, bp.p, OFF + 1700 + i, false, 6000)
        const a = state.assessment
        const kind = a.gravity === 'strong' || a.byId.trunkUpright.basis === 'absolute' || (clean.view.opticalYawDeg >= 75 && clean.view.opticalYawDeg <= 105) ? 'known' : 'unknown'
        views[kind]++
        const c = a.byId.trunkUpright
        if (c.status === 'adjust' && c.direction === 'back' && c.instruction === INSTRUCTIONS.lying) told[kind]++
        // never judged good, whatever the instruction
        expect({ vp: vp.name, p: bp.name, good: c.status === 'good' }).toEqual({ vp: vp.name, p: bp.name, good: false })
      })
      expect(views.known).toBeGreaterThanOrEqual(10)
      expect({ name: bp.name, known: told.known >= views.known * 0.85 }).toEqual({ name: bp.name, known: true })
      // without a known trunk lean the bar is high (headOnTrunk > 48°, no false alarm on a
      // reclined good posture): the deeper lying cases are told, the mildest may get the view
      // instruction ("sit tall… can't judge your back angle") — never "good"
      const share = headOnTrunkTruth(bp.p) >= 55 ? 0.85 : headOnTrunkTruth(bp.p) >= 52 ? 0.5 : 0
      expect({ name: bp.name, unknown: told.unknown >= views.unknown * share }).toEqual({ name: bp.name, unknown: true })
    }
  })
})

describe('setup never accepts a bad posture: gravity references that are a few degrees off', () => {
  it('a camera rolled 5–8° (past the level-mount prior): practically never saved', () => {
    // a clip-on webcam mounted a little crooked: the roll leaks into the sagittal angles of an
    // angled or profile view, and the gravity estimate keeps the camera level
    const ROLLED = viewpointGrid(ROLLED_GRID_ROLLS).filter((vp) => Math.abs(vp.roll) > UP_MAX_ROLL)
    let runs = 0
    const saved: string[] = []
    BAD_SEATED.forEach((bp, k) => {
      ROLLED.forEach((vp, i) => {
        if (!inView(vp, bp.p)) return
        runs++
        if (hold(vp, bp.p, OFF + 900 + 41 * k + i, false).phases.has('done')) saved.push(`${bp.name} @ ${vp.name}`)
      })
    })
    expect(runs).toBeGreaterThanOrEqual(200)
    // without a horizontal cue, an 8° roll at an angled view can still leak ~9° into the trunk
    // reading: rare, not impossible (docs/specs/detection.md, camera roll)
    expect({ saved, rare: saved.length <= Math.max(1, Math.floor(runs * 0.01)) }).toEqual({ saved, rare: true })
  })

  it.each(
    BAD_SEATED.filter((b) => b.family !== 'lying').flatMap((b, k) => [-10, 10].map((slope) => ({ ...b, slope, k: 2 * k + (slope > 0 ? 1 : 0) })))
  )('$name on a seat with the knees $slope°: never saved', (bp) => {
    // thigh gravity assumes level thighs: a 10° slope reads every absolute sagittal angle 10° off
    const p = { ...bp.p, thighSlope: bp.slope }
    let views = 0
    IN_VIEW.forEach((vp, i) => {
      if (!inView(vp, p)) return
      views++
      const local = hold(vp, p, OFF + 5000 + 41 * bp.k + i, false)
      expect({ vp: vp.name, done: local.phases.has('done') }).toEqual({ vp: vp.name, done: false })
    })
    expect(views).toBeGreaterThanOrEqual(IN_VIEW.length * 0.5)
  })
})

// ---------------------------------------------------------------------------
// setup: good postures are verified where possible, never coached wrongly

describe('good postures are verified where the camera allows it, and never coached wrongly', () => {
  it.each(GOOD_SEATED.map((g, i) => ({ ...g, k: i })))('$family: $name', (gp) => {
    let verified = 0
    let waiting = 0
    let views = 0
    IN_VIEW.forEach((vp, i) => {
      if (!inView(vp, gp.p)) return
      views++
      const sim = new PoseSim(vp, { seed: OFF + 2500 + 37 * gp.k + i })
      const session = new SetupSession({ now: () => 0 })
      let state = session.state
      let needs = 0
      let wrong = 0
      let coaching = 0
      for (let t = 0; t < 20_000 && state.phase !== 'done'; t += STEP_MS) {
        state = session.push(sim.render(gp.p), t)
        if (state.needsVerification) needs++
        // (while 'searching' the warm-up's few frames are not acted on, nor shown as the
        // instruction; over the first seconds the gravity estimate itself still settles — a
        // steep camera's thigh gravity can be 15–20° off for a moment, as before v3)
        if (state.phase === 'searching' || t < 5000) continue
        coaching++
        const p = state.assessment.primary
        if (p && (p.id === 'trunkUpright' || p.id === 'headOverShoulders') && p.basis !== 'estimate') wrong++
      }
      if (state.phase === 'done') {
        verified++
        expect(state.baseline!.verified).toBe(true)
      } else if (needs > 0) waiting++
      // a measured essential check may flicker on the simulator's noise (~10× real jitter) at
      // the hardest views, for a few frames — never for long
      expect({ vp: vp.name, wrong: wrong <= Math.max(3, coaching * 0.04) }).toEqual({ vp: vp.name, wrong: true })
    })
    // verified wherever thigh gravity or a near profile shows the back angle: about half the grid
    expect(verified).toBeGreaterThanOrEqual(Math.min(17, views * 0.45))
    expect(verified + waiting).toBeGreaterThanOrEqual(views - 2)
  })
})

// ---------------------------------------------------------------------------
// setup session: the strict flow

describe('setup session: a posture the camera cannot verify', () => {
  // a frontal desk camera: knees under the desk → no thigh gravity; the back angle is unverifiable
  const cam: CameraParams = { azimuth: 0, elevation: 15, distance: 1.1, roll: 0, hfov: 70, aspect: 16 / 9 }
  class NoKnees extends PoseSim {
    render(q: PostureParams): PoseFrame {
      const fr = super.render(q)
      const hide = (l: (typeof fr.image)[number], i: number): typeof l => (i === 25 || i === 26 ? { ...l, visibility: 0.1 } : l)
      return { ...fr, image: fr.image.map(hide) }
    }
  }
  const good = GOOD_SEATED[0].p

  it('is never saved on its own: the session waits, says why, and offers "save anyway"', () => {
    const sim = new NoKnees(cam, { seed: OFF + 3 })
    const session = new SetupSession({ now: () => 0 })
    let firstNeeds: number | null = null
    let firstForce: number | null = null
    let st = session.state
    for (let t = 0; t < 15_000; t += STEP_MS) {
      st = session.push(sim.render(good), t)
      expect(st.phase === 'holding' || st.phase === 'capturing' || st.phase === 'done').toBe(false)
      if (st.needsVerification && firstNeeds === null) firstNeeds = t
      if (st.canForce && firstForce === null) firstForce = t
    }
    expect(firstNeeds).not.toBeNull()
    expect(st.instruction).toBe(INSTRUCTIONS.backFromFront)
    expect(st.unverifiedChecks).toEqual(['trunkUpright'])
    // "save anyway" follows shortly — not only after FORCE_AFTER_S
    expect(firstForce! - firstNeeds!).toBeGreaterThanOrEqual(UNVERIFIED_FORCE_AFTER_S * 1000 - STEP_MS)
    expect(firstForce! - firstNeeds!).toBeLessThan(UNVERIFIED_FORCE_AFTER_S * 1000 + 2000)
    // the user chooses to save it: a forced capture, saved unverified
    expect(session.force()).toBe(true)
    let t = 15_000
    for (; t < 22_000 && st.phase !== 'done'; t += STEP_MS) st = session.push(sim.render(good), t)
    expect(st.phase).toBe('done')
    expect(st.baseline!.verified).toBe(false)
    expect(st.forced).toBe(true)
  })

  it('goes to the cloud review when one is connected; the review verifies it', () => {
    for (const review of [true, 'auto'] as const) {
      const r = runSetup(new NoKnees(cam, { seed: OFF + 4 }), good, { review })
      expect(r.state.phase).toBe('reviewing')
      expect(r.state.unverifiedChecks).toEqual(['trunkUpright'])
      r.session.acceptReview()
      expect(r.session.baseline!.verified).toBe(true)
    }
  })

  it('a review that cannot run never saves it: back to coaching, "save anyway" on, no endless re-reviews', () => {
    const sim = new NoKnees(cam, { seed: OFF + 5 })
    const r = runSetup(sim, good, { review: true })
    expect(r.state.phase).toBe('reviewing')
    r.session.skipReview()
    expect(r.session.state).toMatchObject({ phase: 'coaching', canForce: true, baseline: null })
    // without a reviewer from now on: it waits instead of capturing and asking again
    const phases = new Set<string>()
    let st = r.session.state
    for (let t = r.tMs + STEP_MS; t < r.tMs + 15_000; t += STEP_MS) {
      st = r.session.push(sim.render(good), t)
      phases.add(st.phase)
    }
    expect([...phases]).toEqual(['coaching'])
    expect(st.needsVerification).toBe(true)
    expect(st.canForce).toBe(true)
    // restart() gives the reviewer another chance
    r.session.restart()
    expect(runSetup(sim, good, { session: r.session, startMs: r.tMs + 20_000 }).state.phase).toBe('reviewing')
  })

  it('a review that cannot run still saves a posture the local judge verified', () => {
    const side: CameraParams = { azimuth: 90, elevation: 10, distance: 1.0, roll: 0, hfov: 70, aspect: 16 / 9 }
    const r = runSetup(new PoseSim(side, { seed: OFF + 6 }), good, { review: true })
    expect(r.state.phase).toBe('reviewing')
    expect(r.state.unverifiedChecks).toEqual([])
    r.session.skipReview()
    expect(r.session.state.phase).toBe('done')
    expect(r.session.baseline!.verified).toBe(true)
  })
})

describe('setup session: the final exam of the captured posture', () => {
  // a profile camera (the trunk is judged absolutely). Reclined 27° with the head craned on the
  // trunk: past the strict limits (−25°, 39° head-on-trunk, 26° neck-on-trunk), inside the
  // hold's widened ones (×1.2) — the case the live window's hysteresis could let through
  const cam: CameraParams = { azimuth: 90, elevation: 10, distance: 1.0, roll: 0, hfov: 70, aspect: 16 / 9 }
  const slid = eyesOnScreen({ trunkPitch: -27, neckFlex: 27, slide: 0.06 }, 0)

  it('judges the captured average without the hold slack', () => {
    const sim = new PoseSim(cam, { seed: OFF + 31 })
    const frames = Array.from({ length: 45 }, () => sim.render(slid))
    const res = buildBaseline(frames, { verified: true, capturedAt: 0, cameraDeviceId: null })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.assessment.allGood).toBe(false)
    expect(res.assessment.byId.trunkUpright).toMatchObject({ status: 'adjust', direction: 'back' })
    // the same posture passes the live judge's widened (holding) tolerances (noise-free here: the
    // point is where the posture sits between the two)
    const clean = extractFeatures(new PoseSim(cam, { noise: NO_NOISE }).render(slid), { up: res.baseline.up, upSource: res.baseline.upSource })!
    expect(assessPosture(clean, undefined, { slack: 1.2 }).allGood).toBe(true)
    expect(assessPosture(clean).allGood).toBe(false)
  })

  it('a posture that slides down during the hold is never saved', () => {
    let saved = 0
    let captured = 0
    for (let seed = 1; seed <= 6; seed++) {
      const sim = new PoseSim(cam, { seed: OFF + 40 + seed })
      const session = new SetupSession({ now: () => 0 })
      let st = session.state
      let from: number | null = null
      for (let t = 0; t < 30_000 && st.phase !== 'done'; t += STEP_MS) {
        if (from === null && st.phase === 'holding') from = t
        // good until the hold starts, then sliding into the reclined posture within 0.3 s
        const k = from === null ? 0 : Math.min(1, (t - from) / 300)
        const p = eyesOnScreen({ trunkPitch: -27 * k, neckFlex: 27 * k, slide: 0.06 * k }, 5 * (1 - k))
        st = session.push(sim.render(p), t)
        if (st.phase === 'capturing') captured++
      }
      if (st.phase === 'done') saved++
    }
    expect(captured).toBeGreaterThan(0)
    expect(saved).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// runtime: lying back relative to a good baseline raises Slouching

describe('runtime: lying in the chair raises Slouching from every view', () => {
  const good = GOOD_SEATED[0].p
  const calibrated = IN_VIEW.map((vp, i) => {
    const sim = new PoseSim(vp, { seed: OFF + 3100 + i })
    let { state, tMs, session } = runSetup(sim, good, CONFIRMED)
    if (state.phase === 'failed' && state.failReason === 'unstable') {
      session.restart()
      ;({ state, tMs } = runSetup(sim, good, { ...CONFIRMED, session, startMs: tMs + STEP_MS }))
    }
    return { vp, seed: OFF + 3100 + i, baseline: state.baseline as PostureBaseline | null, t0: tMs + STEP_MS }
  })

  it('setup succeeded (nearly) everywhere in view', () => {
    // (a very close, steep view can keep a lateral check flickering on the simulator's noise
    // through the whole 30 s; required 3 in viewpoints.test.ts pins every view for its seeds)
    expect(calibrated.filter((c) => c.baseline !== null).length).toBeGreaterThanOrEqual(IN_VIEW.length - 2)
  })

  it.each(BAD_SEATED.filter((b) => b.family === 'lying'))('$name', (bp) => {
    let detected = 0
    let views = 0
    let severe = 0
    let reclineViews = 0
    for (const { vp, seed, baseline, t0 } of calibrated) {
      if (!baseline || !inView(vp, bp.p)) continue
      views++
      const sim = new PoseSim(vp, { seed })
      const engine = new PostureEngine(baseline, engineSettings())
      runEngine(engine, sim, good, t0, t0 + 3000)
      const { alerts } = runEngine(engine, sim, bp.p, t0 + 3000, t0 + 33_000)
      const stages: number[] = []
      let recline = 0
      for (let t = t0 + 33_000; t < t0 + 35_000; t += STEP_MS) {
        stages.push(engine.processFrame(sim.render(bp.p), t).snapshot.issues.sink.stage)
        if (engine.subMetrics.recline !== undefined) recline++
      }
      stages.sort((a, b) => a - b)
      const st = stages[stages.length >> 1]
      expect({ vp: vp.name, stage: st >= 1, alerted: alerts.some((a) => a.issue === 'sink') }).toEqual({
        vp: vp.name,
        stage: true,
        alerted: true
      })
      detected++
      if (recline > 0) {
        reclineViews++
        if (st >= 2) severe++
      }
    }
    expect(views).toBeGreaterThanOrEqual(IN_VIEW.length * 0.8)
    expect(detected).toBe(views)
    // where the trunk is visible the recline-slump metric drives it: clearly (stage ≥ 2) from
    // 35° of recline on
    expect(reclineViews).toBeGreaterThanOrEqual(20)
    if (truth(bp.p).trunkFwd <= -30) expect(severe).toBeGreaterThanOrEqual(reclineViews * 0.85)
  })

  it('the recline-slump metric needs both the recline and the neck craning on it', () => {
    const vp = IN_VIEW.find((v) => v.azimuth === 90 && v.elevation === 0)!
    const { baseline } = calibrated.find((c) => c.vp === vp)!
    const clean = new PoseSim(vp, { noise: NO_NOISE })
    const recl = (p: PostureParams): number => computeDeviations(extractFeatures(clean.render(p), extractOptionsFor(baseline!))!, baseline!).subs.recline!
    // lying 40°, eyes on the screen: about the recline itself
    expect(recl(BAD_SEATED[0].p)).toBeGreaterThan(STAGES.sink.recline[2])
    // leaning back 25° with the head going along (resting, looking up): no crane, no score
    expect(recl(eyesOnScreen({ trunkPitch: -25 }, -25))).toBeLessThan(STAGES.sink.recline[0] / 2)
    // a forward head without a recline: no score (that is head-forward)
    expect(recl(eyesOnScreen({ neckFlex: 30 }, 0))).toBeLessThan(STAGES.sink.recline[0] / 2)
    // sitting back 15° against the backrest, head stacked: below the first stage
    expect(recl(GOOD_SEATED[7].p)).toBeLessThan(STAGES.sink.recline[0])
  })

  it('leaning back to stretch for a few seconds raises no alert', () => {
    for (const { vp, seed, baseline, t0 } of calibrated.slice(0, 12)) {
      if (!baseline) continue
      const sim = new PoseSim(vp, { seed })
      const engine = new PostureEngine(baseline, engineSettings())
      // 8 s lying back with the eyes on the screen, every 40 s, for 4 minutes
      const day = (t: number): PostureParams =>
        (t - t0) % 40_000 < 8000 ? eyesOnScreen({ trunkPitch: -35, neckFlex: 40, slide: 0.1 }, 3) : good
      const { alerts } = runEngine(engine, sim, day, t0, t0 + 240_000)
      expect({ vp: vp.name, alerts: alerts.filter((a) => a.issue === 'sink').length }).toEqual({ vp: vp.name, alerts: 0 })
    }
  })

  it('older baselines without the gravity-free neck-on-trunk angle still score the recline', () => {
    const vp = IN_VIEW.find((v) => v.azimuth === 90 && v.elevation === 0)!
    const { baseline } = calibrated.find((c) => c.vp === vp)!
    const { neckOnTrunk: _n, headOnTrunk: _h, ...old } = baseline!
    expect('neckOnTrunk' in old).toBe(false)
    const clean = new PoseSim(vp, { noise: NO_NOISE })
    const f = extractFeatures(clean.render(BAD_SEATED[0].p), extractOptionsFor(old))!
    const a = computeDeviations(f, old).subs.recline!
    const b = computeDeviations(f, baseline!).subs.recline!
    expect(Math.abs(a - b)).toBeLessThan(2)
  })
})
