// Electron wiring for the update service (src/main/updater.ts). electron-updater is
// used ONLY here, and only as the `updater:` value handed to createUpdateService —
// scripts/verify-package.mjs (check 3b) enforces that on the packaged code.

import { app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '../shared/ipc'
import { updateReadyToast } from './notifications'
import { getSettings, onSettingsChanged } from './settings-store'
import { refreshTray } from './tray'
import { createUpdateService, type UpdateService } from './updater'
import { markQuitting, sendToRenderer } from './window'
import { isSafeExternalUrl } from './window-guards'

let service: UpdateService | null = null

/** The update service (created on first use; after app 'ready'). */
export function initUpdater(): UpdateService {
  if (service) return service
  const packaged = app.isPackaged
  const svc = createUpdateService({
    // unpackaged (dev / preview): no updater object at all — nothing can be requested
    updater: packaged ? autoUpdater : null,
    portable: Boolean(process.env['PORTABLE_EXECUTABLE_FILE']),
    currentVersion: app.getVersion(),
    autoCheck: () => getSettings().updates.autoCheck,
    onStatus: (s) => {
      sendToRenderer(IPC.updateState, s)
      refreshTray()
    },
    onReady: (version) => updateReadyToast(version, () => service?.install()),
    beforeInstall: () => markQuitting(),
    openExternal: (url) => {
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    }
  })
  service = svc
  onSettingsChanged((s) => svc.autoCheckChanged(s.updates.autoCheck))
  return svc
}

/** "Restart to update" offer for the tray: the ready version, else null. */
export function readyUpdateVersion(): string | null {
  const st = service?.getStatus().state
  return st?.kind === 'ready' ? st.version : null
}
