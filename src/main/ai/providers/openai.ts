// OpenAI (Chat Completions). First attempt asks for low reasoning effort (fast);
// models that don't know the parameter answer 400 and the ladder drops it.

import { AiError } from '../errors'
import { chatAnalyze, chatConverse, chatListModels, idsOf, listNote } from './chat'
import { baseUrlOf, cleanModelList, type AdapterDeps, type ProviderAdapter } from './types'

export function filterOpenAiModels(ids: string[]): string[] {
  const keep = ids.filter(
    (id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation|codex)/i.test(id)
  )
  return keep.length > 0 ? keep : ids
}

export function createOpenAiAdapter({ fetch }: AdapterDeps): ProviderAdapter {
  return {
    analyze: (req) =>
      chatAnalyze(fetch, baseUrlOf(req.conn), req, {
        ladder: ['json_schema', 'json_schema', 'json_object', 'none'],
        maxCompletionTokens: true,
        imageDetail: 'low',
        extras: (_step, attempt) => (attempt === 0 ? { reasoning_effort: 'low' } : {})
      }),

    chat: (req) =>
      chatConverse(fetch, baseUrlOf(req.conn), req, {
        maxCompletionTokens: true,
        imageDetail: 'low',
        firstExtras: { reasoning_effort: 'low' }
      }),

    async listModels(conn, key, signal) {
      const items = await chatListModels(fetch, conn, key, signal, `${baseUrlOf(conn)}/models`)
      return cleanModelList(filterOpenAiModels(idsOf(items)))
    },

    async test(conn, key, signal) {
      if (!key) throw new AiError('no-key', 'Add an API key first.')
      const ids = idsOf(await chatListModels(fetch, conn, key, signal, `${baseUrlOf(conn)}/models`))
      return { message: `Connected to OpenAI${listNote(conn.model, ids)}.` }
    }
  }
}
