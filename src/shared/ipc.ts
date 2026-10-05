import type { AiChatReply, AiChatRequest, AiConnection, AiModelList, AiPostureReview, AiReviewRequest, AiTestResult } from './ai'
import type { DetectionStatus, PostureAlert, PostureSnapshot, TodayStats } from './posture'
import type { Settings } from './settings'
import type { StatsRange } from './stats'
import type { UpdateStatus } from './update'

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
  aiSaveConnection: 'ai:save-connection',
  aiRemoveConnection: 'ai:remove-connection',
  aiMoveConnection: 'ai:move-connection',
  aiTestConnection: 'ai:test-connection',
  aiListModels: 'ai:list-models',
  aiReviewPosture: 'ai:review-posture',
  aiChat: 'ai:chat',
  statsGetRange: 'stats:get-range',
  breakSnooze: 'breaks:snooze',
  updateGetState: 'update:get-state',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',

  // renderer → main, send (fire-and-forget)
  postureUpdate: 'posture:update',
  alertFire: 'alert:fire',
  detectionStatus: 'detection:status',

  // main → renderer, send
  settingsChanged: 'settings:changed',
  pauseChanged: 'pause:changed',
  requestCalibration: 'control:calibrate',
  navigate: 'control:navigate',
  systemResumed: 'system:resumed',
  windowVisibility: 'window:visibility',
  sittingChanged: 'breaks:sitting',
  updateState: 'update:state'
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
  /** main window is shown and not minimized (tray-hidden = false) */
  windowVisible: boolean
  /** continuous sitting / break reminder state */
  sitting: SittingState
}

/**
 * Continuous sitting time, tracked in main from posture snapshots. A break is
 * ≥ 3 min away from the desk, paused or not detecting; shorter absences don't
 * reset the timer.
 */
export interface SittingState {
  /** whole minutes of the current sitting stretch (0 when not sitting) */
  sittingMinutes: number
  /** epoch ms the stretch started, null when not sitting */
  sittingSince: number | null
  /**
   * the user stepped away (or monitoring is paused) — a break may be under way. False
   * until a sitting stretch has existed: an empty chair at launch is not a break.
   */
  onBreak: boolean
  /**
   * epoch ms the current break began: the absence start during a stretch, the stretch end
   * after one; null when not on a break or before any stretch has ended
   */
  breakSince: number | null
  /** epoch ms of the next stand-up reminder, null when reminders are off or not sitting */
  nextReminderAt: number | null
  /** breaks taken today */
  breaksToday: number
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

  // ── connected AI models (docs/specs/ai-providers.md §4); keys go in, never come back ──
  /**
   * Create (no id) or update (existing id) a connection. key: undefined or '' = keep,
   * null = delete, string = set (encrypted in main). Rejects with a short message on
   * invalid input — read it with aiErrorMessage() from shared/ai.
   */
  aiSaveConnection(conn: Partial<AiConnection> & { id?: string }, key?: string | null): Promise<Settings>
  /** also deletes the connection's stored key */
  aiRemoveConnection(id: string): Promise<Settings>
  /** priority order: -1 = up, 1 = down */
  aiMoveConnection(id: string, delta: -1 | 1): Promise<Settings>
  /** cheap/free check; updates the connection's lastTest; may switch a Google connection's kind (see switchedKind) */
  aiTestConnection(id: string): Promise<AiTestResult>
  aiListModels(id: string): Promise<AiModelList>
  aiReviewPosture(req: AiReviewRequest): Promise<AiPostureReview>
  /** Coach chat: one answer to the conversation (docs/specs/ai-providers.md §7). Never rejects. */
  aiChat(req: AiChatRequest): Promise<AiChatReply>

  /** per-day history for the last `days` local days (1..90, today included), oldest first */
  getStatsRange(days: number): Promise<StatsRange>
  /** postpone the stand-up reminder (default 10 min, 1..120); returns the new state */
  snoozeBreak(minutes?: number): Promise<SittingState>

  // ── app updates from GitHub Releases (src/main/updater.ts; architecture.md §2 "App updates") ──
  /** current update status (mode, state, last check) */
  updateGetState(): Promise<UpdateStatus>
  /** check now (the user pressed "Check for updates"); allowed with auto-check off */
  updateCheck(): Promise<UpdateStatus>
  /** state 'available': installed → download now; portable → open the release page in the browser */
  updateDownload(): Promise<UpdateStatus>
  /** state 'ready' (installed): restart and install; resolves false when there is nothing to install */
  updateInstall(): Promise<boolean>

  sendPostureUpdate(snapshot: PostureSnapshot): void
  sendAlert(alert: PostureAlert): void
  sendDetectionStatus(status: DetectionStatus): void

  onSettingsChanged(cb: (s: Settings) => void): () => void
  onPauseChanged(cb: (p: PauseState) => void): () => void
  onRequestCalibration(cb: () => void): () => void
  onNavigate(cb: (route: AppRoute) => void): () => void
  onSystemResumed(cb: () => void): () => void
  onWindowVisibility(cb: (visible: boolean) => void): () => void
  /** sitting state changed (once a minute while sitting, and on break/reminder changes) */
  onSittingChanged(cb: (s: SittingState) => void): () => void
  /** update status changed (checking, progress, ready, error …) */
  onUpdateState(cb: (s: UpdateStatus) => void): () => void
}
