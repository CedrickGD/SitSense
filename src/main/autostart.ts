import { app } from 'electron'
import type { GeneralSettings, Settings } from '../shared/settings'

/**
 * The exe Windows should start at login. The portable build runs from a temp
 * extraction that is deleted on exit; electron-builder exposes the real
 * portable exe as PORTABLE_EXECUTABLE_FILE.
 */
function loginItem(): { path: string; args: string[] } {
  return { path: process.env['PORTABLE_EXECUTABLE_FILE'] || process.execPath, args: ['--hidden'] }
}

/**
 * The user flipped "Start with Windows" — write it through. Only meaningful
 * for the packaged app; in dev this would register the bare electron.exe.
 */
export function applyAutostart(settings: Settings): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: settings.general.launchOnStartup, enabled: true, ...loginItem() })
}

/**
 * Boot-time sync: re-asserts the Run entry (it survives updates and moves of
 * the portable exe) — but if the user switched SitSense off under Task
 * Manager → Startup apps, respect that and return the setting to store
 * instead of silently re-enabling it.
 */
export function reconcileAutostart(settings: Settings): Partial<GeneralSettings> | null {
  if (!app.isPackaged) return null
  const item = loginItem()
  if (settings.general.launchOnStartup) {
    const current = app.getLoginItemSettings(item)
    if (current.openAtLogin && !current.executableWillLaunchAtLogin) return { launchOnStartup: false }
    app.setLoginItemSettings({ openAtLogin: true, ...item })
  } else {
    app.setLoginItemSettings({ openAtLogin: false, ...item })
  }
  return null
}
