import { describe, expect, it } from 'vitest'
import { isCurrentBaseline } from '@shared/posture'
import { INSTRUCTIONS } from '../assess'
import { FAIL_MESSAGES, SetupSession, buildBaseline, medianFeatures, type SetupState } from '../calibration'
import { FORCE_AFTER_S, REVIEW_MAX_AUTO, REVIEW_REJECTS_FOR_FORCE, REVIEW_RETRY_S } from '../constants'
import { extractFeatures } from '../features'
import type { Frame } from '../types'
import { STEP_MS, runSetup } from './harness'
import { PoseSim, posture, type CameraParams, type PostureParams } from './sim'

const CAM: CameraParams = { azimuth: 10, elevation: 15, distance: 2.0, roll: 2, hfov: 70, aspect: 16 / 9 }
const good = posture()
const headForward = posture({ neckFlex: 35, headPitch: -35 })

type Step = PostureParams | null | ((t: number) => PostureParams | null)

/** Drive a session through a script of [durationMs, posture] segments; returns every state. */
function drive(session: SetupSession, sim: PoseSim, script: Array<[number, Step]>, startMs = 0): { states: SetupState[]; t: number } {
  const states: SetupState[] = []
  let t = startMs
  for (const [dur, step] of script) {
    const end = t + dur
    for (; t < end; t += STEP_MS) {
      const p = typeof step === 'function' ? step(t) : step
      const frame: Frame = p === null ? null : sim.render(p)
      states.push(session.push(frame, t))
    }
  }
  return { states, t }
}
const phasesOf = (states: SetupState[]): string[] =>
  states.map((s) => s.phase).filter((p, i, a) => i === 0 || a[i - 1] !== p)
/** phases after the start-up prefix (warm-up 'searching', and a brief 'coaching' while estimates settle) */
const settledPhases = (states: SetupState[]): string[] => {
  const p = phasesOf(states)
  if (p[0] === 'searching') p.shift()
  if (p[0] === 'coaching' && p[1] === 'holding') p.shift()
  return p
}

describe('SetupSession — happy path', () => {
  it('searching → holding → capturing → done, and builds a v2 baseline', () => {
    const sim = new PoseSim(CAM, { seed: 1 })
    const session = new SetupSession({ now: () => 1234, cameraDeviceId: 'cam-1' })
    expect(session.state.phase).toBe('searching')
    expect(session.state.instruction).toBe(INSTRUCTIONS.inView)
    const { states } = drive(session, sim, [
      [1000, null],
      [8000, good]
    ])
    expect(phasesOf(states)[0]).toBe('searching')
    expect(settledPhases(states)).toEqual(['holding', 'capturing', 'done'])
    // progress is monotonic and completes
    const hold = states.filter((s) => s.phase === 'holding').map((s) => s.holdProgress)
    const cap = states.filter((s) => s.phase === 'capturing').map((s) => s.captureProgress)
    expect(hold.every((v, i) => i === 0 || v >= hold[i - 1])).toBe(true)
    expect(cap.every((v, i) => i === 0 || v >= cap[i - 1])).toBe(true)
    const done = states[states.length - 1]
    expect(done.holdProgress).toBe(1)
    expect(done.captureProgress).toBe(1)
    const b = session.baseline!
    expect(isCurrentBaseline(b)).toBe(true)
    expect(b).toMatchObject({ version: 2, capturedAt: 1234, cameraDeviceId: 'cam-1', verified: true })
    expect(done.baseline).toBe(b)
    expect(Math.abs(b.neckFwd)).toBeLessThan(6)
    expect(b.view.kind).toBe('front')
    expect(b.neckH).not.toBeNull()
  })

  it('coaches first when the posture is not good, then captures once it is', () => {
    const sim = new PoseSim(CAM, { seed: 2 })
    const session = new SetupSession({ now: () => 0 })
    const { states } = drive(session, sim, [
      [3000, headForward],
      [8000, good]
    ])
    const coaching = states.filter((s) => s.phase === 'coaching')
    expect(coaching.length).toBeGreaterThan(10)
    expect(coaching[coaching.length - 1].instruction).toBe(INSTRUCTIONS.headForward)
    expect(coaching[coaching.length - 1].assessment.primary?.id).toBe('headOverShoulders')
    expect(states[states.length - 1].phase).toBe('done')
  })
})

