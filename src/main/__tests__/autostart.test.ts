import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../shared/settings'

const { app } = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn()
  }
}))
vi.mock('electron', () => ({ app }))
const { reg, fs } = vi.hoisted(() => ({
  // reg.exe query; default: the Run value does not exist (reg exits 1 -> throws)
  reg: vi.fn((): string => {
    throw new Error('ERROR: The system was unable to find the specified registry key or value.')
  }),
  fs: { existsSync: vi.fn((_p: string) => true) }
}))
vi.mock('node:child_process', () => ({ execFileSync: reg }))
vi.mock('node:fs', () => ({ existsSync: fs.existsSync }))

/** what `reg query HKCU\...\Run /v com.cedrickgd.sitsense` prints for a value launching `exe` */
const regOut = (exe: string): string =>
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    com.cedrickgd.sitsense    REG_SZ    "${exe}" --hidden\r\n\r\n`

import {
  __resetAutostartForTests,
  applyAutostart,
  AUTOSTART_ARGS,
  AUTOSTART_NAME,
  autostartExecutable,
  parseRunCommand,
  registeredAutostartExe
} from '../autostart'

const settings = (launchOnStartup: boolean): Settings =>
  ({ general: { launchOnStartup } }) as unknown as Settings

describe('autostartExecutable', () => {
  it('uses the real portable exe, not the temp extraction (regression)', () => {
    expect(
      autostartExecutable(
        { PORTABLE_EXECUTABLE_FILE: 'D:\\Tools\\SitSense-portable-0.1.0.exe' },
        'C:\\Users\\u\\AppData\\Local\\Temp\\2abc\\SitSense.exe'
      )
    ).toBe('D:\\Tools\\SitSense-portable-0.1.0.exe')
  })

  it('falls back to execPath for the installed build', () => {
    expect(autostartExecutable({}, 'C:\\Programs\\SitSense\\SitSense.exe')).toBe(
      'C:\\Programs\\SitSense\\SitSense.exe'
    )
    expect(autostartExecutable({ PORTABLE_EXECUTABLE_FILE: '  ' }, 'C:\\x.exe')).toBe('C:\\x.exe')
  })
})

describe('applyAutostart', () => {
  const savedPortable = process.env['PORTABLE_EXECUTABLE_FILE']

  beforeEach(() => {
    __resetAutostartForTests()
    app.isPackaged = true
    app.getLoginItemSettings.mockReset().mockReturnValue({ openAtLogin: false })
    app.setLoginItemSettings.mockReset()
    reg.mockReset().mockImplementation(() => {
      throw new Error('not found')
    })
    fs.existsSync.mockReset().mockReturnValue(true)
    delete process.env['PORTABLE_EXECUTABLE_FILE']
  })
  afterEach(() => {
    if (savedPortable === undefined) delete process.env['PORTABLE_EXECUTABLE_FILE']
    else process.env['PORTABLE_EXECUTABLE_FILE'] = savedPortable
  })

  it('is a no-op in dev (unpackaged)', () => {
    app.isPackaged = false
    applyAutostart(settings(true))
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('does not re-assert an existing entry at boot (respects Task Manager disable)', () => {
    app.getLoginItemSettings.mockReturnValue({ openAtLogin: true })
    applyAutostart(settings(true))
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('registers at boot when enabled but the entry is missing or stale', () => {
    applyAutostart(settings(true))
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: process.execPath,
      args: AUTOSTART_ARGS,
      name: AUTOSTART_NAME
    })
  })

  it('registers the portable exe path in the portable build', () => {
    process.env['PORTABLE_EXECUTABLE_FILE'] = 'D:\\Tools\\SitSense-portable.exe'
    applyAutostart(settings(true))
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({
      path: 'D:\\Tools\\SitSense-portable.exe',
      args: AUTOSTART_ARGS
    })
    expect(app.setLoginItemSettings.mock.calls[0][0].path).toBe('D:\\Tools\\SitSense-portable.exe')
  })

  it('only acts on later calls when the setting actually changes', () => {
    app.getLoginItemSettings.mockReturnValue({ openAtLogin: true })
    applyAutostart(settings(true)) // boot: entry exists, untouched
    applyAutostart(settings(true)) // unrelated settings write
    applyAutostart(settings(true))
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()

    applyAutostart(settings(false)) // user toggles off
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ openAtLogin: false, name: AUTOSTART_NAME })
    )
    applyAutostart(settings(true)) // user toggles back on: explicit intent, re-register
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(2)
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ openAtLogin: true })
    )
  })

  it('removes a leftover entry for this exe at boot when the setting is off', () => {
    app.getLoginItemSettings.mockReturnValue({ openAtLogin: true })
    applyAutostart(settings(false))
    expect(app.setLoginItemSettings).toHaveBeenCalledWith(
      expect.objectContaining({ openAtLogin: false })
    )
    applyAutostart(settings(false))
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1)
  })

  it("never removes another copy's entry (a portable exe with a fresh profile vs the installed app)", () => {
    process.env['PORTABLE_EXECUTABLE_FILE'] = 'D:\\Tools\\SitSense-portable.exe'
    // the shared Run value points at the installed exe, not at this portable one
    app.getLoginItemSettings.mockReturnValue({ openAtLogin: false })
    applyAutostart(settings(false)) // boot with the default (off)
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    applyAutostart(settings(true)) // user turns it on here: this copy takes the entry
    applyAutostart(settings(false)) // and off again: it is ours now only if it points here
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1)
  })

  describe('settings that fell back to defaults (unreadable/corrupt settings.json)', () => {
    it('never deletes an existing entry at boot (regression: EBUSY at login removed autostart)', () => {
      app.getLoginItemSettings.mockReturnValue({ openAtLogin: true })
      applyAutostart(settings(false), { trusted: false })
      expect(app.setLoginItemSettings).not.toHaveBeenCalled()
      // a later automatic settings write (resolvedDelegate, cameraDeviceId) is not a toggle
      applyAutostart(settings(false))
      expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    })

    it('an explicit toggle on and back off still removes the entry', () => {
      app.getLoginItemSettings.mockReturnValue({ openAtLogin: true })
      applyAutostart(settings(false), { trusted: false })
      applyAutostart(settings(true)) // entry is already ours -> re-asserted by the explicit toggle
      applyAutostart(settings(false))
      expect(app.setLoginItemSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ openAtLogin: false, name: AUTOSTART_NAME })
      )
    })

    it('a trusted boot with the setting off still cleans up a leftover entry for this exe', () => {
      app.getLoginItemSettings.mockReturnValue({ openAtLogin: true })
      applyAutostart(settings(false), { trusted: true })
      expect(app.setLoginItemSettings).toHaveBeenCalledWith(expect.objectContaining({ openAtLogin: false }))
    })
  })

  describe('installed and portable copies sharing the Run value', () => {
    const installed = 'C:\\Users\\u\\AppData\\Local\\Programs\\SitSense\\SitSense.exe'
    const portable = 'C:\\Users\\u\\Downloads\\SitSense-portable-0.2.0.exe'

    it("does not steal another live copy's entry at boot (regression)", () => {
      process.env['PORTABLE_EXECUTABLE_FILE'] = portable
      reg.mockReturnValue(regOut(installed))
      applyAutostart(settings(true))
      expect(fs.existsSync).toHaveBeenCalledWith(installed)
      expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    })

    it('re-points a dangling entry (the other exe was deleted) at boot', () => {
      process.env['PORTABLE_EXECUTABLE_FILE'] = portable
      reg.mockReturnValue(regOut('D:\\gone\\SitSense-portable-0.1.0.exe'))
      fs.existsSync.mockReturnValue(false)
      applyAutostart(settings(true))
      expect(app.setLoginItemSettings).toHaveBeenCalledWith(
        expect.objectContaining({ openAtLogin: true, path: portable })
      )
    })

    it('re-registers its own entry when only the args are stale (same exe)', () => {
      reg.mockReturnValue(regOut(process.execPath.toUpperCase()))
      applyAutostart(settings(true))
      expect(app.setLoginItemSettings).toHaveBeenCalledWith(
        expect.objectContaining({ openAtLogin: true, path: process.execPath })
      )
    })

    it('an explicit toggle off and back on takes the entry even if another copy owns it', () => {
      process.env['PORTABLE_EXECUTABLE_FILE'] = portable
      reg.mockReturnValue(regOut(installed))
      applyAutostart(settings(true)) // boot: left to the installed copy
      applyAutostart(settings(false)) // not ours -> nothing removed
      applyAutostart(settings(true)) // user flips it on here
      expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1)
      expect(app.setLoginItemSettings).toHaveBeenCalledWith(
        expect.objectContaining({ openAtLogin: true, path: portable })
      )
    })
  })
})

describe('registeredAutostartExe / parseRunCommand', () => {
  it('reads the exe from reg.exe output', () => {
    reg.mockReturnValueOnce(regOut('C:\\Program Files\\SitSense\\SitSense.exe'))
    expect(registeredAutostartExe()).toBe('C:\\Program Files\\SitSense\\SitSense.exe')
    expect(reg).toHaveBeenLastCalledWith(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', AUTOSTART_NAME],
      expect.objectContaining({ windowsHide: true })
    )
  })

  it('returns null when the value is missing or reg fails', () => {
    reg.mockImplementationOnce(() => {
      throw new Error('exit 1')
    })
    expect(registeredAutostartExe()).toBeNull()
    reg.mockReturnValueOnce('')
    expect(registeredAutostartExe()).toBeNull()
  })

  it('parses quoted, unquoted and empty command lines', () => {
    expect(parseRunCommand('"C:\\a b\\x.exe" --hidden')).toBe('C:\\a b\\x.exe')
    expect(parseRunCommand('  C:\\x.exe --hidden')).toBe('C:\\x.exe')
    expect(parseRunCommand('C:\\Riot Games\\a b.exe --x')).toBe('C:\\Riot Games\\a b.exe')
    expect(parseRunCommand('   ')).toBeNull()
  })
})
