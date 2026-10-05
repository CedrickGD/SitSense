import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../shared/settings'

type Listener = (s: Settings) => void

let settings: Settings = structuredClone(DEFAULT_SETTINGS)
const listeners = new Set<Listener>()
let saveTimer: NodeJS.Timeout | null = null

/** post-merge hook owned by another module (AI: recompute hasKey/keyHint from the key store) */
type Normalizer = (s: Settings) => Settings
let normalizer: Normalizer | null = null

const normalize = (s: Settings): Settings => (normalizer ? normalizer(s) : s)

/** Install the post-merge hook; it also runs once over the current settings. */
export function setSettingsNormalizer(fn: Normalizer | null): void {
  normalizer = fn
  settings = normalize(settings)
}

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

let loadedFromDisk = false

/**
 * true when the last loadSettings() read and parsed settings.json (not a defaults
 * fallback) AND no quarantined `settings.json.corrupt-*` backup sits beside it.
 * A file written by a session that started from defaults after a corrupt load
 * parses cleanly but is not authoritative about AI connections (the backup still
 * holds them), so pruning keys against it would destroy keys the user can still
 * restore. Restoring or deleting the backup makes the next clean load count again.
 */
export function settingsLoadedFromDisk(): boolean {
  return loadedFromDisk
}

/** true when a quarantined corrupt settings backup exists (or the folder can't be listed: fail safe) */
function corruptBackupExists(file: string): boolean {
  const prefix = `${basename(file)}.corrupt-`
  try {
    return readdirSync(dirname(file)).some((f) => f.startsWith(prefix))
  } catch {
    return true
  }
}

/**
 * Why the last loadSettings() fell back to defaults although a settings file existed.
 * 'corrupt': the file did not parse (moved aside to `backup`, or kept in place if that failed).
 * 'unreadable': the file could not be read (e.g. EBUSY/EPERM while AV or backup software
 * held it at login) — it is left untouched and saves are suppressed for this session.
 */
export type SettingsLoadIssue =
  | { kind: 'corrupt'; backup: string | null; error: string }
  | { kind: 'unreadable'; code: string; error: string }

let loadIssue: SettingsLoadIssue | null = null
/** true while the on-disk file must not be overwritten (it exists but we never got to see its contents) */
let protectExisting = false

/** The last load's problem, if any (null after a clean load or a genuine first run). */
export function getSettingsLoadIssue(): SettingsLoadIssue | null {
  return loadIssue
}

const READ_RETRY_DELAY_MS = 150

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const errCode = (err: unknown): string => (err as NodeJS.ErrnoException | null)?.code ?? 'UNKNOWN'

type ReadResult = { ok: true; text: string } | { ok: false; code: string; error: unknown }

/** Read once, and once more after a short pause on anything but "file does not exist". */
function readWithRetry(file: string): ReadResult {
  let last: ReadResult = { ok: false, code: 'UNKNOWN', error: null }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { ok: true, text: readFileSync(file, 'utf8') }
    } catch (err) {
      last = { ok: false, code: errCode(err), error: err }
      if (last.code === 'ENOENT') return last
      if (attempt === 0) sleepSync(READ_RETRY_DELAY_MS)
    }
  }
  return last
}

/** Move a settings file that failed to parse out of the way so no later save can destroy it. */
function quarantineCorrupt(file: string): string | null {
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    renameSync(file, backup)
    return backup
  } catch {
    try {
      copyFileSync(file, backup)
      return backup
    } catch (err) {
      console.error('[settings] could not back up the corrupt settings file:', err)
      return null
    }
  }
}

function useDefaults(): Settings {
  settings = structuredClone(DEFAULT_SETTINGS)
  loadedFromDisk = false
  return settings
}

export function loadSettings(): Settings {
  const file = settingsFile()
  loadIssue = null
  protectExisting = false

  const read = readWithRetry(file)
  if (!read.ok) {
    if (read.code === 'ENOENT') return useDefaults() // genuine first run
    // the file exists but can't be read right now — never replace it with defaults
    protectExisting = true
    loadIssue = { kind: 'unreadable', code: read.code, error: String(read.error) }
    console.error(`[settings] ${file} is unreadable (${read.code}); using defaults for this session and leaving the file untouched:`, read.error)
    return useDefaults()
  }

  let parsed: unknown
  try {
    // a hand edit saved as "UTF-8 with BOM" (Notepad, PowerShell 5.1) must not count as corrupt
    const text = read.text.charCodeAt(0) === 0xfeff ? read.text.slice(1) : read.text
    parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SyntaxError('settings.json does not contain a JSON object')
    }
  } catch (err) {
    const backup = quarantineCorrupt(file)
    // if the backup failed, the original stays in place and must not be overwritten
    protectExisting = backup === null
    loadIssue = { kind: 'corrupt', backup, error: String(err) }
    console.error(
      backup
        ? `[settings] ${file} is corrupt; moved it to ${backup} and started from defaults:`
        : `[settings] ${file} is corrupt and could not be backed up; using defaults without saving:`,
      err
    )
    return useDefaults()
  }

  settings = normalize(mergeSettings(parsed))
  loadedFromDisk = !corruptBackupExists(file)
  return settings
}

export function getSettings(): Settings {
  return settings
}

/** Deep-partial patch; arrays and null replace wholesale. */
export function updateSettings(patch: unknown): Settings {
  // a null/scalar top-level "patch" must never wipe the whole settings object
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return settings
  settings = normalize(mergeSettings(deepMerge(settings, patch)))
  scheduleSave()
  for (const l of listeners) l(settings)
  return settings
}

export function onSettingsChanged(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  if (base === null || typeof base !== 'object' || Array.isArray(base)) base = {}
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge(out[k], v)
  }
  return out
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 500)
}

export function saveNow(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const file = settingsFile()
  if (protectExisting) {
    // the user's real file is still there and was never read — overwriting it with
    // defaults-plus-patches would destroy it; skip until it is gone or next launch
    if (existsSync(file)) {
      console.error('[settings] not saving: the existing settings file could not be read at startup')
      return
    }
    protectExisting = false
  }
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    // fsync before the rename so a power loss can't leave a truncated settings.json
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, JSON.stringify(settings, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch (err) {
    console.error('[settings] save failed:', err)
  }
}
