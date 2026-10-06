// Presence plausibility (docs/specs/detection.md §2 and Implementation notes, "Presence
// plausibility"): MediaPipe finds a "person" in anything person-like — a figure printed on a
// desk mat lying flat in front of the camera (the real-world bug: an empty chair read as "Seeing
// head, shoulders & hips", sitting time counted), a poster on the wall, someone behind the
// user — and reconstructs it at human size. A frame counts as the user (GOOD) only when the
// pose is plausible for someone sitting at the screen, from any camera angle:
// - a figure lying flat ACROSS the view is never GOOD, whatever the camera (no gravity needed);
// - with a measured gravity (a saved baseline whose pitch was observed) a flat figure in ANY
//   orientation is never GOOD;
// - a small figure, a poster or a person far behind the user is too far away;
// - no real user — reclined, lying back 50° in the chair, hunched, from any viewpoint — is
//   rejected, and the strict judge still sees (and rejects) lying in the chair.

import { describe, expect, it, vi } from 'vitest'
import { SetupSession } from '../calibration'
import { HFOV_ASSUMED, PRESENCE_MAX_DEPTH_M, PRESENCE_NECK_MAX } from '../constants'
import { PostureEngine, baselinePitchKnown, extractOptionsFor } from '../engine'
import { extractFeatures, extractFeaturesChecked, frameReject, isGoodFrame } from '../features'
import type { CalibrationBaseline } from '@shared/posture'
import type { Frame, FrameReject } from '../types'
import { angleDeg } from '../vec'
import { STEP_MS, calibrate, engineSettings } from './harness'
import {
  BAD_SEATED,
  GOOD_SEATED,
  NO_NOISE,
  PoseSim,
  ROLLED_GRID_ROLLS,
  deskPhantom,
  eyesOnScreen,
  posture,
  uprightPhantom,
  viewpointGrid,
  type CameraParams,
  type DeskPhantomOptions,
  type FigurePlacement,
  type PostureParams,
  type Viewpoint
} from './sim'

// simulator-heavy: allow for a loaded machine (parallel workers) beyond the 5 s default
vi.setConfig({ testTimeout: 120_000 })

/** stress-test with other noise draws: SIM_SEED_OFFSET=1000 npx vitest run … */
const OFF = Number(process.env.SIM_SEED_OFFSET ?? 0)
const GRID = viewpointGrid()
const ALL_GRIDS: Viewpoint[] = [...GRID, ...viewpointGrid(ROLLED_GRID_ROLLS).map((vp) => ({ ...vp, name: `rolled ${vp.name}` }))]

/** How much a lens of `hfov` scales the perspective-fit depth read at the assumed FOV. */
const lensFactor = (hfov: number): number => Math.tan((hfov * Math.PI) / 360) / Math.tan((HFOV_ASSUMED * Math.PI) / 360)
/**
 * A desk setup: the camera at most 1.5 m from the user, or the depth it reads within that of a
 * user 1.5 m from an 85° lens (≤ 2.5 m). The grid's 2 m viewpoints through 78–85° lenses are not.
 */
const atDesk = (vp: CameraParams): boolean => vp.distance * lensFactor(vp.hfov) <= 2.5

/**
 * A print lying left–right on the desk (square to the view and 10° off), face up or down,
 * centred or off to a side (bottom right, as in the real-world screenshot), desk-mat sized or
 * life-size. On the rolled grid (cameras rolled up to 8°, beyond the level-mount prior) only
 * square to the view.
 */
const across = (headings: number[]): DeskPhantomOptions[] =>
  headings.flatMap((headingDeg) =>
    [true, false].flatMap((faceUp) => [
      { headingDeg, faceUp },
      { headingDeg, faceUp, imageU: 0.22, imageV: 0.22 },
      { headingDeg, faceUp, imageU: -0.3, imageV: 0.1 },
      { headingDeg, faceUp, scale: 1 }
    ])
  )
const ACROSS_LEVEL = across([90, -90, 80, 100, -80, -100])
const ACROSS_ROLLED = across([90, -90])
/** every orientation on the desk, including along the line of sight */
const ANY_HEADING: DeskPhantomOptions[] = [0, 30, 60, 90, 120, 150, 180, -45, -135].flatMap((headingDeg) =>
  [true, false].map((faceUp) => ({ headingDeg, faceUp }))
)

