import { app, powerMonitor } from 'electron'
import { IPC } from '../shared/ipc'
import { handleAppProtocol, registerAppScheme } from './app-protocol'
import { reconcileAutostart } from './autostart'
import { registerIpc } from './ipc'
import { initNotifications, trayHint } from './notifications'
import { getPauseState, initPause, onPauseChanged, pauseForLock, reconcilePause, resumeAfterUnlock, setPause } from './pause'
import { getSettings, loadSettings, saveNow, updateSettings } from './settings-store'
import { lockDownNetwork } from './privacy'
import { initStats, stopStats } from './stats'
import { createTray, destroyTray, refreshTray } from './tray'
import { createMainWindow, markQuitting, sendToRenderer, showMainWindow } from './window'

// AUMID must match electron-builder appId — Windows attributes toasts through it.
app.setAppUserModelId('com.cedrickgd.sitsense')
// A fixed toast activator: with Electron's default (a new random CLSID per
// run), clicking a toast left in the Action Center from an earlier run — or
// its "Pause 15 min" button — can't reach this process.
if (process.platform === 'win32') app.setToastActivatorCLSID('{5B1D3C7E-2A94-4F6B-9E08-7C3A51D2E6F4}')

// a development run must not share the installed app's settings, stats or
// single-instance lock (the tray copy would swallow every `npm run dev`)
if (!app.isPackaged) app.setPath('userData', `${app.getPath('userData')}-dev`)

// must run before app.whenReady()
registerAppScheme()

// MediaPipe needs WebGL even on its CPU delegate (frames are uploaded as
// textures). Chromium no longer falls back to software GL on its own, so on a
// blocklisted driver, a VM or a GPU-less session detection would never start.
// SwiftShader is only used when no GPU works, and this renderer only ever runs
// the app's own bundled code with the network locked down.
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(() => {
    lockDownNetwork()
    handleAppProtocol()
    let settings = loadSettings()
    const autostartFix = reconcileAutostart(settings)
    if (autostartFix) settings = updateSettings({ general: autostartFix })
    registerIpc()
    initNotifications()
    initStats()
    initPause()

    createTray({
      onOpen: () => showMainWindow(),
      onPause: (minutes) => setPause(true, minutes),
      onResume: () => setPause(false),
      onRecalibrate: () => {
        // the wizard needs the camera — asking to recalibrate implies resuming
        if (getPauseState().paused) setPause(false)
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
    const win = createMainWindow({
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
    // release the camera cleanly before sleep instead of relying on the
    // post-resume restart to notice a stream that died silently
    powerMonitor.on('suspend', () => sendToRenderer(IPC.systemSuspend))
    powerMonitor.on('resume', () => {
      reconcilePause()
      sendToRenderer(IPC.systemResumed)
    })

    // nobody can sit at a locked PC: release the camera (LED off) until unlock
    powerMonitor.on('lock-screen', () => pauseForLock())
    powerMonitor.on('unlock-screen', () => resumeAfterUnlock())

    // Windows shutdown/logoff: before-quit/quit never fire, so flush here.
    // 'session-end' is a window event on win32; it must finish synchronously.
    win.on('session-end', () => {
      markQuitting()
      stopStats()
      saveNow()
    })
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
