// Optional sanity check against a real MediaPipe recording (elevated, angled webcam, user
// hunched forward typing). The file is NOT part of the repo: the test is skipped unless it
// exists. Point SITSENSE_REAL_RECORDING at another file to reuse it. Its name says 16:9, but
// the camera delivered 4:3: every check runs with both aspects (the aspect only sets the
// assumed focal length and the viewing-ray correction).

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { projectUp } from '@renderer/detection/pose-geometry'
import { assessPosture } from '../assess'
import { SetupSession, buildBaseline, medianFeatures } from '../calibration'
import { PostureEngine } from '../engine'
import { UP_MAX_ROLL } from '../constants'
import { UpEstimator, cameraRollDeg, estimateUp, extractFeatures } from '../features'
import type { Landmark, PoseFrame, PostureFeatures } from '../types'
import { DEG, median } from '../vec'
import { engineSettings } from './harness'

// simulator-heavy: allow for a loaded machine (parallel workers) beyond the 5 s default
vi.setConfig({ testTimeout: 60_000 })

// the recording is personal pose data: it stays outside the (public) repo
const FILE = process.env.SITSENSE_REAL_RECORDING ?? ''
const HAVE = FILE !== '' && existsSync(FILE)

interface Entry {
  t: number
  lm?: number[][]
  w?: number[][]
}

function load(aspect: number): { t: number[]; frames: Array<PoseFrame | null> } {
  const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Entry[]
  const toL = (a: number[]): Landmark => ({ x: a[0], y: a[1], z: a[2], visibility: a[3] })
  return {
    t: raw.map((e) => e.t),
    frames: raw.map((e) => (e.lm && e.w ? { image: e.lm.map(toL), world: e.w.map(toL), aspect } : null))
  }
}

describe.skipIf(!HAVE).each([
  ['4:3 (the camera)', 4 / 3],
  ['16:9', 16 / 9]
])('real recording: elevated angled webcam, hunched typing, %s', (_name, aspect) => {
  const { t, frames } = HAVE ? load(aspect) : { t: [], frames: [] }

  it('almost every frame is GOOD and every feature is finite', () => {
    const est = new UpEstimator()
    for (const f of frames) est.push(f)
    const up = est.estimate
    const feats = frames.map((f) => extractFeatures(f, { up: up.up, upSource: up.source }))
    const good = feats.filter((f): f is PostureFeatures => f !== null)
    expect(good.length).toBeGreaterThanOrEqual(frames.length * 0.9)
    for (const f of good) {
      for (const v of [f.neckFwd, f.view.yawDeg, f.view.elevationDeg, ...f.up, ...f.forward, ...f.left]) {
        expect(Number.isFinite(v)).toBe(true)
      }
      expect(f.ppm).not.toBeNull()
      expect(Number.isFinite(f.anchor![2]) && f.anchor![2] > 0.3 && f.anchor![2] < 5).toBe(true)
    }
    const m = medianFeatures(good)
    expect(['front', 'angled']).toContain(m.view.kind)
  })

  it('the knees hallucinated under the desk do not drive gravity (no flipped camera pitch)', () => {
    const est = new UpEstimator()
    for (const f of frames) est.push(f)
    const e = est.estimate
    // the camera is elevated (looks down): true up has a negative camera-z component
    if (e.source === 'body') expect(e.up[2]).toBeLessThan(0.05)
    const good = frames.map((f) => extractFeatures(f, { up: e.up, upSource: e.source })).filter((f) => f !== null)
    expect(median(good.map((f) => f!.view.elevationDeg))).toBeGreaterThan(-5)
  })

  it('the estimated camera roll stays within a level webcam (≤ 3°), and so does the drawn vertical', () => {
    // The door frames in this view are within ~2° of the image vertical: the camera's roll is
    // ~0. Whatever the hallucinated hips and knees under the desk say, the estimate (and the
    // drawn true vertical at the shoulders) must stay level: accumulated, per frame, and as
    // the setup session sees it live. (Was ≤ 5°; with a 12° roll clamp the live app drew
    // this vertical 12.4° off, the clamp itself.)
    const LEVEL = UP_MAX_ROLL
    for (const hips of [true, false]) {
      const est = new UpEstimator()
      for (const f of frames) est.push(f, { hips })
      expect(Math.abs(cameraRollDeg(est.estimate.up))).toBeLessThanOrEqual(LEVEL)
    }
    for (const f of frames) if (f) expect(Math.abs(cameraRollDeg(estimateUp(f).up))).toBeLessThanOrEqual(LEVEL)
    const session = new SetupSession({ now: () => 0 })
    frames.forEach((f, i) => {
      const s = session.push(f, t[i])
      expect(Math.abs(cameraRollDeg(s.up.up))).toBeLessThanOrEqual(LEVEL)
      if (s.features) {
        const [u, v] = projectUp(s.features, aspect)
        expect(Math.abs(Math.atan2(u, -v) * DEG)).toBeLessThanOrEqual(LEVEL)
      }
    })
  })

  it('the AI judge never verifies the hunched posture on its own', () => {
    // the trunk lean of a hunch cannot be judged from this camera (no trustworthy thighs, the
    // hips hidden under the desk): the strict local judge never saves it — it keeps coaching,
    // and with a reviewer available ('auto') a capture can only go to the review
    for (const review of [false, 'auto'] as const) {
      const session = new SetupSession({ now: () => 0, review })
      let judged = 0
      const phases = new Set<string>()
      frames.forEach((f, i) => {
        const s = session.push(f, t[i])
        phases.add(s.phase)
        if (s.phase !== 'searching') judged++
        // never a verified posture, and something concrete to do whenever it coaches
        expect(s.assessment.verified).toBe(false)
        if (s.phase === 'coaching') expect(s.instruction).toMatch(/\S/)
      })
      expect(judged).toBeGreaterThan(frames.length * 0.8)
      expect(phases.has('done')).toBe(false)
      if (review === false) expect(phases.has('capturing')).toBe(false)
      expect(session.baseline).toBeNull()
    }
    expect(assessPosture(null).allGood).toBe(false)
  })

  it('the engine runs on it deterministically with a (forced) baseline from the first seconds', () => {
    const first = frames.slice(0, 30)
    const res = buildBaseline(first, { verified: false, capturedAt: 0, cameraDeviceId: null })
    if (!res.ok) {
      // a real, slightly moving user may legitimately be judged unstable; then nothing more to check
      expect(['unstable', 'lost']).toContain(res.reason)
      return
    }
    const run = (): string => {
      const engine = new PostureEngine(res.baseline, engineSettings())
      const out: string[] = []
      frames.forEach((f, i) => {
        const { snapshot } = engine.processFrame(f, t[i])
        const r = snapshot.readout
        if (r) for (const v of [r.neckFwd, r.trunkFwd, r.drop, r.forward, r.lateral]) if (v !== null) expect(Number.isFinite(v)).toBe(true)
        out.push(`${snapshot.presence}:${snapshot.worstStage}`)
      })
      return out.join(',')
    }
    expect(run()).toBe(run())
  })
})
