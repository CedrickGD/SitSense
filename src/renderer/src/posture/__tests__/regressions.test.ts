// Regression tests for the posture-core audit findings: each scenario here
// produced a wrong or missing nudge before its fix.
import { describe, expect, it } from 'vitest'
import type { PostureAlert, PostureSnapshot } from '@shared/posture'
import { CalibrationSession, medianAngle } from '../calibration'
import { LM } from '../constants'
import { PostureEngine, type EngineSettings } from '../engine'
import { EpisodeMachine } from '../episodeMachine'
import { computeGeometry, computeRawMetrics } from '../metrics'
import type { Frame } from '../types'
import { makeFrame, uprightBaseline } from './fixtures'

const ON = { enabled: true, sensitivity: 1, notifyStages: [true, true, true] as [boolean, boolean, boolean] }
const settings = (over: Partial<EngineSettings> = {}): EngineSettings => ({
  issues: { sink: ON, headForward: ON, lean: ON, tooClose: ON },
  dwellSeconds: 12,
  cooldownMinutes: 3,
  escalation: true,
  ...over
})

type Timed = PostureAlert & { t: number }
function run(e: PostureEngine, frame: Frame | ((i: number) => Frame), from: number, to: number): { alerts: Timed[]; snapshot: PostureSnapshot } {
  const alerts: Timed[] = []
  let snapshot!: PostureSnapshot
  for (let t = from, i = 0; t < to; t += 100, i++) {
    const r = e.processFrame(typeof frame === 'function' ? frame(i) : frame, t)
    alerts.push(...r.alerts.map((a) => ({ ...a, t })))
    snapshot = r.snapshot
  }
  return { alerts, snapshot }
}

const slouched = (drop: number): Frame =>
  makeFrame({
    nose: [0.5, 0.38 + drop],
    leftEye: [0.455, 0.34 + drop],
    rightEye: [0.545, 0.34 + drop],
    leftEar: [0.44, 0.32 + drop],
    rightEar: [0.56, 0.32 + drop],
    leftShoulder: [0.35, 0.62 + drop],
    rightShoulder: [0.65, 0.62 + drop]
  })
const hidden = (...idx: number[]): Record<number, number> => Object.fromEntries(idx.map((i) => [i, 0]))

/** head turned about the vertical axis through the ear midpoint */
const yawed = (deg: number): Frame => {
  const t = (deg * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return makeFrame({
    leftEar: [0.5 - 0.06 * c, 0.32],
    rightEar: [0.5 + 0.06 * c, 0.32],
    leftEye: [0.5 - 0.045 * c + 0.064 * s, 0.34],
    rightEye: [0.5 + 0.045 * c + 0.064 * s, 0.34],
    nose: [0.5 + 0.08 * s, 0.38]
  })
}

describe('stale sub-metrics', () => {
  it('a hunch followed by sitting up with the shoulders out of view does not keep head-forward alive', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    const hunch = makeFrame({ nose: [0.5, 0.47], leftEar: [0.44, 0.41], rightEar: [0.56, 0.41], leftEye: [0.455, 0.43], rightEye: [0.545, 0.43] })
    run(e, makeFrame(), 0, 2_000)
    run(e, hunch, 2_000, 7_000)
    const after = run(e, makeFrame({ visibility: hidden(LM.leftShoulder, LM.rightShoulder) }), 7_000, 60_000)
    expect(after.alerts.filter((a) => a.issue === 'headForward')).toEqual([])
    expect(after.snapshot.issues.headForward.stage).toBe(0)
  })

  it('a shoulder tilt followed by hidden shoulders does not fire a lean nudge', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    run(e, makeFrame(), 0, 2_000)
    run(e, makeFrame({ leftShoulder: [0.35, 0.58], rightShoulder: [0.65, 0.66] }), 2_000, 8_000)
    const after = run(e, makeFrame({ visibility: hidden(LM.leftShoulder, LM.rightShoulder) }), 8_000, 60_000)
    expect(after.alerts.filter((a) => a.issue === 'lean')).toEqual([])
  })
})

