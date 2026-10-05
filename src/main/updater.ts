// The update service (docs/specs/architecture.md §2 "App updates"): a small state machine over
// electron-updater's autoUpdater, which talks to GitHub Releases. Pure — the
// autoUpdater, clock, settings and side effects are injected (src/main/updater-init.ts
// wires Electron), so tests drive it with a fake updater.
//
//   installed (NSIS)  check → download in the background → 'ready' → installs on
//                     "Restart to update" or when SitSense quits
//   portable          check only; 'available' links to the GitHub release page —
//                     a portable exe is never replaced or installed over
//   dev / unpackaged  no updater (`updater: null`): nothing is ever requested
//
// Network: only electron-updater's own requests (github.com release feed and
// latest.yml, the installer download from GitHub's asset hosts), only for a check
// the user asked for or — with settings.updates.autoCheck on — 30 s after start and
// every 6 h. Offline is quiet: the state becomes 'error' with one friendly sentence;
// no dialog, no toast.

import { releasePageUrl, type UpdateMode, type UpdateState, type UpdateStatus } from '../shared/update'

/** The part of electron-updater's AppUpdater this service uses. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; downloadPromise?: Promise<unknown> | null } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateServiceDeps {
  /** electron-updater's autoUpdater in a packaged build, null when unpackaged (no updater) */
  updater: UpdaterLike | null
  /** running as SitSense-portable-<v>.exe (PORTABLE_EXECUTABLE_FILE is set) */
  portable: boolean
  currentVersion: string
  /** settings.updates.autoCheck, read when a scheduled check is due */
  autoCheck: () => boolean
  /** every status change (→ renderer, tray) */
  onStatus: (s: UpdateStatus) => void
  /** an installed build finished downloading `version` (once per version) — show the toast */
  onReady?: (version: string) => void
  /** right before quitAndInstall: let windows close and flush state */
  beforeInstall?: () => void
  /** opens an https URL in the user's browser (portable "Download") */
  openExternal: (url: string) => void
  now?: () => number
  startupDelayMs?: number
  intervalMs?: number
  log?: (msg: string) => void
}

export interface UpdateService {
  getStatus(): UpdateStatus
  /** manual = the user pressed "Check for updates" (also allowed with auto-check off) */
  check(manual?: boolean): Promise<UpdateStatus>
  /** 'available': installed → download now; portable → open the release page */
  download(): Promise<UpdateStatus>
  /** 'ready' (installed only): quit and run the installer, then restart. false = nothing to install */
  install(): boolean
  /** schedule the startup check and the 6-hourly check (no-op without an updater) */
  start(): void
  stop(): void
  /** settings.updates.autoCheck changed */
  autoCheckChanged(enabled: boolean): void
}

export const UPDATE_STARTUP_DELAY_MS = 30_000
export const UPDATE_INTERVAL_MS = 6 * 60 * 60_000
const MAX_NOTES = 400