describe('SetupSession — breaking a hold or capture', () => {
  it('a brief wobble (< 0.7 s) does not break the hold', () => {
    const sim = new PoseSim(CAM, { seed: 3 })
    const session = new SetupSession({ now: () => 0 })
    const { states } = drive(session, sim, [
      [700, good],
      [300, headForward],
      [8000, good]
    ])
    expect(settledPhases(states)).toEqual(['holding', 'capturing', 'done'])
  })

  it('an adjust lasting > 0.7 s during holding goes back to coaching', () => {
    const sim = new PoseSim(CAM, { seed: 4 })
    const session = new SetupSession({ now: () => 0 })
    const { states } = drive(session, sim, [
      [800, good],
      [2500, headForward]
    ])
    expect(settledPhases(states)).toEqual(['holding', 'coaching'])
    expect(states[states.length - 1].holdProgress).toBe(0)
  })

  it('an adjust lasting > 0.7 s during capturing discards the capture', () => {
    const sim = new PoseSim(CAM, { seed: 5 })
    const session = new SetupSession({ now: () => 0 })
    const { states } = drive(session, sim, [
      [2500, good],
      [2500, headForward]
    ])
    expect(settledPhases(states)).toEqual(['holding', 'capturing', 'coaching'])
    const last = states[states.length - 1]
    expect(last.captureProgress).toBe(0)
    expect(last.baseline).toBeNull()
  })

  it('losing the user for > 1 s goes back to searching; a shorter dropout is tolerated', () => {
    const sim = new PoseSim(CAM, { seed: 7 }) // (seed 6 draws a ~1% head-roll noise burst that briefly coaches during the hold)
    const a = new SetupSession({ now: () => 0 })
    const short = drive(a, sim, [
      [2000, good],
      [600, null],
      [6000, good]
    ])
    expect(settledPhases(short.states)).toEqual(['holding', 'capturing', 'done'])

    const b = new SetupSession({ now: () => 0 })
    const long = drive(b, sim, [
      [2000, good],
      [1500, null]
    ])
    expect(settledPhases(long.states)).toEqual(['holding', 'capturing', 'searching'])
    expect(long.states[long.states.length - 1].instruction).toBe(INSTRUCTIONS.inView)
  })
})

describe('SetupSession — force', () => {
  it('is offered after 20 s of coaching and saves an unverified baseline (no review)', () => {
    const sim = new PoseSim(CAM, { seed: 7 })
    const session = new SetupSession({ now: () => 0, review: true })
    const { states, t } = drive(session, sim, [[(FORCE_AFTER_S - 2) * 1000, headForward]])
    expect(states[states.length - 1].canForce).toBe(false)
    expect(session.force()).toBe(false)
    const more = drive(session, sim, [[3000, headForward]], t)
    expect(more.states[more.states.length - 1].canForce).toBe(true)
    expect(session.force()).toBe(true)
    expect(session.state.phase).toBe('capturing')
    expect(session.state.forced).toBe(true)
    // the forced capture runs on the bad posture without breaking, and skips the review
    const fin = drive(session, sim, [[4000, headForward]], more.t)
    const last = fin.states[fin.states.length - 1]
    expect(last.phase).toBe('done')
    expect(session.baseline?.verified).toBe(false)
  })
})

