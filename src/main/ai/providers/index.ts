import type { AiProviderKind } from '../../../shared/ai'
import type { FetchLike } from '../http'
import { createAnthropicAdapter } from './anthropic'
import { createGeminiAdapter } from './gemini'
import { createOpenAiAdapter } from './openai'
import { createOpenAiCompatibleAdapter } from './openai-compatible'
import { createOpenRouterAdapter } from './openrouter'
import type { ProviderAdapter } from './types'
import { createVertexAdapter } from './vertex'

export type AdapterSet = Record<AiProviderKind, ProviderAdapter>

export function createAdapters(fetchImpl: FetchLike): AdapterSet {
  const deps = { fetch: fetchImpl }
  return {
    gemini: createGeminiAdapter(deps),
    vertex: createVertexAdapter(deps),
    openai: createOpenAiAdapter(deps),
    anthropic: createAnthropicAdapter(deps),
    openrouter: createOpenRouterAdapter(deps),
    'openai-compatible': createOpenAiCompatibleAdapter(deps)
  }
}

export * from './types'
