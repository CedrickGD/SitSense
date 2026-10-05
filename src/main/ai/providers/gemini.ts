// Google Gemini API (AI Studio). Test = the Google key probe (docs/specs/ai-providers.md §3):
// models list first; on 401/403 try Vertex express countTokens and suggest switching.

import { AiError } from '../errors'
import { filterGeminiModels, geminiGenerateUrl, geminiListRaw, googleChat, googleGenerate, mayProbeOtherGoogleEndpoint, modelNote, vertexCountTokens, vertexModelNote } from './google'
import { baseUrlOf, cleanModelList, type AdapterDeps, type ProviderAdapter } from './types'

export function createGeminiAdapter({ fetch }: AdapterDeps): ProviderAdapter {
  return {
    analyze: (req) => googleGenerate(fetch, geminiGenerateUrl(baseUrlOf(req.conn), req.conn.model), req),

    chat: (req) => googleChat(fetch, geminiGenerateUrl(baseUrlOf(req.conn), req.conn.model), req),

    async listModels(conn, key, signal) {
      return cleanModelList(filterGeminiModels(await geminiListRaw(fetch, conn, key, signal)))
    },

    async test(conn, key, signal) {
      if (!key) throw new AiError('no-key', 'Add an API key first.')
      try {
        const ids = await geminiListRaw(fetch, conn, key, signal)
        return { message: `Connected to the Gemini API${modelNote(conn, ids)}.` }
      } catch (first) {
        if (!mayProbeOtherGoogleEndpoint(conn, first)) throw first
        try {
          await vertexCountTokens(fetch, conn, key, signal)
        } catch {
          throw first
        }
        return { message: `This key works with Vertex AI — switched${vertexModelNote(conn)}.`, suggestedKind: 'vertex' }
      }
    }
  }
}
