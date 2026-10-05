import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'

type Handler = (e: unknown, ...args: unknown[]) => unknown

const h = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Handler>()
  const top = { parent: null as unknown, processId: 7, routingId: 1, url: 'app://renderer/index.html' }
  const wc = { mainFrame: top, isCrashed: () => false, send: () => {} }
  const win = {
    isDestroyed: () => false,
    webContents: wc,
    minimize: () => calls.push('win.minimize'),
    close: () => calls.push('win.close')
  }
  const calls: string[] = []
  const state = { win: win as unknown, alertShown: true }
  const rec =
    (name: string, ret: unknown = undefined) =>
    (..._a: unknown[]) => {
      calls.push(name)
      return ret
    }
  return { handlers, listeners, top, wc, win, state, calls, rec }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', isPackaged: false, quit: h.rec('app.quit') },
  ipcMain: {
    handle: (ch: string, fn: Handler) => h.handlers.set(ch, fn),
    on: (ch: string, fn: Handler) => h.listeners.set(ch, fn)
  }
}))
vi.mock('../ai', () => ({
  initAi: () => ({
    saveConnection: h.rec('ai.save', {}),
    removeConnection: h.rec('ai.remove', {}),
    moveConnection: h.rec('ai.move', {}),
    testConnection: h.rec('ai.test', {}),
    listModels: h.rec('ai.list', {}),
    reviewPosture: h.rec('ai.review', {}),
    chat: h.rec('ai.chat', {})
  })
}))
vi.mock('../autostart', () => ({ applyAutostart: h.rec('autostart') }))
vi.mock('../notifications', () => ({ fireAlert: () => (h.calls.push('fireAlert'), h.state.alertShown), testNotification: h.rec('testNotification') }))
vi.mock('../breaks', () => ({
  breaksPostureUpdate: h.rec('breaksPostureUpdate'),
  breaksSettingsChanged: h.rec('breaksSettingsChanged'),
  getSittingState: h.rec('getSittingState', {}),
  snoozeBreak: h.rec('snoozeBreak', {})
}))
vi.mock('../pause', () => ({ getPauseState: () => ({ paused: false, resumeAt: null }), setPause: h.rec('setPause', {}) }))
vi.mock('../settings-store', () => ({ getSettings: h.rec('getSettings', {}), updateSettings: h.rec('updateSettings', {}) }))
vi.mock('../stats', () => ({
  getTodayStats: h.rec('getTodayStats', {}),
  getStatsRange: h.rec('getStatsRange', {}),
  statsPostureUpdate: h.rec('statsPostureUpdate'),
  statsRecordAlert: h.rec('statsRecordAlert')
}))
vi.mock('../tray', () => ({ refreshTray: h.rec('refreshTray'), trayPostureUpdate: h.rec('trayPostureUpdate') }))
vi.mock('../updater-init', () => ({
  initUpdater: () => ({
    getStatus: h.rec('update.getStatus', { state: { kind: 'idle' } }),
    check: (...a: unknown[]) => (h.calls.push(`update.check(${a.map((x) => JSON.stringify(x)).join(',')})`), {}),
    download: (...a: unknown[]) => (h.calls.push(`update.download(${a.map((x) => JSON.stringify(x)).join(',')})`), {}),
    install: (...a: unknown[]) => (h.calls.push(`update.install(${a.map((x) => JSON.stringify(x)).join(',')})`), false)
  })
}))
vi.mock('../window', () => ({
  getMainWindow: () => h.state.win,
  isMainWindowVisible: () => true,
  markQuitting: h.rec('markQuitting'),
  sendToRenderer: h.rec('sendToRenderer')
}))

import { getLastDetectionStatus, isTrustedIpcSender, registerIpc } from '../ipc'

const SNAPSHOT = {
  presence: 'present',
  issues: { headForward: { issue: 'headForward', stage: 0, activeForMs: null, metric: 0 } },
  worstStage: 0,
  calibrated: true,
  recalibrationSuggested: false,
  ts: 1
}
const ALERT = { issue: 'headForward', stage: 1, kind: 'initial', durationMs: 1000 }
const STATUS = { running: true, delegate: 'GPU', targetFps: 10, measuredFps: 9, cameraError: null }
const sendArgs: Record<string, unknown> = {
  [IPC.postureUpdate]: SNAPSHOT,
  [IPC.alertFire]: ALERT,
  [IPC.detectionStatus]: STATUS
}

type Frame = { parent: unknown; processId: number; routingId: number; url: string }
const ev = (frame: Partial<Frame> | null = {}, sender: unknown = h.wc) => ({
  sender,
  senderFrame: frame === null ? null : { ...h.top, ...frame }
})
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const check = (e: unknown, win: unknown = h.win, dev?: string): boolean => isTrustedIpcSender(e as any, win as any, dev)

