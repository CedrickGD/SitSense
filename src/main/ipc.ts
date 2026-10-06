import { app, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC, type AppStatus, type WindowControlAction } from '../shared/ipc'
import type { DetectionStatus, PostureAlert, PostureSnapshot } from '../shared/posture'
import { initAi } from './ai'
import { AiError } from './ai/errors'
import { stripAiConnections } from './ai/validate'
import { applyAutostart } from './autostart'
import { breaksPostureUpdate, breaksSettingsChanged, getSittingState, snoozeBreak } from './breaks'
import { fireAlert, testNotification } from './notifications'
import { getPauseState, setPause } from './pause'
import { getSettings, updateSettings } from './settings-store'
import { getStatsRange, getTodayStats, statsPostureUpdate, statsRecordAlert } from './stats'
import { refreshTray, trayPostureUpdate } from './tray'
import { initUpdater } from './updater-init'
import { getMainWindow, isMainWindowVisible, markQuitting, sendToRenderer } from './window'
import { isTrustedRendererUrl } from './window-guards'

let lastDetectionStatus: DetectionStatus | null = null

export function getLastDetectionStatus(): DetectionStatus | null {
  return lastDetectionStatus
}

type SenderEvent = Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender' | 'senderFrame'>

/**
 * True only for IPC from our own renderer: the main window's webContents, its
 * top frame (no subframes), currently showing app://renderer — or the dev server
 * origin from ELECTRON_RENDERER_URL, the same rule window.ts navigates by.
 */
export function isTrustedIpcSender(
  e: SenderEvent,
  win: BrowserWindow | null,
  devUrl: string | undefined = process.env['ELECTRON_RENDERER_URL'] || undefined
): boolean {
  try {
    if (!win || win.isDestroyed()) return false
    const wc = win.webContents
    if (e.sender !== wc) return false
    const frame = e.senderFrame
    // null = the frame navigated away or was destroyed before the message was handled
    if (!frame || frame.parent !== null) return false
    // compare by id: the WebFrameMain wrapper object is not guaranteed to be the same instance
    const top = wc.mainFrame
    if (frame.processId !== top.processId || frame.routingId !== top.routingId) return false
    return isTrustedRendererUrl(frame.url, devUrl)
  } catch {
    // a disposed WebFrameMain throws on property access
    return false
  }
}

function rejectSender(channel: string, e: SenderEvent): void {
  let url = '?'
  try {
    url = e.senderFrame?.url ?? 'no frame'
  } catch {
    /* disposed frame */
  }
  console.warn(`[ipc] rejected '${channel}' from untrusted sender (${url})`)
}

/** ipcMain.handle that only answers our own renderer; anything else gets a rejected promise. */
function handle<A extends unknown[], R>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => R): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!isTrustedIpcSender(e, getMainWindow())) {
      rejectSender(channel, e)
      throw new Error('Unauthorized IPC sender')
    }
    return fn(e, ...(args as A))
  })
}

/** ipcMain.on that silently drops messages from anything but our own renderer. */
function on<A extends unknown[]>(channel: string, fn: (e: IpcMainEvent, ...args: A) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (!isTrustedIpcSender(e, getMainWindow())) {
      rejectSender(channel, e)
      return
    }
    fn(e, ...(args as A))
  })
}

// ── payload shape checks for the renderer→main sends ──
// The sender is already trusted; these keep a malformed message (renderer bug,
// version skew) from throwing inside a listener or poisoning the tray/stats state
// that a timer later dereferences.

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function isPostureSnapshot(v: unknown): v is PostureSnapshot {
  if (!isObj(v)) return false
  if (typeof v['presence'] !== 'string' || !isNum(v['worstStage']) || typeof v['calibrated'] !== 'boolean' || !isNum(v['ts'])) {
    return false
  }
  const issues = v['issues']
  if (!isObj(issues)) return false
  const list = Object.values(issues)
  // tray/stats reduce over the issues without a seed: an empty map would throw
  return list.length > 0 && list.every((i) => isObj(i) && typeof i['issue'] === 'string' && isNum(i['stage']))
}

export function isPostureAlert(v: unknown): v is PostureAlert {
  return isObj(v) && typeof v['issue'] === 'string' && isNum(v['stage']) && typeof v['kind'] === 'string'
}

