import { describe, expect, it } from 'vitest'
import type { PostureAlert, PostureSnapshot } from '@shared/posture'
import { PostureEngine, type EngineSettings } from '../engine'
import type { Frame } from '../types'
import { makeFrame, uprightBaseline } from './fixtures'

const settings = (over: Partial<EngineSettings> = {}): EngineSettings => ({
  issues: {
    sink: { enabled: true, sensitivity: 1, notifyStages: [true, true, true] },
    headForward: { enabled: true, sensitivity: 1, notifyStages: [true, true, true] },
    lean: { enabled: true, sensitivity: 1, notifyStages: [true, true, true] },
    tooClose: { enabled: true, sensitivity: 1, notifyStages: [true, true, true] }
  },
  dwellSeconds: 2,
  cooldownMinutes: 2,
  escalation: true,
  ...over
})

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

/** Run frames at 10fps; returns every alert plus the final snapshot. */
function run(
  engine: PostureEngine,
  frame: Frame | ((i: number) => Frame),
  fromMs: number,
  toMs: number
): { alerts: PostureAlert[]; snapshot: PostureSnapshot } {
  const alerts: PostureAlert[] = []
  let snapshot!: PostureSnapshot
  let i = 0
  for (let t = fromMs; t < toMs; t += 100, i++) {
    const f = typeof frame === 'function' ? frame(i) : frame
    const r = engine.processFrame(f, t)
    alerts.push(...r.alerts)
    snapshot = r.snapshot
  }
  return { alerts, snapshot }
}

describe('PostureEngine — baseline behavior', () => {
  it('reports all-clear on upright frames', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    const { alerts, snapshot } = run(e, makeFrame(), 0, 3_000)
    expect(alerts).toEqual([])
    expect(snapshot.presence).toBe('active')
    expect(snapshot.calibrated).toBe(true)
    expect(snapshot.worstStage).toBe(0)
    expect(snapshot.issues.sink.stage).toBe(0)
  })

  it('does nothing without a calibration baseline', () => {
    const e = new PostureEngine(null, settings())
    const { alerts, snapshot } = run(e, slouched(0.15), 0, 5_000)
    expect(alerts).toEqual([])
    expect(snapshot.calibrated).toBe(false)
    expect(snapshot.worstStage).toBe(0)
  })
})

describe('PostureEngine — slouch detection', () => {
  it('raises the sink stage in the snapshot as the user sinks', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    run(e, makeFrame(), 0, 1_000)
    const { snapshot } = run(e, slouched(0.1), 1_000, 5_000) // 0.33 U0 → clear
    expect(snapshot.issues.sink.stage).toBe(2)
    expect(snapshot.worstStage).toBe(2)
  })

  it('fires a sink alert after the dwell time', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    run(e, makeFrame(), 0, 1_000)
    const { alerts } = run(e, slouched(0.12), 1_000, 7_000)
    const sink = alerts.filter((a) => a.issue === 'sink')
    expect(sink).toHaveLength(1)
    expect(sink[0].kind).toBe('initial')
    expect(sink[0].stage).toBeGreaterThanOrEqual(1)
  })

  it('a disabled issue neither alerts nor shows a stage', () => {
    const e = new PostureEngine(
      uprightBaseline(),
      settings({
        issues: {
          ...settings().issues,
          sink: { enabled: false, sensitivity: 1, notifyStages: [true, true, true] }
        }
      })
    )
    run(e, makeFrame(), 0, 1_000)
    const { alerts, snapshot } = run(e, slouched(0.12), 1_000, 8_000)
    expect(alerts.filter((a) => a.issue === 'sink')).toEqual([])
    expect(snapshot.issues.sink.stage).toBe(0)
  })

  it('disabled slight stage means slight-only violations never alert', () => {
    const base = settings()
    const e = new PostureEngine(
      uprightBaseline(),
      settings({
        issues: {
          ...base.issues,
          sink: { enabled: true, sensitivity: 1, notifyStages: [false, true, true] }
        }
      })
    )
    run(e, makeFrame(), 0, 1_000)
    // 0.06 drop = 0.2 U0 → slight territory only → no episode, no alert
    const slight = run(e, slouched(0.06), 1_000, 9_000)
    expect(slight.alerts).toEqual([])
    // deepening to clear (0.12 → 0.4 U0) does alert, at stage ≥ 2
    const clear = run(e, slouched(0.12), 9_000, 15_000)
    const sink = clear.alerts.filter((a) => a.issue === 'sink')
    expect(sink).toHaveLength(1)
    expect(sink[0].stage).toBeGreaterThanOrEqual(2)
  })
})