const phantomSim = (vp: CameraParams, fig: FigurePlacement, seed?: number): PoseSim =>
  seed === undefined ? new PoseSim(vp, { noise: NO_NOISE, figure: fig }) : new PoseSim(vp, { seed, figure: fig })

/** the realistic seated postures plus the extremes a user still sits in */
const EXTREME_SEATED: Array<{ name: string; p: PostureParams }> = [
  { name: 'lying 50°, head going along', p: eyesOnScreen({ trunkPitch: -50, slide: 0.2, sink: 0.04, neckFlex: 0 }, 0) },
  { name: 'lying 45°, head going along, looking up', p: eyesOnScreen({ trunkPitch: -45, slide: 0.18, sink: 0.04, neckFlex: -5 }, -8) },
  { name: 'hunch 35°, head forward', p: eyesOnScreen({ trunkPitch: 35, slide: 0.1, shoulderRound: 0.04, neckFlex: 15 }, 20) },
  { name: 'leaning 20° to the left, shoulder raised', p: posture({ trunkRoll: 20, shrugL: 0.05 }) },
  { name: 'swiveled 40°, head turned 40°', p: posture({ swivel: 40, headYaw: 40 }) }
]
const ALL_SEATED = [...GOOD_SEATED, ...BAD_SEATED, ...EXTREME_SEATED]

describe('frame reject reasons', () => {
  it('say why a frame is BAD, and agree with isGoodFrame / extractFeatures', () => {
    const vp = GRID.find((v) => v.azimuth === 0 && v.elevation === 15)!
    const user = new PoseSim(vp, { noise: NO_NOISE }).render(posture())
    expect(frameReject(user)).toBeNull()
    expect(isGoodFrame(user)).toBe(true)
    expect(frameReject(null)).toBe('no-pose')
    expect(frameReject({ ...user, world: null })).toBe('no-pose')
    const hidden = user.image.map((l, i) => (i <= 12 ? { ...l, visibility: 0.05 } : l))
    expect(frameReject({ ...user, image: hidden })).toBe('not-in-view')
    const flat = phantomSim(vp, deskPhantom(vp, { headingDeg: 90 })!).render(posture())
    expect(frameReject(flat)).toBe('not-upright')
    expect(isGoodFrame(flat)).toBe(false)
    expect(extractFeaturesChecked(flat)).toEqual({ features: null, reject: 'not-upright' })
    const far = phantomSim(vp, uprightPhantom(vp, 4.5, 1)).render(posture())
    expect(extractFeaturesChecked(far).reject).toBe('too-far')
    // the engine and setup expose the latest one
    const engine = new PostureEngine(null, engineSettings())
    engine.processFrame(flat, 0)
    expect(engine.frameReject).toBe('not-upright')
    engine.processFrame(null, 100)
    expect(engine.frameReject).toBe('no-pose')
    engine.processFrame(user, 200)
    expect(engine.frameReject).toBeNull()
    const session = new SetupSession({ now: () => 0 })
    expect(session.push(far, 0).frameReject).toBe('too-far')
    expect(session.push(user, 100).frameReject).toBeNull()
  })
})

