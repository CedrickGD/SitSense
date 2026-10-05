import type { PauseState } from '../shared/ipc'

type Listener = (p: PauseState) => void

/** Longest timed pause accepted (24 h); also keeps setTimeout far below its 2^31 ms overflow. */
export const MAX_PAUSE_MINUTES = 24 * 60
const RECONCILE_INTERVAL_MS = 30_000

let paused = false
let resumeAt: number | null = null
let resumeTimer: NodeJS.Timeout | null = null
let reconcileTimer: NodeJS.Timeout | null = null
const listeners = new Set<Listener>()

export function getPauseState(): PauseState {
  return { paused, resumeAt }
}

/**
 * minutes: 15/30/60 from the UI (any whole-ish duration in 1..MAX_PAUSE_MINUTES is
 * accepted), null = until manually resumed. Input arrives over IPC, so it is
 * validated here — a NaN/huge/negative value must never arm a bogus timer.
 */
export function setPause(nextPaused: boolean, minutes: number | null = null): PauseState {
  if (typeof nextPaused !== 'boolean') {
    throw new TypeError(`setPause: paused must be a boolean, got ${typeof nextPaused}`)
  }
  if (
    minutes !== null &&
    (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_PAUSE_MINUTES)
  ) {
    throw new RangeError(`setPause: minutes must be null or in (0, ${MAX_PAUSE_MINUTES}], got ${String(minutes)}`)
  }
  if (resumeTimer) {
    clearTimeout(resumeTimer)
    resumeTimer = null
  }
  paused = nextPaused
  if (paused && minutes !== null) {
    resumeAt = Date.now() + minutes * 60_000
    resumeTimer = setTimeout(() => setPause(false), minutes * 60_000)
  } else {
    resumeAt = null
  }
  const state = getPauseState()
  for (const l of listeners) l(state)
  return state
}

export function onPauseChanged(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * setTimeout drifts across system sleep: the resumeAt deadline can pass while
 * the timer is suspended. Call this on powerMonitor resume (and periodically)
 * to honor the wall-clock deadline the UI shows.
 */
export function reconcilePause(): void {
  if (paused && resumeAt !== null && Date.now() >= resumeAt) setPause(false)
}

/**
 * Starts the periodic wall-clock reconcile of timed pauses. Idempotent.
 *
 * Deliberately NO powerSaveBlocker: a posture monitor must never keep Windows
 * awake. 'prevent-app-suspension' maps to a system-required power request on
 * Windows, which stops idle sleep all day (laptop drains, webcam films an empty
 * room overnight) while buying nothing — Windows does not suspend Win32 desktop
 * processes, and hidden-window renderer throttling is already disabled via
 * `backgroundThrottling: false`. When the machine does sleep, the powerMonitor
 * 'resume' path reconciles pauses and the renderer re-acquires the camera.
 */
export function initPauseReconciler(): void {
  if (reconcileTimer) return
  reconcileTimer = setInterval(reconcilePause, RECONCILE_INTERVAL_MS)
  reconcileTimer.unref?.()
}

/** @deprecated Kept for src/main/index.ts compatibility — no blocker is held any more. Use initPauseReconciler. */
export const initPowerSaveBlocker = initPauseReconciler

/** Test-only: reset module state between cases. */
export function __resetPauseForTests(): void {
  if (resumeTimer) clearTimeout(resumeTimer)
  if (reconcileTimer) clearInterval(reconcileTimer)
  resumeTimer = null
  reconcileTimer = null
  paused = false
  resumeAt = null
  listeners.clear()
}
