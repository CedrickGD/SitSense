import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import type { Settings } from '../shared/settings'

/**
 * HKCU\...\Run value name. Electron defaults it to the AppUserModelId, which
 * src/main/index.ts sets to this same string; it is passed explicitly so the
 * NSIS uninstaller (build/installer.nsh) can delete exactly this value.
 */
export const AUTOSTART_NAME = 'com.cedrickgd.sitsense'
export const AUTOSTART_ARGS = ['--hidden']

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

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

/** The exe path in a Run value's data (`"C:\x\SitSense.exe" --hidden` or an unquoted path). */
export function parseRunCommand(data: string): string | null {
  const d = data.trim()
  if (!d) return null
  // Electron always quotes; an unquoted path may still contain spaces up to ".exe"
  const m = /^"([^"]+)"/.exec(d) ?? /^(.+?\.exe)(?=\s|$)/i.exec(d) ?? /^(\S+)/.exec(d)
  return m ? m[1] : null
}

/**
 * The exe the shared Run value currently launches; null = no value (or unreadable).
 * Electron can only answer "does it launch THIS path", so the value is read with
 * Windows' own reg.exe (System32 — no bundled dependency).
 */
export function registeredAutostartExe(): string | null {
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', AUTOSTART_NAME], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000
    })
    const line = out.split(/\r?\n/).find((l) => l.includes(AUTOSTART_NAME))
    const data = line?.split(/REG_(?:EXPAND_)?SZ/)[1]
    return data ? parseRunCommand(data) : null
  } catch {
    return null
  }
}

// value applied in this process; null = nothing applied yet (boot)
let lastApplied: boolean | null = null

export interface ApplyAutostartOptions {
  /**
   * false when the settings were NOT read from the user's file (unreadable or
   * corrupt -> defaults). Their launchOnStartup:false is then not the user's
   * choice, so the boot reconcile must not delete an existing entry because of it.
   */
  trusted?: boolean
}

/**
 * Registers/unregisters launch-at-login. Only meaningful for the packaged app —
 * in dev this would register the bare electron.exe, so it is skipped.
 *
 * Called at boot and after every settings write, but it only acts when the
 * setting actually changed. At boot it reconciles without re-asserting: if a Run
 * entry for this exe already exists it is left untouched, so a user who
 * disabled SitSense in Task Manager > Startup apps (StartupApproved) stays
 * disabled. setLoginItemSettings would otherwise re-approve it on every launch.
 *
 * The installed app and every portable copy share %APPDATA%\SitSense and the Run
 * value name. At boot a copy only (re)points the value at itself when it is
 * missing or dangling (its exe no longer exists); a live other copy's entry is
 * only taken over when the toggle is flipped in this copy.
 */
export function applyAutostart(settings: Settings, opts: ApplyAutostartOptions = {}): void {
  if (!app.isPackaged) return
  const desired = settings.general.launchOnStartup
  if (desired === lastApplied) return
  const atBoot = lastApplied === null
  // recorded even when the boot reconcile below skips: later automatic settings
  // writes (resolvedDelegate, cameraDeviceId) must not re-run the boot reconcile
  lastApplied = desired

  const path = autostartExecutable()
  // openAtLogin is true only if the Run value already points at this exe + args
  const ours = (): boolean => app.getLoginItemSettings({ path, args: AUTOSTART_ARGS }).openAtLogin
  if (atBoot && desired && ours()) return
  // settings fell back to defaults (file unreadable/corrupt): 'off' is not the
  // user's choice, never delete an existing entry because of it. Only an explicit
  // off->on->off toggle in this process removes it.
  if (atBoot && !desired && opts.trusted === false) return
  if (atBoot && desired) {
    const other = registeredAutostartExe()
    // another live copy (installed vs portable) owns the shared value: keep it and
    // its Task Manager approval; only re-point a missing or dangling entry
    if (other && other.toLowerCase() !== path.toLowerCase() && existsSync(other)) return
  }
  // switching off (or a fresh profile booting with it off) must only remove an
  // entry that launches THIS exe, never another copy's
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