describe('presence plausibility: real users', () => {
  it('every seated posture, extremes included, is GOOD wherever it is in view, from every viewpoint (noise-free)', () => {
    let checked = 0
    const rejected: string[] = []
    for (const vp of ALL_GRIDS) {
      for (const sp of ALL_SEATED) {
        const r = frameReject(new PoseSim(vp, { noise: NO_NOISE }).render(sp.p))
        if (r === 'not-in-view') continue
        checked++
        // beyond a desk (2 m from an 85° lens reads like a person 3 m away) lying back may be
        // too far without a baseline — see "far away" below
        if (r === 'too-far' && !atDesk(vp)) continue
        if (r !== null) rejected.push(`${vp.name} | ${sp.name}: ${r}`)
      }
    }
    expect(rejected).toEqual([])
    expect(checked).toBeGreaterThan(ALL_GRIDS.length * ALL_SEATED.length * 0.8)
  })

  it('under the simulator noise (~10× real jitter) a user is rejected in well under 0.5% of frames', () => {
    let frames = 0
    let rejected = 0
    for (const [k, vp] of GRID.entries()) {
      for (const sp of ALL_SEATED) {
        if (frameReject(new PoseSim(vp, { noise: NO_NOISE }).render(sp.p)) === 'not-in-view') continue
        const sim = new PoseSim(vp, { seed: 4100 + k + OFF })
        for (let i = 0; i < 20; i++) {
          const r = frameReject(sim.render(sp.p))
          if (r === 'not-in-view') continue
          frames++
          if (r !== null) rejected++
        }
      }
    }
    expect(frames).toBeGreaterThan(10_000)
    expect(rejected / frames).toBeLessThan(0.005)
  })

  it("with the saved baseline's gravity, a user lying back 50° with the head along or hunching stays GOOD", () => {
    let checked = 0
    for (const [k, vp] of GRID.entries()) {
      if (k % 3 !== 0) continue // a third of the grid: setup per viewpoint is the slow part
      const sim = new PoseSim(vp, { seed: 4300 + k + OFF })
      const b = calibrate(sim, GOOD_SEATED[0].p)
      if (!b || !baselinePitchKnown(b)) continue
      const clean = new PoseSim(vp, { noise: NO_NOISE })
      for (const sp of [...BAD_SEATED, ...EXTREME_SEATED]) {
        const r = frameReject(clean.render(sp.p), extractOptionsFor(b))
        if (r === 'not-in-view') continue
        checked++
        expect(r, `${vp.name} | ${sp.name}`).toBeNull()
      }
    }
    expect(checked).toBeGreaterThan(50)
  })
})

describe('presence plausibility: a figure lying flat on the desk', () => {
  it('lying across the view, it is never a GOOD frame from any viewpoint that sees the desk (no gravity needed)', () => {
    let inView = 0
    let upright = 0
    const good: string[] = []
    for (const vp of ALL_GRIDS) {
      for (const o of vp.name.startsWith('rolled') ? ACROSS_ROLLED : ACROSS_LEVEL) {
        const fig = deskPhantom(vp, o)
        if (!fig) continue
        const r = frameReject(phantomSim(vp, fig).render(posture()))
        if (r === 'not-in-view') continue
        inView++
        if (r === 'not-upright') upright++
        // (a few off-centre prints through a wide lens are too far as well)
        else if (r !== 'too-far') good.push(`${vp.name} | ${JSON.stringify(o)}`)
      }
    }
    expect(good).toEqual([])
    // most viewpoints look down on the desk (the ones that look up see no desk)
    expect(inView).toBeGreaterThan(1000)
    expect(upright / inView).toBeGreaterThan(0.95)
  })

  it('lying diagonally (15–35° off across), it is (nearly) never a GOOD frame without gravity either', () => {
    // read through a camera pitch that would make it upright enough, it is reclined AND rolled
    // at once (the roll budget); only off-centre prints, whose view ray turns them, slip through
    let inView = 0
    let good = 0
    let noisy = 0
    let noisyGood = 0
    for (const vp of GRID) {
      for (const h of [55, 60, 65, 70, 75]) {
        for (const headingDeg of [h, -h, 180 - h, h - 180]) {
          for (const faceUp of [true, false]) {
            for (const place of [{}, { imageU: 0.2, imageV: 0.25 }, { imageU: -0.3, imageV: 0.1 }, { scale: 0.6 }]) {
              const fig = deskPhantom(vp, { headingDeg, faceUp, ...place })
              if (!fig) continue
              const r = frameReject(phantomSim(vp, fig).render(posture()))
              if (r === 'not-in-view') continue
              inView++
              if (r === null) good++
              const sim = phantomSim(vp, fig, 6100 + h + OFF)
              for (let i = 0; i < 3; i++) {
                const q = frameReject(sim.render(posture()))
                if (q === 'not-in-view') continue
                noisy++
                if (q === null) noisyGood++
              }
            }
          }
        }
      }
    }
    expect(inView).toBeGreaterThan(2500)
    expect(good / inView).toBeLessThan(0.01)
    expect(noisyGood / noisy).toBeLessThan(0.03)
  })

  it('with a measured gravity it is never GOOD, in any orientation (also along the line of sight)', () => {
    let inView = 0
    for (const vp of GRID) {
      for (const o of ANY_HEADING) {
        const fig = deskPhantom(vp, o)
        if (!fig) continue
        const sim = phantomSim(vp, fig)
        const fr = sim.render(posture())
        for (const upSource of ['body', 'hips'] as const) {
          const r = frameReject(fr, { up: sim.trueUp, upSource, gravityKnown: true })
          if (r === 'not-in-view') continue
          inView++
          expect(r, `${vp.name} | ${JSON.stringify(o)}`).toBe('not-upright')
        }
      }
    }
    expect(inView).toBeGreaterThan(GRID.length * ANY_HEADING.length * 0.5)
  })

  it('a small print or figurine (13 cm) is too far away in any orientation, without any gravity', () => {
    let inView = 0
    for (const vp of GRID) {
      for (const o of ANY_HEADING) {
        const fig = deskPhantom(vp, { ...o, scale: 0.1 })
        if (!fig) continue
        const r = frameReject(phantomSim(vp, fig).render(posture()))
        if (r === 'not-in-view') continue
        inView++
        expect(r, `${vp.name} | ${JSON.stringify(o)}`).toBe('too-far')
      }
    }
    expect(inView).toBeGreaterThan(GRID.length * ANY_HEADING.length * 0.3)
  })

  it('the neck of a flat figure is ~90° from up, a seated user is far inside PRESENCE_NECK_MAX', () => {
    const vp = GRID.find((v) => v.azimuth === 0 && v.elevation === 30)!
    const fig = deskPhantom(vp, { headingDeg: 0 })!
    const sim = phantomSim(vp, fig)
    const f = extractFeatures(sim.render(posture()), { up: sim.trueUp, upSource: 'camera' })!
    // along the line of sight it passes the pitch-free test; its neck lies flat
    expect(f).not.toBeNull()
    expect(angleDeg(f.up, sim.trueUp)).toBeLessThan(1)
    expect(Math.abs(f.neckFwd)).toBeGreaterThan(PRESENCE_NECK_MAX + 10)
  })
})

