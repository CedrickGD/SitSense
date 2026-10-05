// Minimal JSON-over-HTTP helper for provider adapters. fetch is injected so
// tests never touch the network; keys travel only in headers, never in URLs.

import { AiError, mapFetchFailure, mapHttpError, type ErrorContext } from './errors'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface JsonRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
  signal: AbortSignal
  ctx: ErrorContext
  /** byte cap for a 2xx body (default MAX_RESPONSE_BYTES; model lists pass MAX_LIST_BYTES) */
  maxBytes?: number
}

/** analyze/test answers are a few KB; 2 MB is far above any real one. */
export const MAX_RESPONSE_BYTES = 2_000_000
/** model lists (OpenRouter's full list is ~2 MB) */
export const MAX_LIST_BYTES = 20_000_000
/** error bodies: the first 64 KB is plenty for error mapping */
export const MAX_ERROR_BYTES = 64 * 1024

const TOO_LARGE = 'The provider sent an unexpectedly large response.'

/**
 * Read a body as UTF-8 with a running byte limit (chunked responses have no
 * content-length). Past `max` it stops, cancels the stream and returns the first
 * `max` bytes with truncated: true — memory use never exceeds the cap.
 */
async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  const body = res.body
  if (!body) return { text: '', truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    if (total + value.byteLength > max) {
      chunks.push(value.subarray(0, max - total))
      total = max
      reader.cancel().catch(() => undefined)
      return { text: Buffer.concat(chunks, total).toString('utf8'), truncated: true }
    }
    chunks.push(value)
    total += value.byteLength
  }
  return { text: Buffer.concat(chunks, total).toString('utf8'), truncated: false }
}

export async function requestJson(fetchImpl: FetchLike, req: JsonRequest): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) }
  let body: string | undefined
  if (req.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(req.body)
  }
  let res: Response
  try {
    res = await fetchImpl(req.url, {
      method: req.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: req.signal,
      // never follow a redirect: it could carry the key's header to another host
      redirect: 'manual'
    })
  } catch (err) {
    throw mapFetchFailure(err, req.signal, req.ctx.host)
  }
  const ok = res.status >= 200 && res.status < 300
  const max = ok ? (req.maxBytes ?? MAX_RESPONSE_BYTES) : MAX_ERROR_BYTES
  const len = Number(res.headers?.get?.('content-length') ?? NaN)
  if (ok && Number.isFinite(len) && len > max) {
    res.body?.cancel().catch(() => undefined)
    throw new AiError('unexpected', TOO_LARGE)
  }
  let read: { text: string; truncated: boolean }
  try {
    read = await readCapped(res, max)
  } catch (err) {
    throw mapFetchFailure(err, req.signal, req.ctx.host)
  }
  // an error body is mapped from its first 64 KB; a success body over the cap is refused
  if (!ok) throw mapHttpError(res.status, read.text, req.ctx)
  if (read.truncated) throw new AiError('unexpected', TOO_LARGE)
  const text = read.text
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AiError('unexpected', 'Unexpected response from the provider (not JSON).', res.status)
  }
}

/**
 * An AbortSignal that fires after `ms` with an AiError('timeout') reason, and also
 * follows an optional parent signal (e.g. "AI was switched off").
 */
export function timeoutSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const ctl = new AbortController()
  const secs = Math.round(ms / 1000)
  const timer = setTimeout(() => ctl.abort(new AiError('timeout', `No answer within ${secs} s.`)), ms)
  const onParent = (): void => ctl.abort(parent?.reason instanceof AiError ? parent.reason : new AiError('cancelled', 'Cancelled.'))
  if (parent) {
    if (parent.aborted) onParent()
    else parent.addEventListener('abort', onParent, { once: true })
  }
  return {
    signal: ctl.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParent)
    }
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the server'
  }
}

export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Reject as soon as `signal` aborts, even if the underlying promise ignores it. */
export function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}
