import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsLoadIssue } from '../settings-store'

type Fn = (...a: unknown[]) => unknown

const h = vi.hoisted(() => {
  const order: string[] = []
  const calls: string[] = []
  const appHandlers = new Map<string, Fn[]>()
  const winHandlers = new Map<string, Fn[]>()
  const powerHandlers = new Map<string, Fn[]>()
  const add = (m: Map<string, Fn[]>) => (ev: string, fn: Fn) => {
    m.set(ev, [...(m.get(ev) ?? []), fn])
  }
  let ready: () => void = () => {}
  const readyP = new Promise<void>((r) => (ready = r))
  const state = { lock: true, loadIssue: null as unknown }
  const toasts: { title: string; body: string }[] = []
  const autostartOpts: unknown[] = []
  return { order, calls, appHandlers, winHandlers, powerHandlers, add, readyP, release: () => ready(), state, toasts, autostartOpts }
})

vi.mock('../dev-profile', () => {
  h.order.push('dev-profile')
  return {}
})
vi.mock('electron', () => {
  h.order.push('electron')
  return {
    app: {
      setAppUserModelId: () => h.order.push('setAppUserModelId'),
      requestSingleInstanceLock: () => {
        h.order.push('requestSingleInstanceLock')
        return h.state.lock
      },
      on: h.add(h.appHandlers),
      whenReady: () => h.readyP,
      quit: () => h.calls.push('app.quit')
    },
    powerMonitor: { on: h.add(h.powerHandlers) },
    Notification: class {
      static isSupported = (): boolean => true
      constructor(private o: { title: string; body: string }) {}
      on(): void {}
      show(): void {
        h.toasts.push(this.o)
      }
    }
  }
})
vi.mock('../app-protocol', () => ({ registerAppScheme: () => {}, handleAppProtocol: () => {} }))
vi.mock('../autostart', () => ({ applyAutostart: (_s: unknown, opts: unknown) => h.autostartOpts.push(opts) }))
vi.mock('../ipc', () => ({ registerIpc: () => {} }))
vi.mock('../breaks', () => ({ initBreaks: () => h.calls.push('initBreaks') }))
vi.mock('../notifications', () => ({ trayHint: () => {} }))
vi.mock('../pause', () => ({
  initPauseReconciler: () => h.calls.push('initPauseReconciler'),
  initPowerSaveBlocker: () => h.calls.push('initPowerSaveBlocker'),
  onPauseChanged: () => () => {},
  reconcilePause: () => {},
  setPause: () => {}
}))
vi.mock('../settings-store', () => ({
  getSettings: () => ({ onboarded: true }),
  getSettingsLoadIssue: () => h.state.loadIssue,
  loadSettings: () => ({ general: { startHidden: false } }),
  saveNow: () => h.calls.push('saveNow'),
  updateSettings: () => {}
}))
vi.mock('../stats', () => ({ initStats: () => {}, stopStats: () => h.calls.push('stopStats') }))
vi.mock('../tray', () => ({ createTray: () => {}, destroyTray: () => h.calls.push('destroyTray'), refreshTray: () => {} }))
vi.mock('../updater-init', () => ({ initUpdater: () => ({ start: () => {}, install: () => false }), readyUpdateVersion: () => null }))
vi.mock('../window', () => ({
  createMainWindow: () => ({ on: h.add(h.winHandlers) }),
  markQuitting: () => h.calls.push('markQuitting'),
  sendToRenderer: () => {},
  showMainWindow: () => {}
}))

const emit = (m: Map<string, Fn[]>, ev: string): void => {
  for (const fn of m.get(ev) ?? []) fn({ reasons: ['shutdown'] })
}

describe('main process lifecycle (index.ts)', () => {
  beforeEach(() => {
    h.calls.length = 0
  })

  it('applies the dev profile before touching electron or the single-instance lock', async () => {
    await import('../index')
    expect(h.order[0]).toBe('dev-profile')
    expect(h.order.indexOf('dev-profile')).toBeLessThan(h.order.indexOf('requestSingleInstanceLock'))
  })

  it('does not flush before settings and stats are loaded', () => {
    emit(h.appHandlers, 'will-quit')
    expect(h.calls).not.toContain('saveNow')
    expect(h.calls).not.toContain('stopStats')
  })

  it('starts the pause reconciler, not the power-save blocker', async () => {
    h.state.loadIssue = { kind: 'corrupt', backup: 'C:/data/settings.json.corrupt-2026-10-02T08-00-00-000Z', error: 'SyntaxError' }
    h.release()
    await h.readyP
    await Promise.resolve()
    expect(h.calls).toContain('initPauseReconciler')
    expect(h.calls).not.toContain('initPowerSaveBlocker')
  })

  it('tells the user once at startup that their settings were reset and where the backup is', () => {
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0]!.title).toMatch(/reset/)
    expect(h.toasts[0]!.body).toContain('settings.json.corrupt-2026-10-02T08-00-00-000Z')
  })

  it('boot autostart reconcile is untrusted after a defaults fallback (never deletes the entry)', () => {
    expect(h.autostartOpts).toEqual([{ trusted: false }])
  })

  it('has toast copy for every settings load issue and none for a clean load', async () => {
    const { settingsLoadIssueMessage } = await import('../index')
    expect(settingsLoadIssueMessage(null)).toBeNull()
    const issues: SettingsLoadIssue[] = [
      { kind: 'corrupt', backup: '/x/settings.json.corrupt-1', error: 'e' },
      { kind: 'corrupt', backup: null, error: 'e' },
      { kind: 'unreadable', code: 'EBUSY', error: 'e' }
    ]
    for (const i of issues) expect(settingsLoadIssueMessage(i)?.body.length).toBeGreaterThan(0)
    expect(settingsLoadIssueMessage(issues[2]!)?.body).toContain('EBUSY')
  })

  it('flushes on the window session-end (Windows shutdown/logoff), not on a dead app listener', () => {
    expect(h.appHandlers.has('session-end')).toBe(false)
    expect(h.winHandlers.get('session-end')).toHaveLength(1)
    emit(h.winHandlers, 'session-end')
    // and then quits: a non-forced Restart Manager close-app does not kill the process
    expect(h.calls).toEqual(['markQuitting', 'stopStats', 'saveNow', 'app.quit'])
  })

  it('flushes on will-quit for a normal quit and on powerMonitor shutdown', () => {
    emit(h.appHandlers, 'will-quit')
    expect(h.calls).toEqual(['stopStats', 'saveNow'])
    h.calls.length = 0
    emit(h.powerHandlers, 'shutdown')
    expect(h.calls).toEqual(['markQuitting', 'stopStats', 'saveNow'])
  })

  it('marks quitting on before-quit and destroys the tray on quit', () => {
    emit(h.appHandlers, 'before-quit')
    emit(h.appHandlers, 'quit')
    expect(h.calls).toEqual(['markQuitting', 'destroyTray'])
  })
})
