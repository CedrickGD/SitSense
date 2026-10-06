// Pure helpers for Settings › AI models and the posture setup card.
// Unit-tested in __tests__/ai-settings.test.ts.

import {
  AI_PRESETS,
  type AiConnection,
  type AiProviderKind,
  type AiProviderPreset,
  type AiSettings,
  type AiShareMode
} from '@shared/ai'
import type { CalibrationBaseline } from '@shared/posture'
import { isUsableConnection, keyRequired } from '@renderer/ai/helpers'
import { fmtRelative } from '@renderer/lib/format'

/** The UI is English: dates use a fixed locale, not the system's (no "2. Okt."). */
export const UI_LOCALE = 'en-GB'

const CUSTOM_PRESET = AI_PRESETS.find((p) => p.id === 'custom') ?? AI_PRESETS[AI_PRESETS.length - 1]

const trimSlash = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase()

export function presetById(id: string): AiProviderPreset {
  return AI_PRESETS.find((p) => p.id === id) ?? AI_PRESETS[0]
}

/**
 * Connections store only kind + baseUrl, so the preset is inferred: the kind's own
 * preset, or for OpenAI-compatible servers the preset whose URL matches (else Custom).
 */
export function presetForConnection(c: { kind: AiProviderKind; baseUrl: string | null }): AiProviderPreset {
  if (c.kind !== 'openai-compatible') return AI_PRESETS.find((p) => p.kind === c.kind) ?? CUSTOM_PRESET
  const url = c.baseUrl ? trimSlash(c.baseUrl) : ''
  return (
    AI_PRESETS.find((p) => p.kind === 'openai-compatible' && p.baseUrl !== '' && trimSlash(p.baseUrl) === url) ??
    CUSTOM_PRESET
  )
}

/** Base URL is always visible for OpenAI-compatible servers, behind "Advanced" for the hosted providers. */
export function baseUrlAlwaysVisible(preset: AiProviderPreset): boolean {
  return preset.kind === 'openai-compatible'
}

/** Two-letter monogram for the provider glyph. */
export function providerGlyph(preset: AiProviderPreset): string {
  const map: Record<string, string> = {
    gemini: 'G',
    vertex: 'V',
    openai: 'O',
    anthropic: 'A',
    openrouter: 'R',
    ollama: 'Ol',
    lmstudio: 'LM',
    custom: '{}'
  }
  return map[preset.id] ?? preset.label.slice(0, 2)
}

const isGoogle = (p: AiProviderPreset): boolean => p.kind === 'gemini' || p.kind === 'vertex'

/**
 * A short hint from the key's prefix — never echoes the key. Google's prefix does
 * not identify the endpoint ("AQ." is both Gemini and Vertex express), so the hint
 * says Test will find out.
 */
export function keyPrefixHint(preset: AiProviderPreset, rawKey: string): string | null {
  const key = rawKey.trim()
  if (key.length < 4) return null
  if (/\s/.test(rawKey.trim())) return 'The key contains a space — copy it again without spaces.'
  if (isGoogle(preset)) {
    if (key.startsWith('AQ.'))
      return 'A Google auth key. It works with Gemini or Vertex AI express — Test finds out which and switches if needed.'
    if (key.startsWith('AIza'))
      return preset.kind === 'vertex'
        ? 'Keys starting with “AIza” are AI Studio keys — Test will switch this to Google Gemini if needed.'
        : 'A classic AI Studio key.'
    return 'Google keys start with “AQ.” or “AIza” — check that you copied the whole key.'
  }
  if (preset.kind === 'anthropic' && !key.startsWith('sk-ant-')) return 'Anthropic keys start with “sk-ant-”.'
  if (preset.kind === 'openrouter' && !key.startsWith('sk-or-')) return 'OpenRouter keys start with “sk-or-”.'
  if (preset.kind === 'openai') {
    if (key.startsWith('sk-ant-')) return 'This looks like an Anthropic key — choose Anthropic as the provider.'
    if (key.startsWith('sk-or-')) return 'This looks like an OpenRouter key — choose OpenRouter as the provider.'
    if (!key.startsWith('sk-')) return 'OpenAI keys start with “sk-”.'
  }
  return null
}

