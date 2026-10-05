// App updates from GitHub Releases (docs/specs/architecture.md §2 "App updates", packaging.md
// "Updates"). Main owns the updater (src/main/updater.ts); the renderer only shows
// this status and asks main to check / download / install.

/** Where releases are published. Must match `publish` in electron-builder.yml. */
export const UPDATE_REPO = { owner: 'CedrickGD', repo: 'SitSense' } as const

export const RELEASES_URL = `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases`

/**
 * installed — the NSIS install: downloads in the background, installs on restart/quit.
 * portable  — SitSense-portable-<v>.exe: only checks; the user downloads the new exe.
 * dev       — unpackaged (electron-vite dev / preview): no updater at all.
 */
export type UpdateMode = 'installed' | 'portable' | 'dev'

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  /** a newer version exists; installed builds move on to 'downloading' by themselves */
  | { kind: 'available'; version: string; notes: string | null; portable: boolean }
  | { kind: 'downloading'; version: string; percent: number }
  /** downloaded and verified; installs on restart (or when SitSense quits) */
  | { kind: 'ready'; version: string }
  /** one short, friendly sentence (never a raw stack or URL) */
  | { kind: 'error'; message: string }

export interface UpdateStatus {
  /** the running version (app.getVersion()) */
  currentVersion: string
  mode: UpdateMode
  state: UpdateState
  /** epoch ms of the last finished check (any outcome), null = none this session */
  lastCheckedAt: number | null
}

const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/

/** A plain semver string as electron-updater reports it ("0.2.0", "1.0.0-beta.1"). */
export function isVersionString(v: unknown): v is string {
  return typeof v === 'string' && SEMVER.test(v)
}

/** The GitHub release page of `version` (tags are "v<version>"); the release list for anything odd. */
export function releasePageUrl(version: string | null | undefined): string {
  return isVersionString(version) ? `${RELEASES_URL}/tag/v${version}` : `${RELEASES_URL}/latest`
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export function isUpdateState(v: unknown): v is UpdateState {
  if (!isObj(v)) return false
  switch (v['kind']) {
    case 'idle':
    case 'checking':
    case 'up-to-date':
      return true
    case 'available':
      return (
        isVersionString(v['version']) &&
        (v['notes'] === null || typeof v['notes'] === 'string') &&
        typeof v['portable'] === 'boolean'
      )
    case 'downloading':
      return isVersionString(v['version']) && typeof v['percent'] === 'number' && v['percent'] >= 0 && v['percent'] <= 100
    case 'ready':
      return isVersionString(v['version'])
    case 'error':
      return typeof v['message'] === 'string'
    default:
      return false
  }
}

/** Shape check for a status crossing IPC (main → renderer). */
export function isUpdateStatus(v: unknown): v is UpdateStatus {
  return (
    isObj(v) &&
    typeof v['currentVersion'] === 'string' &&
    (v['mode'] === 'installed' || v['mode'] === 'portable' || v['mode'] === 'dev') &&
    isUpdateState(v['state']) &&
    (v['lastCheckedAt'] === null || (typeof v['lastCheckedAt'] === 'number' && Number.isFinite(v['lastCheckedAt'])))
  )
}
