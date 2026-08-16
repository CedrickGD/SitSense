import { app, powerMonitor } from 'electron'
import { IPC } from '../shared/ipc'
import { handleAppProtocol, registerAppScheme } from './app-protocol'
import { applyAutostart } from './autostart'
import { registerIpc } from './ipc'
import { trayHint } from './notifications'
import { initPowerSaveBlocker, onPauseChanged, reconcilePause, setPause } from './pause'
import { getSettings, loadSettings, saveNow, updateSettings } from './settings-store'
import { initStats, stopStats } from './stats'
import { createTray, destroyTray, refreshTray } from './tray'
import { createMainWindow, markQuitting, sendToRenderer, showMainWindow } from './window'

// AUMID must match electron-builder appId — Windows attributes toasts through it.
app.setAppUserModelId('com.cedrickgd.sitsense')

// must run before app.whenReady()
registerAppScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(() => {
    handleAppProtocol()
    const settings = loadSettings()
    applyAutostart(settings)
    registerIpc()
    initStats()
    initPowerSaveBlocker()

    createTray({
      onOpen: () => showMainWindow(),
      onPause: (minutes) => setPause(true, minutes),
      onResume: () => setPause(false),
      onRecalibrate: () => {
        showMainWindow()
        sendToRenderer(IPC.requestCalibration)
      },
      onSettings: () => {
        showMainWindow()
        sendToRenderer(IPC.navigate, 'settings')
      },
      onQuit: () => {
        markQuitting()
        app.quit()
      }
    })

    const startHidden = process.argv.includes('--hidden') || settings.general.startHidden
    createMainWindow({
      startHidden,
      firstHideHint: () => {
        if (!getSettings().onboarded) {
          trayHint()
          updateSettings({ onboarded: true })
        }
      }
    })

    onPauseChanged((state) => {
      sendToRenderer(IPC.pauseChanged, state)
      refreshTray()
    })

    // camera streams often die silently across sleep/resume — renderer reacquires;
    // timed pauses are reconciled against their wall-clock deadline
    powerMonitor.on('resume', () => {
      reconcilePause()
      sendToRenderer(IPC.systemResumed)
    })
  })

  // Windows shutdown/logoff must not be blocked by the close-to-tray handler
  app.on('session-end' as never, () => {
    markQuitting()
    app.quit()
  })

  // the tray keeps the app alive; quitting happens only via the tray menu
  app.on('window-all-closed', () => {
    /* keep running */
  })

  app.on('before-quit', () => {
    markQuitting()
  })

  app.on('quit', () => {
    stopStats()
    saveNow()
    destroyTray()
  })
}
