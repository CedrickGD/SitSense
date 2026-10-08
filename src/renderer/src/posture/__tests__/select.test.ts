// Several poses in view (docs/specs/detection.md §2, "Several poses in view"): the pose model
// runs with room for two, so a figure on the desk mat, a poster or someone behind the user can
// come back beside the user. pickUser must find the user from every viewpoint, whatever order
// the model returns them in, and must not jump between two plausible people.

import { describe, expect, it } from 'vitest'
import { HFOV_ASSUMED } from '../constants'
import { extractOptionsFor } from '../engine'
import { frameReject } from '../features'
import { PICK_FOLLOW_MAX, pickUser, posePoint, poseSize } from '../select'
import type { PoseFrame } from '../types'
import { calibrate } from './harness'
import { NO_NOISE, PoseSim, deskPhantom, posture, uprightPhantom, viewpointGrid, type CameraParams, type FigurePlacement } from './sim'

const GRID = viewpointGrid()
const lensFactor = (hfov: number): number => Math.tan((hfov * Math.PI) / 360) / Math.tan((HFOV_ASSUMED * Math.PI) / 360)
/** a desk setup (as in phantoms.test.ts): the user reads at most 2.5 m away */
const atDesk = (vp: CameraParams): boolean => vp.distance * lensFactor(vp.hfov) <= 2.5

const userFrame = (vp: CameraParams, seed = 3): PoseFrame => new PoseSim(vp, { seed }).render(posture())
const figureFrame = (vp: CameraParams, fig: FigurePlacement, seed = 5): PoseFrame =>
  new PoseSim(vp, { seed, figure: fig }).render(posture())

/** The user's index whichever order the model returns the two poses in. */
function picksUser(user: PoseFrame, other: PoseFrame, opts = {}): boolean {
  return pickUser([user, other], opts) === 0 && pickUser([other, user], opts) === 1
}

describe('pickUser: the user beside a pose that is not the user', () => {
  it('a figure lying on the desk (any heading, face up or down) never wins over the user, from every desk viewpoint', () => {
    let checked = 0
    const missed: string[] = []
    for (const vp of GRID) {
      if (!atDesk(vp)) continue
      const user = userFrame(vp)
      if (frameReject(user) !== null) continue
      for (const headingDeg of [90, -90, 80, 30, 0, 180, -135]) {
        for (const faceUp of [true, false]) {
          for (const imageU of [0, 0.22, -0.3]) {
            const fig = deskPhantom(vp, { headingDeg, faceUp, imageU, imageV: 0.22 })
            if (!fig) continue
            const print = figureFrame(vp, fig)
            // only what presence already rejects is decided by plausibility (the rest: by size)
            if (frameReject(print) === null) continue
            checked++
            if (!picksUser(user, print)) missed.push(`${vp.name} | heading ${headingDeg} ${faceUp ? 'up' : 'down'} u${imageU}`)
          }
        }
      }
    }
    expect(missed).toEqual([])
    expect(checked).toBeGreaterThan(100)
  })

  it('a person or a poster far behind the user never wins', () => {
    let checked = 0
    for (const vp of GRID) {
      if (!atDesk(vp)) continue
      const user = userFrame(vp)
      if (frameReject(user) !== null) continue
      for (const [dist, figScale, u] of [
        [4.5, 1, 0.25],
        [5, 1, -0.2],
        [2.5, 0.35, 0.3]
      ] as const) {
        const other = figureFrame(vp, uprightPhantom(vp, dist, figScale, u, -0.05))
        checked++
        expect(picksUser(user, other), `${vp.name} | ${dist} m, scale ${figScale}`).toBe(true)
      }
    }
    expect(checked).toBeGreaterThan(60)
  })

  it('with a saved baseline the pick uses its measurements (the engine’s options)', () => {
    const vp = GRID.find((v) => v.azimuth === 0 && v.elevation === 15)!
    const baseline = calibrate(new PoseSim(vp, { seed: 7 }))
    expect(baseline).not.toBeNull()
    const user = userFrame(vp)
    const print = figureFrame(vp, deskPhantom(vp, { headingDeg: 90, imageV: 0.22 })!)
    expect(picksUser(user, print, extractOptionsFor(baseline!))).toBe(true)
  })

  it('a user only partly in view still beats a figure that is not the user', () => {
    const vp = GRID.find((v) => v.azimuth === 0 && v.elevation === 15)!
    const full = userFrame(vp)
    const partial: PoseFrame = { ...full, image: full.image.map((l, i) => (i <= 10 ? { ...l, visibility: 0.05 } : l)) }
    expect(frameReject(partial)).toBe('not-in-view')
    const print = figureFrame(vp, deskPhantom(vp, { headingDeg: 90, imageV: 0.22, scale: 1 })!)
    expect(frameReject(print)).not.toBeNull()
    expect(picksUser(partial, print)).toBe(true)
  })
})

