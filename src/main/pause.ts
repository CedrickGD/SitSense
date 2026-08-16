import { powerSaveBlocker } from 'electron'
import type { PauseState } from '../shared/ipc'

type Listener = (p: PauseState) => void

let paused = false
let resumeAt: number | null = null
let resumeTimer: NodeJS.Timeout | null = null
let blockerId: number | null = null
const listeners = new Set<Listener>()

export function getPauseState(): PauseState {
  return { paused, resumeAt }
}

/** minutes: 15/30/60, null = until manually resumed. */
export function setPause(nextPaused: boolean, minutes: number | null = null): PauseState {
  if (resumeTimer) {
    clearTimeout(resumeTimer)
    resumeTimer = null
  }
  paused = nextPaused
  if (paused && minutes && minutes > 0) {
    resumeAt = Date.now() + minutes * 60_000
    resumeTimer = setTimeout(() => setPause(false), minutes * 60_000)
  } else {
    resumeAt = null
  }
  syncPowerSaveBlocker()
  const state = getPauseState()
  for (const l of listeners) l(state)
  return state
}

export function onPauseChanged(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** While monitoring (not paused), keep Windows from suspending the app. */
function syncPowerSaveBlocker(): void {
  if (!paused && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (paused && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

export function initPowerSaveBlocker(): void {
  syncPowerSaveBlocker()
}
