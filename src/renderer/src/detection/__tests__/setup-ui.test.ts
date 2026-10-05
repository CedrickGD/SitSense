import { describe, expect, it } from 'vitest'
import { CHECK_IDS } from '@renderer/posture/assess'
import { SetupSession } from '@renderer/posture/calibration'
import { runSetup } from '@renderer/posture/__tests__/harness'
import { PoseSim, posture } from '@renderer/posture/__tests__/sim'
import { extractFeatures } from '@renderer/posture/features'
import {
  IDLE_PROBE,
  NO_EXTRAS,
  PROBE_READY_MS,
  SetupProbe,
  reviewFailNote,
  setupReviewMeasurements,
  summarizeBaseline,
  toSetupUi
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
  const f = () => extractFeatures(sim.render(posture()))

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
