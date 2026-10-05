// Shared drivers for the simulator-based tests.

import type { CalibrationBaseline, PostureAlert, PostureSnapshot } from '@shared/posture'
import { SetupSession, type SetupOptions, type SetupState } from '../calibration'
import { PostureEngine, type EngineSettings } from '../engine'
import type { Frame } from '../types'
import { PoseSim, posture, type PostureParams } from './sim'

export const FPS = 10
export const STEP_MS = 1000 / FPS

export const engineSettings = (over: Partial<EngineSettings> = {}): EngineSettings => ({
  issues: {
    sink: { enabled: true, sensitivity: 1, notifyStages: [true, true, true] },
    headForward: { enabled: true, sensitivity: 1, notifyStages: [true, true, true] },
    lean: { enabled: true, sensitivity: 1, notifyStages: [true, true, true] },
    tooClose: { enabled: true, sensitivity: 1, notifyStages: [true, true, true] }
  },
  dwellSeconds: 12,
  cooldownMinutes: 3,
  escalation: true,
  ...over
})

export type PostureFn = (tMs: number, i: number) => PostureParams | null

export interface RunSetupOptions extends SetupOptions {
  maxMs?: number
  startMs?: number
  session?: SetupSession
  /**
   * A simulated cloud reviewer: when the session stops in 'reviewing', 'accept' confirms the
   * capture (the simulator knows the posture is good) and the run continues to 'done'.
   * Default: none (the run stops in 'reviewing').
   */
  reviewer?: 'accept'
  /** press "Save this posture anyway" as soon as the session offers it (default false) */
  force?: boolean
}

/**
 * Drive a SetupSession until it settles (done / failed / reviewing) or `maxMs` passes.
 *
 * The local judge only saves what it can verify from the camera: a good posture seen from a
 * view that cannot verify an essential check waits in 'coaching' (needsVerification) unless a
 * reviewer confirms it — tests that just need a baseline use `review: 'auto', reviewer: 'accept'`
 * (what a connected cloud model does with a good posture).
 */
export function runSetup(
  sim: PoseSim,
  pose: PostureFn | PostureParams = posture(),
  opts: RunSetupOptions = {}
): { session: SetupSession; state: SetupState; tMs: number; phases: string[] } {
  const { maxMs: max, startMs, session: given, reviewer, force, ...setupOpts } = opts
  const session = given ?? new SetupSession({ now: () => 0, ...setupOpts })
  const maxMs = max ?? 30_000
  let t = startMs ?? 0
  const phases: string[] = []
  let state = session.state
  for (let i = 0; t < (startMs ?? 0) + maxMs; i++, t += STEP_MS) {
    const p = typeof pose === 'function' ? pose(t, i) : pose
    const frame: Frame = p === null ? null : sim.render(p)
    state = session.push(frame, t)
    if (phases[phases.length - 1] !== state.phase) phases.push(state.phase)
    if (state.phase === 'reviewing' && reviewer === 'accept') {
      session.acceptReview()
      state = session.state
      phases.push(state.phase)
    }
    if (force && state.canForce && state.phase !== 'capturing' && !state.forced) {
      session.force()
      state = session.state
      if (phases[phases.length - 1] !== state.phase) phases.push(state.phase)
    }
    if (state.phase === 'done' || state.phase === 'failed' || state.phase === 'reviewing') break
  }
  return { session, state, tMs: t, phases }
}

/**
 * runSetup options for a test that just needs a baseline of a GOOD posture, the way the app
 * gets one with a cloud model connected: the local judge saves what it can verify; a capture it
 * cannot verify from this camera goes to the (simulated) reviewer, which confirms it.
 */
export const CONFIRMED: RunSetupOptions = { review: 'auto', reviewer: 'accept' }

/**
 * A baseline for this camera and posture, the way the app gets one: the local judge saves it
 * when it can verify it; otherwise a (simulated) cloud reviewer confirms it.
 */
export function calibrate(sim: PoseSim, pose: PostureParams = posture()): CalibrationBaseline | null {
  const { state } = runSetup(sim, pose, { review: 'auto', reviewer: 'accept' })
  return state.phase === 'done' ? state.baseline : null
}

/** Run the engine from `fromMs` (inclusive) to `toMs` (exclusive). */
export function runEngine(
  engine: PostureEngine,
  sim: PoseSim,
  pose: PostureFn | PostureParams | null,
  fromMs: number,
  toMs: number
): { alerts: PostureAlert[]; snapshot: PostureSnapshot } {
  const alerts: PostureAlert[] = []
  let snapshot!: PostureSnapshot
  let i = 0
  for (let t = fromMs; t < toMs; t += STEP_MS, i++) {
    const p = typeof pose === 'function' ? pose(t, i) : pose
    const r = engine.processFrame(p === null ? null : sim.render(p), t)
    alerts.push(...r.alerts)
    snapshot = r.snapshot
  }
  return { alerts, snapshot }
}
