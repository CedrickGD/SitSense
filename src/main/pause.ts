import { join } from 'node:path'
import { app } from 'electron'
import type { PauseState } from '../shared/ipc'
import { readJson, writeJsonAtomic } from './json-file'

type Listener = (p: PauseState) => void

/** Who paused: the user (persisted, survives restarts) or the locked screen (temporary). */
type PauseReason = 'user' | 'lock'

/** longest timed pause accepted; also keeps setTimeout below its 2^31-1 ms limit */
const MAX_PAUSE_MINUTES = 24 * 60

let paused = false
let resumeAt: number | null = null
let reason: PauseReason | null = null
let resumeTimer: NodeJS.Timeout | null = null
const listeners = new Set<Listener>()

const pauseFile = (): string => join(app.getPath('userData'), 'pause.json')

export function getPauseState(): PauseState {
  return { paused, resumeAt }
}

/** minutes: 15/30/60 (1–1440), null = until manually resumed. */
export function setPause(nextPaused: boolean, minutes: number | null = null): PauseState {
  const valid = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
  const until = nextPaused && valid ? Date.now() + Math.min(minutes, MAX_PAUSE_MINUTES) * 60_000 : null
  return apply(nextPaused, until, 'user')
}

/** Locking the session releases the camera; unlocking brings it back — unless the user had paused. */
export function pauseForLock(): void {
  if (!paused) apply(true, null, 'lock')
}

export function resumeAfterUnlock(): void {
  if (paused && reason === 'lock') apply(false, null, 'lock')
}

function apply(nextPaused: boolean, until: number | null, why: PauseReason): PauseState {
  if (resumeTimer) {
    clearTimeout(resumeTimer)
    resumeTimer = null
  }
  paused = nextPaused
  resumeAt = paused ? until : null
  reason = paused ? why : null
  if (paused && resumeAt !== null) {
    resumeTimer = setTimeout(reconcilePause, Math.max(0, resumeAt - Date.now()))
  }
  persist()
  const state = getPauseState()
  for (const l of listeners) l(state)
  return state
}

/** Only a user's pause is remembered — a lock-screen pause must not outlive the session. */
function persist(): void {
  try {
    writeJsonAtomic(pauseFile(), reason === 'user' ? { paused, resumeAt } : { paused: false, resumeAt: null })
  } catch (err) {
    console.error('[pause] save failed:', err)
  }
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
  if (paused && resumeAt !== null && Date.now() >= resumeAt) apply(false, null, 'user')
}

/**
 * Restores a pause from the last session ("Until I resume" is a privacy
 * switch — a reboot must not silently turn the camera back on), then keeps
 * timed pauses honest. Call before the window is created.
 */
export function initPause(): void {
  const saved = readJson(pauseFile()) as Partial<PauseState> | null
  if (saved?.paused === true) {
    const until = typeof saved.resumeAt === 'number' && Number.isFinite(saved.resumeAt) ? saved.resumeAt : null
    if (until === null) apply(true, null, 'user')
    else if (until > Date.now()) apply(true, Math.min(until, Date.now() + MAX_PAUSE_MINUTES * 60_000), 'user')
  }
  setInterval(reconcilePause, 30_000)
}
