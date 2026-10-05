// Shared Google generateContent code for the Gemini API (AI Studio) and Vertex AI
// express mode. Both take the key in the x-goog-api-key header (never ?key=, URLs
// end up in logs) and the same request/response body.

import { AI_PRESETS, type AiConnection } from '../../../shared/ai'
import { AiError } from '../errors'
import { MAX_LIST_BYTES, isObj, requestJson, type FetchLike } from '../http'
import {
  CHAT_MAX_OUTPUT_TOKENS,
  CUT_OFF_MESSAGE,
  MAX_OUTPUT_TOKENS,
  REVIEW_SCHEMA,
  baseUrlOf,
  defaultBaseUrl,
  defaultModel,
  errorContext,
  looksComplete,
  type AnalyzeRequest,
  type ChatRequest
} from './types'

/** accept "models/gemini-x" and "publishers/google/models/gemini-x" as well */
export function googleModelId(model: string): string {
  return model.trim().replace(/^.*models\//, '')
}

export function geminiGenerateUrl(base: string, model: string): string {
  return `${base}/models/${encodeURIComponent(googleModelId(model))}:generateContent`
}

export function vertexUrl(base: string, model: string, method: 'generateContent' | 'countTokens'): string {
  return `${base}/publishers/google/models/${encodeURIComponent(googleModelId(model))}:${method}`
}

export const googleHeaders = (key: string | null): Record<string, string> => (key ? { 'x-goog-api-key': key } : {})

/**
 * thinkingConfig.thinkingLevel only exists on Gemini 3+ (older models reject it).
 * The "-latest" aliases (gemini-flash-latest, gemini-flash-lite-latest, …) point at
 * current thinking models, so they get it too; googleGenerate retries without it
 * if a model rejects the field.
 */
export function wantsThinkingLevel(model: string): boolean {
  const id = googleModelId(model)
  const m = /^gemini-(\d+)/.exec(id)
  if (m) return Number(m[1]) >= 3
  return /^gemini-[a-z-]+-latest$/.test(id)
}

export function googleBody(req: AnalyzeRequest, thinking = true): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseJsonSchema: REVIEW_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    mediaResolution: 'MEDIA_RESOLUTION_MEDIUM'
  }
  if (thinking && wantsThinkingLevel(req.conn.model)) generationConfig.thinkingConfig = { thinkingLevel: 'LOW' }
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: req.imageJpegB64 } }, { text: req.prompt }]
      }
    ],
    generationConfig
  }
}

/** Chat: roles user/model, the image (if any) on the last user turn, free text out. */
export function googleChatBody(req: ChatRequest, thinking = true): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS }
  if (req.imageJpegB64) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_MEDIUM'
  if (thinking && wantsThinkingLevel(req.conn.model)) generationConfig.thinkingConfig = { thinkingLevel: 'LOW' }
  const last = req.messages.length - 1
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: req.messages.map((m, i) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts:
        i === last && req.imageJpegB64
          ? [{ inlineData: { mimeType: 'image/jpeg', data: req.imageJpegB64 } }, { text: m.content }]
          : [{ text: m.content }]
    })),
    generationConfig
  }
}

/** POST with thinkingLevel, retried once without it when the model rejects the field */
async function generateWithThinkingRetry(model: string, send: (thinking: boolean) => Promise<unknown>): Promise<unknown> {
  try {
    return await send(true)
  } catch (err) {
    const rejected = err instanceof AiError && err.code === 'bad-request' && err.httpStatus === 400
    if (!rejected || !wantsThinkingLevel(model)) throw err
    return send(false)
  }
}

export async function googleChat(fetchImpl: FetchLike, url: string, req: ChatRequest): Promise<string> {
  const res = await generateWithThinkingRetry(req.conn.model, (thinking) =>
    requestJson(fetchImpl, {
      url,
      method: 'POST',
      headers: googleHeaders(req.key),
      body: googleChatBody(req, thinking),
      signal: req.signal,
      ctx: errorContext(req.conn, req.key, url)
    })
  )
  return googleText(res, { partialOk: true })
}

/**
 * candidates[0].content.parts[].text, skipping thought parts. partialOk (chat): an
 * answer cut off by maxOutputTokens is returned with a trailing "…" instead of failing.
 */
