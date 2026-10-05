import { join } from 'node:path'
import { app, BrowserWindow, screen, shell } from 'electron'
import { IPC } from '../shared/ipc'
import { APP_ORIGIN, MIN_WINDOW, initialWindowSize, isSafeExternalUrl, isTrustedRendererUrl, nextReloadDelay } from './window-guards'

let mainWindow: BrowserWindow | null = null
let quitting = false
let onFirstHide: (() => void) | null = null

// renderer / GPU crash recovery
const UNRESPONSIVE_KILL_MS = 20_000
let crashTimes: number[] = []
let reloadTimer: NodeJS.Timeout | null = null
let unresponsiveTimer: NodeJS.Timeout | null = null
let gpuWatchInstalled = false

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
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isCrashed()) return
  mainWindow.webContents.send(channel, ...args)
}

const devRendererUrl = (): string | undefined => process.env['ELECTRON_RENDERER_URL'] || undefined

function loadRenderer(win: BrowserWindow): void {
  const dev = devRendererUrl()
  void win.loadURL(dev ?? `${APP_ORIGIN}/index.html`)
}

/**
 * The renderer runs detection; if it (or the GPU process MediaPipe draws on)
 * dies, monitoring silently stops. Reload with exponential backoff — never
 * give up, but don't spin on a crash loop either.
 */
function scheduleRendererRecovery(reason: string): void {
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return
  if (reloadTimer) return // a reload is already pending
  const { delayMs, history } = nextReloadDelay(crashTimes, Date.now())
  crashTimes = history
  console.error(`[window] renderer lost (${reason}); reloading in ${delayMs} ms (crash #${history.length} in 5 min)`)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return
    loadRenderer(mainWindow)
  }, delayMs)
}

function clearUnresponsiveTimer(): void {
  if (unresponsiveTimer) {
    clearTimeout(unresponsiveTimer)
    unresponsiveTimer = null
  }
}

function installCrashRecovery(win: BrowserWindow): void {
  const wc = win.webContents

  wc.on('render-process-gone', (_e, details) => {
    clearUnresponsiveTimer()
    if (details.reason === 'clean-exit') return
    scheduleRendererRecovery(`render-process-gone: ${details.reason} (exit ${details.exitCode})`)
  })

  // a hung renderer (e.g. a wedged wasm/GPU call) never reports posture again;
  // give it a grace period, then crash it so the path above reloads it
  win.on('unresponsive', () => {
    if (unresponsiveTimer) return
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null
      if (!win.isDestroyed() && !wc.isCrashed()) {
        console.error('[window] renderer unresponsive; restarting it')
        wc.forcefullyCrashRenderer()
      }
    }, UNRESPONSIVE_KILL_MS)
  })
  win.on('responsive', clearUnresponsiveTimer)
  win.on('closed', () => {
    clearUnresponsiveTimer()
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = null
  })

  // GPU process death loses every WebGL context (MediaPipe's GPU delegate and
  // the preview); Chromium restarts the GPU process but the page must re-init
  if (!gpuWatchInstalled) {
    gpuWatchInstalled = true
    app.on('child-process-gone', (_e, details) => {
      if (details.type !== 'GPU' || details.reason === 'clean-exit') return
      scheduleRendererRecovery(`gpu-process-gone: ${details.reason} (exit ${details.exitCode})`)
    })
  }
}

/**
 * Lock the window down to our own renderer: no popups, no navigation away,
 * no webviews, and only camera (video) permission for our own origin.
 */
function installSecurityGuards(win: BrowserWindow): void {
  const wc = win.webContents
  const trusted = (url: string | undefined | null): boolean => isTrustedRendererUrl(url, devRendererUrl())

  wc.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const guardNavigation = (e: Electron.Event, url: string): void => {
    if (trusted(url)) return
    e.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  }
  wc.on('will-navigate', (e, url) => guardNavigation(e, url))
  wc.on('will-redirect', (e, url) => guardNavigation(e, url))
  wc.on('will-attach-webview', (e) => e.preventDefault())

  const ses = wc.session
  // camera only, and only for our own page — everything else is denied
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    if (permission !== 'media' || !trusted(details.requestingUrl)) return cb(false)
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
    cb(mediaTypes.length > 0 && mediaTypes.every((t) => t === 'video'))
  })
  // synchronous checks (permissions.query, enumerateDevices labels): same policy
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (permission !== 'media') return false
    if (!trusted(details.requestingUrl ?? requestingOrigin)) return false
    return details.mediaType !== 'audio'
  })
}

export function createMainWindow(options: { startHidden: boolean; firstHideHint: () => void }): BrowserWindow {
  onFirstHide = options.firstHideHint

  const size = initialWindowSize(screen.getPrimaryDisplay().workAreaSize)
  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    frame: false,
    backgroundColor: '#171512',
    // packaged builds use the exe's own icon; build/ isn't shipped in the asar
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.ico') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // the bundled preload only uses contextBridge + ipcRenderer, which the
      // sandboxed preload environment provides
      sandbox: true,
      // detection must keep running while the window is hidden in the tray
      backgroundThrottling: false
    }
  })

  installSecurityGuards(mainWindow)
  installCrashRecovery(mainWindow)

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

  loadRenderer(mainWindow)

  return mainWindow
}