describe('face-only baselines', () => {
  it('keep measuring distance in face units when weak shoulders show up at runtime', () => {
    // shoulders at 0.55 visibility: too weak for calibration (0.6), usable at runtime (0.5)
    const f = makeFrame({ leftShoulder: [0.32, 0.62], rightShoulder: [0.68, 0.62], visibility: { [LM.leftShoulder]: 0.55, [LM.rightShoulder]: 0.55 } })
    const cal = new CalibrationSession(0)
    for (let t = 0; t < 5_000; t += 80) cal.addFrame(f, t)
    const res = cal.finish()
    if (!res.ok) throw new Error(res.reason)
    expect(res.baseline.sSh0).toBeNull()
    const r = run(new PostureEngine(res.baseline, settings()), f, 0, 30_000)
    expect(r.snapshot.issues.tooClose.metric).toBeCloseTo(1, 3)
    expect(r.alerts).toEqual([])
  })
})

describe('gaps without frames (pause, sleep, camera restart)', () => {
  it('an hour-long gap does not resume a pending dwell or report its length', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    run(e, makeFrame(), 0, 2_000)
    run(e, slouched(0.12), 2_000, 13_800) // 11.8 s of a 12 s dwell
    const T = 13_800 + 3_600_000
    const after = run(e, makeFrame(), T, T + 5_000)
    expect(after.alerts).toEqual([])
    expect(after.snapshot.issues.sink.activeForMs).toBeNull()
  })
})

describe('episode machine', () => {
  it('losing sight of an alerted user keeps the quiet period', () => {
    const m = new EpisodeMachine('sink', { dwellS: 12, cooldownS: 180, escalation: true })
    const drive = (sev: 0 | 1 | 2, data: boolean, from: number, to: number): PostureAlert[] => {
      const out: PostureAlert[] = []
      for (let t = from; t < to; t += 100) out.push(...m.step({ sevTrigger: sev, sevRecovery: sev, dataAvailable: data }, t))
      return out
    }
    expect(drive(2, true, 0, 13_000)).toHaveLength(1)
    drive(2, false, 13_000, 25_000) // 12 s of data loss → silent reset
    // same unfixed slouch comes back — no fresh nudge 30 s after the last one
    expect(drive(2, true, 25_000, 60_000)).toEqual([])
  })

  it('a clearly worse episode inside the quiet period notifies as an escalation', () => {
    const e = new PostureEngine(uprightBaseline(), settings({ cooldownMinutes: 5 }))
    run(e, makeFrame(), 0, 2_000)
    const first = run(e, slouched(0.05), 2_000, 20_000)
    expect(first.alerts.filter((a) => a.issue === 'sink').map((a) => a.stage)).toEqual([1])
    run(e, makeFrame(), 20_000, 30_000) // recovered → quiet period
    const worse = run(e, slouched(0.16), 30_000, 70_000).alerts.filter((a) => a.issue === 'sink')
    expect(worse).toHaveLength(1)
    expect(worse[0].kind).toBe('escalation')
    expect(worse[0].stage).toBe(3)
    expect(worse[0].t).toBeLessThan(60_000)
  })

  it('the same stage inside the quiet period stays silent', () => {
    const e = new PostureEngine(uprightBaseline(), settings({ cooldownMinutes: 5 }))
    run(e, makeFrame(), 0, 2_000)
    run(e, slouched(0.05), 2_000, 20_000)
    run(e, makeFrame(), 20_000, 30_000)
    expect(run(e, slouched(0.05), 30_000, 120_000).alerts.filter((a) => a.issue === 'sink')).toEqual([])
  })
})

describe('calibration angles', () => {
  it('medianAngle is wrap-safe around ±180°', () => {
    expect(Math.abs(medianAngle([179.8, -179.8, 179.8, -179.8]))).toBeCloseTo(180, 5)
    expect(medianAngle([10, 12, 11])).toBeCloseTo(11, 6)
    expect(medianAngle([-2, 2, 1, -1])).toBeCloseTo(0, 6)
  })

  it('level features jittering across ±180° do not bake in a 180° lean', () => {
    const jit = (i: number): number => (i % 2 === 0 ? 0.0005 : -0.0005)
    const frame = (i: number): Frame =>
      makeFrame({
        leftEar: [0.44, 0.32 + jit(i)],
        rightEar: [0.56, 0.32 - jit(i)],
        leftEye: [0.455, 0.34 + jit(i)],
        rightEye: [0.545, 0.34 - jit(i)],
        leftShoulder: [0.35, 0.62 + jit(i)],
        rightShoulder: [0.65, 0.62 - jit(i)]
      })
    const cal = new CalibrationSession(0)
    for (let i = 0; i < 60; i++) cal.addFrame(frame(i), i * 80)
    const res = cal.finish()
    if (!res.ok) throw new Error(res.reason)
    const r = run(new PostureEngine(res.baseline, settings()), frame, 0, 30_000)
    expect(r.snapshot.issues.lean.stage).toBe(0)
    expect(r.alerts).toEqual([])
  })
})