describe('PostureEngine — presence', () => {
  it('goes away on lost pose and silences everything, then comes back', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    run(e, makeFrame(), 0, 1_000)
    run(e, slouched(0.12), 1_000, 2_000) // pending episode
    const away = run(e, null, 2_000, 6_000) // 4s of no pose
    expect(away.snapshot.presence).toBe('away')
    expect(away.alerts).toEqual([])
    const back = run(e, makeFrame(), 6_000, 8_500)
    expect(back.snapshot.presence).toBe('active')
  })

  it('a 10-30s away break freezes episodes instead of wiping them', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    run(e, makeFrame(), 0, 1_000)
    run(e, slouched(0.12), 1_000, 2_500) // ~1s accrued toward the 2s dwell
    run(e, null, 2_500, 17_500) // 15s away — under the 30s full-reset line
    // returns STILL slouching: presence exits away ~1.5s in (19.0s), and the
    // frozen dwell must resume (not restart): the alert lands before 20s,
    // while a wiped episode would need a fresh 2s dwell (≈21s)
    const resumed = run(e, slouched(0.12), 17_500, 20_000)
    expect(resumed.alerts.filter((a) => a.issue === 'sink')).toHaveLength(1)
  })

  it('a long away break resets episodes and cooldowns', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    run(e, makeFrame(), 0, 1_000)
    const first = run(e, slouched(0.12), 1_000, 7_000)
    expect(first.alerts.filter((a) => a.issue === 'sink')).toHaveLength(1)
    run(e, makeFrame(), 7_000, 14_000) // recovered for >5s → a 2 min cooldown is running
    run(e, null, 14_000, 47_000) // 33s away → full reset, cooldown included
    run(e, makeFrame(), 47_000, 49_500)
    const second = run(e, slouched(0.12), 49_500, 56_000)
    const sinkAgain = second.alerts.filter((a) => a.issue === 'sink' && a.kind === 'initial')
    expect(sinkAgain).toHaveLength(1)
  })
})

describe('PostureEngine — too close and the sink distance gate', () => {
  it('flags tooClose and holds sink when the user moves toward the camera', () => {
    const e = new PostureEngine(uprightBaseline(), settings())
    run(e, makeFrame(), 0, 1_000)
    // 30% closer AND shoulders dropped: sink metric is positive but D≈1.3 is
    // outside the sink gate — sink must not alert
    const g = 1.3
    const sx = (x: number): number => 0.5 + (x - 0.5) * g
    const closeSlouch = makeFrame({
      nose: [0.5, 0.44],
      leftEye: [sx(0.455), 0.4],
      rightEye: [sx(0.545), 0.4],
      leftEar: [sx(0.44), 0.38],
      rightEar: [sx(0.56), 0.38],
      leftShoulder: [sx(0.35), 0.68],
      rightShoulder: [sx(0.65), 0.68]
    })
    const { alerts, snapshot } = run(e, closeSlouch, 1_000, 9_000)
    expect(alerts.some((a) => a.issue === 'tooClose')).toBe(true)
    expect(alerts.filter((a) => a.issue === 'sink')).toEqual([])
    expect(snapshot.issues.tooClose.stage).toBeGreaterThanOrEqual(2)
  })
})
