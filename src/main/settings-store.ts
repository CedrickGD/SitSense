import { join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../shared/settings'
import { readJson, writeJsonAtomic } from './json-file'

type Listener = (s: Settings) => void

let settings: Settings = structuredClone(DEFAULT_SETTINGS)
const listeners = new Set<Listener>()
let saveTimer: NodeJS.Timeout | null = null

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): Settings {
  // a missing or unreadable file means defaults — but a corrupt one is set
  // aside (and the .bak used) rather than overwritten, see readJson
  const raw = readJson(settingsFile())
  settings = raw === null ? structuredClone(DEFAULT_SETTINGS) : mergeSettings(raw)
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
  try {
    writeJsonAtomic(settingsFile(), settings, { backup: true })
  } catch (err) {
    console.error('[settings] save failed:', err)
  }
}
