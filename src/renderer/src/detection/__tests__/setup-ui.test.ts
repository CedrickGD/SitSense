import { describe, expect, it } from 'vitest'
import { CHECK_IDS, INSTRUCTIONS, assessPosture } from '@renderer/posture/assess'
import { SetupSession } from '@renderer/posture/calibration'
import { extractOptionsFor } from '@renderer/posture/engine'
import { extractFeatures } from '@renderer/posture/features'
import type { PoseFrame } from '@renderer/posture/types'
import { STEP_MS, runSetup } from '@renderer/posture/__tests__/harness'
import { GOOD_SEATED, PoseSim, posture, type CameraParams, type PostureParams } from '@renderer/posture/__tests__/sim'
import { cameraFix, guideFocus, verificationBadge } from '@renderer/screens/setup/copy'
import {
  IDLE_PROBE,
  NO_EXTRAS,
  PROBE_READY_MS,
  SetupProbe,
  SetupViewTracker,
  VIEW_KIND_HYST_DEG,
  nextViewKind,
  reviewFailNote,
  reviewOutcome,
  setupReviewMeasurements,
  summarizeBaseline,
  toSetupUi,
  viewAllowsBackCheck,
  viewFixOf,
  type SetupProbeState
} from '../setup-ui'

const sideSim = (): PoseSim =>
  new PoseSim({ azimuth: 80, elevation: 10, distance: 1.2, roll: 0, hfov: 65, aspect: 16 / 9 }, { seed: 7 })

describe('toSetupUi', () => {
  it('maps a fresh session to searching with every check listed', () => {
    const ui = toSetupUi(new SetupSession().state, NO_EXTRAS)
    expect(ui.phase).toBe('searching')
    expect(ui.checks.map((c) => c.id)).toEqual([...CHECK_IDS])
    expect(ui.view).toBeNull()
    expect(ui.instruction).toMatch(/head and at least one shoulder/)
    expect(ui.baselineSummary).toBeNull()
    expect(ui.reviewing).toBeNull()
  })

  it('reaches done with a baseline summary from a side camera', () => {
    const { state } = runSetup(sideSim(), posture())
    expect(state.phase).toBe('done')
    const summary = summarizeBaseline(state.baseline!, state.forced)
    const ui = toSetupUi(state, { ...NO_EXTRAS, baselineSummary: summary })
    expect(ui.phase).toBe('done')
    expect(ui.holdProgress).toBe(1)
    expect(ui.captureProgress).toBe(1)
    expect(ui.baselineSummary?.view).toBe('side')
    expect(Math.abs(ui.baselineSummary!.neckFwdDeg)).toBeLessThan(15)
  })

  it('stops in reviewing with review on and shows the reviewer only there', () => {
    const { state } = runSetup(sideSim(), posture(), { review: true })
    expect(state.phase).toBe('reviewing')
    const ui = toSetupUi(state, { ...NO_EXTRAS, reviewing: { label: 'Gemini' } })
    expect(ui.reviewing).toEqual({ label: 'Gemini' })
    expect(ui.instruction).toBeNull()
  })

  it('counts a reviewer rejection and coaches again', () => {
    const { session } = runSetup(sideSim(), posture(), { review: true })
    session.rejectReview('Sit back against the chair.')
    const ui = toSetupUi(session.state, NO_EXTRAS)
    expect(ui.phase).toBe('coaching')
    expect(ui.reviewRejections).toBe(1)
    expect(ui.reviewing).toBeNull()
  })
})

describe('toSetupUi — strict judge', () => {
  it('maps needsVerification (false for a fresh session)', () => {
    expect(toSetupUi(new SetupSession().state, NO_EXTRAS).needsVerification).toBe(false)
  })
})

