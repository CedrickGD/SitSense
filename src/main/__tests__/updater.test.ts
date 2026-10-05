import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isUpdateStatus, releasePageUrl, type UpdateStatus } from '../../shared/update'
import {
  UPDATE_ERRORS,
  UPDATE_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  createUpdateService,
  friendlyUpdateError,
  notesText,
  type UpdaterLike
} from '../updater'

type CheckResult = Awaited<ReturnType<UpdaterLike['checkForUpdates']>>

/**
 * A stand-in for electron-updater's autoUpdater: emits the same events in the same
 * order as AppUpdater.checkForUpdates() / downloadUpdate(). `next` decides what the
 * next check finds.
 */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true
  checks = 0
  downloads = 0
  installs: [boolean | undefined, boolean | undefined][] = []
  next: { kind: 'none' } | { kind: 'update'; version: string; notes?: unknown } | { kind: 'fail'; error: Error } = { kind: 'none' }
  /** settle the auto-download (installed) */
  finishDownload: (() => void) | null = null
  failDownload: ((e: Error) => void) | null = null

  async checkForUpdates(): Promise<CheckResult> {
    this.checks++
    this.emit('checking-for-update')
    await Promise.resolve()
    const n = this.next
    if (n.kind === 'fail') {
      // AppUpdater emits 'error' and then rejects
      this.emit('error', n.error)
      throw n.error
    }
    if (n.kind === 'none') {
      this.emit('update-not-available', { version: '0.2.0' })
      return { isUpdateAvailable: false }
    }
    this.emit('update-available', { version: n.version, releaseNotes: n.notes })
    return { isUpdateAvailable: true, downloadPromise: this.autoDownload ? this.downloadUpdate() : null }
  }

  downloadUpdate(): Promise<unknown> {
    this.downloads++
    const version = this.next.kind === 'update' ? this.next.version : '?'
    return new Promise((resolve, reject) => {
      this.finishDownload = () => {
        this.emit('download-progress', { percent: 100 })
        this.emit('update-downloaded', { version })
        resolve(['setup.exe'])
      }
      this.failDownload = (e) => {
        this.emit('error', e)
        reject(e)
      }
    })
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter])
  }
}

const offline = (): Error => Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), { code: 'ERR_INTERNET_DISCONNECTED' })

function setup(opts: { portable?: boolean; autoCheck?: boolean; noUpdater?: boolean } = {}) {
  const up = new FakeUpdater()
  const statuses: UpdateStatus[] = []
  const ready: string[] = []
  const opened: string[] = []
  const calls: string[] = []
  const settings = { autoCheck: opts.autoCheck ?? true }
  const svc = createUpdateService({
    updater: opts.noUpdater ? null : up,
    portable: opts.portable ?? false,
    currentVersion: '0.2.0',
    autoCheck: () => settings.autoCheck,
    onStatus: (s) => statuses.push(s),
    onReady: (v) => ready.push(v),
    beforeInstall: () => calls.push('beforeInstall'),
    openExternal: (u) => opened.push(u),
    now: () => 1234,
    log: () => {}
  })
  const kinds = (): string[] => statuses.map((s) => s.state.kind)
  return { up, svc, statuses, ready, opened, calls, settings, kinds }
}

describe('update service — installed (NSIS)', () => {
  it('turns on background download and install-on-quit', () => {
    const { up, svc } = setup()
    expect(up.autoDownload).toBe(true)
    expect(up.autoInstallOnAppQuit).toBe(true)
    expect(svc.getStatus()).toEqual({ currentVersion: '0.2.0', mode: 'installed', state: { kind: 'idle' }, lastCheckedAt: null })
  })

  it('reports up to date', async () => {
    const { svc, kinds } = setup()
    const s = await svc.check(true)
    expect(s.state).toEqual({ kind: 'up-to-date' })
    expect(s.lastCheckedAt).toBe(1234)
    expect(kinds()).toContain('checking')
  })

  it('downloads a new version, then is ready and installs on restart', async () => {
    const { up, svc, ready, calls, kinds } = setup()
    up.next = { kind: 'update', version: '0.3.0', notes: '<p>Faster <b>setup</b> &amp; fixes</p>' }
    const s = await svc.check(true)
    expect(s.state).toEqual({ kind: 'downloading', version: '0.3.0', percent: 0 })
    up.emit('download-progress', { percent: 41.6 })
    expect(svc.getStatus().state).toEqual({ kind: 'downloading', version: '0.3.0', percent: 42 })
    up.finishDownload!()
    expect(svc.getStatus().state).toEqual({ kind: 'ready', version: '0.3.0' })
    expect(ready).toEqual(['0.3.0'])
    expect(kinds()).toEqual(expect.arrayContaining(['checking', 'downloading', 'ready']))

    // nothing to check while an update waits for the restart
    await svc.check(true)
    expect(up.checks).toBe(1)

    expect(svc.install()).toBe(true)
    expect(calls).toEqual(['beforeInstall'])
    expect(up.installs).toEqual([[true, true]]) // silent installer, restart afterwards
  })

  it('announces a ready version once', async () => {
    const { up, svc, ready } = setup()
    up.next = { kind: 'update', version: '0.3.0' }
    await svc.check(true)
    up.finishDownload!()
    up.emit('update-downloaded', { version: '0.3.0' })
    expect(ready).toEqual(['0.3.0'])
  })

  it('does not install unless an update is ready', async () => {
    const { up, svc, calls } = setup()
    expect(svc.install()).toBe(false)
    up.next = { kind: 'update', version: '0.3.0' }
    await svc.check(true)
    expect(svc.install()).toBe(false) // still downloading
    expect(up.installs).toEqual([])
    expect(calls).toEqual([])
  })

  it('reports a failed download and can try again', async () => {
    const { up, svc } = setup()
    up.next = { kind: 'update', version: '0.3.0' }
    await svc.check(true)
    up.failDownload!(Object.assign(new Error('sha512 checksum mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' }))
    await Promise.resolve()
    expect(svc.getStatus().state).toEqual({ kind: 'error', message: UPDATE_ERRORS.integrity })
    await svc.check(true)
    expect(up.checks).toBe(2)
    expect(svc.getStatus().state.kind).toBe('downloading')
  })

  it('a later error never hides a ready update', async () => {
    const { up, svc } = setup()
    up.next = { kind: 'update', version: '0.3.0' }
    await svc.check(true)
    up.finishDownload!()
    up.emit('error', offline())
    expect(svc.getStatus().state).toEqual({ kind: 'ready', version: '0.3.0' })
  })
})