/** Release notes (GitHub gives HTML, or a list per version) → one short plain-text paragraph. */
export function notesText(raw: unknown): string | null {
  let text = ''
  if (typeof raw === 'string') text = raw
  else if (Array.isArray(raw)) {
    text = raw
      .map((n) => (n && typeof n === 'object' && typeof (n as { note?: unknown }).note === 'string' ? (n as { note: string }).note : ''))
      .join(' ')
  }
  text = text
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES - 1).trimEnd()}…` : text
}

export const UPDATE_ERRORS = {
  offline: 'Couldn’t reach GitHub. Check your internet connection and try again.',
  rateLimited: 'GitHub is limiting requests right now. Try again in a while.',
  noRelease: 'No update information was found on GitHub.',
  integrity: 'The downloaded update didn’t pass its integrity check, so it wasn’t installed.',
  notUpdatable: 'This copy of SitSense can’t update itself. Download the latest version from GitHub.',
  check: 'Couldn’t check for updates right now. Try again later.',
  download: 'The update couldn’t be downloaded. Try again later.'
} as const

/** Any updater error → one short sentence for the About card (the raw error only goes to the log). */
export function friendlyUpdateError(err: unknown, phase: 'check' | 'download'): string {
  const e = (err ?? {}) as { code?: unknown; message?: unknown; statusCode?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const msg = `${code} ${typeof e.message === 'string' ? e.message : String(err)}`
  const status = typeof e.statusCode === 'number' ? e.statusCode : Number(/\bstatus(?:Code)?\W+(\d{3})\b|\b(\d{3}) (?:Not Found|Forbidden)\b/i.exec(msg)?.slice(1).find(Boolean) ?? NaN)
  if (/net::ERR_|ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_|CONNECTION_|PROXY_|TIMED_OUT|ADDRESS_|TUNNEL_|SSL_|CERT_)|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up/i.test(msg)) {
    return UPDATE_ERRORS.offline
  }
  if (status === 403 || status === 429 || /rate limit/i.test(msg)) return UPDATE_ERRORS.rateLimited
  if (status === 404 || /ERR_UPDATER_(LATEST_VERSION_NOT_FOUND|CHANNEL_FILE_NOT_FOUND|NO_PUBLISHED_VERSIONS|NO_FILES_PROVIDED|ASSET_NOT_FOUND)|Cannot find (latest|channel)/i.test(msg)) {
    return UPDATE_ERRORS.noRelease
  }
  if (/sha512|sha2|checksum|ERR_UPDATER_INVALID_SIGNATURE|not signed|signature/i.test(msg)) return UPDATE_ERRORS.integrity
  if (/app-update\.yml|ENOENT/i.test(msg)) return UPDATE_ERRORS.notUpdatable
  return phase === 'download' ? UPDATE_ERRORS.download : UPDATE_ERRORS.check
}

const versionOf = (info: unknown): string | null => {
  const v = info && typeof info === 'object' ? (info as { version?: unknown }).version : null
  return typeof v === 'string' && v ? v : null
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const { updater, portable } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((m: string) => console.log(`[updater] ${m}`))
  const mode: UpdateMode = updater ? (portable ? 'portable' : 'installed') : 'dev'

  let state: UpdateState = { kind: 'idle' }
  let lastCheckedAt: number | null = null
  /** the check in flight: whether the user asked for it, and the state before it */
  let inFlight: { manual: boolean; prev: UpdateState } | null = null
  /** version being downloaded (progress events don't carry it) */
  let pendingVersion: string | null = null
  let announcedReady: string | null = null
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null
  let startupDone = false

  const current = (): UpdateState => state
  const status = (): UpdateStatus => ({ currentVersion: deps.currentVersion, mode, state, lastCheckedAt })
  const set = (next: UpdateState): void => {
    state = next
    deps.onStatus(status())
  }

  const onError = (err: unknown): void => {
    // a downloaded update stays installable whatever a later request does
    if (state.kind === 'ready') return
    const phase = state.kind === 'downloading' ? 'download' : 'check'
    const raw = err instanceof Error ? err.message : String(err)
    log(`${phase} failed: ${raw.split('\n')[0].slice(0, 300)}`)
    // a background check that fails must not hide a portable "version X is available"
    if (inFlight && !inFlight.manual && inFlight.prev.kind === 'available') {
      set(inFlight.prev)
      return
    }
    set({ kind: 'error', message: friendlyUpdateError(err, phase) })
  }

  if (updater) {
    // portable: never download, never install over the running exe
    updater.autoDownload = !portable
    updater.autoInstallOnAppQuit = !portable
    updater.on('checking-for-update', () => {
      if (state.kind !== 'ready' && state.kind !== 'downloading') set({ kind: 'checking' })
    })
    updater.on('update-not-available', () => set({ kind: 'up-to-date' }))
    updater.on('update-available', (info: unknown) => {
      const version = versionOf(info)
      if (!version) return
      pendingVersion = version
      const notes = notesText((info as { releaseNotes?: unknown }).releaseNotes)
      if (!portable && updater.autoDownload) set({ kind: 'downloading', version, percent: 0 })
      else set({ kind: 'available', version, notes, portable })
    })
    updater.on('download-progress', (p: { percent?: unknown }) => {
      if (portable || !pendingVersion || state.kind === 'ready') return
      const pct = typeof p?.percent === 'number' && Number.isFinite(p.percent) ? Math.min(100, Math.max(0, Math.round(p.percent))) : 0
      if (state.kind === 'downloading' && state.percent === pct) return
      set({ kind: 'downloading', version: pendingVersion, percent: pct })
    })
    updater.on('update-downloaded', (info: unknown) => {
      if (portable) return
      const version = versionOf(info) ?? pendingVersion
      if (!version) return
      set({ kind: 'ready', version })
      if (announcedReady !== version) {
        announcedReady = version
        deps.onReady?.(version)
      }
    })
    updater.on('error', (err: unknown) => onError(err))
  }

  async function check(manual = false): Promise<UpdateStatus> {
    if (!updater) return status()
    // one check at a time; nothing to check while a download runs or one is ready
    if (inFlight || state.kind === 'checking' || state.kind === 'downloading' || state.kind === 'ready') return status()
    const prev = state
    inFlight = { manual, prev }
    set({ kind: 'checking' })
    try {
      const result = await updater.checkForUpdates()
      // the download is followed through events; its rejection is reported via 'error'
      result?.downloadPromise?.catch(() => undefined)
      // no event settled the check (null = updater inactive): settle from the result.
      // (current(): the event handlers changed `state` while this awaited)
      if (current().kind === 'checking') {
        if (!result) set(prev)
        else if (result.isUpdateAvailable === false) set({ kind: 'up-to-date' })
        else set({ kind: 'idle' })
      }
    } catch (err) {
      onError(err)
    } finally {
      lastCheckedAt = now()
      inFlight = null
      deps.onStatus(status())
    }
    return status()
  }

  async function download(): Promise<UpdateStatus> {
    if (!updater || state.kind !== 'available') return status()
    if (portable) {
      deps.openExternal(releasePageUrl(state.version))
      return status()
    }
    const version = state.version
    pendingVersion = version
    set({ kind: 'downloading', version, percent: 0 })
    updater.downloadUpdate().catch(() => undefined) // reported through the 'error' event
    return status()
  }

  function install(): boolean {
    if (!updater || portable || state.kind !== 'ready') return false
    deps.beforeInstall?.()
    // silent NSIS install, then start SitSense again
    updater.quitAndInstall(true, true)
    return true
  }

  const scheduled = (): void => {
    if (deps.autoCheck()) void check(false)
  }

  return {
    getStatus: status,
    check,
    download,
    install,
    start() {
      if (!updater || startupTimer || intervalTimer) return
      startupTimer = setTimeout(() => {
        startupTimer = null
        startupDone = true
        scheduled()
      }, deps.startupDelayMs ?? UPDATE_STARTUP_DELAY_MS)
      intervalTimer = setInterval(scheduled, deps.intervalMs ?? UPDATE_INTERVAL_MS)
    },
    stop() {
      if (startupTimer) clearTimeout(startupTimer)
      if (intervalTimer) clearInterval(intervalTimer)
      startupTimer = null
      intervalTimer = null
    },
    autoCheckChanged(enabled) {
      // turned on after the startup check was skipped: check now rather than in up to 6 h
      if (enabled && startupDone && lastCheckedAt === null && state.kind === 'idle') void check(false)
    }
  }
}
