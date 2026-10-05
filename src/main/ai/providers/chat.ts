// Shared OpenAI Chat Completions code for OpenAI, OpenRouter and any OpenAI-compatible
// server (Ollama, LM Studio, LiteLLM, company gateways).
//
// Structured output support varies, so analyze() walks a ladder of request bodies:
// json_schema → json_object → plain prompt, moving down only on a 400/422 (the server
// rejected a parameter). Auth, quota, 404, 5xx and network errors stop immediately.

import type { AiConnection } from '../../../shared/ai'
import { AiError } from '../errors'
import { MAX_LIST_BYTES, isObj, requestJson, type FetchLike } from '../http'
import {
  CHAT_MAX_OUTPUT_TOKENS,
  CUT_OFF_MESSAGE,
  MAX_OUTPUT_TOKENS,
  REVIEW_SCHEMA,
  dataUrl,
  errorContext,
  looksComplete,
  type AnalyzeRequest,
  type ChatRequest
} from './types'

export type ResponseFormatStep = 'json_schema' | 'json_object' | 'none'

export interface ChatOptions {
  /** extra headers (e.g. OpenRouter attribution) */
  headers?: Record<string, string>
  /** per-step extra body fields */
  extras?: (step: ResponseFormatStep, attempt: number) => Record<string, unknown>
  /** use max_completion_tokens (OpenAI) instead of max_tokens */
  maxCompletionTokens?: boolean
  /** OpenAI image detail */
  imageDetail?: 'low' | 'high' | 'auto'
  /** the ladder of bodies to try, top first */
  ladder: ResponseFormatStep[]
  /** extra "move down the ladder" rule on top of the default 400/422 bad-request one */
  stepDownOn?: (err: AiError, step: ResponseFormatStep) => boolean
}

export const bearer = (key: string | null): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {})

const JSON_ONLY_HINT =
  '\n\nReply with only a JSON object with the keys "verdict" ("good" or "adjust"), "score" (0-100), "summary" (string) and "instructions" (array of strings).'

export function chatBody(req: AnalyzeRequest, step: ResponseFormatStep, opts: ChatOptions, attempt: number): Record<string, unknown> {
  const image: Record<string, unknown> = { url: dataUrl(req.imageJpegB64) }
  if (opts.imageDetail) image.detail = opts.imageDetail
  const body: Record<string, unknown> = {
    model: req.conn.model,
    messages: [
      { role: 'system', content: req.system },
      {
        role: 'user',
        content: [
          { type: 'text', text: step === 'json_schema' ? req.prompt : req.prompt + JSON_ONLY_HINT },
          { type: 'image_url', image_url: image }
        ]
      }
    ],
    stream: false
  }
  body[opts.maxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = MAX_OUTPUT_TOKENS
  if (step === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'posture_review', strict: true, schema: REVIEW_SCHEMA }
    }
  } else if (step === 'json_object') {
    body.response_format = { type: 'json_object' }
  }
  return { ...body, ...(opts.extras?.(step, attempt) ?? {}) }
}

export interface ConverseOptions {
  headers?: Record<string, string>
  maxCompletionTokens?: boolean
  imageDetail?: 'low' | 'high' | 'auto'
  /** extra body fields for the first attempt only; a 400/422 retries once without them */
  firstExtras?: Record<string, unknown>
}

/** Coach chat body: system + alternating turns; the image (if any) rides on the last user turn. */
export function converseBody(req: ChatRequest, opts: ConverseOptions, withExtras: boolean): Record<string, unknown> {
  const last = req.messages.length - 1
  const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }]
  req.messages.forEach((m, i) => {
    if (i === last && req.imageJpegB64) {
      const image: Record<string, unknown> = { url: dataUrl(req.imageJpegB64) }
      if (opts.imageDetail) image.detail = opts.imageDetail
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          { type: 'image_url', image_url: image }
        ]
      })
    } else {
      messages.push({ role: m.role, content: m.content })
    }
  })
  const body: Record<string, unknown> = { model: req.conn.model, messages, stream: false }
  body[opts.maxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = CHAT_MAX_OUTPUT_TOKENS
  return withExtras && opts.firstExtras ? { ...body, ...opts.firstExtras } : body
}

