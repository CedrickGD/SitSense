import { join } from 'node:path'
import { Menu, nativeImage, Tray } from 'electron'
import {
  ISSUE_LABELS,
  type PostureSnapshot,
  type TrayState
} from '../shared/posture'
import { stageLabel } from './notifications'
import { getPauseState, onPauseChanged } from './pause'
import { resourcesDir } from './resources'

export interface TrayCallbacks {
  onOpen: () => void
  onPause: (minutes: number | null) => void
  onResume: () => void
  onRecalibrate: () => void
  onSettings: () => void
  onQuit: () => void
  /** version of a downloaded update waiting for a restart, else null (src/main/updater.ts) */
  updateReady?: () => string | null
  /** "Restart to update" */
  onInstallUpdate?: () => void
}

// keep the Tray referenced for the process lifetime — GC'd trays vanish
let tray: Tray | null = null
let icons: Partial<Record<TrayState, Electron.NativeImage>> = {}
let callbacks: TrayCallbacks | null = null
let lastSnapshot: PostureSnapshot | null = null
let lastUpdateAt = 0
let currentState: TrayState = 'off'
let staleTimer: NodeJS.Timeout | null = null
let countdownTimer: NodeJS.Timeout | null = null
let unsubscribePause: (() => void) | null = null

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
    if (!getPauseState().paused && lastUpdateAt && Date.now() - lastUpdateAt > 10_000) {
      lastSnapshot = null
      refreshTray()
    }
  }, 5_000)
  // a snapshot from before a pause must not be shown after resuming: until the
  // renderer reports again, the tray says "not detecting" instead of old posture
  unsubscribePause?.()
  unsubscribePause = onPauseChanged(() => {
    lastSnapshot = null
    lastUpdateAt = 0
    refreshTray()
  })
  refreshTray()
}

export function destroyTray(): void {
  if (staleTimer) clearInterval(staleTimer)
  if (countdownTimer) clearInterval(countdownTimer)
  staleTimer = null
  countdownTimer = null
  unsubscribePause?.()
  unsubscribePause = null
  tray?.destroy()
  tray = null
  // a recreated Tray starts with no icon/menu — force a full refresh next time
  currentState = 'off'
  lastStatusText = ''
  lastUpdateReady = null
  lastSnapshot = null
  lastUpdateAt = 0
}

export function trayPostureUpdate(snapshot: PostureSnapshot): void {
  lastSnapshot = snapshot
  lastUpdateAt = Date.now()
  refreshTray()
}

let lastStatusText = ''
let lastUpdateReady: string | null = null

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
  const update = callbacks?.updateReady?.() ?? null
  if (status !== lastStatusText || update !== lastUpdateReady) {
    lastStatusText = status
    lastUpdateReady = update
    tray.setToolTip(`SitSense — ${status}${update ? ` · update ${update} ready` : ''}`)
    rebuildMenu()
  }
  syncCountdownTimer()
}

function computeState(): TrayState {
  if (getPauseState().paused) return 'paused'
  if (!lastSnapshot) return 'off'
  if (!lastSnapshot.calibrated) return 'off'
  if (lastSnapshot.presence === 'away') return 'away'
  // nothing is judged while the view is far off the setup distance: neutral, not "good"
  if (lastSnapshot.suspended === true) return 'off'
  if (lastSnapshot.worstStage >= 3) return 'bad'
  if (lastSnapshot.worstStage >= 1) return 'warn'
  return 'good'
}

function statusText(): string {
  const pause = getPauseState()
  if (pause.paused) {
    return pause.resumeAt ? `paused, resumes in ${minutesLeft(pause.resumeAt)}` : 'paused'
  }
  if (!lastSnapshot) return 'not detecting'
  if (!lastSnapshot.calibrated) return 'not calibrated'
  if (lastSnapshot.presence === 'away') return 'away'
  if (lastSnapshot.suspended === true) return 'view changed — redo posture setup'
  if (lastSnapshot.worstStage === 0) return 'good posture'
  const worst = Object.values(lastSnapshot.issues).reduce((a, b) => (b.stage > a.stage ? b : a))
  return `${ISSUE_LABELS[worst.issue]} (${stageLabel(worst.stage)})`
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

  const update = callbacks?.updateReady?.() ?? null
  const updateItems: Electron.MenuItemConstructorOptions[] = update
    ? [{ label: 'Restart to update', toolTip: `Installs SitSense ${update}`, click: () => callbacks?.onInstallUpdate?.() }]
    : []

  const menu = Menu.buildFromTemplate([
    { label: statusText(), enabled: false },
    { type: 'separator' },
    { label: 'Open SitSense', click: () => callbacks?.onOpen() },
    ...updateItems,
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
