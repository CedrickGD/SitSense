import { AI_PRESETS, type AiChatMessage, type AiConnection, type AiProviderKind } from '../../../shared/ai'
import type { ErrorContext } from '../errors'
import { hostOf, type FetchLike } from '../http'

export interface AnalyzeRequest {
  conn: AiConnection
  key: string | null
  /** system prompt */
  system: string
  /** user prompt (sent next to the image) */
  prompt: string
  imageJpegB64: string
  signal: AbortSignal
}

/** One coach-chat turn (docs/specs/ai-providers.md §7). */
export interface ChatRequest {
  conn: AiConnection
  key: string | null
  system: string
  /** validated: user first, alternating, ends with the user's new message */
  messages: AiChatMessage[]
  /** optional JPEG attached to the last user turn */
  imageJpegB64?: string
  signal: AbortSignal
}

export interface TestOutcome {
  message: string
  /** the key works with the other Google endpoint; the caller switches the connection's kind */
  suggestedKind?: AiProviderKind
}

export interface ProviderAdapter {
  /** raw model text (expected to contain the JSON review) */
  analyze(req: AnalyzeRequest): Promise<string>
  /** free-text coach answer (markdown-lite); a reply cut off by the output cap is returned as is */
  chat(req: ChatRequest): Promise<string>
  listModels(conn: AiConnection, key: string | null, signal: AbortSignal): Promise<string[]>
  /** cheap/free connection check; throws AiError on failure */
  test(conn: AiConnection, key: string | null, signal: AbortSignal): Promise<TestOutcome>
}

export interface AdapterDeps {
  fetch: FetchLike
}

/** JSON schema of the review (no min/max/maxItems: Anthropic rejects those; the parser clamps). */
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['good', 'adjust'] },
    score: { type: 'integer' },
    summary: { type: 'string' },
    instructions: { type: 'array', items: { type: 'string' } }
  },
  required: ['verdict', 'score', 'summary', 'instructions'],
  additionalProperties: false
} as const

/**
 * Output cap per request. Every provider counts thinking/reasoning tokens against it
 * (Gemini maxOutputTokens, OpenAI max_completion_tokens, Anthropic max_tokens); the
 * visible JSON answer is only ~150 tokens, so the headroom is for thinking. Billing
 * is per token actually produced, not per cap.
 */
export const MAX_OUTPUT_TOKENS = 4096

/**
 * Chat output cap. A reply is ≤ 4000 characters (~1000 tokens); the rest is headroom
 * for thinking. A reply cut off by the cap is still shown (ending in "…").
 */
export const CHAT_MAX_OUTPUT_TOKENS = 4096

export const CUT_OFF_MESSAGE = 'The answer was cut off (the model hit its output limit) — try a faster or non-thinking model.'

/** a truncated answer is only usable if the JSON object was already closed */
export function looksComplete(text: string): boolean {
  const t = text.trim().replace(/```\s*$/, '').trim()
  return t.length > 0 && t.endsWith('}')
}

/** kinds whose requests always need a key */
export const KEY_REQUIRED: ReadonlySet<AiProviderKind> = new Set(['gemini', 'vertex', 'openai', 'anthropic', 'openrouter'])

export function defaultBaseUrl(kind: AiProviderKind): string {
  return AI_PRESETS.find((p) => p.kind === kind)?.baseUrl ?? ''
}

export function defaultModel(kind: AiProviderKind): string {
  return AI_PRESETS.find((p) => p.kind === kind)?.models[0] ?? ''
}

/** baseUrl override or the preset's, without trailing slashes */
export function baseUrlOf(conn: Pick<AiConnection, 'kind' | 'baseUrl'>): string {
  return (conn.baseUrl || defaultBaseUrl(conn.kind)).replace(/\/+$/, '')
}

export function errorContext(conn: AiConnection, key: string | null, url: string, model = conn.model): ErrorContext {
  return { kind: conn.kind, model, keySent: !!key, key, host: hostOf(url) }
}

export const dataUrl = (b64: string): string => `data:image/jpeg;base64,${b64}`

/** de-duplicate, drop junk, sort, cap — model ids go to the renderer */
export function cleanModelList(ids: unknown[]): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string') continue
    const t = id.trim()
    if (t && t.length <= 200 && !/[\u0000-\u001f]/.test(t)) out.add(t)
  }
  return [...out].sort((a, b) => a.localeCompare(b)).slice(0, 1000)
}