describe('presence plausibility: far away', () => {
  it('a poster figure on a wall and a person 4 m behind the user are too far, from every viewpoint', () => {
    let inView = 0
    for (const vp of ALL_GRIDS) {
      const cases: Array<[string, FigurePlacement]> = [
        ['person 4.5 m away', uprightPhantom(vp, 4.5, 1)],
        ['person 4.5 m away, off to the side', uprightPhantom(vp, 4.5, 1, 0.3, -0.1)],
        ['poster figure (40 cm) 1.5 m away', uprightPhantom(vp, 1.5, 0.25, -0.25, -0.15)],
        ['poster figure (55 cm) 2.5 m away', uprightPhantom(vp, 2.5, 0.35)]
      ]
      for (const [name, fig] of cases) {
        const { features, reject } = extractFeaturesChecked(phantomSim(vp, fig).render(posture()))
        if (reject === 'not-in-view') continue
        inView++
        expect(features, `${vp.name} | ${name}`).toBeNull()
        expect(reject, `${vp.name} | ${name}`).toBe('too-far')
      }
    }
    expect(inView).toBeGreaterThan(ALL_GRIDS.length * 3)
  })

  it('a desk user (≤ 1.5 m, or reading like one through a wide lens) stays well inside the depth limit', () => {
    let maxDepth = 0
    let n = 0
    for (const vp of GRID) {
      if (!atDesk(vp)) continue
      for (const sp of ALL_SEATED) {
        // measured through an assumed 100° lens so nothing is cut at the limit, then rescaled
        const f = extractFeatures(new PoseSim(vp, { noise: NO_NOISE }).render(sp.p), { hfovDeg: 100 })
        if (!f?.anchor) continue
        n++
        maxDepth = Math.max(maxDepth, f.anchor[2] * lensFactor(100))
      }
    }
    expect(n).toBeGreaterThan(GRID.length * ALL_SEATED.length * 0.5)
    expect(maxDepth).toBeGreaterThan(2.2) // the grid reaches the edge of a desk setup
    expect(maxDepth).toBeLessThan(PRESENCE_MAX_DEPTH_M - 0.3)
  })

  it('a person 4 m away is too far through every lens of 55–85°, centred or off to the side, from any height', () => {
    let noisy = 0
    let noisyGood = 0
    for (const hfov of [55, 60, 65, 70, 78, 85]) {
      for (const elevation of [-20, 0, 15, 30, 50]) {
        for (const azimuth of [0, 40, 90]) {
          const vp: CameraParams = { azimuth, elevation, distance: 0.8, roll: 0, hfov, aspect: 16 / 9 }
          for (const [u, v] of [[0, -0.05], [0.25, -0.1], [-0.3, 0.05]]) {
            const fig = uprightPhantom(vp, 4, 1, u, v)
            const r = frameReject(phantomSim(vp, fig).render(posture()))
            if (r === 'not-in-view') continue
            expect(r, `fov${hfov} el${elevation} az${azimuth} (${u}, ${v})`).toBe('too-far')
            // under the simulator noise a frame through the narrowest lens may read just inside
            // (the engine's 1.5 s of GOOD frames never comes together, see the engine tests)
            const sim = phantomSim(vp, fig, 5700 + hfov + elevation + OFF)
            for (let i = 0; i < 10; i++) {
              const q = frameReject(sim.render(posture()))
              if (q === 'not-in-view') continue
              noisy++
              if (q === null) noisyGood++
            }
          }
        }
      }
    }
    expect(noisy).toBeGreaterThan(1000)
    expect(noisyGood / noisy).toBeLessThan(0.05)
  })

  it('a poster or standee whose life-size equivalent is beyond the limit is too far (FOV-scaled)', () => {
    // a figure of `scale` at `d` reads like a person at d / scale (here ≥ 3.3 m), × the lens factor
    const cases: Array<[number, number]> = [[1.0, 0.3], [1.7, 0.5], [2.3, 0.7], [2.7, 0.8], [3.4, 1]]
    for (const hfov of [65, 70, 85]) {
      for (const elevation of [0, 15, 30]) {
        const vp: CameraParams = { azimuth: 0, elevation, distance: 0.8, roll: 0, hfov, aspect: 16 / 9 }
        for (const [d, s] of cases) {
          const r = frameReject(phantomSim(vp, uprightPhantom(vp, d, s, 0, -0.1)).render(posture()))
          if (r === 'not-in-view') continue
          expect(r, `fov${hfov} el${elevation} ${d} m ×${s}`).toBe('too-far')
        }
      }
    }
  })

  it('with a baseline the bound follows the user: a figure or a person a few times farther is too far, whatever the lens', () => {
    let runs = 0
    for (const hfov of [55, 70, 85]) {
      for (const [elevation, distance] of [[15, 0.6], [0, 0.85], [30, 1.0]]) {
        const vp: CameraParams = { azimuth: 0, elevation, distance, roll: 0, hfov, aspect: 16 / 9 }
        const b = calibrate(new PoseSim(vp, { seed: 5750 + hfov + elevation + OFF }), GOOD_SEATED[0].p)
        if (!b) continue
        runs++
        const o = extractOptionsFor(b)
        // the user, lying back, or pushed back 0.6 m: still the user
        const clean = new PoseSim(vp, { noise: NO_NOISE })
        for (const sp of [...BAD_SEATED, ...EXTREME_SEATED]) {
          const r = frameReject(clean.render(sp.p), o)
          if (r === 'not-in-view') continue
          expect(r, `fov${hfov} el${elevation} | ${sp.name}`).toBeNull()
        }
        expect(['too-far', 'not-upright']).not.toContain(frameReject(clean.render(posture({ slide: -0.6 })), o))
        // a standee on the desk, a poster on the wall, a person behind: each reads like a person
        // ≥ 3× (and ≥ 1.3 m) farther than the user — closer than the absolute 3 m bound for a
        // user sitting close
        const eq = Math.max(3.2 * distance, distance + 1.3)
        for (const fig of [uprightPhantom(vp, 0.25 * eq, 0.25, 0.2, 0.1), uprightPhantom(vp, 0.85 * eq, 0.85, -0.2, -0.1), uprightPhantom(vp, eq, 1)]) {
          const r = frameReject(phantomSim(vp, fig).render(posture()), o)
          if (r === 'not-in-view') continue
          expect(r, `fov${hfov} el${elevation} d${distance}`).toBe('too-far')
        }
      }
    }
    expect(runs).toBeGreaterThan(4)
  })

  it('with a baseline, a user far from a wide-angle webcam can lean back (the bound is relative)', () => {
    let runs = 0
    for (const [hfov, distance] of [[85, 2.0], [110, 1.1], [120, 0.95]]) {
      const vp: CameraParams = { azimuth: 0, elevation: 15, distance, roll: 0, hfov, aspect: 16 / 9 }
      const clean = new PoseSim(vp, { noise: NO_NOISE })
      const b = calibrate(new PoseSim(vp, { seed: 5800 + hfov + OFF }), GOOD_SEATED[0].p)
      expect(b, `fov${hfov} d${distance}`).not.toBeNull()
      const o = extractOptionsFor(b!)
      for (const sp of [...BAD_SEATED, ...EXTREME_SEATED]) {
        const r = frameReject(clean.render(sp.p), o)
        if (r === 'not-in-view') continue
        runs++
        expect(r, `fov${hfov} d${distance} | ${sp.name}`).toBeNull()
      }
      // pushed back 0.5 m too
      expect(['too-far', 'not-upright']).not.toContain(frameReject(clean.render(posture({ slide: -0.5 })), o))
    }
    expect(runs).toBeGreaterThan(20)
  })
})

