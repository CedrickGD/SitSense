import { app } from 'electron'
import type { Settings } from '../shared/settings'

/**
 * Registers/unregisters launch-at-login. Only meaningful for the packaged app —
 * in dev this would register the bare electron.exe, so it is skipped.
 * Re-asserted on every boot while enabled (survives NSIS updates).
 */
export function applyAutostart(settings: Settings): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin: settings.general.launchOnStartup,
    path: process.execPath,
    args: ['--hidden']
  })
}