describe('pickUser: two people who could both be the user', () => {
  const vp: CameraParams = { azimuth: 0, elevation: 10, distance: 0.8, roll: 0, hfov: 70, aspect: 16 / 9 }
  const user = new PoseSim(vp, { noise: NO_NOISE }).render(posture())
  // a colleague behind and to the side, near enough to be plausible
  const colleague = new PoseSim(vp, { noise: NO_NOISE, figure: uprightPhantom(vp, 1.6, 1, 0.3, -0.05) }).render(posture())

  it('both are plausible; without a previous pick the larger (nearer) one is taken', () => {
    expect(frameReject(user)).toBeNull()
    expect(frameReject(colleague)).toBeNull()
    expect(poseSize(user)).toBeGreaterThan(poseSize(colleague))
    expect(picksUser(user, colleague)).toBe(true)
  })

  it('the previous pick is followed, so the readings never jump between them', () => {
    const atColleague = posePoint(colleague)!
    expect(pickUser([user, colleague], {}, atColleague)).toBe(1)
    expect(pickUser([colleague, user], {}, atColleague)).toBe(0)
    const atUser = posePoint(user)!
    expect(pickUser([colleague, user], {}, atUser)).toBe(1)
    // a pick far from both (the colleague is to the right) falls back to size
    const far = { x: atUser.x - 3 * PICK_FOLLOW_MAX, y: atUser.y }
    expect(pickUser([colleague, user], {}, far)).toBe(1)
  })

  it('following never beats plausibility: a figure lying where the user was does not keep the pick', () => {
    const print = new PoseSim(vp, { noise: NO_NOISE, figure: deskPhantom(vp, { headingDeg: 90, imageV: 0.2 }) ?? undefined }).render(posture())
    if (frameReject(print) === null) return // this camera sees no desk there
    expect(pickUser([print, user], {}, posePoint(print))).toBe(1)
  })
})

describe('pickUser: edge cases', () => {
  it('one pose (or none) is index 0', () => {
    const vp = GRID[0]
    expect(pickUser([])).toBe(0)
    expect(pickUser([userFrame(vp)])).toBe(0)
  })

  it('a pose without world landmarks ranks below a GOOD one but above a figure that is not the user', () => {
    const vp = GRID.find((v) => v.azimuth === 0 && v.elevation === 15)!
    const user = userFrame(vp)
    const noWorld: PoseFrame = { ...user, world: null }
    expect(pickUser([noWorld, user])).toBe(1)
    const print = figureFrame(vp, deskPhantom(vp, { headingDeg: 90, imageV: 0.22 })!)
    expect(pickUser([print, noWorld])).toBe(1)
  })

  it('posePoint falls back to the seen upper body without both shoulders, and is null when nothing is seen', () => {
    const vp = GRID.find((v) => v.azimuth === 0 && v.elevation === 15)!
    const user = userFrame(vp)
    const oneShoulder: PoseFrame = { ...user, image: user.image.map((l, i) => (i === 12 ? { ...l, visibility: 0.1 } : l)) }
    expect(posePoint(oneShoulder)).not.toBeNull()
    const nothing: PoseFrame = { ...user, image: user.image.map((l) => ({ ...l, visibility: 0.1 })) }
    expect(posePoint(nothing)).toBeNull()
    expect(poseSize(nothing)).toBe(0)
  })
})