describe('SetupSession — external review hook', () => {
  it('stops in reviewing with a pending baseline; accept → done', () => {
    const sim = new PoseSim(CAM, { seed: 8 })
    const session = new SetupSession({ now: () => 0, review: true })
    const { state } = runSetup(sim, good, { session })
    expect(state.phase).toBe('reviewing')
    expect(session.pendingBaseline).not.toBeNull()
    expect(session.baseline).toBeNull()
    expect(state.baseline).toBe(session.pendingBaseline)
    // frames keep the live assessment fresh but do not change the phase
    const pending = session.pendingBaseline
    session.push(sim.render(good), 99_000)
    expect(session.state.phase).toBe('reviewing')
    session.acceptReview()
    expect(session.state.phase).toBe('done')
    expect(session.baseline).toBe(pending)
    expect(session.baseline?.verified).toBe(true)
  })

  it('reject → coaching with the reviewer’s instruction; two rejections offer force', () => {
    const sim = new PoseSim(CAM, { seed: 9 })
    const session = new SetupSession({ now: () => 0, review: true })
    let r = runSetup(sim, good, { session })
    expect(r.state.phase).toBe('reviewing')
    session.rejectReview('Sit back so your shoulders touch the chair.')
    expect(session.state).toMatchObject({
      phase: 'coaching',
      reviewRejections: 1,
      reviewInstruction: 'Sit back so your shoulders touch the chair.',
      instruction: 'Sit back so your shoulders touch the chair.',
      baseline: null,
      canForce: false
    })
    r = runSetup(sim, good, { session, startMs: r.tMs + STEP_MS })
    expect(r.state.phase).toBe('reviewing')
    session.rejectReview('Still slouching.')
    expect(session.state.reviewRejections).toBe(2)
    expect(session.state.canForce).toBe(true)
    expect(session.force()).toBe(true)
    r = runSetup(sim, good, { session, startMs: r.tMs + STEP_MS })
    expect(r.state.phase).toBe('done')
    expect(session.baseline?.verified).toBe(false)
  })

  it('review calls are ignored outside the reviewing phase', () => {
    const session = new SetupSession({ review: true })
    session.acceptReview()
    session.rejectReview('x')
    expect(session.state.phase).toBe('searching')
    expect(session.state.reviewRejections).toBe(0)
  })
})

describe('SetupSession — failures and restart', () => {
  it("fails 'unstable' when the user keeps moving during the capture, then restarts", () => {
    const sim = new PoseSim(CAM, { seed: 10 })
    const session = new SetupSession({ now: () => 0 })
    // bobbing up and down ±3.5 cm with a ~2 s period: every moment is still judged good
    const sway = (t: number): PostureParams => posture({ sink: 0.035 * Math.sin(t / 300) })
    const { states } = drive(session, sim, [[9000, sway]])
    const last = states[states.length - 1]
    expect(last.phase).toBe('failed')
    expect(last.failReason).toBe('unstable')
    expect(last.instruction).toBe(FAIL_MESSAGES.unstable)
    // stays failed until restart()
    session.push(sim.render(good), 20_000)
    expect(session.state.phase).toBe('failed')
    session.restart()
    expect(session.state.phase).toBe('searching')
    expect(session.state.failReason).toBeNull()
    const again = runSetup(sim, good, { session, startMs: 30_000 })
    expect(again.state.phase).toBe('done')
  })

  it("fails 'lost' when too few GOOD frames arrive during the capture", () => {
    const sim = new PoseSim(CAM, { seed: 11 })
    const session = new SetupSession({ now: () => 0 })
    let t = 0
    let state = session.state
    for (; state.phase !== 'capturing' && t < 10_000; t += STEP_MS) state = session.push(sim.render(good), t)
    expect(state.phase).toBe('capturing')
    // then 4 fps with every other frame lost: 2 GOOD frames per second, never > 1 s out of view
    for (let i = 0; i < 60 && state.phase !== 'failed' && state.phase !== 'done'; i++, t += 250) {
      state = session.push(i % 2 === 0 ? sim.render(good) : null, t)
    }
    expect(state.phase).toBe('failed')
    expect(state.failReason).toBe('lost')
  })
})

describe('buildBaseline', () => {
  it('stores nulls for what a profile camera cannot see', () => {
    const sim = new PoseSim({ azimuth: 90, elevation: 10, distance: 1.2, roll: 0, hfov: 65, aspect: 16 / 9 }, { seed: 12 })
    const frames = Array.from({ length: 30 }, () => sim.render(good))
    const r = buildBaseline(frames, { verified: true, capturedAt: 0, cameraDeviceId: null })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.baseline.view.kind).toBe('side')
    expect(r.baseline.neckLat).toBeNull()
    expect(r.baseline.trunkLat).toBeNull()
    expect(r.baseline.shoulderTilt).toBeNull()
    expect(r.baseline.neckH).toBeNull()
    expect(r.baseline.trunkFwd).not.toBeNull()
  })

  it("is 'lost' with fewer than 15 GOOD frames", () => {
    const sim = new PoseSim(CAM, { seed: 13 })
    const frames: Frame[] = [...Array.from({ length: 10 }, () => sim.render(good)), null, null]
    expect(buildBaseline(frames, { verified: true, capturedAt: 0, cameraDeviceId: null })).toEqual({ ok: false, reason: 'lost' })
  })
})

