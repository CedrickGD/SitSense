import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const created: { opts: Record<string, unknown> }[] = []
  const noop = (): void => {}
  class BrowserWindow {
    webContents = {
      on: noop,
      setWindowOpenHandler: noop,
      session: { setPermissionRequestHandler: noop, setPermissionCheckHandler: noop },
      send: noop,
      isCrashed: () => false
    }
    constructor(public opts: Record<string, unknown>) {
      created.push(this)
    }
    on(): void {}
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
  }
  return {
    created,
    BrowserWindow,
    app: { isPackaged: true, on: noop },
    Menu: { setApplicationMenu: vi.fn() }
  }
})

vi.mock('electron', () => ({
  app: h.app,
  BrowserWindow: h.BrowserWindow,
  Menu: h.Menu,
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  shell: { openExternal: vi.fn() }
}))

import { createMainWindow } from '../window'

const create = (): Record<string, unknown> => {
  createMainWindow({ startHidden: true, firstHideHint: () => {} })
  return h.created[h.created.length - 1]!.opts
}

describe('main window chrome (regression: default menu let Ctrl+R reload and Ctrl+Shift+I open DevTools)', () => {
  beforeEach(() => {
    h.Menu.setApplicationMenu.mockReset()
  })

  it('removes the default application menu and disables DevTools in the packaged app', () => {
    h.app.isPackaged = true
    const opts = create()
    expect(h.Menu.setApplicationMenu).toHaveBeenCalledWith(null)
    expect((opts['webPreferences'] as Record<string, unknown>)['devTools']).toBe(false)
  })

  it('keeps the default menu and DevTools in dev', () => {
    h.app.isPackaged = false
    const opts = create()
    expect(h.Menu.setApplicationMenu).not.toHaveBeenCalled()
    expect((opts['webPreferences'] as Record<string, unknown>)['devTools']).toBe(true)
  })
})
