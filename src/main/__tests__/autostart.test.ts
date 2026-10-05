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

import {
  __resetAutostartForTests,
  applyAutostart,
  AUTOSTART_ARGS,
  AUTOSTART_NAME,
  autostartExecutable
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
    process.env['PORTABLE_EXECUTABLE_FILE'] = 'D:\Tools\SitSense-portable.exe'
    // the shared Run value points at the installed exe, not at this portable one
    app.getLoginItemSettings.mockReturnValue({ openAtLogin: false })
    applyAutostart(settings(false)) // boot with the default (off)
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    applyAutostart(settings(true)) // user turns it on here: this copy takes the entry
    applyAutostart(settings(false)) // and off again: it is ours now only if it points here
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1)
  })
})