export function isDetectionStatus(v: unknown): v is DetectionStatus {
  return isObj(v) && typeof v['running'] === 'boolean'
}

/** Every channel registered below goes through handle()/on(), i.e. through isTrustedIpcSender. */
export function registerIpc(): void {
  handle(IPC.settingsGet, () => getSettings())

  handle(IPC.settingsSet, (_e, patch: unknown) => {
    // ai.connections change only through the dedicated AI IPC below
    const merged = updateSettings(stripAiConnections(patch))
    applyAutostart(merged)
    sendToRenderer(IPC.settingsChanged, merged)
    refreshTray()
    breaksSettingsChanged()
    return merged
  })

  // ── connected AI models (docs/specs/ai-providers.md §4) ──
  const ai = initAi()
  // thrown errors reach the renderer as a rejected promise; only our short message crosses
  const plain = <T>(fn: () => T, fallback: string): T => {
    try {
      return fn()
    } catch (err) {
      throw new Error(err instanceof AiError ? err.message : fallback)
    }
  }
  handle(IPC.aiSaveConnection, (_e, conn: unknown, key: unknown) =>
    plain(() => ai.saveConnection(conn, key), 'Couldn’t save the connection.')
  )
  handle(IPC.aiRemoveConnection, (_e, id: unknown) => plain(() => ai.removeConnection(id), 'Couldn’t remove the connection.'))
  handle(IPC.aiMoveConnection, (_e, id: unknown, delta: unknown) =>
    plain(() => ai.moveConnection(id, delta), 'Couldn’t move the connection.')
  )
  handle(IPC.aiTestConnection, (_e, id: unknown) => ai.testConnection(id))
  handle(IPC.aiListModels, (_e, id: unknown) => ai.listModels(id))
  handle(IPC.aiReviewPosture, (_e, req: unknown) => ai.reviewPosture(req))
  handle(IPC.aiChat, (_e, req: unknown) => ai.chat(req))
  handle(IPC.aiChatCancel, () => ai.cancelChat())
  handle(IPC.aiCancelReview, (_e, requestId: unknown) => ai.cancelReview(requestId))

  handle(IPC.appGetStatus, (): AppStatus => {
    return {
      version: app.getVersion(),
      pause: getPauseState(),
      packaged: app.isPackaged,
      windowVisible: isMainWindowVisible(),
      sitting: getSittingState()
    }
  })

  handle(IPC.statsGetToday, () => getTodayStats())

  // days is validated in stats.ts (finite number, clamped to 1..90)
  handle(IPC.statsGetRange, (_e, days: unknown) => getStatsRange(days))

  // minutes: null/undefined = default 10, otherwise clamped to 1..120 by the tracker
  handle(IPC.breakSnooze, (_e, minutes: unknown) => snoozeBreak(minutes ?? undefined))

  handle(IPC.notifyTest, () => testNotification())

  // ── app updates (src/main/updater.ts). No renderer arguments are read: main decides
  // what to check, which version to download, which page to open and what to install.
  const updates = initUpdater()
  handle(IPC.updateGetState, () => updates.getStatus())
  handle(IPC.updateCheck, () => updates.check(true))
  handle(IPC.updateDownload, () => updates.download())
  handle(IPC.updateInstall, () => updates.install())

  handle(IPC.pauseSet, (_e, paused: boolean, minutes: number | null) => {
    return setPause(paused, minutes)
  })

  handle(IPC.windowControl, (_e, action: unknown) => {
    const win = getMainWindow()
    if (!win) return
    if (action === ('minimize' satisfies WindowControlAction)) win.minimize()
    else if (action === ('hide' satisfies WindowControlAction)) win.close() // intercepted by close-to-tray
  })

  handle(IPC.quitApp, () => {
    markQuitting()
    app.quit()
  })

  on(IPC.postureUpdate, (_e, snapshot: unknown) => {
    if (!isPostureSnapshot(snapshot)) return
    trayPostureUpdate(snapshot)
    statsPostureUpdate(snapshot)
    breaksPostureUpdate(snapshot)
  })

  on(IPC.alertFire, (_e, alert: unknown) => {
    if (!isPostureAlert(alert)) return
    if (fireAlert(alert)) statsRecordAlert()
  })

  on(IPC.detectionStatus, (_e, status: unknown) => {
    if (!isDetectionStatus(status)) return
    lastDetectionStatus = status
  })
}