describe('setup review request', () => {
  const base = {
    view: 'front' as const,
    neckFwdDeg: 5,
    trunkFwdDeg: null,
    headPitchDeg: null,
    shoulderTiltDeg: null,
    headRollDeg: null,
    trunkLatDeg: null,
    localVerdict: 'good' as const,
    localInstruction: null
  }
  it('a verified capture goes as "good"', () => {
    expect(setupReviewMeasurements(base, [])).toEqual(base)
  })
  it('an unverified one asks the model to judge exactly that, and to say adjust when unsure', () => {
    const m = setupReviewMeasurements(base, ['trunkUpright'])
    expect(m.localVerdict).toBe('adjust')
    expect(m.localInstruction).toMatch(/back angle \(slumped, reclined or lying in the chair\?\)/)
    expect(m.localInstruction).toMatch(/answer adjust if unsure/)
    expect(m.localInstruction!.length).toBeLessThanOrEqual(200)
    expect(setupReviewMeasurements(base, ['trunkUpright', 'headOverShoulders']).localInstruction!.length).toBeLessThanOrEqual(200)
  })
  it('an unreachable reviewer never sounds like a pass for an unverified capture', () => {
    expect(reviewFailNote('Google Gemini', 'timeout', ['trunkUpright'])).toBe("Couldn't reach Google Gemini — I still can't check your back.")
    expect(reviewFailNote('Google Gemini', 'timeout', [])).toMatch(/used on-device judgment/)
  })
})

describe('SetupProbe (step 1 camera check)', () => {
  const sim = sideSim()
  const f = () => sim.render(posture())

  it('is idle before any frame and after frames stop', () => {
    const p = new SetupProbe()
    expect(p.state(0)).toEqual(IDLE_PROBE)
    p.push(f(), 0)
    expect(p.state(5000)).toEqual(IDLE_PROBE)
  })

  it('sees a side-view user with hips, and is ready after 1 s in view', () => {
    const p = new SetupProbe()
    let st = p.push(f(), 0)
    expect(st.inView).toBe(true)
    expect(st.ready).toBe(false)
    for (let t = 100; t <= PROBE_READY_MS; t += 100) st = p.push(f(), t)
    expect(st).toMatchObject({ frames: true, inView: true, ready: true, view: 'side', hips: 'seen', backCheckable: true })
  })

  it('drops out of view after a run of empty frames and must be ready again', () => {
    const p = new SetupProbe()
    for (let t = 0; t <= 1200; t += 100) p.push(f(), t)
    let st = p.push(null, 1300)
    for (let t = 1400; t <= 2000; t += 100) st = p.push(null, t)
    expect(st).toMatchObject({ frames: true, inView: false, ready: false, view: null })
    st = p.push(f(), 2100)
    st = p.push(f(), 2200)
    expect(st.ready).toBe(false)
  })
})

// ───────────────────────────── review findings (regressions) ─────────────────────────────

const OFF_SEED = Number(process.env.SIM_SEED_OFFSET ?? 0)
/** a frontal desk camera with the knees under the desk: hips seen, back angle unverifiable */
const FRONT_CAM: CameraParams = { azimuth: 0, elevation: 15, distance: 1.1, roll: 0, hfov: 70, aspect: 16 / 9 }
const SIDE_CAM: CameraParams = { azimuth: 80, elevation: 10, distance: 1.2, roll: 0, hfov: 65, aspect: 16 / 9 }
class NoKnees extends PoseSim {
  render(q: PostureParams): PoseFrame {
    const fr = super.render(q)
    return { ...fr, image: fr.image.map((l, i) => (i === 25 || i === 26 ? { ...l, visibility: 0.1 } : l)) }
  }
}
const GOOD = GOOD_SEATED[0].p

function probeFor(sim: PoseSim, ms = 2000): SetupProbeState {
  const p = new SetupProbe()
  let st = p.state(0)
  for (let t = 0; t <= ms; t += STEP_MS) st = p.push(sim.render(GOOD), t)
  return st
}