describe('medianFeatures', () => {
  it('takes medians and drops features seen in fewer than half the frames', () => {
    const sim = new PoseSim(CAM, { seed: 14 })
    const fs = Array.from({ length: 5 }, (_, i) => extractFeatures(sim.render(posture({ neckFlex: i * 2 })))!)
    fs[0] = { ...fs[0], trunkLat: null }
    fs[1] = { ...fs[1], headPitch: null }
    fs[2] = { ...fs[2], headPitch: null }
    fs[3] = { ...fs[3], headPitch: null }
    const m = medianFeatures(fs)
    expect(m.neckFwd).toBeCloseTo([...fs.map((f) => f.neckFwd)].sort((a, b) => a - b)[2], 6)
    expect(m.trunkLat).not.toBeNull()
    expect(m.headPitch).toBeNull()
  })
})

describe('SetupSession — low frame rates', () => {
  it.each([3, 3.5, 3.75])('finishes at %d fps (the warm-up counts frames since the user came into view)', (fps) => {
    const sim = new PoseSim({ azimuth: 15, elevation: 15, distance: 1.6, roll: 0, hfov: 70, aspect: 16 / 9 }, { seed: 1 })
    const session = new SetupSession({ now: () => 0 })
    let st = session.state
    for (let t = 0; t < 30_000 && st.phase !== 'done' && st.phase !== 'failed'; t += 1000 / fps) st = session.push(sim.render(good), t)
    expect(st.phase).toBe('done')
  })
})

describe('SetupSession — a short wobble during the capture', () => {
  it.each([600, 900, 1300])('a %d ms excursion never ends in a terminal failure', (ms) => {
    for (const seed of [1, 2, 3]) {
      const sim = new PoseSim({ azimuth: 15, elevation: 15, distance: 1.6, roll: 0, hfov: 70, aspect: 16 / 9 }, { seed })
      const session = new SetupSession({ now: () => 0 })
      let t = 0
      let st = session.state
      for (; st.phase !== 'capturing' && t < 20_000; t += STEP_MS) st = session.push(sim.render(good), t)
      expect(st.phase).toBe('capturing')
      const { states } = drive(
        session,
        sim,
        [
          [1000, good],
          [ms, headForward],
          [15_000, good]
        ],
        t
      )
      expect({ seed, phases: phasesOf(states).includes('failed'), last: states[states.length - 1].phase }).toEqual({
        seed,
        phases: false,
        last: 'done'
      })
    }
  })

  it('a forced capture that keeps moving still fails unstable (nothing is tolerated there)', () => {
    const sim = new PoseSim(CAM, { seed: 7 })
    const session = new SetupSession({ now: () => 0 })
    const { t } = drive(session, sim, [[(FORCE_AFTER_S + 1) * 1000, headForward]])
    expect(session.force()).toBe(true)
    const sway = (tt: number): PostureParams => posture({ neckFlex: 35, headPitch: -35, sink: 0.04 * Math.sin(tt / 250) })
    const { states } = drive(session, sim, [[8000, sway]], t)
    expect(states[states.length - 1]).toMatchObject({ phase: 'failed', failReason: 'unstable' })
  })

  it('a neck that keeps moving fails the stability check (each moment judged good)', () => {
    const sim = new PoseSim(CAM, { seed: 12 })
    const session = new SetupSession({ now: () => 0 })
    const nod = (tt: number): PostureParams => posture({ neckFlex: 9 * Math.sin(tt / 250), headPitch: -9 * Math.sin(tt / 250) })
    const { states } = drive(session, sim, [[12_000, nod]])
    expect(states[states.length - 1]).toMatchObject({ phase: 'failed', failReason: 'unstable' })
  })
})