describe('isTrustedIpcSender', () => {
  it('accepts the main window top frame on app://renderer', () => {
    expect(check(ev())).toBe(true)
    expect(check(ev({ url: 'app://renderer/' }))).toBe(true)
  })

  it('accepts the dev server origin only when it is the configured renderer URL', () => {
    const dev = ev({ url: 'http://localhost:5173/#/settings' })
    expect(check(dev, h.win, 'http://localhost:5173')).toBe(true)
    expect(check(dev)).toBe(false)
    expect(check(ev({ url: 'http://localhost:5174/' }), h.win, 'http://localhost:5173')).toBe(false)
  })

  it.each([
    ['a foreign origin', ev({ url: 'https://evil.example/' })],
    ['a file: page', ev({ url: 'file:///C:/x/index.html' })],
    ['an app: lookalike host', ev({ url: 'app://renderer.evil/index.html' })],
    ['an unparsable URL', ev({ url: 'not a url' })],
    ['a subframe', ev({ parent: { url: 'app://renderer/index.html' } })],
    ['another frame id of the same window', ev({ routingId: 2 })],
    ['another renderer process', ev({ processId: 99 })],
    ['a destroyed frame (senderFrame null)', ev(null)],
    ['another webContents', ev({}, { mainFrame: h.top })]
  ])('rejects %s', (_n, e) => {
    expect(check(e)).toBe(false)
  })

  it('rejects when the main window is missing or destroyed', () => {
    expect(check(ev(), null)).toBe(false)
    expect(check(ev(), { ...h.win, isDestroyed: () => true })).toBe(false)
  })

  it('rejects a disposed frame whose properties throw', () => {
    const frame = {
      get parent(): never {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
    }
    expect(check({ sender: h.wc, senderFrame: frame })).toBe(false)
  })
})

describe('registerIpc sender validation', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  beforeEach(() => {
    delete process.env['ELECTRON_RENDERER_URL']
    h.handlers.clear()
    h.listeners.clear()
    h.state.win = h.win
    registerIpc()
    h.calls.length = 0
  })
  afterEach(() => warn.mockClear())

  const argsFor: Record<string, unknown[]> = {
    [IPC.pauseSet]: [true, 15],
    [IPC.windowControl]: ['minimize'],
    [IPC.statsGetRange]: [7],
    [IPC.breakSnooze]: [10]
  }

  it('guards every invoke and send channel the renderer can reach', () => {
    const renderToMain = [
      IPC.settingsGet,
      IPC.settingsSet,
      IPC.appGetStatus,
      IPC.statsGetToday,
      IPC.notifyTest,
      IPC.pauseSet,
      IPC.windowControl,
      IPC.quitApp,
      IPC.aiSaveConnection,
      IPC.aiRemoveConnection,
      IPC.aiMoveConnection,
      IPC.aiTestConnection,
      IPC.aiListModels,
      IPC.aiReviewPosture,
      IPC.aiChat,
      IPC.statsGetRange,
      IPC.breakSnooze,
      IPC.updateGetState,
      IPC.updateCheck,
      IPC.updateDownload,
      IPC.updateInstall
    ]
    expect([...h.handlers.keys()].sort()).toEqual([...renderToMain].sort())
    expect([...h.listeners.keys()].sort()).toEqual([IPC.postureUpdate, IPC.alertFire, IPC.detectionStatus].sort())
  })

  it('rejects every invoke from an untrusted frame without running the handler', async () => {
    for (const [ch, fn] of h.handlers) {
      for (const bad of [ev({ url: 'https://evil.example/' }), ev({ parent: {} }), ev(null), ev({}, {})]) {
        await expect(Promise.resolve().then(() => fn(bad, ...(argsFor[ch] ?? [])))).rejects.toThrow(/Unauthorized IPC sender/)
      }
    }
    expect(h.calls).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('drops every send from an untrusted frame', () => {
    for (const [ch, fn] of h.listeners) fn(ev({ url: 'https://evil.example/' }), sendArgs[ch])
    expect(h.calls).toEqual([])
  })

  it('rejects everything when there is no main window', async () => {
    h.state.win = null
    await expect(Promise.resolve().then(() => h.handlers.get(IPC.settingsGet)!(ev()))).rejects.toThrow(/Unauthorized/)
    h.listeners.get(IPC.alertFire)!(ev(), ALERT)
    expect(h.calls).toEqual([])
  })

  it('serves our own renderer', async () => {
    for (const [ch, fn] of h.handlers) await fn(ev(), ...(argsFor[ch] ?? []))
    for (const [ch, fn] of h.listeners) fn(ev(), sendArgs[ch])
    expect(h.calls).toEqual(
      expect.arrayContaining([
        'getSettings',
        'updateSettings',
        'getTodayStats',
        'testNotification',
        'setPause',
        'markQuitting',
        'app.quit',
        'ai.save',
        'ai.remove',
        'ai.move',
        'ai.test',
        'ai.list',
        'ai.review',
        'ai.chat',
        'getStatsRange',
        'snoozeBreak',
        'getSittingState',
        'update.getStatus',
        'update.check(true)',
        'update.download()',
        'update.install()',
        'breaksSettingsChanged',
        'trayPostureUpdate',
        'statsPostureUpdate',
        'breaksPostureUpdate',
        'fireAlert',
        'statsRecordAlert'
      ])
    )
    expect(getLastDetectionStatus()).toEqual(STATUS)
    expect(warn).not.toHaveBeenCalled()
  })

  it('serves the dev server renderer when ELECTRON_RENDERER_URL names it', async () => {
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173'
    await h.handlers.get(IPC.settingsGet)!(ev({ url: 'http://localhost:5173/' }))
    expect(h.calls).toEqual(['getSettings'])
  })
})

describe('registerIpc payload checks (trusted sender, malformed payload)', () => {
  beforeEach(() => {
    h.handlers.clear()
    h.listeners.clear()
    h.state.win = h.win
    registerIpc()
    h.calls.length = 0
  })

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['no issues', { ...SNAPSHOT, issues: {} }],
    ['an issue without a stage', { ...SNAPSHOT, issues: { headForward: { issue: 'headForward' } } }],
    ['a missing timestamp', { ...SNAPSHOT, ts: undefined }]
  ])('drops a posture update that is %s', (_n, payload) => {
    expect(() => h.listeners.get(IPC.postureUpdate)!(ev(), payload)).not.toThrow()
    expect(h.calls).toEqual([])
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['missing its kind', { issue: 'headForward', stage: 1 }],
    ['a non-numeric stage', { ...ALERT, stage: '1' }]
  ])('drops an alert that is %s without throwing', (_n, payload) => {
    expect(() => h.listeners.get(IPC.alertFire)!(ev(), payload)).not.toThrow()
    expect(h.calls).toEqual([])
  })

  it('counts an alert in the day stats only when a nudge was shown', () => {
    h.state.alertShown = false
    h.listeners.get(IPC.alertFire)!(ev(), ALERT)
    expect(h.calls).toEqual(['fireAlert'])
    h.state.alertShown = true
    h.listeners.get(IPC.alertFire)!(ev(), ALERT)
    expect(h.calls).toEqual(['fireAlert', 'fireAlert', 'statsRecordAlert'])
  })

  it('feeds posture updates to the tray, stats and break tracker', () => {
    h.listeners.get(IPC.postureUpdate)!(ev(), SNAPSHOT)
    expect(h.calls).toEqual(['trayPostureUpdate', 'statsPostureUpdate', 'breaksPostureUpdate'])
  })

  it('ignores a malformed detection status', () => {
    h.listeners.get(IPC.detectionStatus)!(ev(), STATUS)
    h.listeners.get(IPC.detectionStatus)!(ev(), null)
    h.listeners.get(IPC.detectionStatus)!(ev(), { running: 'yes' })
    expect(getLastDetectionStatus()).toEqual(STATUS)
  })

  it('update channels never pass renderer arguments to the updater', async () => {
    const junk = ['https://evil.example/SitSense-Setup-9.9.9.exe', { version: '9.9.9' }, false]
    await h.handlers.get(IPC.updateGetState)!(ev(), ...junk)
    await h.handlers.get(IPC.updateCheck)!(ev(), ...junk)
    await h.handlers.get(IPC.updateDownload)!(ev(), ...junk)
    await h.handlers.get(IPC.updateInstall)!(ev(), ...junk)
    // a check from the renderer is always a manual one; download/install take nothing
    expect(h.calls).toEqual(['update.getStatus', 'update.check(true)', 'update.download()', 'update.install()'])
  })

  it('window:control minimizes or hides, and ignores anything else', async () => {
    const fn = h.handlers.get(IPC.windowControl)!
    await fn(ev(), 'minimize')
    await fn(ev(), 'hide')
    for (const bad of [undefined, null, 'close', 'maximize', 1, {}]) await fn(ev(), bad)
    expect(h.calls).toEqual(['win.minimize', 'win.close'])
  })
})
