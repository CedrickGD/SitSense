// Any OpenAI-compatible server: Ollama, LM Studio, LiteLLM, gateways.
// The key is optional (Bearer only when set). Test lists /models; servers without
// /models get a one-token chat request instead.

import { AiError } from '../errors'
import { requestJson } from '../http'
import { bearer, chatAnalyze, chatConverse, chatListModels, chatText, idsOf, listNote } from './chat'
import { CUT_OFF_MESSAGE, baseUrlOf, cleanModelList, errorContext, type AdapterDeps, type ProviderAdapter } from './types'

function baseOrThrow(conn: Parameters<typeof baseUrlOf>[0]): string {
  const base = baseUrlOf(conn)
  if (!base) throw new AiError('invalid-input', 'Set the server’s base URL first.')
  return base
}

export function createOpenAiCompatibleAdapter({ fetch }: AdapterDeps): ProviderAdapter {
  return {
    analyze: (req) => chatAnalyze(fetch, baseOrThrow(req.conn), req, { ladder: ['json_schema', 'json_object', 'none'] }),

    chat: (req) => chatConverse(fetch, baseOrThrow(req.conn), req),

    async listModels(conn, key, signal) {
      return cleanModelList(idsOf(await chatListModels(fetch, conn, key, signal, `${baseOrThrow(conn)}/models`)))
    },

    async test(conn, key, signal) {
      const base = baseOrThrow(conn)
      try {
        const ids = idsOf(await chatListModels(fetch, conn, key, signal, `${base}/models`))
        return { message: `Connected${listNote(conn.model, ids)}.` }
      } catch (err) {
        if (!(err instanceof AiError && err.httpStatus === 404 && conn.model)) throw err
      }
      const url = `${base}/chat/completions`
      const res = await requestJson(fetch, {
        url,
        method: 'POST',
        headers: bearer(key),
        body: { model: conn.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
        signal,
        ctx: errorContext(conn, key, url)
      })
      try {
        chatText(res)
      } catch (err) {
        // an empty or cut-off one-token answer still proves the endpoint works
        if (!(err instanceof AiError && err.code === 'unexpected' && (err.message.includes('empty') || err.message === CUT_OFF_MESSAGE))) throw err
      }
      return { message: 'Connected.' }
    }
  }
}