export function googleText(res: unknown, opts: { partialOk?: boolean } = {}): string {
  if (!isObj(res)) throw new AiError('unexpected', 'Unexpected response from the provider.')
  const cands = Array.isArray(res.candidates) ? res.candidates : []
  if (cands.length === 0) {
    const fb = isObj(res.promptFeedback) ? res.promptFeedback : null
    const why = typeof fb?.blockReason === 'string' ? ` (${fb.blockReason})` : ''
    throw new AiError('refused', `The model declined this request${why}.`)
  }
  const c = cands[0]
  const content = isObj(c) && isObj(c.content) ? c.content : null
  const parts = content && Array.isArray(content.parts) ? content.parts : []
  const text = parts
    .filter((p): p is Record<string, unknown> => isObj(p) && p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
  const fr = isObj(c) && typeof c.finishReason === 'string' ? c.finishReason : ''
  // MAX_TOKENS: thinking + answer hit maxOutputTokens; a partial JSON answer is useless
  if (fr === 'MAX_TOKENS' && opts.partialOk && text.trim()) return `${text.trimEnd()}…`
  if (fr === 'MAX_TOKENS' && !looksComplete(text)) throw new AiError('unexpected', CUT_OFF_MESSAGE)
  if (!text.trim()) {
    if (fr && fr !== 'STOP') throw new AiError('refused', `The model declined this request (${fr}).`)
    throw new AiError('unexpected', 'The model returned an empty answer.')
  }
  return text
}

export async function googleGenerate(fetchImpl: FetchLike, url: string, req: AnalyzeRequest): Promise<string> {
  // a model that doesn't know thinkingLevel answers 400: retried once without it
  const res = await generateWithThinkingRetry(req.conn.model, (thinking) =>
    requestJson(fetchImpl, {
      url,
      method: 'POST',
      headers: googleHeaders(req.key),
      body: googleBody(req, thinking),
      signal: req.signal,
      ctx: errorContext(req.conn, req.key, url)
    })
  )
  return googleText(res)
}

/** GET {gemini}/models?pageSize=1000 — free; also the Gemini half of the key probe */
export async function geminiListRaw(fetchImpl: FetchLike, conn: AiConnection, key: string | null, signal: AbortSignal, base?: string): Promise<string[]> {
  const root = base ?? (conn.kind === 'gemini' ? baseUrlOf(conn) : defaultBaseUrl('gemini'))
  const ids: string[] = []
  let pageToken = ''
  for (let page = 0; page < 5; page++) {
    const url = `${root}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    const res = await requestJson(fetchImpl, {
      url,
      headers: googleHeaders(key),
      signal,
      ctx: { ...errorContext(conn, key, url), kind: 'gemini' },
      maxBytes: MAX_LIST_BYTES
    })
    if (!isObj(res)) throw new AiError('unexpected', 'Unexpected response from the provider.')
    for (const m of Array.isArray(res.models) ? res.models : []) {
      if (!isObj(m) || typeof m.name !== 'string') continue
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : null
      if (methods && !methods.includes('generateContent')) continue
      ids.push(m.name.replace(/^models\//, ''))
    }
    pageToken = typeof res.nextPageToken === 'string' ? res.nextPageToken : ''
    if (!pageToken) break
  }
  return ids
}

/** keep the vision-capable chat models for the picker */
export function filterGeminiModels(ids: string[]): string[] {
  return ids.filter((id) => id.startsWith('gemini') && !/(tts|image|live|embedding|transcribe|audio)/i.test(id))
}

/**
 * POST {vertex}/publishers/google/models/{model}:countTokens — free; the Vertex half
 * of the key probe. For a Vertex connection it checks the connection's own model;
 * as the cross-endpoint probe of a Gemini connection it uses a fixed Vertex model
 * (the Gemini connection's model may exist only on the Gemini API).
 */
export async function vertexCountTokens(fetchImpl: FetchLike, conn: AiConnection, key: string | null, signal: AbortSignal, base?: string): Promise<void> {
  const own = conn.kind === 'vertex'
  const root = base ?? (own ? baseUrlOf(conn) : defaultBaseUrl('vertex'))
  const model = (own && conn.model) || defaultModel('vertex')
  const url = vertexUrl(root, model, 'countTokens')
  const res = await requestJson(fetchImpl, {
    url,
    method: 'POST',
    headers: googleHeaders(key),
    body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
    signal,
    ctx: { ...errorContext(conn, key, url, model), kind: 'vertex' }
  })
  if (!isObj(res) || typeof res.totalTokens !== 'number') throw new AiError('unexpected', 'Unexpected response from the provider.')
}

/** 401/403 from the first probe means "maybe the other Google endpoint" */
export const isAuthFailure = (e: unknown): boolean => e instanceof AiError && (e.httpStatus === 401 || e.httpStatus === 403)

/**
 * The cross-endpoint probe sends the stored key to the other Google host, so it only
 * runs for a connection on its preset endpoint — the same rule saveConnection uses
 * for keeping a key across Gemini ↔ Vertex. A custom base URL (gateway/proxy) never
 * has its key sent anywhere else; its first error is reported unchanged.
 */
export const mayProbeOtherGoogleEndpoint = (conn: AiConnection, err: unknown): boolean => !conn.baseUrl && isAuthFailure(err)

const VERTEX_PRESET_MODELS: readonly string[] = AI_PRESETS.find((p) => p.kind === 'vertex')?.models ?? []

/** after a Gemini → Vertex switch: Vertex has no model list, so flag a model the probe didn't check */
export function vertexModelNote(conn: AiConnection): string {
  const want = googleModelId(conn.model)
  if (!want || VERTEX_PRESET_MODELS.includes(want)) return ''
  return ` — check that “${want.length > 60 ? `${want.slice(0, 59)}…` : want}” is available on Vertex AI`
}

export function modelNote(conn: AiConnection, ids: string[]): string {
  const want = googleModelId(conn.model)
  if (!want || ids.length === 0 || ids.includes(want)) return ''
  return ` — but “${want.length > 60 ? `${want.slice(0, 59)}…` : want}” isn’t in this key’s model list`
}
