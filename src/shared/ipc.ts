import type { DetectionStatus, PostureAlert, PostureSnapshot, TodayStats } from './posture'
import type { Settings } from './settings'

/**
 * Single source of truth for every IPC channel and its payloads.
 * Preload exposes exactly this surface; the renderer never touches ipcRenderer.
 */
export const IPC = {
  // renderer → main, invoke (request/response)
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appGetStatus: 'app:get-status',
  statsGetToday: 'stats:get-today',
  notifyTest: 'notify:test',
  pauseSet: 'pause:set',
  windowControl: 'window:control',
  quitApp: 'app:quit',

  // renderer → main, send (fire-and-forget)
  postureUpdate: 'posture:update',
  alertFire: 'alert:fire',
  detectionStatus: 'detection:status',

  // main → renderer, send
  settingsChanged: 'settings:changed',
  pauseChanged: 'pause:changed',
  requestCalibration: 'control:calibrate',
  navigate: 'control:navigate',
  systemResumed: 'system:resumed'
} as const

export type AppRoute = 'dashboard' | 'calibrate' | 'settings'

export interface PauseState {
  paused: boolean
  /** epoch ms when monitoring auto-resumes, null = until manually resumed */
  resumeAt: number | null
}

export interface AppStatus {
  version: string
  pause: PauseState
  packaged: boolean
}

export type WindowControlAction = 'minimize' | 'hide'

/** API surface exposed on window.sitsense by the preload script. */
export interface SitSenseApi {
  getSettings(): Promise<Settings>
  /** deep-partial patch; returns the merged result after main persists it */
  setSettings(patch: unknown): Promise<Settings>
  getAppStatus(): Promise<AppStatus>
  getTodayStats(): Promise<TodayStats>
  testNotification(): Promise<void>
  /** minutes: 15/30/60, null = until resumed; pass paused=false to resume */
  setPause(paused: boolean, minutes?: number | null): Promise<PauseState>
  windowControl(action: WindowControlAction): Promise<void>
  quitApp(): Promise<void>

  sendPostureUpdate(snapshot: PostureSnapshot): void
  sendAlert(alert: PostureAlert): void
  sendDetectionStatus(status: DetectionStatus): void

  onSettingsChanged(cb: (s: Settings) => void): () => void
  onPauseChanged(cb: (p: PauseState) => void): () => void
  onRequestCalibration(cb: () => void): () => void
  onNavigate(cb: (route: AppRoute) => void): () => void
  onSystemResumed(cb: () => void): () => void
}
