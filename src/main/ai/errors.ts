// Provider error mapping (docs/specs/ai-providers.md §3–§4).
// Every message produced here is short, user-facing and NEVER contains an API key:
// mapped categories use canned text, and the few raw provider messages that are
// passed through go through scrubSecrets() first.

import type { AiProviderKind } from '../../shared/ai'

export type AiErrorCode =
  | 'bad-key'
  | 'no-key'
  | 'wrong-endpoint'
  | 'quota'
  | 'model-not-found'
  | 'endpoint-not-found'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'refused'
  | 'bad-request'
  | 'server'
  | 'unexpected'
  | 'invalid-input'

export class AiError extends Error {
  readonly code: AiErrorCode
  /** HTTP status when the error came from a provider response */
  readonly httpStatus: number | null

  constructor(code: AiErrorCode, message: string, httpStatus: number | null = null) {
    super(message)
    this.name = 'AiError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export interface ErrorContext {
  kind: AiProviderKind
  model: string
  /** a key was sent with the request */
  keySent: boolean
  /** the key (only used to scrub it out of any text we pass through) */
  key: string | null
  /** hostname of the endpoint, for network messages */
  host: string
}

interface ParsedErrorBody {
  message: string
  /** google.rpc status ("UNAUTHENTICATED"), OpenAI/Anthropic error.type, … */
  status: string
  /** google ErrorInfo reason, OpenAI error.code */
  reason: string
  /** OpenAI error.param: the request field that was rejected */
  param: string
}

const MAX_PASSTHROUGH = 160

/** Remove anything that could be a secret from provider text. */
export function scrubSecrets(text: string, key: string | null): string {
  let out = text
  if (key && key.length >= 4) out = out.split(key).join('[key]')
  out = out
    .replace(/([?&]key=)[^&\s"']+/gi, '$1[key]')
    .replace(/\b(sk-[A-Za-z0-9_*.-]{6,})/g, '[key]')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, '[key]')
    .replace(/\bAQ\.[0-9A-Za-z_.-]{8,}/g, '[key]')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[key]')
  // last-resort: any fragment of the key's tail (masked echoes like "sk-INVAL****LDER")
  if (key && key.length >= 12) {
    const tail = key.slice(-6)
    out = out.split(tail).join('[key]')
  }
  return out
}

function oneLine(text: string, key: string | null): string {
  const t = scrubSecrets(text, key).replace(/\s+/g, ' ').trim()
  return t.length > MAX_PASSTHROUGH ? `${t.slice(0, MAX_PASSTHROUGH - 1)}…` : t
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

/** Understands google.rpc.Status (also array-wrapped), OpenAI, Anthropic, OpenRouter, {detail}, {error:"…"} and plain text. */
export function parseErrorBody(text: string): ParsedErrorBody {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return { message: text.slice(0, 500), status: '', reason: '', param: '' }
  }
  if (Array.isArray(j)) j = j[0]
  if (!isObj(j)) return { message: '', status: '', reason: '', param: '' }
  const e = j.error
  if (typeof e === 'string') return { message: e, status: '', reason: '', param: '' }
  if (isObj(e)) {
    let reason = s(e.code)
    if (Array.isArray(e.details)) {
      for (const d of e.details) {
        if (isObj(d) && typeof d.reason === 'string') {
          reason = d.reason
          break
        }
      }
    }
    const meta = isObj(e.metadata) ? e.metadata : null
    return {
      message: s(e.message) || s(meta?.raw),
      status: s(e.status) || s(e.type),
      reason,
      param: s(e.param)
    }
  }
  if (typeof j.detail === 'string') return { message: j.detail, status: '', reason: '', param: '' }
  if (isObj(j.detail)) return { message: s(j.detail.message), status: '', reason: '', param: '' }
  return { message: s(j.message), status: '', reason: '', param: '' }
}

/**
 * A 400 that rejects a request parameter or value for this model ("Unsupported
 * parameter: 'reasoning_effort' is not supported with this model.", "Invalid
 * parameter: 'response_format' of type 'json_schema' …", "output_config … not
 * supported on this model"). These must stay 'bad-request' so the request ladders
 * move down — they mention "model" but the model itself exists.
 */
function rejectsParameter(b: ParsedErrorBody, msg: string, reason: string): boolean {
  if (reason === 'UNSUPPORTED_PARAMETER' || reason === 'UNSUPPORTED_VALUE' || reason === 'UNKNOWN_PARAMETER' || reason === 'INVALID_PARAMETER') return true
  if (b.param && b.param !== 'model') return true
  return (
    /\b(unsupported|invalid|unknown|unrecognized) (parameter|value|request argument|field)/.test(msg) ||
    /not supported (with|on|by|for) (this|the) model/.test(msg) ||
    /does not support .* with this model/.test(msg)
  )
}

/** the model id itself is unknown or not available to this key */
function namesMissingModel(msg: string, reason: string): boolean {
  if (reason === 'MODEL_NOT_FOUND') return true
  if (!msg.includes('model')) return false
  return msg.includes('not found') || msg.includes('does not exist') || msg.includes('invalid model') || /model\b.* is not supported\b/.test(msg)
}

/** Map an HTTP error response to a short user-facing AiError. */
export function mapHttpError(status: number, bodyText: string, ctx: ErrorContext): AiError {
  const b = parseErrorBody(bodyText)
  const msg = b.message.toLowerCase()
  const reason = b.reason.toUpperCase()
  const st = b.status.toUpperCase()

  // Google: an AI Studio key on Vertex (or vice versa) / API not enabled for the key's project
  if (
    reason === 'SERVICE_DISABLED' ||
    msg.includes('has not been used in project') ||
    msg.includes('api keys are not supported by this api') ||
    (status === 403 && msg.includes('is disabled'))
  ) {
    return new AiError(
      'wrong-endpoint',
      "This key doesn't work with this endpoint, or the API isn't enabled for its project.",
      status
    )
  }
  if (reason === 'API_KEY_INVALID' || reason === 'INVALID_API_KEY' || msg.includes('api key not valid')) {
    return new AiError('bad-key', 'The API key was rejected — check that it was copied completely.', status)
  }
  if (status >= 300 && status < 400) {
    return new AiError('unexpected', 'The server redirected the request — check the base URL.', status)
  }
  switch (status) {
    case 401:
      if (!ctx.keySent) return new AiError('no-key', 'This endpoint needs an API key.', status)
      return new AiError('bad-key', 'The API key was rejected — check that it was copied completely.', status)
    case 402:
      return new AiError('quota', 'Out of credits, or billing isn’t set up for this key.', status)
    case 403:
      if (!ctx.keySent || msg.includes('unregistered callers')) return new AiError('no-key', 'This endpoint needs an API key.', status)
      if (ctx.kind === 'openrouter' && (msg.includes('moderation') || msg.includes('flagged')))
        return new AiError('refused', 'The provider’s moderation blocked this request.', status)
      return new AiError('bad-key', 'Access denied — this key may not be allowed to use this model or API.', status)
    case 404:
      if (ctx.kind === 'openai-compatible' && !msg.includes('model'))
        return new AiError('endpoint-not-found', 'Endpoint not found — check the base URL (try adding or removing /v1).', status)
      return new AiError('model-not-found', modelNotFound(ctx.model), status)
    case 408:
    case 504:
      return new AiError('timeout', 'The provider timed out — try again.', status)
    case 413:
      return new AiError('bad-request', 'The image is too large for this provider.', status)
    case 429:
      if (reason === 'INSUFFICIENT_QUOTA' || msg.includes('insufficient_quota') || msg.includes('exceeded your current quota'))
        return new AiError('quota', 'Quota exhausted — check the plan or billing for this key.', status)
      return new AiError('quota', 'Rate limit or quota reached — try again later.', status)
  }
  if (status === 400 || status === 422) {
    if (st === 'FAILED_PRECONDITION')
      return new AiError('bad-request', 'Not available for this account or region (billing or location).', status)
    if (!rejectsParameter(b, msg, reason) && namesMissingModel(msg, reason))
      return new AiError('model-not-found', modelNotFound(ctx.model), status)
    const detail = oneLine(b.message, ctx.key)
    return new AiError('bad-request', detail ? `The provider rejected the request: ${detail}` : 'The provider rejected the request.', status)
  }
  if (status >= 500) {
    if (st.includes('OVERLOADED') || status === 529) return new AiError('server', 'The provider is overloaded — try again shortly.', status)
    return new AiError('server', `The provider is unavailable right now (HTTP ${status}).`, status)
  }
  return new AiError('unexpected', `Unexpected response from the provider (HTTP ${status}).`, status)
}

function modelNotFound(model: string): string {
  const m = model.length > 60 ? `${model.slice(0, 59)}…` : model
  return m ? `Model “${m}” wasn’t found, or this key can’t use it.` : 'Model not found.'
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host.toLowerCase())
}

/** Map a thrown fetch error (no response) to an AiError. */
export function mapFetchFailure(err: unknown, signal: AbortSignal, host: string): AiError {
  if (signal.aborted) {
    const r: unknown = signal.reason
    if (r instanceof AiError) return r
    return new AiError('cancelled', 'Cancelled.')
  }
  if (err instanceof AiError) return err
  if (isLocalHost(host.replace(/:\d+$/, ''))) return new AiError('network', `Can’t reach ${host} — is the server running?`)
  return new AiError('network', `Network error — can’t reach ${host}.`)
}

/** Final safety net for any message leaving main. */
export function safeMessage(err: unknown, key: string | null): string {
  const m = err instanceof AiError ? err.message : 'Unexpected error.'
  return scrubSecrets(m, key)
}
