import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type SitSenseApi, type WindowControlAction } from '../shared/ipc'
import type { DetectionStatus, PostureAlert, PostureSnapshot } from '../shared/posture'

function subscribe(channel: string, cb: (...args: unknown[]) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: SitSenseApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch: unknown) => ipcRenderer.invoke(IPC.settingsSet, patch),
  getAppStatus: () => ipcRenderer.invoke(IPC.appGetStatus),
  getTodayStats: () => ipcRenderer.invoke(IPC.statsGetToday),
  testNotification: () => ipcRenderer.invoke(IPC.notifyTest),
  setPause: (paused: boolean, minutes?: number | null) =>
    ipcRenderer.invoke(IPC.pauseSet, paused, minutes ?? null),
  windowControl: (action: WindowControlAction) => ipcRenderer.invoke(IPC.windowControl, action),
  quitApp: () => ipcRenderer.invoke(IPC.quitApp),

  sendPostureUpdate: (snapshot: PostureSnapshot) => ipcRenderer.send(IPC.postureUpdate, snapshot),
  sendAlert: (alert: PostureAlert) => ipcRenderer.send(IPC.alertFire, alert),
  sendDetectionStatus: (status: DetectionStatus) => ipcRenderer.send(IPC.detectionStatus, status),

  onSettingsChanged: (cb) => subscribe(IPC.settingsChanged, cb as (...args: unknown[]) => void),
  onPauseChanged: (cb) => subscribe(IPC.pauseChanged, cb as (...args: unknown[]) => void),
  onRequestCalibration: (cb) => subscribe(IPC.requestCalibration, cb as (...args: unknown[]) => void),
  onSystemResumed: (cb) => subscribe(IPC.systemResumed, cb as (...args: unknown[]) => void)
}

contextBridge.exposeInMainWorld('sitsense', api)
