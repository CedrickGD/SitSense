import { app } from 'electron'
import type { Settings } from '../shared/settings'

/**
 * HKCU\...\Run value name. Electron defaults it to the AppUserModelId, which
 * src/main/index.ts sets to this same string; it is passed explicitly so the
 * NSIS uninstaller (build/installer.nsh) can delete exactly this value.
 */
export const AUTOSTART_NAME = 'com.cedrickgd.sitsense'
export const AUTOSTART_ARGS = ['--hidden']

/**
 * The exe that should launch at login. The portable build runs from a temp
 * extraction dir that is deleted on exit; its stub exports the real exe path
 * in PORTABLE_EXECUTABLE_FILE, so that is what must be registered.
 */
export function autostartExecutable(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath
): string {
  const portable = env['PORTABLE_EXECUTABLE_FILE']
  return portable && portable.trim() ? portable : execPath
}

// value applied in this process; null = nothing applied yet (boot)
let lastApplied: boolean | null = null

/**
 * Registers/unregisters launch-at-login. Only meaningful for the packaged app —
 * in dev this would register the bare electron.exe, so it is skipped.
 *
 * Called at boot and after every settings write, but it only acts when the
 * setting actually changed. At boot it reconciles without re-asserting: if a Run
 * entry for this exe already exists it is left untouched, so a user who
 * disabled SitSense in Task Manager > Startup apps (StartupApproved) stays
 * disabled. setLoginItemSettings would otherwise re-approve it on every launch.
 */
export function applyAutostart(settings: Settings): void {
  if (!app.isPackaged) return
  const desired = settings.general.launchOnStartup
  if (desired === lastApplied) return
  const atBoot = lastApplied === null
  lastApplied = desired

  const path = autostartExecutable()
  // openAtLogin is true only if the Run value already points at this exe + args
  const ours = (): boolean => app.getLoginItemSettings({ path, args: AUTOSTART_ARGS }).openAtLogin
  if (atBoot && desired && ours()) return
  // the installed app and every portable copy share the Run value name: switching off
  // (or a fresh profile booting with it off) must only remove an entry that launches
  // THIS exe, never another copy's
  if (!desired && !ours()) return
  app.setLoginItemSettings({
    openAtLogin: desired,
    path,
    args: AUTOSTART_ARGS,
    name: AUTOSTART_NAME
  })
}

/** Test-only: forget what was applied in this process. */
export function __resetAutostartForTests(): void {
  lastApplied = null
}
