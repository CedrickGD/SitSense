import { join } from 'node:path'
import { Menu, nativeImage, Tray } from 'electron'
import {
  ISSUE_LABELS,
  ISSUES,
  type DetectionStatus,
  type PostureSnapshot,
  type TrayState
} from '../shared/posture'
import { stageLabel } from './notifications'
import { getPauseState } from './pause'
import { resourcesDir } from './resources'

export interface TrayCallbacks {
  onOpen: () => void
  onPause: (minutes: number | null) => void
  onResume: () => void
  onRecalibrate: () => void
  onSettings: () => void
  onQuit: () => void
}

// keep the Tray referenced for the process lifetime — GC'd trays vanish
let tray: Tray | null = null
let icons: Partial<Record<TrayState, Electron.NativeImage>> = {}
let callbacks: TrayCallbacks | null = null
let lastSnapshot: PostureSnapshot | null = null
let lastUpdateAt = 0
let cameraError: DetectionStatus['cameraError'] = null
let modelError = false
/** snapshots older than this say nothing about the present (pause, sleep, stalled renderer) */
const STALE_MS = 10_000
let currentState: TrayState = 'off'
let staleTimer: NodeJS.Timeout | null = null
let countdownTimer: NodeJS.Timeout | null = null

const ICON_FILES: Record<TrayState, string> = {
  good: 'tray-good.ico',
  warn: 'tray-warn.ico',
  bad: 'tray-bad.ico',
  paused: 'tray-paused.ico',
  away: 'tray-away.ico',
  off: 'tray-away.ico'
}

export function createTray(cb: TrayCallbacks): void {
  callbacks = cb
  for (const state of Object.keys(ICON_FILES) as TrayState[]) {
    icons[state] = nativeImage.createFromPath(join(resourcesDir(), 'tray', ICON_FILES[state]))
  }
  tray = new Tray(icons.off ?? nativeImage.createEmpty())
  tray.on('click', () => callbacks?.onOpen())
  // if the renderer stalls or hasn't started, the tray must not lie
  staleTimer = setInterval(() => {
    if (lastSnapshot && Date.now() - lastUpdateAt > STALE_MS) {
      lastSnapshot = null
      refreshTray()
    }
  }, 5_000)
  refreshTray()
}

export function destroyTray(): void {
  if (staleTimer) clearInterval(staleTimer)
  if (countdownTimer) clearInterval(countdownTimer)
  tray?.destroy()
  tray = null
}

export function trayPostureUpdate(snapshot: PostureSnapshot): void {
  lastSnapshot = snapshot
  lastUpdateAt = Date.now()
  refreshTray()
}

export function trayDetectionStatus(status: DetectionStatus): void {
  const nextModelError = status.modelError === true
  if (status.cameraError === cameraError && nextModelError === modelError) return
  cameraError = status.cameraError
  modelError = nextModelError
  refreshTray()
}

/** The last snapshot, if it still describes the present. */
function current(): PostureSnapshot | null {
  return lastSnapshot && Date.now() - lastUpdateAt <= STALE_MS ? lastSnapshot : null
}

let lastStatusText = ''

export function refreshTray(): void {
  if (!tray) return
  const state = computeState()
  if (state !== currentState) {
    currentState = state
    const icon = icons[state]
    if (icon) tray.setImage(icon)
  }
  // rebuild the (immutable) menu only when its content actually changed —
  // replacing it on every posture update can close an open menu mid-click
  const status = statusText()
  if (status !== lastStatusText) {
    lastStatusText = status
    tray.setToolTip(`SitSense — ${status}`)
    rebuildMenu()
  }
  syncCountdownTimer()
}

const CAMERA_ERROR_TEXT: Record<Exclude<DetectionStatus['cameraError'], null>, string> = {
  'in-use': 'camera in use by another app',
  denied: 'camera blocked in Windows privacy settings',
  'not-found': 'no camera found'
}

function computeState(): TrayState {
  if (getPauseState().paused) return 'paused'
  const snap = current()
  if (cameraError || modelError || !snap || !snap.calibrated || snap.recalibrationSuggested) return 'off'
  if (snap.presence === 'away') return 'away'
  if (snap.worstStage >= 3) return 'bad'
  if (snap.worstStage >= 1) return 'warn'
  return 'good'
}

function statusText(): string {
  const pause = getPauseState()
  if (pause.paused) {
    return pause.resumeAt ? `paused, resumes in ${minutesLeft(pause.resumeAt)}` : 'paused'
  }
  if (cameraError) return CAMERA_ERROR_TEXT[cameraError]
  if (modelError) return "posture model couldn't load, retrying"
  const snap = current()
  if (!snap) return 'not detecting'
  if (!snap.calibrated) return 'not calibrated'
  if (snap.recalibrationSuggested) return 'camera view changed, recalibrate'
  if (snap.presence === 'away') return 'away'
  if (snap.worstStage === 0) return 'good posture'
  let worst = snap.issues[ISSUES[0]]
  for (const id of ISSUES) if (snap.issues[id].stage > worst.stage) worst = snap.issues[id]
  const minutes = worst.activeForMs !== null ? Math.floor(worst.activeForMs / 60_000) : 0
  return `${ISSUE_LABELS[worst.issue]} (${stageLabel(worst.stage)})${minutes >= 1 ? `, ${minutes} min` : ''}`
}

function minutesLeft(resumeAt: number): string {
  const mins = Math.max(1, Math.ceil((resumeAt - Date.now()) / 60_000))
  return `${mins} min`
}

function rebuildMenu(): void {
  if (!tray || !callbacks) return
  const pause = getPauseState()
  const pauseItem: Electron.MenuItemConstructorOptions = pause.paused
    ? {
        label: pause.resumeAt
          ? `Resume monitoring (${minutesLeft(pause.resumeAt)} left)`
          : 'Resume monitoring',
        click: () => callbacks?.onResume()
      }
    : {
        label: 'Pause',
        submenu: [
          { label: '15 minutes', click: () => callbacks?.onPause(15) },
          { label: '30 minutes', click: () => callbacks?.onPause(30) },
          { label: '60 minutes', click: () => callbacks?.onPause(60) },
          { label: 'Until I resume', click: () => callbacks?.onPause(null) }
        ]
      }

  const menu = Menu.buildFromTemplate([
    { label: statusText(), enabled: false },
    { type: 'separator' },
    { label: 'Open SitSense', click: () => callbacks?.onOpen() },
    pauseItem,
    { label: 'Recalibrate', click: () => callbacks?.onRecalibrate() },
    { label: 'Settings', click: () => callbacks?.onSettings() },
    { type: 'separator' },
    { label: 'Quit SitSense', click: () => callbacks?.onQuit() }
  ])
  tray.setContextMenu(menu)
}

/** While paused with a resume time, keep the countdown label fresh. */
function syncCountdownTimer(): void {
  const pause = getPauseState()
  if (pause.paused && pause.resumeAt && !countdownTimer) {
    countdownTimer = setInterval(() => refreshTray(), 30_000)
  } else if ((!pause.paused || !pause.resumeAt) && countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}