export async function chatConverse(fetchImpl: FetchLike, base: string, req: ChatRequest, opts: ConverseOptions = {}): Promise<string> {
  const url = `${base}/chat/completions`
  const attempts = opts.firstExtras ? [true, false] : [false]
  let lastErr: unknown = null
  for (const withExtras of attempts) {
    try {
      const res = await requestJson(fetchImpl, {
        url,
        method: 'POST',
        headers: { ...bearer(req.key), ...(opts.headers ?? {}) },
        body: converseBody(req, opts, withExtras),
        signal: req.signal,
        ctx: errorContext(req.conn, req.key, url)
      })
      return chatText(res, { partialOk: true })
    } catch (err) {
      lastErr = err
      const retryable = withExtras && err instanceof AiError && err.code === 'bad-request' && (err.httpStatus === 400 || err.httpStatus === 422)
      if (!retryable) throw err
    }
  }
  throw lastErr
}

/**
 * choices[0].message.content (string or content-part array); refusals and error finishes
 * throw. partialOk (chat): an answer cut off by the token cap comes back with a trailing "…".
 */
export function chatText(res: unknown, opts: { partialOk?: boolean } = {}): string {
  if (!isObj(res)) throw new AiError('unexpected', 'Unexpected response from the provider.')
  if (isObj(res.error)) {
    // OpenRouter can answer HTTP 200 with an error object
    throw new AiError('server', 'The provider reported an error for this request.')
  }
  const choice = Array.isArray(res.choices) && isObj(res.choices[0]) ? res.choices[0] : null
  if (!choice) throw new AiError('unexpected', 'Unexpected response from the provider.')
  if (choice.finish_reason === 'error') throw new AiError('server', 'The provider reported an error for this request.')
  const msg = isObj(choice.message) ? choice.message : null
  if (msg && typeof msg.refusal === 'string' && msg.refusal.trim()) throw new AiError('refused', 'The model declined this request.')
  let text = ''
  if (msg && typeof msg.content === 'string') text = msg.content
  else if (msg && Array.isArray(msg.content)) {
    text = msg.content
      .map((p) => (isObj(p) && typeof p.text === 'string' ? p.text : ''))
      .join('')
  }
  // 'length': reasoning + answer hit max_(completion_)tokens; a partial JSON answer is useless
  if (choice.finish_reason === 'length' && opts.partialOk && text.trim()) return `${text.trimEnd()}…`
  if (choice.finish_reason === 'length' && !looksComplete(text)) throw new AiError('unexpected', CUT_OFF_MESSAGE)
  if (!text.trim()) {
    if (choice.finish_reason === 'content_filter') throw new AiError('refused', 'The model declined this request.')
    throw new AiError('unexpected', 'The model returned an empty answer.')
  }
  return text
}

export async function chatAnalyze(fetchImpl: FetchLike, base: string, req: AnalyzeRequest, opts: ChatOptions): Promise<string> {
  const url = `${base}/chat/completions`
  let lastErr: unknown = null
  for (let i = 0; i < opts.ladder.length; i++) {
    try {
      const res = await requestJson(fetchImpl, {
        url,
        method: 'POST',
        headers: { ...bearer(req.key), ...(opts.headers ?? {}) },
        body: chatBody(req, opts.ladder[i], opts, i),
        signal: req.signal,
        ctx: errorContext(req.conn, req.key, url)
      })
      return chatText(res)
    } catch (err) {
      lastErr = err
      const retryable =
        err instanceof AiError &&
        ((err.code === 'bad-request' && (err.httpStatus === 400 || err.httpStatus === 422)) || !!opts.stepDownOn?.(err, opts.ladder[i]))
      if (!retryable) throw err
    }
  }
  throw lastErr
}

/** GET {base}/models → data[].id */
export async function chatListModels(
  fetchImpl: FetchLike,
  conn: AiConnection,
  key: string | null,
  signal: AbortSignal,
  url: string,
  headers: Record<string, string> = bearer(key)
): Promise<unknown[]> {
  const res = await requestJson(fetchImpl, { url, headers, signal, ctx: errorContext(conn, key, url), maxBytes: MAX_LIST_BYTES })
  if (!isObj(res) || !Array.isArray(res.data)) {
    // some servers (older Ollama/LiteLLM builds) return a bare array or {models:[…]}
    if (Array.isArray(res)) return res
    if (isObj(res) && Array.isArray(res.models)) return res.models
    throw new AiError('unexpected', 'Unexpected response from the provider.')
  }
  return res.data
}

export const idsOf = (items: unknown[]): string[] =>
  items.map((m) => (isObj(m) ? (typeof m.id === 'string' ? m.id : typeof m.name === 'string' ? m.name : null) : typeof m === 'string' ? m : null)).filter((x): x is string => !!x)

export function listNote(model: string, ids: string[]): string {
  if (!model || ids.length === 0 || ids.includes(model)) return ''
  return ` — but “${model.length > 60 ? `${model.slice(0, 59)}…` : model}” isn’t in the model list`
}
