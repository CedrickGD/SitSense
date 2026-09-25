import { app, ipcMain, shell } from 'electron'
import { IPC, type AppStatus, type SystemSettingsPage, type WindowControlAction } from '../shared/ipc'
import { applyAutostart } from './autostart'
import { fireAlert, notificationsPostureUpdate, testNotification } from './notifications'
import { getPauseState, setPause } from './pause'
import { getSettings, updateSettings } from './settings-store'
import { getTodayStats, statsPostureUpdate } from './stats'
import { refreshTray, trayDetectionStatus, trayPostureUpdate } from './tray'
import { isDetectionStatus, isPauseRequest, isPostureAlert, isPostureSnapshot } from './validate'
import { getMainWindow, isMainWindowVisible, markQuitting, sendToRenderer } from './window'

/** the only URIs the renderer can make the shell open */
const SYSTEM_SETTINGS: Record<SystemSettingsPage, string> = {
  'camera-privacy': 'ms-settings:privacy-webcam',
  camera: 'ms-settings:camera'
}

export function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => getSettings())

  ipcMain.handle(IPC.settingsSet, (_e, patch: unknown) => {
    const wasAutostart = getSettings().general.launchOnStartup
    const merged = updateSettings(patch)
    // only a real toggle touches the Run key — slider drags must not rewrite it
    if (merged.general.launchOnStartup !== wasAutostart) applyAutostart(merged)
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

  ipcMain.handle(IPC.pauseSet, (_e, paused: unknown, minutes: unknown) => {
    if (!isPauseRequest(paused, minutes)) return getPauseState()
    return setPause(paused as boolean, (minutes as number | null | undefined) ?? null)
  })

  ipcMain.handle(IPC.windowControl, (_e, action: WindowControlAction) => {
    const win = getMainWindow()
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'hide') win.close() // intercepted by close-to-tray
  })

  ipcMain.handle(IPC.openSystemSettings, (_e, page: unknown) => {
    const uri = SYSTEM_SETTINGS[page as SystemSettingsPage]
    if (typeof uri === 'string' && process.platform === 'win32') void shell.openExternal(uri)
  })

  ipcMain.handle(IPC.quitApp, () => {
    markQuitting()
    app.quit()
  })

  ipcMain.on(IPC.postureUpdate, (_e, snapshot: unknown) => {
    if (!isPostureSnapshot(snapshot)) return
    trayPostureUpdate(snapshot)
    statsPostureUpdate(snapshot)
    notificationsPostureUpdate(snapshot)
  })

  ipcMain.on(IPC.alertFire, (_e, alert: unknown) => {
    if (isPostureAlert(alert)) fireAlert(alert)
  })

  ipcMain.on(IPC.detectionStatus, (_e, status: unknown) => {
    if (!isDetectionStatus(status)) return
    trayDetectionStatus(status)
  })
}