describe('step 1 measures like step 2, never with the saved baseline', () => {
  // the controller used to feed the probe the engine's features, measured with the saved
  // baseline's gravity and hip setting (extractOptionsFor) — wrong once the camera moved
  const savedSide = runSetup(new PoseSim(SIDE_CAM, { seed: 9 }), GOOD).state.baseline!

  it('a baseline saved without hips (trunkFwd null) does not hide the hips now in view', () => {
    const sim = new NoKnees(FRONT_CAM, { seed: 3 })
    // the old path: the baseline's hip setting drops the hips
    const old = extractFeatures(sim.render(GOOD), extractOptionsFor({ ...savedSide, trunkFwd: null }))
    expect(old?.vis.hips).toBe(0)
    // the probe sees them, as a fresh setup session does
    const probe = probeFor(sim)
    expect(probe).toMatchObject({ inView: true, hips: 'seen' })
    const session = new SetupSession()
    let st = session.state
    for (let t = 0; t <= 2000; t += STEP_MS) st = session.push(sim.render(GOOD), t)
    expect(st.features!.vis.hips).toBeGreaterThan(0)
    expect(probe.backCheckable).toBe(!st.assessment.unverified.includes('trunkUpright'))
  })

  it('a thigh-gravity baseline does not make a frontal view look like full tracking', () => {
    expect(savedSide.upSource).toBe('body')
    const sim = new NoKnees(FRONT_CAM, { seed: 4 })
    // the old path: the baseline's thigh gravity judged the trunk absolutely from the front
    const old = extractFeatures(sim.render(GOOD), extractOptionsFor(savedSide))
    expect(assessPosture(old!).unverified).not.toContain('trunkUpright')
    expect(probeFor(sim)).toMatchObject({ view: 'front', hips: 'seen', backCheckable: false })
  })

  it('reset() forgets the gravity estimate too', () => {
    const p = new SetupProbe()
    const side = new PoseSim(SIDE_CAM, { seed: 5 })
    for (let t = 0; t <= 1500; t += STEP_MS) p.push(side.render(GOOD), t)
    p.reset()
    const front = new NoKnees(FRONT_CAM, { seed: 5 })
    let st = p.state(0)
    for (let t = 2000; t <= 4000; t += STEP_MS) st = p.push(front.render(GOOD), t)
    expect(st).toMatchObject({ view: 'front', backCheckable: false })
  })
})

describe('the back check is a property of the view', () => {
  it('an angled side camera (≈65°) without thigh gravity cannot check the back', () => {
    expect(probeFor(new NoKnees({ ...SIDE_CAM, azimuth: 65 }, { seed: 3 }))).toMatchObject({ hips: 'seen', backCheckable: false })
  })
  it('two readings that disagree (leaning in) leave the view checkable', () => {
    const a = (viewInstruction: string): Parameters<typeof viewAllowsBackCheck>[0] =>
      ({ unverified: ['trunkUpright'], byId: { trunkUpright: { viewInstruction } } }) as never
    expect(viewAllowsBackCheck(a(INSTRUCTIONS.sitBackLookAhead))).toBe(true)
    expect(viewAllowsBackCheck(a(INSTRUCTIONS.backFromFront))).toBe(false)
    expect(viewAllowsBackCheck(a(INSTRUCTIONS.hipsHidden))).toBe(false)
  })
})

describe('step 2 says why the back cannot be verified (viewFix)', () => {
  const coach = (sim: PoseSim): ReturnType<typeof toSetupUi> => toSetupUi(runSetup(sim, GOOD, { maxMs: 6000 }).state, NO_EXTRAS)
  it("hips seen from the front: the camera angle — the Target card doesn't ask for the hips", () => {
    const ui = coach(new NoKnees(FRONT_CAM, { seed: 6 }))
    expect(ui.viewFix).toBe('angle')
    expect(guideFocus(ui)).toBe('verify')
    expect(cameraFix(ui)).toBe('front')
  })
  it('hips under a desk: the hips', () => {
    const ui = coach(new PoseSim(FRONT_CAM, { seed: 6, deskOcclusion: true }))
    expect(ui.viewFix).toBe('hips')
    expect(guideFocus(ui)).toBe('hips')
  })
  it('a verified side view: nothing to fix', () => {
    const { state } = runSetup(new PoseSim(SIDE_CAM, { seed: 6 }), GOOD, { review: true })
    expect(toSetupUi(state, NO_EXTRAS).viewFix).toBeNull()
  })
  it("maps every one of the judge's view instructions to its own fix", () => {
    const a = (viewInstruction: string): Parameters<typeof viewFixOf>[0] => ({ unverified: ['trunkUpright'], viewInstruction }) as never
    const hipsSeen = { vis: { hips: 1 } } as never
    expect(viewFixOf(a(INSTRUCTIONS.backFromAngle), null)).toBe('angle')
    expect(viewFixOf(a(INSTRUCTIONS.backFromFront), null)).toBe('angle')
    expect(viewFixOf(a(INSTRUCTIONS.showHipsForHead), hipsSeen)).toBe('hips')
    // a rolled camera is its own camera fix, not "turn the camera"
    expect(viewFixOf(a(INSTRUCTIONS.levelCamera), hipsSeen)).toBe('level')
    // the head a little past the limit is a posture fix, never "can't judge your back"
    expect(viewFixOf(a(INSTRUCTIONS.headForward), hipsSeen)).toBe('head')
    expect(viewFixOf({ unverified: [], viewInstruction: null } as never, hipsSeen)).toBeNull()
  })
})