describe('update service — offline', () => {
  it('ends in a quiet, friendly error (no throw, no raw message)', async () => {
    const { up, svc } = setup()
    up.next = { kind: 'fail', error: offline() }
    const s = await svc.check(false)
    expect(s.state).toEqual({ kind: 'error', message: UPDATE_ERRORS.offline })
    expect(s.lastCheckedAt).toBe(1234)
    expect(JSON.stringify(s)).not.toMatch(/net::|ERR_/)
  })

  it('maps proxy/DNS failures (what the offline smoke test produces) to the offline message', () => {
    expect(friendlyUpdateError(new Error('net::ERR_PROXY_CONNECTION_FAILED'), 'check')).toBe(UPDATE_ERRORS.offline)
    expect(friendlyUpdateError(new Error('getaddrinfo ENOTFOUND github.com'), 'check')).toBe(UPDATE_ERRORS.offline)
    expect(friendlyUpdateError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'download')).toBe(UPDATE_ERRORS.offline)
  })

  it('maps other failures', () => {
    expect(friendlyUpdateError(new Error('HttpError: 404 Not Found'), 'check')).toBe(UPDATE_ERRORS.noRelease)
    expect(friendlyUpdateError(Object.assign(new Error('Cannot find latest.yml'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }), 'check')).toBe(UPDATE_ERRORS.noRelease)
    expect(friendlyUpdateError(Object.assign(new Error('rate limited'), { statusCode: 403 }), 'check')).toBe(UPDATE_ERRORS.rateLimited)
    expect(friendlyUpdateError(new Error("ENOENT: no such file or directory, open 'C:\\x\\resources\\app-update.yml'"), 'check')).toBe(UPDATE_ERRORS.notUpdatable)
    expect(friendlyUpdateError(new Error('something odd'), 'check')).toBe(UPDATE_ERRORS.check)
    expect(friendlyUpdateError('weird', 'download')).toBe(UPDATE_ERRORS.download)
    expect(friendlyUpdateError(null, 'check')).toBe(UPDATE_ERRORS.check)
  })
})

describe('update service — portable', () => {
  it('never downloads or installs', async () => {
    const { up, svc, ready, calls } = setup({ portable: true })
    expect(up.autoDownload).toBe(false)
    expect(up.autoInstallOnAppQuit).toBe(false)
    up.next = { kind: 'update', version: '0.3.0', notes: 'Better nudges' }
    const s = await svc.check(true)
    expect(s.mode).toBe('portable')
    expect(s.state).toEqual({ kind: 'available', version: '0.3.0', notes: 'Better nudges', portable: true })
    expect(up.downloads).toBe(0)
    up.emit('update-downloaded', { version: '0.3.0' })
    expect(svc.getStatus().state.kind).toBe('available')
    expect(ready).toEqual([])
    expect(svc.install()).toBe(false)
    expect(up.installs).toEqual([])
    expect(calls).toEqual([])
  })

  it('"Download" opens the GitHub release page instead', async () => {
    const { up, svc, opened } = setup({ portable: true })
    up.next = { kind: 'update', version: '0.3.0' }
    await svc.check(true)
    await svc.download()
    expect(opened).toEqual(['https://github.com/CedrickGD/SitSense/releases/tag/v0.3.0'])
    expect(up.downloads).toBe(0)
  })

  it('a failed background check keeps "version X is available"', async () => {
    const { up, svc } = setup({ portable: true })
    up.next = { kind: 'update', version: '0.3.0' }
    await svc.check(false)
    up.next = { kind: 'fail', error: offline() }
    await svc.check(false)
    expect(svc.getStatus().state.kind).toBe('available')
    await svc.check(true) // a manual check reports the failure
    expect(svc.getStatus().state).toEqual({ kind: 'error', message: UPDATE_ERRORS.offline })
  })
})