// ---------------------------------------------------------------------------
// the engine and setup with an empty chair

/** Run the engine over `ms` of one frame source; the presence states seen and the last reject. */
function runFrames(
  engine: PostureEngine,
  render: (i: number) => Frame,
  fromMs: number,
  ms: number
): { presence: Set<string>; rejects: Set<FrameReject | null>; alerts: number; t: number } {
  const presence = new Set<string>()
  const rejects = new Set<FrameReject | null>()
  let alerts = 0
  let t = fromMs
  for (let i = 0; t < fromMs + ms; i++, t += STEP_MS) {
    const r = engine.processFrame(render(i), t)
    presence.add(r.snapshot.presence)
    rejects.add(engine.frameReject)
    alerts += r.alerts.length
  }
  return { presence, rejects, alerts, t }
}

describe('engine: an empty chair with a phantom in view', () => {
  it('uncalibrated (no baseline): a desk-mat print lying across never makes the user present', () => {
    let runs = 0
    for (const [k, vp] of GRID.entries()) {
      const fig = deskPhantom(vp, { headingDeg: k % 2 ? 90 : -80, imageU: k % 3 === 0 ? 0.2 : 0, imageV: 0.2 })
      if (!fig) continue
      const sim = phantomSim(vp, fig, 5100 + k + OFF)
      if (frameReject(phantomSim(vp, fig).render(posture())) === 'not-in-view') continue
      runs++
      const engine = new PostureEngine(null, engineSettings())
      const r = runFrames(engine, () => sim.render(posture()), 0, 30_000)
      expect([...r.presence], vp.name).toEqual(['away'])
      expect(r.rejects.has('not-upright'), vp.name).toBe(true)
      expect(r.alerts).toBe(0)
    }
    expect(runs).toBeGreaterThan(GRID.length * 0.4)
  })

  it('uncalibrated: a person behind the user or a poster never makes the user present', () => {
    for (const [k, vp] of GRID.entries()) {
      if (k % 2) continue
      for (const fig of [uprightPhantom(vp, 4.5, 1), uprightPhantom(vp, 2, 0.3, 0.2, -0.1)]) {
        const sim = phantomSim(vp, fig, 5200 + k + OFF)
        const engine = new PostureEngine(null, engineSettings())
        const r = runFrames(engine, () => sim.render(posture()), 0, 10_000)
        expect([...r.presence], vp.name).toEqual(['away'])
      }
    }
  })

  it('uncalibrated: a person 4 m away through a narrow 55° webcam never makes the user present', () => {
    for (const elevation of [0, 15, 30]) {
      const vp: CameraParams = { azimuth: 0, elevation, distance: 0.8, roll: 0, hfov: 55, aspect: 16 / 9 }
      const sim = phantomSim(vp, uprightPhantom(vp, 4, 1, 0.1, -0.05), 5900 + elevation + OFF)
      const r = runFrames(new PostureEngine(null, engineSettings()), () => sim.render(posture()), 0, 30_000)
      expect([...r.presence], `el${elevation}`).toEqual(['away'])
      expect(r.rejects.has('too-far')).toBe(true)
    }
  })

  it('uncalibrated: a print lying diagonally on the desk (20–40° off across, the real screenshot) never makes the user present', () => {
    let runs = 0
    for (const elevation of [20, 30, 40]) {
      const vp: CameraParams = { azimuth: 0, elevation, distance: 0.8, roll: 0, hfov: 70, aspect: 16 / 9 }
      for (const headingDeg of [70, 65, 60, 55, 50, -50, -55, -60, -70, 110, 120, 130, -120]) {
        for (const faceUp of [true, false]) {
          for (const place of [{ scale: 0.6, imageU: 0.2, imageV: 0.25 }, { imageV: 0.2 }]) {
            const fig = deskPhantom(vp, { headingDeg, faceUp, ...place })
            if (!fig) continue
            runs++
            const sim = phantomSim(vp, fig, 6000 + elevation + headingDeg + OFF)
            const r = runFrames(new PostureEngine(null, engineSettings()), () => sim.render(posture()), 0, 20_000)
            expect([...r.presence], `el${elevation} heading ${headingDeg} ${faceUp ? 'up' : 'down'} ${JSON.stringify(place)}`).toEqual(['away'])
          }
        }
      }
    }
    expect(runs).toBeGreaterThan(100)
  })

  it('calibrated: after the user leaves, a flat figure in any orientation keeps presence away (no sitting time, no alerts)', () => {
    let runs = 0
    let known = 0
    for (const [k, vp] of GRID.entries()) {
      if (k % 2) continue // half the grid: setup per viewpoint is the slow part
      const user = new PoseSim(vp, { seed: 5300 + k + OFF })
      const b: CalibrationBaseline | null = calibrate(user, GOOD_SEATED[0].p)
      if (!b) continue
      const pitchKnown = baselinePitchKnown(b)
      if (pitchKnown) known++
      for (const headingDeg of pitchKnown ? [0, 45, 90, 150, 180] : [90, -90]) {
        const fig = deskPhantom(vp, { headingDeg, imageV: 0.2 })
        if (!fig) continue
        if (frameReject(phantomSim(vp, fig).render(posture()), extractOptionsFor(b)) === 'not-in-view') continue
        runs++
        const engine = new PostureEngine(b, engineSettings())
        // the user sits there, then leaves; the print on the desk stays in view
        let r = runFrames(engine, () => user.render(GOOD_SEATED[0].p), 0, 5000)
        expect(engine.presenceState, vp.name).toBe('active')
        r = runFrames(engine, () => null, r.t, 1000)
        const phantom = phantomSim(vp, fig, 5400 + k + OFF)
        const away = runFrames(engine, () => phantom.render(posture()), r.t, 30_000)
        expect(engine.presenceState, `${vp.name} heading ${headingDeg}`).toBe('away')
        expect(away.alerts).toBe(0)
        // once away (2 s), it never comes back for the print
        const later = runFrames(engine, () => phantom.render(posture()), away.t, 20_000)
        expect([...later.presence], `${vp.name} heading ${headingDeg}`).toEqual(['away'])
        // and the user is seen again as soon as they sit down
        runFrames(engine, () => user.render(GOOD_SEATED[0].p), later.t, 3000)
        expect(engine.presenceState, vp.name).toBe('active')
      }
    }
    expect(known).toBeGreaterThan(5)
    expect(runs).toBeGreaterThan(20)
  })
})

