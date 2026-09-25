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
 * Boot-time sync with Task Manager → Startup apps, which can switch the entry
 * off and on again behind the app's back. Returns the setting to store when
 * the user changed it there; otherwise re-asserts the Run entry (it survives
 * updates and moves of the portable exe).
 */
export function reconcileAutostart(settings: Settings): Partial<GeneralSettings> | null {
  if (!app.isPackaged) return null
  const item = loginItem()
  const current = app.getLoginItemSettings(item)
  if (settings.general.launchOnStartup) {
    // switched off there: respect it instead of silently re-enabling
    if (current.openAtLogin && !current.executableWillLaunchAtLogin) return { launchOnStartup: false }
    app.setLoginItemSettings({ openAtLogin: true, ...item })
  } else if (current.openAtLogin) {
    // switched back on there: adopt it. A still-disabled entry is left alone,
    // so it stays in Task Manager for the user to turn on again.
    if (current.executableWillLaunchAtLogin) return { launchOnStartup: true }
  }
  return null
}
