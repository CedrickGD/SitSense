// MUST stay the first import: moves unpackaged (dev) runs to their own userData
// before anything reads it or takes the single-instance lock (see dev-profile.ts)
import './dev-profile'
import { basename } from 'node:path'
import { app, Notification, powerMonitor } from 'electron'
import { IPC } from '../shared/ipc'
import { handleAppProtocol, registerAppScheme } from './app-protocol'
import { applyAutostart } from './autostart'
import { initBreaks } from './breaks'
import { registerIpc } from './ipc'
import { trayHint } from './notifications'
import { initPauseReconciler, onPauseChanged, reconcilePause, setPause } from './pause'
import { getSettings, getSettingsLoadIssue, loadSettings, saveNow, updateSettings, type SettingsLoadIssue } from './settings-store'
import { initStats, stopStats } from './stats'
import { createTray, destroyTray, refreshTray } from './tray'
import { initUpdater, readyUpdateVersion } from './updater-init'
import { createMainWindow, markQuitting, sendToRenderer, showMainWindow } from './window'

// AUMID must match electron-builder appId — Windows attributes toasts through it.
app.setAppUserModelId('com.cedrickgd.sitsense')

/** set once settings and stats are loaded — before that, a flush would write defaults over the user's files */
let stateLoaded = false

/**
 * Persist the in-progress stats minute and any debounced settings patch.
 * Synchronous fs only, so it completes inside a session-end handler. Safe to
 * call more than once (stopStats/saveNow are idempotent).
 */
function flushState(): void {
  if (!stateLoaded) return
  stopStats()
  saveNow()
}

/** Toast copy telling the user their settings file was not used this launch (null = nothing to say). */
export function settingsLoadIssueMessage(issue: SettingsLoadIssue | null): { title: string; body: string } | null {
  if (!issue) return null
  if (issue.kind === 'unreadable') {
    return {
      title: 'SitSense couldn’t read your settings',
      body: `Using default settings for now (${issue.code}). Your settings file was left untouched and will be read again next launch.`
    }
  }
  if (issue.backup) {
    return {
      title: 'SitSense settings were reset',
      body: `Your settings file was damaged, so defaults are in use. The old file was kept as ${basename(issue.backup)} in the SitSense data folder; your saved AI keys are kept until you restore or delete it.`
    }
  }
  return {
    title: 'SitSense settings are damaged',
    body: 'Your settings file is damaged and couldn’t be backed up, so defaults are in use and the file won’t be overwritten.'
  }
}

/** Surface a settings load problem once per launch (the console alone is invisible in a tray app). */
function notifySettingsLoadIssue(): void {
  const msg = settingsLoadIssueMessage(getSettingsLoadIssue())
  if (!msg || !Notification.isSupported()) return
  const n = new Notification({ title: msg.title, body: msg.body })
  n.on('click', () => showMainWindow())
  n.show()
}

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
    initBreaks()
    stateLoaded = true
    initPauseReconciler()

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
      },
      updateReady: () => readyUpdateVersion(),
      onInstallUpdate: () => initUpdater().install()
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

    // Windows shutdown / restart / logoff (and Restart Manager 'close-app', e.g. an
    // installer upgrade) do NOT emit before-quit/will-quit/quit — and 'session-end'
    // is a BrowserWindow event, never emitted on `app`. The window gets
    // WM_ENDSESSION even while hidden in the tray; the process is killed right
    // after this handler returns, so flush synchronously here. Restart Manager only
    // *asks* an app to exit (a non-forced close-app does not kill it), and the flush
    // has stopped stats sampling for good — so quit explicitly rather than linger
    // in the tray recording nothing. will-quit's second flush is a no-op.
    win.on('session-end', () => {
      markQuitting()
      flushState()
      app.quit()
    })

    notifySettingsLoadIssue()

    // update checks (GitHub Releases): 30 s after start, then every 6 h, only while
    // settings.updates.autoCheck is on; never in an unpackaged run
    initUpdater().start()

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

    // Linux/macOS only (documented as such) — harmless on Windows, kept so the
    // flush doesn't depend on which OS path ends the session
    powerMonitor.on('shutdown', () => {
      markQuitting()
      flushState()
    })
  })

  // the tray keeps the app alive; quitting happens only via the tray menu
  app.on('window-all-closed', () => {
    /* keep running */
  })

  app.on('before-quit', () => {
    markQuitting()
  })

  // regular quit (tray menu, app:quit IPC): windows are closed, flush before exit
  app.on('will-quit', () => {
    flushState()
  })

  app.on('quit', () => {
    destroyTray()
  })
}