export type TestStatus = 'ok' | 'failed' | 'untested'

export function testStatus(c: Pick<AiConnection, 'lastTest'>): TestStatus {
  return c.lastTest ? (c.lastTest.ok ? 'ok' : 'failed') : 'untested'
}

/** "just now", "4 min ago", "2 h ago", "yesterday", "12 Mar" */
export function formatAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  if (h < 48) return 'yesterday'
  return new Date(at).toLocaleDateString(UI_LOCALE, { day: 'numeric', month: 'short' })
}

/** The id main assigned to a newly added connection. */
export function findNewConnectionId(before: readonly AiConnection[], after: readonly AiConnection[]): string | null {
  const known = new Set(before.map((c) => c.id))
  return after.find((c) => !known.has(c.id))?.id ?? null
}

/** Model suggestions for the datalist: preset models first, then loaded ones, de-duplicated. */
export function modelSuggestions(preset: AiProviderPreset, loaded: readonly string[]): string[] {
  return [...new Set([...preset.models, ...loaded].filter((m) => m.trim() !== ''))]
}

// ---------- add / edit form ----------

export interface ConnectionDraft {
  presetId: string
  label: string
  baseUrl: string
  model: string
}

export function draftForPreset(preset: AiProviderPreset): ConnectionDraft {
  return { presetId: preset.id, label: preset.label, baseUrl: preset.baseUrl, model: preset.models[0] ?? '' }
}

export function draftForConnection(c: AiConnection): ConnectionDraft {
  const preset = presetForConnection(c)
  return { presetId: preset.id, label: c.label, baseUrl: c.baseUrl ?? preset.baseUrl, model: c.model }
}

/**
 * Switch the form to another preset. The label follows the preset unless the user
 * typed their own; base URL and model reset to the new preset's.
 */
export function switchPreset(d: ConnectionDraft, next: AiProviderPreset): ConnectionDraft {
  const prev = presetById(d.presetId)
  const label = d.label.trim() === '' || d.label === prev.label ? next.label : d.label
  return { presetId: next.id, label, baseUrl: next.baseUrl, model: next.models[0] ?? '' }
}

/** The payload for aiSaveConnection (main validates and normalizes it). */
export function draftPayload(d: ConnectionDraft, id: string | null): Partial<AiConnection> & { id?: string } {
  const preset = presetById(d.presetId)
  return {
    ...(id ? { id } : {}),
    kind: preset.kind,
    label: d.label.trim() || preset.label,
    baseUrl: d.baseUrl.trim() || null,
    model: d.model.trim()
  }
}

export type KeyAction = 'keep' | 'replace' | 'remove'

/** aiSaveConnection's key argument: undefined = keep, null = delete, string = set. */
export function keyArgument(action: KeyAction, input: string): string | null | undefined {
  if (action === 'remove') return null
  return input.trim() ? input.trim() : undefined
}

// ---------- endpoints (mirrors main's ai/service.ts + ai/validate.ts) ----------

/** The built-in URL for a kind ('' for OpenAI-compatible servers, which always store one). */
const defaultBaseUrl = (kind: AiProviderKind): string => AI_PRESETS.find((p) => p.kind === kind)?.baseUrl ?? ''