/** Every numeric parameter of `a` moved `x` of the way to `b`. */
function lerpPosture(a: PostureParams, b: PostureParams, x: number): PostureParams {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const v0 = (a as unknown as Record<string, unknown>)[k]
    out[k] = typeof v === 'number' && typeof v0 === 'number' ? v0 + (v - v0) * x : v
  }
  return out as unknown as PostureParams
}

describe('engine: a stale measured gravity (webcam re-aimed, or a baseline kept for another camera)', () => {
  const STALE: Array<{ name: string; azimuth: number; from: number; to: number; distance: number }> = [
    { name: 'az0 el30 → el−5', azimuth: 0, from: 30, to: -5, distance: 0.8 },
    { name: 'az0 el15 → el−20', azimuth: 0, from: 15, to: -20, distance: 1.2 },
    { name: 'az−35 el0 → el−35', azimuth: -35, from: 0, to: -35, distance: 1.2 },
    { name: 'az40 el15 → el−15', azimuth: 40, from: 15, to: -15, distance: 1.2 }
  ]
  const lying = BAD_SEATED.filter((s) => s.family === 'lying')

  it('the tracked user who slides into lying in the chair stays present and is alerted (Slouching)', () => {
    let runs = 0
    for (const c of STALE) {
      const cam = (elevation: number): CameraParams => ({ azimuth: c.azimuth, elevation, distance: c.distance, roll: 0, hfov: 70, aspect: 16 / 9 })
      const b = calibrate(new PoseSim(cam(c.from), { seed: 6200 + OFF }), GOOD_SEATED[0].p)
      expect(b, c.name).not.toBeNull()
      expect(baselinePitchKnown(b!), c.name).toBe(true)
      for (const sp of lying) {
        runs++
        const now = new PoseSim(cam(c.to), { seed: 6300 + OFF })
        const engine = new PostureEngine(b, engineSettings())
        // sits down upright, then slides into the posture over 3 s
        let r = runFrames(engine, () => now.render(GOOD_SEATED[0].p), 0, 5000)
        expect(engine.presenceState, c.name).toBe('active')
        r = runFrames(engine, (i) => now.render(lerpPosture(GOOD_SEATED[0].p, sp.p, Math.min(1, (i + 1) / 30))), r.t, 3000)
        const after = runFrames(engine, () => now.render(sp.p), r.t, 90_000)
        expect([...after.presence], `${c.name} | ${sp.name}`).toEqual(['active'])
        expect(after.alerts, `${c.name} | ${sp.name}`).toBeGreaterThan(0)
      }
    }
    expect(runs).toBe(STALE.length * lying.length)
  })

  it('the track never passes to a figure on the desk: the user leaves (no gap) and the print keeps presence away', () => {
    let runs = 0
    for (const [k, vp] of GRID.entries()) {
      if (k % 3) continue
      const user = new PoseSim(vp, { seed: 6400 + k + OFF })
      const b = calibrate(user, GOOD_SEATED[0].p)
      if (!b || !baselinePitchKnown(b)) continue
      for (const headingDeg of [0, 30, 150, 180]) {
        for (const scale of [0.45, 0.8]) {
          const fig = deskPhantom(vp, { headingDeg, scale, imageV: 0.2 })
          if (!fig) continue
          if (frameReject(phantomSim(vp, fig).render(posture()), extractOptionsFor(b)) === 'not-in-view') continue
          runs++
          const engine = new PostureEngine(b, engineSettings())
          const r = runFrames(engine, () => user.render(GOOD_SEATED[0].p), 0, 5000)
          expect(engine.presenceState, vp.name).toBe('active')
          // the pose model jumps straight from the user to the print
          const phantom = phantomSim(vp, fig, 6500 + k + OFF)
          const away = runFrames(engine, () => phantom.render(posture()), r.t, 30_000)
          expect(engine.presenceState, `${vp.name} heading ${headingDeg} ×${scale}`).toBe('away')
          const later = runFrames(engine, () => phantom.render(posture()), away.t, 20_000)
          expect([...later.presence], `${vp.name} heading ${headingDeg} ×${scale}`).toEqual(['away'])
        }
      }
    }
    expect(runs).toBeGreaterThan(20)
  })
})

