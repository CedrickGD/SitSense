// OpenRouter (OpenAI-shaped Chat Completions). The model list is public, so it is
// fetched without the key; the key check is GET /key.
//
// The json_schema step sets provider.require_parameters so OpenRouter only routes to
// upstream providers that honour response_format (otherwise some treat the schema as
// a hint). When no endpoint qualifies OpenRouter answers 404/503, and the ladder
// falls back to json_object / plain without the routing constraint.

import { AiError } from '../errors'
import { isObj, requestJson } from '../http'
import { bearer, chatAnalyze, chatConverse, chatListModels } from './chat'
import { baseUrlOf, cleanModelList, errorContext, type AdapterDeps, type ProviderAdapter } from './types'

const ATTRIBUTION = { 'x-title': 'SitSense' }

export function filterOpenRouterModels(items: unknown[]): string[] {
  const out: string[] = []
  for (const m of items) {
    if (!isObj(m) || typeof m.id !== 'string' || m.id.endsWith(':batch')) continue
    const arch = isObj(m.architecture) ? m.architecture : null
    const inputs = arch && Array.isArray(arch.input_modalities) ? arch.input_modalities : null
    if (inputs && !inputs.includes('image')) continue
    out.push(m.id)
  }
  return out
}

export function createOpenRouterAdapter({ fetch }: AdapterDeps): ProviderAdapter {
  return {
    analyze: (req) =>
      chatAnalyze(fetch, baseUrlOf(req.conn), req, {
        ladder: ['json_schema', 'json_object', 'none'],
        headers: ATTRIBUTION,
        extras: (step) => (step === 'json_schema' ? { provider: { require_parameters: true } } : {}),
        stepDownOn: (err, step) => step === 'json_schema' && (err.httpStatus === 404 || err.httpStatus === 503)
      }),

    chat: (req) => chatConverse(fetch, baseUrlOf(req.conn), req, { headers: ATTRIBUTION }),

    async listModels(conn, _key, signal) {
      const url = `${baseUrlOf(conn)}/models?supported_parameters=structured_outputs&input_modalities=image`
      const items = await chatListModels(fetch, conn, null, signal, url, {})
      return cleanModelList(filterOpenRouterModels(items))
    },

    async test(conn, key, signal) {
      if (!key) throw new AiError('no-key', 'Add an API key first.')
      const url = `${baseUrlOf(conn)}/key`
      const res = await requestJson(fetch, { url, headers: { ...bearer(key), ...ATTRIBUTION }, signal, ctx: errorContext(conn, key, url) })
      if (!isObj(res)) throw new AiError('unexpected', 'Unexpected response from the provider.')
      return { message: 'Connected to OpenRouter.' }
    }
  }
}
