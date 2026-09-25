import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import { devServerUrl } from './privacy'
import { getSettings } from './settings-store'

let mainWindow: BrowserWindow | null = null
let quitting = false
let onFirstHide: (() => void) | null = null

export function markQuitting(): void {
  quitting = true
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Shown and not minimized — i.e. someone could be looking at the preview. */
export function isMainWindowVisible(): boolean {
  return !!mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()
}

/** The app's own pages: the packaged app:// origin, or the dev server in development. */
function isAppUrl(url: string): boolean {
  if (url === 'app://renderer' || url.startsWith('app://renderer/')) return true
  const dev = devServerUrl()
  if (!dev) return false
  try {
    return new URL(url).origin === dev.origin
  } catch {
    return false
  }
}

/** A crashed renderer is reloaded (it re-reads pause/settings on boot) — but not in a loop. */
const RELOAD_LIMIT = 3
const RELOAD_WINDOW_MS = 10 * 60_000
const recentCrashes: number[] = []

/** Broadcast to the renderer regardless of window visibility. */
export function sendToRenderer(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args)
}

export function createMainWindow(options: { startHidden: boolean; firstHideHint: () => void }): BrowserWindow {
  onFirstHide = options.firstHideHint

  mainWindow = new BrowserWindow({
    width: 980,
    height: 660,
    minWidth: 780,
    minHeight: 580,
    show: false,
    frame: false,
    backgroundColor: '#171512',
    // packaged builds use the exe's own icon; build/ isn't shipped in the asar
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.ico') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // the preload only needs `electron` — the renderer, which chews on a
      // webcam stream all day, gets Chromium's full process sandbox
      sandbox: true,
      spellcheck: false,
      // detection must keep running while the window is hidden in the tray
      backgroundThrottling: false
    }
  })

  // the webcam for our own pages only — no microphone, nothing else, no other origin
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const types = 'mediaTypes' in details ? details.mediaTypes : undefined
    cb(
      permission === 'media' &&
        isAppUrl(details.requestingUrl) &&
        !!types &&
        types.length > 0 &&
        types.every((t) => t === 'video')
    )
  })
  // permission *checks* (navigator.permissions, device labels) follow the same rule
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    return permission === 'media' && details.mediaType !== 'audio' && isAppUrl(details.requestingUrl ?? '')
  })
  // nothing in the app navigates; a page swap would inherit the preload API and camera
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (quitting || details.reason === 'clean-exit') return
    const now = Date.now()
    while (recentCrashes.length && now - recentCrashes[0] > RELOAD_WINDOW_MS) recentCrashes.shift()
    recentCrashes.push(now)
    console.error(`[window] renderer gone (${details.reason})`)
    if (recentCrashes.length > RELOAD_LIMIT) {
      console.error('[window] renderer keeps crashing — not reloading again')
      return
    }
    setTimeout(() => mainWindow?.webContents.reload(), 2_000)
  })

  if (!options.startHidden) {
    mainWindow.on('ready-to-show', () => mainWindow?.show())
  }

  // the renderer only spends effort on preview visuals while they can be seen
  const reportVisibility = (): void => sendToRenderer(IPC.windowVisibility, isMainWindowVisible())
  mainWindow.on('show', reportVisibility)
  mainWindow.on('hide', reportVisibility)
  mainWindow.on('minimize', reportVisibility)
  mainWindow.on('restore', reportVisibility)

  // closing hides to the tray (unless the user turned that off); the real
  // quit comes from the tray menu
  let hintShown = false
  mainWindow.on('close', (e) => {
    if (!quitting && !getSettings().general.closeToTray) {
      quitting = true
      app.quit()
      return
    }
    if (!quitting) {
      e.preventDefault()
      mainWindow?.hide()
      if (!hintShown) {
        hintShown = true
        onFirstHide?.()
      }
    }
  })

  // the app has no external links; never hand renderer-supplied URLs to the shell
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const dev = devServerUrl()
  if (dev) {
    mainWindow.loadURL(dev.toString())
  } else {
    mainWindow.loadURL('app://renderer/index.html')
  }

  return mainWindow
}