describe('SetupSession — repeated review rejections', () => {
  it('force stays reachable, re-reviews wait for the user, and automatic re-reviews stop after REVIEW_MAX_AUTO', () => {
    const sim = new PoseSim(CAM, { seed: 9 })
    const session = new SetupSession({ now: () => 0, review: true })
    let t = 0
    let reviews = 0
    let reviewingSince: number | null = null
    let lastReject = -Infinity
    let firstHoldAfterReject = Infinity
    const forceable: boolean[] = []
    // the reviewer takes 3 s and always rejects; the user keeps the same (locally good) posture
    for (; t < 90_000; t += STEP_MS) {
      const st = session.push(sim.render(good), t)
      if (st.phase === 'holding' && lastReject > -Infinity && firstHoldAfterReject === Infinity) firstHoldAfterReject = t - lastReject
      if (session.state.reviewRejections >= REVIEW_REJECTS_FOR_FORCE) forceable.push(session.state.canForce)
      if (st.phase === 'reviewing') {
        if (reviewingSince === null) {
          reviewingSince = t
          reviews++
        } else if (t - reviewingSince >= 3000) {
          session.rejectReview('Sit back so your shoulders touch the chair.')
          reviewingSince = null
          lastReject = t
        }
      }
    }
    // after a rejection, at least REVIEW_RETRY_S of coaching before the next hold
    expect(firstHoldAfterReject).toBeGreaterThanOrEqual(REVIEW_RETRY_S * 1000)
    // no endless capture/review loop
    expect(reviews).toBe(REVIEW_MAX_AUTO)
    expect(session.state).toMatchObject({ phase: 'coaching', autoCapture: false, canForce: true })
    // force was reachable the whole time once earned
    expect(forceable.length).toBeGreaterThan(100)
    expect(forceable.every(Boolean)).toBe(true)
    // restart() re-enables automatic captures
    session.restart()
    expect(session.state.autoCapture).toBe(true)
  })

  it('force() while a review is pending saves it unverified; skipReview() keeps the local verdict', () => {
    const sim = new PoseSim(CAM, { seed: 9 })
    const a = new SetupSession({ now: () => 0, review: true })
    let r = runSetup(sim, good, { session: a })
    a.rejectReview('x')
    r = runSetup(sim, good, { session: a, startMs: r.tMs + STEP_MS })
    a.rejectReview('y')
    r = runSetup(sim, good, { session: a, startMs: r.tMs + STEP_MS })
    expect(r.state.phase).toBe('reviewing')
    expect(a.state.canForce).toBe(true)
    expect(a.force()).toBe(true)
    expect(a.state.phase).toBe('done')
    expect(a.baseline?.verified).toBe(false)

    const b = new SetupSession({ now: () => 0, review: true })
    expect(runSetup(sim, good, { session: b }).state.phase).toBe('reviewing')
    b.skipReview()
    expect(b.state.phase).toBe('done')
    // CAM sees the thighs: every check was judged locally
    expect(b.baseline?.verified).toBe(true)
  })

  it('the live local instruction comes before the last review instruction', () => {
    const sim = new PoseSim(CAM, { seed: 9 })
    const session = new SetupSession({ now: () => 0, review: true })
    const r = runSetup(sim, good, { session })
    session.rejectReview('Sit back so your shoulders touch the chair.')
    const { states, t } = drive(session, sim, [[3000, posture({ neckFlex: 40, headPitch: -40 })]], r.tMs + STEP_MS)
    expect(states[states.length - 1]).toMatchObject({
      phase: 'coaching',
      instruction: INSTRUCTIONS.headForward,
      reviewInstruction: 'Sit back so your shoulders touch the chair.'
    })
    // good again (still within the retry pause): the reviewer's advice is shown
    const back = drive(session, sim, [[1500, good]], t)
    expect(back.states[back.states.length - 1]).toMatchObject({
      phase: 'coaching',
      instruction: 'Sit back so your shoulders touch the chair.'
    })
  })
})
