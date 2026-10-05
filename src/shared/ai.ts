// Bring-your-own AI model connections (docs/specs/ai-providers.md).
// Shared by main, preload and renderer. API keys never appear in these types:
// main keeps them encrypted and only reports hasKey/keyHint.
import type { IssueId, PresenceState, Stage, ViewKind } from './posture'

export const AI_PROVIDER_KINDS = ['gemini', 'vertex', 'openai', 'anthropic', 'openrouter', 'openai-compatible'] as const
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number]

export interface AiTestStatus {
  ok: boolean
  at: number
  message: string
  latencyMs: number | null
}

export interface AiConnection {
  id: string
  kind: AiProviderKind
  /** user-visible name, defaults to the preset's name */
  label: string
  /** required for 'openai-compatible'; optional override for the presets */
  baseUrl: string | null
  model: string
  enabled: boolean
  /** a key is stored in main's encrypted key store (recomputed by main, never trusted from disk) */
  hasKey: boolean
  /** e.g. "…x2Ig" */
  keyHint: string | null
  lastTest: AiTestStatus | null
}

export type AiShareMode = 'sketch' | 'snapshot'

export interface AiSettings {
  /** master switch — off means zero network requests */
  enabled: boolean
  /** what leaves the device with a review: a pose drawing (default) or a camera snapshot */
  share: AiShareMode
  /** ask the connected model to confirm the posture before setup saves the baseline */
  useInSetup: boolean
  /** order = priority; the first enabled one is primary, the rest are fallbacks */
  connections: AiConnection[]
}

export interface AiProviderPreset {
  id: string
  kind: AiProviderKind
  label: string
  /** empty = the user must enter one */
  baseUrl: string
  /** suggested vision-capable models, first = default */
  models: string[]
  keyRequired: boolean
  keyHelp: string
}

/** Templates for the "Add connection" form — a connection stores only kind + baseUrl. */
export const AI_PRESETS: readonly AiProviderPreset[] = [
  {
    id: 'gemini',
    kind: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.5-flash'],
    keyRequired: true,
    keyHelp: 'Create a key at aistudio.google.com/api-keys (starts with "AQ." or "AIza").'
  },
  {
    id: 'vertex',
    kind: 'vertex',
    label: 'Google Vertex AI (express)',
    baseUrl: 'https://aiplatform.googleapis.com/v1',
    models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.5-flash'],
    keyRequired: true,
    keyHelp: 'An express-mode API key from the Google Cloud console (starts with "AQ.").'
  },
  {
    id: 'openai',
    kind: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6-luna'],
    keyRequired: true,
    keyHelp: 'Create a key at platform.openai.com/api-keys (starts with "sk-").'
  },
  {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5'],
    keyRequired: true,
    keyHelp: 'Create a key at console.anthropic.com (starts with "sk-ant-").'
  },
  {
    id: 'openrouter',
    kind: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['google/gemini-3.5-flash-lite', 'openai/gpt-6-luna', 'anthropic/claude-haiku-4.5'],
    keyRequired: true,
    keyHelp: 'Create a key at openrouter.ai/keys (starts with "sk-or-").'
  },
  {
    id: 'ollama',
    kind: 'openai-compatible',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    models: [],
    keyRequired: false,
    keyHelp: 'Runs fully on this computer. Pick a vision model you have pulled (e.g. a "-vl" model).'
  },
  {
    id: 'lmstudio',
    kind: 'openai-compatible',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    models: [],
    keyRequired: false,
    keyHelp: 'Runs fully on this computer. Load a vision model and start the local server.'
  },
  {
    id: 'custom',
    kind: 'openai-compatible',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    models: [],
    keyRequired: false,
    keyHelp: 'Any OpenAI-compatible endpoint, e.g. LiteLLM or a company gateway.'
  }
]

export const AI_LIMITS = {
  maxConnections: 12,
  maxLabel: 60,
  maxModel: 200,
  maxBaseUrl: 500,
  maxKey: 4096,
  maxImageBytes: 1_500_000,
  maxSummary: 200,
  maxInstruction: 120,
  maxInstructions: 3,
  timeoutMs: 25_000
} as const

export interface AiTestResult {
  ok: boolean
  message: string
  latencyMs: number | null
  /**
   * Set when the Google key probe found that the key belongs to the other Google
   * endpoint: main already switched the connection to this kind (and broadcast
   * settingsChanged); `message` says so, e.g. "This key works with Vertex AI — switched."
   */
  switchedKind?: AiProviderKind
}

/**
 * The user-facing text of a rejected AI IPC call (aiSaveConnection / aiRemoveConnection /
 * aiMoveConnection throw on invalid input). Electron prefixes the message with
 * "Error invoking remote method '…': Error: " — this strips that.
 */
export function aiErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const m = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^\w*Error:\s*/, '')
  return m.trim() || 'Something went wrong.'
}

export interface AiReviewMeasurements {
  view: 'front' | 'angled' | 'side'
  neckFwdDeg: number | null
  trunkFwdDeg: number | null
  headPitchDeg: number | null
  shoulderTiltDeg: number | null
  headRollDeg: number | null
  trunkLatDeg: number | null
  localVerdict: 'good' | 'adjust'
  localInstruction: string | null
}

export interface AiReviewRequest {
  purpose: 'setup' | 'check'
  /** base64 JPEG (no data: prefix) — a pose sketch or a camera snapshot per `share` */
  imageJpegB64: string
  share: AiShareMode
  measurements: AiReviewMeasurements
}

