import { app, ipcMain } from 'electron'
import { IPC, type AppStatus, type WindowControlAction } from '../shared/ipc'
import type { DetectionStatus, PostureAlert, PostureSnapshot } from '../shared/posture'
import { applyAutostart } from './autostart'
import { fireAlert, testNotification } from './notifications'
import { getPauseState, setPause } from './pause'
import { getSettings, updateSettings } from './settings-store'
import { getTodayStats, statsPostureUpdate } from './stats'
import { refreshTray, trayPostureUpdate } from './tray'
import { getMainWindow, isMainWindowVisible, markQuitting, sendToRenderer } from './window'

let lastDetectionStatus: DetectionStatus | null = null

export function getLastDetectionStatus(): DetectionStatus | null {
  return lastDetectionStatus
}

export function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => getSettings())

  ipcMain.handle(IPC.settingsSet, (_e, patch: unknown) => {
    const merged = updateSettings(patch)
    applyAutostart(merged)
    sendToRenderer(IPC.settingsChanged, merged)
    refreshTray()
    return merged
  })

  ipcMain.handle(IPC.appGetStatus, (): AppStatus => {
    return {
      version: app.getVersion(),
      pause: getPauseState(),
      packaged: app.isPackaged,
      windowVisible: isMainWindowVisible()
    }
  })

  ipcMain.handle(IPC.statsGetToday, () => getTodayStats())

  ipcMain.handle(IPC.notifyTest, () => testNotification())

  ipcMain.handle(IPC.pauseSet, (_e, paused: boolean, minutes: number | null) => {
    return setPause(paused, minutes)
  })

  ipcMain.handle(IPC.windowControl, (_e, action: WindowControlAction) => {
    const win = getMainWindow()
    if (!win) return
    if (action === 'minimize') win.minimize()
    else win.close() // intercepted by close-to-tray
  })

  ipcMain.handle(IPC.quitApp, () => {
    markQuitting()
    app.quit()
  })

  ipcMain.on(IPC.postureUpdate, (_e, snapshot: PostureSnapshot) => {
    trayPostureUpdate(snapshot)
    statsPostureUpdate(snapshot)
  })

  ipcMain.on(IPC.alertFire, (_e, alert: PostureAlert) => {
    fireAlert(alert)
  })

  ipcMain.on(IPC.detectionStatus, (_e, status: DetectionStatus) => {
    lastDetectionStatus = status
  })
}