/** Main's base-URL normalization; undefined when main would reject the URL (the save fails anyway). */
function normalizeBaseUrl(raw: string): string | null | undefined {
  const t = raw.trim()
  if (!t) return null
  try {
    const u = new URL(t)
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

/** The kind + baseUrl main would store for this draft (a hosted preset's own URL is stored as null). */
function storedEndpoint(d: ConnectionDraft): { kind: AiProviderKind; baseUrl: string | null } | null {
  const kind = presetById(d.presetId).kind
  const baseUrl = normalizeBaseUrl(d.baseUrl)
  if (baseUrl === undefined) return null
  if (kind !== 'openai-compatible' && baseUrl && baseUrl === defaultBaseUrl(kind)) return { kind, baseUrl: null }
  return { kind, baseUrl }
}

function originOf(c: { kind: AiProviderKind; baseUrl: string | null }): string {
  try {
    return new URL((c.baseUrl || defaultBaseUrl(c.kind)).replace(/\/+$/, '')).origin
  } catch {
    return ''
  }
}

const isGoogleKind = (k: AiProviderKind): boolean => k === 'gemini' || k === 'vertex'

/**
 * Why saving this draft would delete the kept key, or null when it wouldn't. Main drops a
 * stored key whenever the endpoint's origin changes — a provider switch, or just a new host
 * or port — except Gemini ↔ Vertex on Google's own URLs.
 */
export function saveDropsKey(
  saved: Pick<AiConnection, 'kind' | 'baseUrl'>,
  d: ConnectionDraft
): 'provider' | 'address' | null {
  const next = storedEndpoint(d)
  if (!next) return null
  if (originOf(saved) === originOf(next)) return null
  if (isGoogleKind(saved.kind) && isGoogleKind(next.kind) && !saved.baseUrl && !next.baseUrl) return null
  return presetForConnection(saved).id !== d.presetId ? 'provider' : 'address'
}

/** Saving the draft would change the saved connection (or nothing is saved yet). */
export function draftDiffers(saved: AiConnection | null, d: ConnectionDraft): boolean {
  if (!saved) return true
  const p = draftPayload(d, saved.id)
  const next = storedEndpoint(d)
  return (
    p.kind !== saved.kind ||
    p.label !== saved.label ||
    p.model !== saved.model ||
    !next ||
    next.baseUrl !== saved.baseUrl
  )
}

/** A hosted provider already routed through its own base URL: "Advanced" opens so the override is visible. */
export function hasBaseUrlOverride(d: ConnectionDraft): boolean {
  const preset = presetById(d.presetId)
  if (baseUrlAlwaysVisible(preset)) return false
  const t = d.baseUrl.trim()
  return t !== '' && trimSlash(t) !== trimSlash(preset.baseUrl)
}

// ---------- disclosure ----------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Presets that run the model themselves, so a review never leaves this computer. */
const RUNS_LOCALLY = new Set(['ollama', 'lmstudio'])

/**
 * Who receives a review, in plain words: "Google Gemini", "Ollama on this computer",
 * "OpenAI via the server at proxy.corp.example", "the server at llm.corp.example".
 * Only Ollama and LM Studio are said to keep it on this computer — a local gateway
 * (a custom server on localhost) can pass it on to cloud models.
 */
export function providerPhrase(c: Pick<AiConnection, 'kind' | 'baseUrl'>): string {
  const preset = presetForConnection(c)
  let host: string | null = null
  try {
    host = new URL(c.baseUrl || preset.baseUrl).hostname
  } catch {
    host = null
  }
  const local = host !== null && LOCAL_HOSTS.has(host)
  const server = local ? 'the server on this computer' : host ? `the server at ${host}` : 'your server'

  if (preset.kind === 'openai-compatible') {
    // Ollama / LM Studio are only recognised by their own localhost URL
    if (RUNS_LOCALLY.has(preset.id)) return `${preset.label} on this computer`
    return local ? `${server}, which may pass it on to other services` : server
  }
  // a hosted provider behind a proxy: the proxy is what receives the data
  if (c.baseUrl && trimSlash(c.baseUrl) !== trimSlash(preset.baseUrl)) return `${preset.label} via ${server}`
  return preset.label
}

/**
 * Everyone a review may reach, in the order they're asked: main moves on to the next
 * usable connection when one can't answer. One that's on but can't be called (no key,
 * model or server address) never receives anything, so it isn't named. De-duplicated.
 */
export function recipientPhrases(connections: readonly AiConnection[]): string[] {
  return [...new Set(connections.filter(connectionUsable).map(providerPhrase))]
}

export function shareDisclosure(share: AiShareMode, recipients: string | readonly string[] | null): string {
  const list = recipients === null ? [] : typeof recipients === 'string' ? [recipients] : [...recipients]
  const first = list[0] ?? 'your connected provider'
  const rest = list.slice(1)
  const what =
    share === 'sketch'
      ? 'a drawing of your pose (lines and dots on a plain background, no camera image)'
      : 'one small still from your camera (at most 640 px), which shows you and the room behind you'
  // the coach asks the connections in the same order, so the fallback sentence covers both
  const fallback = rest.length ? ` If that one can’t answer, the same goes to ${rest.join(', then ')}.` : ''
  return (
    `When you press Check my posture now or setup double-checks your posture, SitSense sends ${what}, plus the angles it measured, to ${first}.${fallback}` +
    ' When you message the coach, it sends your words, the recent conversation and the items ticked under “What your coach sees” (today’s stats, your saved posture, live numbers) to the same connection — never an image.' +
    ' Nothing is sent in the background. While monitoring is paused nothing from the camera leaves this PC (no image, no live numbers); coach questions are still answered.'
  )
}

// ---------- AI status line (Settings › AI models hero) ----------

/**
 * Why a connection can't be called yet ('Needs a key' …), or null when it can. The reasons
 * behind isUsableConnection (ai/helpers.ts) / main's isUsable, minus the enabled switch.
 */
export function connectionProblem(c: Pick<AiConnection, 'kind' | 'model' | 'hasKey' | 'baseUrl'>): string | null {
  if (c.kind === 'openai-compatible' && !c.baseUrl) return 'Needs a server address'
  if (keyRequired(c.kind) && !c.hasKey) return 'Needs a key'
  if (c.model.trim().length === 0) return 'Needs a model'
  return null
}

/** What a request would really call: on, and nothing missing (the shared predicate). */
export function connectionUsable(c: AiConnection): boolean {
  return isUsableConnection(c)
}

export type AiStatus =
  | { kind: 'off'; text: string }
  | { kind: 'ok'; text: string; primary: AiConnection; fallbacks: number }
  | { kind: 'broken'; text: string }

/**
 * 'Off — SitSense sends nothing to an AI model.' / 'On · Primary: Gemini (gemini-x) · 2 fallbacks'
 * / 'On, but no connection works yet' (nothing usable, or every usable one failed its last test).
 * The primary is the first usable connection — the one a request really tries first.
 */
export function aiStatus(ai: Pick<AiSettings, 'enabled' | 'connections'>): AiStatus {
  if (!ai.enabled) return { kind: 'off', text: 'Off — SitSense sends nothing to an AI model.' }
  const usable = ai.connections.filter(connectionUsable)
  const primary = usable[0]
  if (!primary || usable.every((c) => c.lastTest?.ok === false))
    return { kind: 'broken', text: 'On, but no connection works yet' }
  const fallbacks = usable.length - 1
  const fb = fallbacks > 0 ? ` · ${fallbacks} ${fallbacks === 1 ? 'fallback' : 'fallbacks'}` : ''
  return { kind: 'ok', text: `On · Primary: ${primary.label} (${primary.model})${fb}`, primary, fallbacks }
}

// ---------- Posture setup card ----------

const VIEW_WORDS: Record<CalibrationBaseline['view']['kind'], string> = {
  front: 'Front view',
  angled: 'Angled view',
  side: 'Side view'
}

/** "today 14:20", "yesterday 09:05", "12 Mar 2026, 16:40" (the exact time, for tooltips) */
export function formatSetupTime(at: number, now: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString(UI_LOCALE, { hour: '2-digit', minute: '2-digit' })
  const day = (t: number): string => new Date(t).toDateString()
  if (day(at) === day(now)) return `today ${time}`
  if (day(at) === day(now - 86_400_000)) return `yesterday ${time}`
  return `${d.toLocaleDateString(UI_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })}, ${time}`
}

export interface SetupLine {
  /** "Set up 2 days ago" */
  ago: string
  /** exact time for the tooltip */
  when: string
  /** "Side view" */
  view: string
  verified: boolean
  /** "Verified by on-device AI" / "Not verified" */
  verdict: string
}

/** ui-v3 §10.5: `Set up {relative} · {view} · Verified by on-device AI` / `… · Not verified`. */
export function setupLine(b: CalibrationBaseline, now: number): SetupLine {
  return {
    ago: `Set up ${fmtRelative(b.capturedAt, now)}`,
    when: formatSetupTime(b.capturedAt, now),
    view: VIEW_WORDS[b.view.kind] ?? 'Your camera',
    verified: b.verified,
    verdict: b.verified ? 'Verified by on-device AI' : 'Not verified'
  }
}