describe('lean direction', () => {
  const leanRun = (f: Frame): PostureSnapshot => {
    const e = new PostureEngine(uprightBaseline(), settings())
    run(e, makeFrame(), 0, 2_000)
    return run(e, f, 2_000, 20_000).snapshot
  }

  it('comes from the roll or tilt that triggered, not from a zero lateral offset', () => {
    const rollA = leanRun(makeFrame({ leftEar: [0.44, 0.30], rightEar: [0.56, 0.34] })).issues.lean
    const rollB = leanRun(makeFrame({ leftEar: [0.44, 0.34], rightEar: [0.56, 0.30] })).issues.lean
    expect(rollA.stage).toBeGreaterThan(0)
    expect(rollA.direction).toBeDefined()
    expect(rollB.direction).toBeDefined()
    expect(rollA.direction).not.toBe(rollB.direction)

    const tiltA = leanRun(makeFrame({ leftShoulder: [0.35, 0.58], rightShoulder: [0.65, 0.66] })).issues.lean
    const tiltB = leanRun(makeFrame({ leftShoulder: [0.35, 0.66], rightShoulder: [0.65, 0.58] })).issues.lean
    expect(tiltA.direction).not.toBe(tiltB.direction)
  })

  it('roll and sideways shift toward the same side agree', () => {
    // in the fixtures the person's left is image-left: dropping the left ear
    // and shifting the head left are the same lean
    const roll = leanRun(makeFrame({ leftEar: [0.44, 0.34], rightEar: [0.56, 0.30] })).issues.lean
    const shift = leanRun(
      makeFrame({ nose: [0.42, 0.38], leftEye: [0.375, 0.34], rightEye: [0.465, 0.34], leftEar: [0.36, 0.32], rightEar: [0.48, 0.32] })
    ).issues.lean
    expect(shift.stage).toBeGreaterThan(0)
    expect(roll.direction).toBe(shift.direction)
  })
})

describe('recalibration hint', () => {
  it('clears once the view has been back in range for a while', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    const g = 2
    const sx = (x: number): number => 0.5 + (x - 0.5) * g
    const veryClose = makeFrame({
      leftEye: [sx(0.455), 0.34],
      rightEye: [sx(0.545), 0.34],
      leftEar: [sx(0.44), 0.32],
      rightEar: [sx(0.56), 0.32],
      leftShoulder: [sx(0.35), 0.62],
      rightShoulder: [sx(0.65), 0.62]
    })
    run(e, makeFrame(), 0, 2_000)
    expect(run(e, veryClose, 2_000, 20_000).snapshot.recalibrationSuggested).toBe(true)
    expect(run(e, makeFrame(), 20_000, 40_000).snapshot.recalibrationSuggested).toBe(false)
  })
})

describe('head turns', () => {
  it('looking at a side monitor does not read as head-forward', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    run(e, makeFrame(), 0, 2_000)
    const r = run(e, yawed(40), 2_000, 32_000)
    expect(r.alerts.filter((a) => a.issue === 'headForward')).toEqual([])
  })

  it('yaw no longer inflates the pitch proxy', () => {
    const pitch = (deg: number): number => computeRawMetrics(computeGeometry(yawed(deg)), uprightBaseline()).fwdPitch!
    expect(Math.abs(pitch(40))).toBeLessThan(0.05)
    expect(Math.abs(pitch(50))).toBeLessThan(0.05)
  })

  it('calibration refuses a turned head instead of baking it into the baseline', () => {
    const cal = new CalibrationSession(0)
    for (let t = 0; t < 5_000; t += 80) cal.addFrame(yawed(30), t)
    expect(cal.finish()).toEqual({ ok: false, reason: 'face-camera' })
  })
})

describe('head reference line', () => {
  it('ears dropping out mid-session do not bias sink, gap or lateral offset', () => {
    const cal = new CalibrationSession(0)
    for (let t = 0; t < 5_000; t += 80) cal.addFrame(makeFrame(), t)
    const res = cal.finish()
    if (!res.ok) throw new Error(res.reason)
    const m = computeRawMetrics(computeGeometry(makeFrame({ visibility: hidden(LM.leftEar, LM.rightEar) })), res.baseline)
    expect(m.sink).toBeCloseTo(0, 6)
    expect(m.fwdGap).toBeCloseTo(0, 6)
    expect(m.leanLateral).toBeCloseTo(0, 6)
  })
})