export type AiPostureReview =
  | {
      ok: true
      connectionLabel: string
      model: string
      verdict: 'good' | 'adjust'
      score: number
      summary: string
      instructions: string[]
    }
  | { ok: false; message: string }

export type AiModelList = { ok: true; models: string[] } | { ok: false; message: string }

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  share: 'sketch',
  useInSetup: true,
  connections: []
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

/** Validate a persisted/patched AI settings object field by field. */
export function mergeAiSettings(p: unknown): AiSettings {
  const base = structuredClone(DEFAULT_AI_SETTINGS)
  if (!isObj(p)) return base
  const out: AiSettings = {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    share: p.share === 'snapshot' || p.share === 'sketch' ? p.share : base.share,
    useInSetup: typeof p.useInSetup === 'boolean' ? p.useInSetup : base.useInSetup,
    connections: []
  }
  const seen = new Set<string>()
  for (const c of Array.isArray(p.connections) ? p.connections : []) {
    if (!isObj(c)) continue
    const id = str(c.id, 64)
    const kind = c.kind as AiProviderKind
    if (!id || seen.has(id) || !AI_PROVIDER_KINDS.includes(kind)) continue
    seen.add(id)
    const lt = isObj(c.lastTest) ? c.lastTest : null
    out.connections.push({
      id,
      kind,
      label: str(c.label, AI_LIMITS.maxLabel)?.trim() || kind,
      baseUrl: str(c.baseUrl, AI_LIMITS.maxBaseUrl)?.trim() || null,
      model: str(c.model, AI_LIMITS.maxModel)?.trim() ?? '',
      enabled: typeof c.enabled === 'boolean' ? c.enabled : true,
      hasKey: c.hasKey === true,
      keyHint: str(c.keyHint, 16),
      lastTest:
        lt && typeof lt.ok === 'boolean' && typeof lt.at === 'number'
          ? {
              ok: lt.ok,
              at: lt.at,
              message: str(lt.message, 300) ?? '',
              latencyMs: typeof lt.latencyMs === 'number' ? lt.latencyMs : null
            }
          : null
    })
    if (out.connections.length >= AI_LIMITS.maxConnections) break
  }
  return out
}

// ── Coach chat (docs/specs/ai-providers.md §7) ──

export const AI_CHAT_LIMITS = {
  /** only the most recent turns are sent; older ones are dropped by main */
  maxTurns: 30,
  /** per message; the newest user message is rejected above it, older ones are cut */
  maxMessageChars: 4000,
  /** the coach's answer is cut to this */
  maxReplyChars: 4000,
  maxRecentAlerts: 10,
  /** a request with more messages than this is refused outright (before trimming) */
  maxRawMessages: 200
} as const

export interface AiChatMessage {
  role: 'user' | 'assistant'
  /** plain text; the coach answers in markdown-lite (paragraphs, "- " bullets, **bold**) */
  content: string
}

/** What the on-device model sees right now. Every field is optional; null = not measurable. */
export interface AiChatLiveContext {
  presence?: PresenceState
  calibrated?: boolean
  view?: ViewKind
  neckFwdDeg?: number | null
  trunkFwdDeg?: number | null
  headPitchDeg?: number | null
  shoulderTiltDeg?: number | null
  headRollDeg?: number | null
  trunkLatDeg?: number | null
  /** current smoothed stage per issue (0 fine … 3 severe) */
  issues?: Partial<Record<IssueId, Stage>>
  worstStage?: Stage
  localVerdict?: 'good' | 'adjust'
  /** the app's own coaching line, ≤ 200 chars */
  localInstruction?: string | null
  /** continuous sitting time (main also knows it; the renderer may pass what it shows) */
  sittingMinutes?: number
}

/** Today's totals (minutes), e.g. from getStatsRange(1). */
export interface AiChatDayContext {
  trackedMinutes?: number
  goodMinutes?: number
  awayMinutes?: number
  minutesByIssue?: Partial<Record<IssueId, number>>
  alertsCount?: number
  breaksTaken?: number
}

/** A few days of history, e.g. from getStatsRange(7). */
export interface AiChatHistoryContext {
  days?: number
  /** share of tracked minutes in good posture, 0..1; null = no data */
  alignedShare?: number | null
  streakDays?: number
}

/** The saved good-posture reference (numbers only). */
export interface AiChatBaselineContext {
  capturedAt?: number
  view?: ViewKind
  /** the connected AI confirmed it at setup */
  verified?: boolean
  neckFwdDeg?: number | null
  trunkFwdDeg?: number | null
  headPitchDeg?: number | null
}

export interface AiChatRecentAlert {
  issue: IssueId
  stage: Stage
  minutesAgo: number
}

export interface AiChatContext {
  live?: AiChatLiveContext
  today?: AiChatDayContext
  history?: AiChatHistoryContext
  baseline?: AiChatBaselineContext
  /** newest first, at most AI_CHAT_LIMITS.maxRecentAlerts */
  recentAlerts?: AiChatRecentAlert[]
}

export interface AiChatRequest {
  /** oldest first; must end with the user's new message */
  messages: AiChatMessage[]
  /** validated and size-capped by main; unknown or malformed fields are dropped */
  context?: AiChatContext
  /**
   * Optional picture for the newest user turn, built like a review image. Same consent
   * rules as aiReviewPosture: AI enabled, monitoring not paused, share === settings.ai.share.
   */
  image?: { jpegB64: string; share: AiShareMode }
}

export type AiChatReply =
  | {
      ok: true
      /** markdown-lite, ≤ AI_CHAT_LIMITS.maxReplyChars */
      reply: string
      connectionLabel: string
      model: string
    }
  | { ok: false; message: string }
