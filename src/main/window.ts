import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { IPC } from '../shared/ipc'

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
      sandbox: false,
      // detection must keep running while the window is hidden in the tray
      backgroundThrottling: false
    }
  })

  // camera only — everything else is denied
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media')
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

  // closing hides to the tray; the real quit comes from the tray menu
  let hintShown = false
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWindow?.hide()
      if (!hintShown) {
        hintShown = true
        onFirstHide?.()
      }
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadURL('app://renderer/index.html')
  }

  return mainWindow
}
