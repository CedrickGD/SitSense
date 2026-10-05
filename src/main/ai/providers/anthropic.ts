// Anthropic Messages API. Structured output via output_config.format; effort 'low'
// for models that support it (Haiku 4.5 rejects effort, so it is never sent there).
// Older models that reject output_config fall back to a plain JSON-only prompt.

import { AiError } from '../errors'
import { MAX_LIST_BYTES, isObj, requestJson } from '../http'
import {
  CHAT_MAX_OUTPUT_TOKENS,
  CUT_OFF_MESSAGE,
  MAX_OUTPUT_TOKENS,
  REVIEW_SCHEMA,
  baseUrlOf,
  cleanModelList,
  errorContext,
  looksComplete,
  type AdapterDeps,
  type AnalyzeRequest,
  type ChatRequest,
  type ProviderAdapter
} from './types'

export const ANTHROPIC_VERSION = '2023-06-01'

const headers = (key: string | null): Record<string, string> => ({
  ...(key ? { 'x-api-key': key } : {}),
  'anthropic-version': ANTHROPIC_VERSION
})

/** effort exists on the 4.6+/5.x families, not on Haiku 4.5 or older models */
function supportsEffort(model: string): boolean {
  if (/haiku/i.test(model)) return false
  const m = /claude-(?:opus|sonnet)-(\d+)(?:-(\d+))?/.exec(model)
  if (!m) return false
  const major = Number(m[1])
  const minor = m[2] && m[2].length <= 2 ? Number(m[2]) : 0
  return major > 4 || (major === 4 && minor >= 6)
}

type Step = 'format+effort' | 'format' | 'plain'

export function anthropicBody(req: AnalyzeRequest, step: Step): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.conn.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: req.system,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: req.imageJpegB64 } },
          {
            type: 'text',
            text: step === 'plain' ? `${req.prompt}\n\nReply with only the JSON object.` : req.prompt
          }
        ]
      }
    ]
  }
  if (step !== 'plain') {
    const output_config: Record<string, unknown> = { format: { type: 'json_schema', schema: REVIEW_SCHEMA } }
    if (step === 'format+effort') output_config.effort = 'low'
    body.output_config = output_config
  }
  return body
}

/** Coach chat: system + alternating turns; the image (if any) leads the last user turn. */
export function anthropicChatBody(req: ChatRequest, effort: boolean): Record<string, unknown> {
  const last = req.messages.length - 1
  const body: Record<string, unknown> = {
    model: req.conn.model,
    max_tokens: CHAT_MAX_OUTPUT_TOKENS,
    system: req.system,
    messages: req.messages.map((m, i) =>
      i === last && req.imageJpegB64
        ? {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: req.imageJpegB64 } },
              { type: 'text', text: m.content }
            ]
          }
        : { role: m.role, content: m.content }
    )
  }
  if (effort) body.output_config = { effort: 'low' }
  return body
}

/**
 * The text blocks of a Messages response. Review: the first text block. partialOk
 * (chat): all text blocks joined, and an answer cut off by max_tokens ends in "…".
 */
export function anthropicText(res: unknown, opts: { partialOk?: boolean } = {}): string {
  if (!isObj(res)) throw new AiError('unexpected', 'Unexpected response from the provider.')
  if (res.stop_reason === 'refusal') throw new AiError('refused', 'The model declined this request.')
  const blocks = (Array.isArray(res.content) ? res.content : []).filter(
    (b): b is Record<string, unknown> => isObj(b) && b.type === 'text' && typeof b.text === 'string'
  )
  const text = opts.partialOk ? blocks.map((b) => b.text as string).join('\n\n') : ((blocks[0]?.text as string | undefined) ?? '')
  if (res.stop_reason === 'max_tokens' && opts.partialOk && text.trim()) return `${text.trimEnd()}…`
  // max_tokens: adaptive thinking + answer hit the cap; a partial JSON answer is useless
  if (res.stop_reason === 'max_tokens' && !looksComplete(text)) throw new AiError('unexpected', CUT_OFF_MESSAGE)
  if (!text.trim()) throw new AiError('unexpected', 'The model returned an empty answer.')
  return text
}

export function createAnthropicAdapter({ fetch }: AdapterDeps): ProviderAdapter {
  return {
    async analyze(req) {
      const url = `${baseUrlOf(req.conn)}/messages`
      const ladder: Step[] = supportsEffort(req.conn.model) ? ['format+effort', 'format', 'plain'] : ['format', 'plain']
      let lastErr: unknown = null
      for (const step of ladder) {
        try {
          const res = await requestJson(fetch, {
            url,
            method: 'POST',
            headers: headers(req.key),
            body: anthropicBody(req, step),
            signal: req.signal,
            ctx: errorContext(req.conn, req.key, url)
          })
          return anthropicText(res)
        } catch (err) {
          lastErr = err
          if (!(err instanceof AiError && err.code === 'bad-request' && err.httpStatus === 400)) throw err
        }
      }
      throw lastErr
    },

    async chat(req) {
      const url = `${baseUrlOf(req.conn)}/messages`
      const attempts = supportsEffort(req.conn.model) ? [true, false] : [false]
      let lastErr: unknown = null
      for (const effort of attempts) {
        try {
          const res = await requestJson(fetch, {
            url,
            method: 'POST',
            headers: headers(req.key),
            body: anthropicChatBody(req, effort),
            signal: req.signal,
            ctx: errorContext(req.conn, req.key, url)
          })
          return anthropicText(res, { partialOk: true })
        } catch (err) {
          lastErr = err
          if (!(effort && err instanceof AiError && err.code === 'bad-request' && err.httpStatus === 400)) throw err
        }
      }
      throw lastErr
    },

    async listModels(conn, key, signal) {
      const ids: string[] = []
      let after = ''
      for (let page = 0; page < 5; page++) {
        const url = `${baseUrlOf(conn)}/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`
        const res = await requestJson(fetch, { url, headers: headers(key), signal, ctx: errorContext(conn, key, url), maxBytes: MAX_LIST_BYTES })
        if (!isObj(res) || !Array.isArray(res.data)) throw new AiError('unexpected', 'Unexpected response from the provider.')
        for (const m of res.data) {
          if (!isObj(m) || typeof m.id !== 'string') continue
          const caps = isObj(m.capabilities) ? m.capabilities : null
          const img = caps && isObj(caps.image_input) ? caps.image_input.supported : undefined
          if (img === false) continue
          ids.push(m.id)
        }
        if (res.has_more !== true || typeof res.last_id !== 'string') break
        after = res.last_id
      }
      return cleanModelList(ids)
    },

    async test(conn, key, signal) {
      if (!key) throw new AiError('no-key', 'Add an API key first.')
      if (!conn.model) {
        const url = `${baseUrlOf(conn)}/models?limit=1`
        await requestJson(fetch, { url, headers: headers(key), signal, ctx: errorContext(conn, key, url) })
        return { message: 'Connected to Anthropic.' }
      }
      // GET /models/{id} is free and checks the key and the model together
      const url = `${baseUrlOf(conn)}/models/${encodeURIComponent(conn.model)}`
      await requestJson(fetch, { url, headers: headers(key), signal, ctx: errorContext(conn, key, url) })
      return { message: 'Connected to Anthropic.' }
    }
  }
}