describe('setup: a phantom is never coached', () => {
  it('a print lying across the desk keeps setup searching, and the state says why', () => {
    let runs = 0
    for (const [k, vp] of GRID.entries()) {
      if (k % 2) continue
      const fig = deskPhantom(vp, { headingDeg: 90, imageV: 0.2 })
      if (!fig) continue
      if (frameReject(phantomSim(vp, fig).render(posture())) === 'not-in-view') continue
      runs++
      const sim = phantomSim(vp, fig, 5500 + k + OFF)
      const session = new SetupSession({ now: () => 0 })
      const phases = new Set<string>()
      let state = session.state
      for (let t = 0; t < 15_000; t += STEP_MS) {
        state = session.push(sim.render(posture()), t)
        phases.add(state.phase)
      }
      expect([...phases], vp.name).toEqual(['searching'])
      expect(state.features).toBeNull()
      expect(state.frameReject).toBe('not-upright')
    }
    expect(runs).toBeGreaterThan(GRID.length * 0.2)
  })

  it('a person far behind keeps setup searching (too far)', () => {
    const vp = GRID.find((v) => v.azimuth === 0 && v.elevation === 15)!
    const sim = phantomSim(vp, uprightPhantom(vp, 4.5, 1), 5600 + OFF)
    const session = new SetupSession({ now: () => 0 })
    let state = session.state
    for (let t = 0; t < 10_000; t += STEP_MS) state = session.push(sim.render(posture()), t)
    expect(state.phase).toBe('searching')
    expect(state.frameReject).toBe('too-far')
  })
})
