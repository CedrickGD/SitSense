// Google Vertex AI express mode (API key, no project/location in the URL).
// Express mode has no models.list, so listModels returns the preset's suggestions.
// Test = countTokens (free); on 401/403 try the Gemini API and suggest switching.

import { AI_PRESETS } from '../../../shared/ai'
import { AiError } from '../errors'
import { geminiListRaw, googleChat, googleGenerate, mayProbeOtherGoogleEndpoint, modelNote, vertexCountTokens, vertexUrl } from './google'
import { baseUrlOf, type AdapterDeps, type ProviderAdapter } from './types'

export const VERTEX_MODELS: readonly string[] = AI_PRESETS.find((p) => p.kind === 'vertex')?.models ?? []

export function createVertexAdapter({ fetch }: AdapterDeps): ProviderAdapter {
  return {
    analyze: (req) => googleGenerate(fetch, vertexUrl(baseUrlOf(req.conn), req.conn.model, 'generateContent'), req),

    chat: (req) => googleChat(fetch, vertexUrl(baseUrlOf(req.conn), req.conn.model, 'generateContent'), req),

    async listModels() {
      return [...VERTEX_MODELS]
    },

    async test(conn, key, signal) {
      if (!key) throw new AiError('no-key', 'Add an API key first.')
      try {
        await vertexCountTokens(fetch, conn, key, signal)
        return { message: 'Connected to Vertex AI.' }
      } catch (first) {
        if (!mayProbeOtherGoogleEndpoint(conn, first)) throw first
        let ids: string[]
        try {
          ids = await geminiListRaw(fetch, conn, key, signal)
        } catch {
          throw first
        }
        return { message: `This key works with the Gemini API — switched${modelNote(conn, ids)}.`, suggestedKind: 'gemini' }
      }
    }
  }
}