describe('update service — dev / unpackaged', () => {
  it('has no updater: nothing is checked, scheduled or installed', async () => {
    vi.useFakeTimers()
    try {
      const { svc, statuses, opened } = setup({ noUpdater: true })
      svc.start()
      vi.advanceTimersByTime(UPDATE_INTERVAL_MS * 2)
      expect((await svc.check(true)).state).toEqual({ kind: 'idle' })
      expect(svc.getStatus().mode).toBe('dev')
      await svc.download()
      expect(svc.install()).toBe(false)
      expect(statuses).toEqual([])
      expect(opened).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('update service — schedule', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('checks 30 s after start and every 6 h while auto-check is on', async () => {
    const { up, svc } = setup()
    svc.start()
    vi.advanceTimersByTime(UPDATE_STARTUP_DELAY_MS - 1)
    expect(up.checks).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(up.checks).toBe(1)
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS)
    expect(up.checks).toBe(2)
    svc.stop()
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 3)
    expect(up.checks).toBe(2)
  })

  it('makes no automatic request with auto-check off; a manual check still works', async () => {
    const { up, svc, settings } = setup({ autoCheck: false })
    svc.start()
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 3)
    expect(up.checks).toBe(0)
    await svc.check(true)
    expect(up.checks).toBe(1)
    settings.autoCheck = true
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS)
    expect(up.checks).toBe(2)
    svc.stop()
  })

  it('turning auto-check on after a skipped startup check checks right away', async () => {
    const { up, svc, settings } = setup({ autoCheck: false })
    svc.start()
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY_MS)
    expect(up.checks).toBe(0)
    settings.autoCheck = true
    svc.autoCheckChanged(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(up.checks).toBe(1)
    svc.autoCheckChanged(true) // already checked this session: no second request
    await vi.advanceTimersByTimeAsync(0)
    expect(up.checks).toBe(1)
    svc.stop()
  })

  it('runs one check at a time', async () => {
    const { up, svc } = setup()
    await Promise.all([svc.check(true), svc.check(true), svc.check(false)])
    expect(up.checks).toBe(1)
  })
})

describe('release notes and status shape', () => {
  it('turns release notes into short plain text', () => {
    expect(notesText('<h2>What’s new</h2><ul><li>Faster&nbsp;setup</li><li>A &lt;fix&gt;</li></ul><script>alert(1)</script>')).toBe('What’s new Faster setup A <fix>')
    expect(notesText([{ version: '0.3.0', note: '<p>One</p>' }, { version: '0.2.5', note: 'Two' }])).toBe('One Two')
    expect(notesText(null)).toBeNull()
    expect(notesText('   ')).toBeNull()
    expect(notesText('x'.repeat(1000))!.length).toBeLessThanOrEqual(400)
  })

  it('validates statuses crossing IPC', async () => {
    const { up, svc } = setup()
    up.next = { kind: 'update', version: '0.3.0' }
    await svc.check(true)
    expect(isUpdateStatus(svc.getStatus())).toBe(true)
    expect(isUpdateStatus({ currentVersion: '0.2.0', mode: 'installed', state: { kind: 'ready', version: '0.3.0' }, lastCheckedAt: null })).toBe(true)
    for (const bad of [
      null,
      {},
      { currentVersion: '0.2.0', mode: 'cloud', state: { kind: 'idle' }, lastCheckedAt: null },
      { currentVersion: '0.2.0', mode: 'installed', state: { kind: 'ready', version: 'javascript:alert(1)' }, lastCheckedAt: null },
      { currentVersion: '0.2.0', mode: 'installed', state: { kind: 'downloading', version: '0.3.0', percent: 140 }, lastCheckedAt: null },
      { currentVersion: '0.2.0', mode: 'installed', state: { kind: 'available', version: '0.3.0', notes: 1, portable: true }, lastCheckedAt: null },
      { currentVersion: '0.2.0', mode: 'installed', state: { kind: 'idle' }, lastCheckedAt: 'yesterday' }
    ]) {
      expect(isUpdateStatus(bad)).toBe(false)
    }
  })

  it('links a release page only for a plain version', () => {
    expect(releasePageUrl('0.3.0')).toBe('https://github.com/CedrickGD/SitSense/releases/tag/v0.3.0')
    expect(releasePageUrl('1.0.0-beta.2')).toBe('https://github.com/CedrickGD/SitSense/releases/tag/v1.0.0-beta.2')
    expect(releasePageUrl('../../evil')).toBe('https://github.com/CedrickGD/SitSense/releases/latest')
    expect(releasePageUrl(null)).toBe('https://github.com/CedrickGD/SitSense/releases/latest')
  })
})