describe('the Saved badge names who verified what', () => {
  const res = { ok: true as const, connectionLabel: 'Gemini', model: 'm', verdict: 'good' as const, score: 90, summary: 's', instructions: [] }
  const saved = (sim: PoseSim): string | undefined => {
    const { session, state } = runSetup(sim, GOOD, { review: true })
    expect(state.phase).toBe('reviewing')
    // as the controller does: the verdict records the reviewing state's unverified checks
    const outcome = reviewOutcome(res, state)
    session.acceptReview()
    const done = session.state
    const ui = toSetupUi(done, { ...NO_EXTRAS, reviewResult: outcome, baselineSummary: summarizeBaseline(done.baseline!, done.forced) })
    return verificationBadge(ui)?.text
  }
  it('the on-device judge could not verify it: the model alone', () => {
    expect(saved(new NoKnees(FRONT_CAM, { seed: OFF_SEED + 4 }))).toBe('Verified by Gemini')
  })
  it('the on-device judge verified it too: both', () => {
    expect(saved(new PoseSim(SIDE_CAM, { seed: 7 }))).toBe('Verified by on-device AI and Gemini')
  })
})

describe('step 2 camera view chip', () => {
  it('nextViewKind needs a boundary crossed by VIEW_KIND_HYST_DEG', () => {
    expect(nextViewKind(null, 26)).toBe('angled')
    expect(nextViewKind('front', 26)).toBe('front')
    expect(nextViewKind('front', 25 + VIEW_KIND_HYST_DEG)).toBe('angled')
    expect(nextViewKind('angled', 23)).toBe('angled')
    expect(nextViewKind('angled', 25 - VIEW_KIND_HYST_DEG - 0.1)).toBe('front')
    expect(nextViewKind('side', 58)).toBe('side')
    expect(nextViewKind('angled', 62)).toBe('angled')
    expect(nextViewKind('angled', 60 + VIEW_KIND_HYST_DEG)).toBe('side')
    expect(nextViewKind('side', 10)).toBe('front')
  })

  it('does not flicker for a camera right at the front/angled or angled/side boundary', () => {
    for (const azimuth of [26, 62]) {
      for (const seed of [1, 2, 3]) {
        const sim = new PoseSim({ azimuth, elevation: 10, distance: 1.1, roll: 0, hfov: 70, aspect: 16 / 9 }, { seed })
        const session = new SetupSession()
        const tracker = new SetupViewTracker()
        let raw = 0
        let smooth = 0
        let lastRaw: unknown
        let lastSmooth: unknown
        for (let t = 0; t < 20_000; t += STEP_MS) {
          const st = session.push(sim.render(GOOD), t)
          const r = toSetupUi(st, NO_EXTRAS).view
          const s = toSetupUi(st, NO_EXTRAS, tracker.push(st, t)).view
          if (lastRaw !== undefined && r !== lastRaw) raw++
          if (lastSmooth !== undefined && s !== lastSmooth) smooth++
          lastRaw = r
          lastSmooth = s
        }
        // the per-frame kind flickers on the simulator's noise (~10× real jitter)
        expect(raw).toBeGreaterThan(20)
        expect({ azimuth, seed, smooth: smooth <= 2 }).toEqual({ azimuth, seed, smooth: true })
      }
    }
  })

  it('is null out of view and forgets the old view', () => {
    const tracker = new SetupViewTracker()
    const session = new SetupSession()
    const sim = new PoseSim(SIDE_CAM, { seed: 2 })
    let t = 0
    for (; t < 2000; t += STEP_MS) tracker.push(session.push(sim.render(GOOD), t), t)
    expect(tracker.view).toBe('side')
    for (; t < 4000; t += STEP_MS) tracker.push(session.push(null, t), t)
    expect(tracker.view).toBeNull()
  })
})
