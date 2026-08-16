import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../shared/settings'

type Listener = (s: Settings) => void

let settings: Settings = structuredClone(DEFAULT_SETTINGS)
const listeners = new Set<Listener>()
let saveTimer: NodeJS.Timeout | null = null

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): Settings {
  try {
    settings = mergeSettings(JSON.parse(readFileSync(settingsFile(), 'utf8')))
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS)
  }
  return settings
}

export function getSettings(): Settings {
  return settings
}

/** Deep-partial patch; arrays and null replace wholesale. */
export function updateSettings(patch: unknown): Settings {
  // a null/scalar top-level "patch" must never wipe the whole settings object
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return settings
  settings = mergeSettings(deepMerge(settings, patch))
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
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(settings, null, 2))
    renameSync(tmp, file)
  } catch (err) {
    console.error('[settings] save failed:', err)
  }
}
