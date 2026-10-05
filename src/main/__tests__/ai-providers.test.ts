import { describe, expect, it } from 'vitest'
import { AiError, mapHttpError, scrubSecrets } from '../ai/errors'
import { timeoutSignal } from '../ai/http'
import { createAdapters, type AnalyzeRequest } from '../ai/providers'
import { MAX_OUTPUT_TOKENS } from '../ai/providers/types'
import { FAKE_KEYS, JPEG_B64, conn, fakeFetch, type Reply } from '../ai/test-utils'

const signal = (): AbortSignal => new AbortController().signal

function req(c = conn(), key: string | null = FAKE_KEYS.aq): AnalyzeRequest {
  return { conn: c, key, system: 'SYS', prompt: 'PROMPT', imageJpegB64: JPEG_B64, signal: signal() }
}

const REVIEW = '{"verdict":"good","score":90,"summary":"Looks fine.","instructions":[]}'

async function rejection(p: Promise<unknown>): Promise<AiError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(AiError)
    return e as AiError
  }
  throw new Error('expected a rejection')
}

const googleOk = (text = REVIEW): Reply => ({
  body: { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text }] }, finishReason: 'STOP' }] }
})

describe('Gemini adapter', () => {
  it('sends the image + prompt to generateContent with the key in a header only', async () => {
    const f = fakeFetch(() => googleOk())
    const text = await createAdapters(f).gemini.analyze(req())
    expect(text).toBe(REVIEW)
    const call = f.calls[0]
    expect(call.method).toBe('POST')
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent')
    expect(call.url).not.toContain(FAKE_KEYS.aq)
    expect(call.headers['x-goog-api-key']).toBe(FAKE_KEYS.aq)
    const body = call.body as Record<string, any>
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] })
    expect(body.contents[0].role).toBe('user')
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: JPEG_B64 } })
    expect(body.contents[0].parts[1]).toEqual({ text: 'PROMPT' })
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.responseJsonSchema.required).toEqual(['verdict', 'score', 'summary', 'instructions'])
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' })
  })

  it('omits thinkingConfig for pre-3 models and strips a "models/" prefix', async () => {
    const f = fakeFetch(() => googleOk())
    await createAdapters(f).gemini.analyze(req(conn({ model: 'models/gemini-2.5-flash' })))
    expect(f.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
    expect((f.calls[0].body as any).generationConfig.thinkingConfig).toBeUndefined()
  })

  it('reports a blocked prompt as a refusal', async () => {
    const f = fakeFetch(() => ({ body: { promptFeedback: { blockReason: 'SAFETY' } } }))
    const e = await rejection(createAdapters(f).gemini.analyze(req()))
    expect(e.code).toBe('refused')
    expect(e.message).toContain('SAFETY')
  })

  it('lists generateContent-capable gemini models only, across pages', async () => {
    const f = fakeFetch((c) =>
      c.url.includes('pageToken')
        ? { body: { models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] } }
        : {
            body: {
              models: [
                { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent', 'countTokens'] },
                { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
                { name: 'models/gemini-3.5-flash-tts', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/imagen-4', supportedGenerationMethods: ['predict'] }
              ],
              nextPageToken: 'p2'
            }
          }
    )
    const models = await createAdapters(f).gemini.listModels(conn(), FAKE_KEYS.aq, signal())
    expect(models).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash'])
    expect(f.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000')
    expect(f.calls[1].url).toContain('pageToken=p2')
  })
})

describe('Vertex express adapter', () => {
  it('posts to publishers/google/models/{model}:generateContent', async () => {
    const f = fakeFetch(() => googleOk())
    await createAdapters(f).vertex.analyze(req(conn({ kind: 'vertex' })))
    expect(f.calls[0].url).toBe('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.5-flash-lite:generateContent')
    expect(f.calls[0].headers['x-goog-api-key']).toBe(FAKE_KEYS.aq)
    expect((f.calls[0].body as any).contents[0].role).toBe('user')
  })

  it('has no models endpoint: returns the preset list without a request', async () => {
    const f = fakeFetch(() => ({ status: 500 }))
    const models = await createAdapters(f).vertex.listModels(conn({ kind: 'vertex' }), FAKE_KEYS.aq, signal())
    expect(models).toContain('gemini-3.5-flash-lite')
    expect(f.calls).toHaveLength(0)
  })
})

describe('OpenAI adapter', () => {
  const ok = (content = REVIEW): Reply => ({ body: { choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop' }] } })

  it('uses chat/completions with Bearer auth, a data-URL image and a strict json_schema', async () => {
    const f = fakeFetch(() => ok())
    const c = conn({ kind: 'openai', model: 'gpt-6-luna' })
    expect(await createAdapters(f).openai.analyze(req(c, FAKE_KEYS.openai))).toBe(REVIEW)
    const call = f.calls[0]
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(call.headers.authorization).toBe(`Bearer ${FAKE_KEYS.openai}`)
    const body = call.body as any
    expect(body.model).toBe('gpt-6-luna')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG_B64}`, detail: 'low' } })
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema.strict).toBe(true)
    expect(body.reasoning_effort).toBe('low')
    expect(body.max_completion_tokens).toBe(MAX_OUTPUT_TOKENS)
    expect(body.max_tokens).toBeUndefined()
  })

  it('drops reasoning_effort when the model rejects it (400) and retries', async () => {
    const f = fakeFetch((_c, i) =>
      i === 0
        ? { status: 400, body: { error: { message: 'Unrecognized request argument supplied: reasoning_effort', type: 'invalid_request_error', code: null } } }
        : ok()
    )
    await createAdapters(f).openai.analyze(req(conn({ kind: 'openai', model: 'gpt-4o' }), FAKE_KEYS.openai))
    expect(f.calls).toHaveLength(2)
    expect((f.calls[1].body as any).reasoning_effort).toBeUndefined()
    expect((f.calls[1].body as any).response_format.type).toBe('json_schema')
  })

  it('does not retry on auth errors and never echoes the key (even masked)', async () => {
    const f = fakeFetch(() => ({
      status: 401,
      body: { error: { message: `Incorrect API key provided: ${FAKE_KEYS.openai.slice(0, 8)}****${FAKE_KEYS.openai.slice(-4)}.`, type: 'invalid_request_error', code: 'invalid_api_key' } }
    }))
    const e = await rejection(createAdapters(f).openai.analyze(req(conn({ kind: 'openai' }), FAKE_KEYS.openai)))
    expect(f.calls).toHaveLength(1)
    expect(e.code).toBe('bad-key')
    expect(e.message).not.toContain(FAKE_KEYS.openai.slice(-4))
    expect(e.message).not.toContain('sk-')
  })

  it('treats a refusal as a failure', async () => {
    const f = fakeFetch(() => ({ body: { choices: [{ message: { content: null, refusal: 'I can’t help' }, finish_reason: 'stop' }] } }))
    expect((await rejection(createAdapters(f).openai.analyze(req(conn({ kind: 'openai' }), FAKE_KEYS.openai)))).code).toBe('refused')
  })

  it('filters the model list to chat models', async () => {
    const f = fakeFetch(() => ({
      body: { object: 'list', data: ['gpt-6-luna', 'gpt-6.1-sol', 'text-embedding-3-large', 'gpt-realtime', 'dall-e-3', 'o4-mini', 'whisper-1'].map((id) => ({ id, object: 'model' })) }
    }))
    const models = await createAdapters(f).openai.listModels(conn({ kind: 'openai' }), FAKE_KEYS.openai, signal())
    expect(models).toEqual(['gpt-6-luna', 'gpt-6.1-sol', 'o4-mini'])
    expect(f.calls[0].url).toBe('https://api.openai.com/v1/models')
  })
})

describe('Anthropic adapter', () => {
  const ok = (stop = 'end_turn'): Reply => ({ body: { type: 'message', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: REVIEW }], stop_reason: stop } })

  it('sends x-api-key + anthropic-version, a base64 image block and output_config.format (no effort on Haiku)', async () => {
    const f = fakeFetch(() => ok())
    const c = conn({ kind: 'anthropic', model: 'claude-haiku-4-5-20251001' })
    expect(await createAdapters(f).anthropic.analyze(req(c, FAKE_KEYS.anthropic))).toBe(REVIEW)
    const call = f.calls[0]
    expect(call.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call.headers['x-api-key']).toBe(FAKE_KEYS.anthropic)
    expect(call.headers['anthropic-version']).toBe('2023-06-01')
    expect(call.headers.authorization).toBeUndefined()
    const body = call.body as any
    expect(body.system).toBe('SYS')
    expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS)
    expect(body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG_B64 } })
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: 'PROMPT' })
    expect(body.output_config.format.type).toBe('json_schema')
    expect(body.output_config.effort).toBeUndefined()
  })

  it('asks for low effort on 5.x models', async () => {
    const f = fakeFetch(() => ok())
    await createAdapters(f).anthropic.analyze(req(conn({ kind: 'anthropic', model: 'claude-sonnet-5-5' }), FAKE_KEYS.anthropic))
    expect((f.calls[0].body as any).output_config.effort).toBe('low')
  })

  it('maps stop_reason refusal and 529 overloaded', async () => {
    const a = createAdapters(fakeFetch(() => ok('refusal'))).anthropic
    expect((await rejection(a.analyze(req(conn({ kind: 'anthropic' }), FAKE_KEYS.anthropic)))).code).toBe('refused')
    const b = createAdapters(fakeFetch(() => ({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }))).anthropic
    const e = await rejection(b.analyze(req(conn({ kind: 'anthropic' }), FAKE_KEYS.anthropic)))
    expect(e.code).toBe('server')
    expect(e.message).toMatch(/overloaded/i)
  })

  it('test checks the key and model together via GET /models/{id}', async () => {
    const f = fakeFetch(() => ({ status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model: nope' } } }))
    const e = await rejection(createAdapters(f).anthropic.test(conn({ kind: 'anthropic', model: 'nope' }), FAKE_KEYS.anthropic, signal()))
    expect(f.calls[0].url).toBe('https://api.anthropic.com/v1/models/nope')
    expect(e.code).toBe('model-not-found')
  })
})

describe('OpenRouter adapter', () => {
  it('sends Bearer + attribution and lists vision models without the key', async () => {
    const f = fakeFetch((c) =>
      c.url.includes('/models')
        ? {
            body: {
              data: [
                { id: 'google/gemini-3.5-flash-lite', architecture: { input_modalities: ['text', 'image'] } },
                { id: 'meta/text-only', architecture: { input_modalities: ['text'] } },
                { id: 'openai/gpt-6-luna:batch', architecture: { input_modalities: ['text', 'image'] } }
              ]
            }
          }
        : { body: { choices: [{ message: { content: REVIEW }, finish_reason: 'stop' }] } }
    )
    const a = createAdapters(f).openrouter
    const c = conn({ kind: 'openrouter', model: 'google/gemini-3.5-flash-lite' })
    await a.analyze(req(c, FAKE_KEYS.openrouter))
    expect(f.calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(f.calls[0].headers.authorization).toBe(`Bearer ${FAKE_KEYS.openrouter}`)
    expect(f.calls[0].headers['x-title']).toBe('SitSense')
    expect(await a.listModels(c, FAKE_KEYS.openrouter, signal())).toEqual(['google/gemini-3.5-flash-lite'])
    expect(f.calls[1].headers.authorization).toBeUndefined()
  })

  it('treats finish_reason "error" with HTTP 200 as a failure', async () => {
    const f = fakeFetch(() => ({ body: { choices: [{ message: { content: '' }, finish_reason: 'error' }] } }))
    expect((await rejection(createAdapters(f).openrouter.analyze(req(conn({ kind: 'openrouter' }), FAKE_KEYS.openrouter)))).code).toBe('server')
  })
})

describe('OpenAI-compatible adapter (Ollama / LM Studio / LiteLLM)', () => {
  const local = conn({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'qwen3-vl:8b', hasKey: false })

  it('sends no Authorization header without a key and walks json_schema → json_object → plain on 400s', async () => {
    const f = fakeFetch((_c, i) =>
      i < 2 ? { status: 400, body: { error: { message: 'response_format not supported' } } } : { body: { choices: [{ message: { content: `<think>hmm</think>\n${REVIEW}` } }] } }
    )
    const text = await createAdapters(f)['openai-compatible'].analyze(req(local, null))
    expect(text).toContain(REVIEW)
    expect(f.calls.map((c) => (c.body as any).response_format?.type ?? 'none')).toEqual(['json_schema', 'json_object', 'none'])
    expect(f.calls[0].url).toBe('http://localhost:11434/v1/chat/completions')
    expect(f.calls[0].headers.authorization).toBeUndefined()
    expect((f.calls[2].body as any).messages[1].content[0].text).toContain('Reply with only a JSON object')
  })

  it('maps connection refused to "is the server running?"', async () => {
    const f = fakeFetch(() => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
    const e = await rejection(createAdapters(f)['openai-compatible'].analyze(req(local, null)))
    expect(e.code).toBe('network')
    expect(e.message).toBe('Can’t reach localhost:11434 — is the server running?')
  })

  it('suggests fixing /v1 on a 404 without a model hint', async () => {
    const f = fakeFetch(() => ({ status: 404, body: '404 page not found' }))
    const e = await rejection(createAdapters(f)['openai-compatible'].analyze(req(local, null)))
    expect(e.code).toBe('endpoint-not-found')
    expect(e.message).toContain('/v1')
  })

  it('test falls back to a one-token chat request when /models is missing', async () => {
    const f = fakeFetch((c) => (c.url.endsWith('/models') ? { status: 404, body: 'not found' } : { body: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } }))
    const out = await createAdapters(f)['openai-compatible'].test(local, 'gw-key-123456789', signal())
    expect(out.message).toBe('Connected.')
    expect(f.calls[1].headers.authorization).toBe('Bearer gw-key-123456789')
    expect((f.calls[1].body as any).max_tokens).toBe(1)
  })

  it('does not follow redirects', async () => {
    const f = fakeFetch(() => ({ status: 302, headers: { location: 'https://evil.example/' } }))
    const e = await rejection(createAdapters(f)['openai-compatible'].listModels(local, 'k-123456789', signal()))
    expect(e.message).toContain('redirected')
  })
})

describe('error mapping', () => {
  const ctx = { kind: 'gemini' as const, model: 'gemini-3.5-flash-lite', keySent: true, key: FAKE_KEYS.aq, host: 'generativelanguage.googleapis.com' }
  const g = (code: number, status: string, message: string, reason?: string): string =>
    JSON.stringify({ error: { code, message, status, details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }] : [] } })

  it.each([
    ['AIza key invalid (400 API_KEY_INVALID)', 400, g(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID'), 'bad-key'],
    ['AQ. key invalid (401 ACCESS_TOKEN_TYPE_UNSUPPORTED)', 401, g(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.', 'ACCESS_TOKEN_TYPE_UNSUPPORTED'), 'bad-key'],
    ['AI Studio key on Vertex (401 API keys not supported)', 401, g(401, 'UNAUTHENTICATED', 'API keys are not supported by this API. Expected OAuth2 access token', 'CREDENTIALS_MISSING'), 'wrong-endpoint'],
    ['API not enabled (403 SERVICE_DISABLED)', 403, g(403, 'PERMISSION_DENIED', 'Agent Platform API has not been used in project 123 before or it is disabled.', 'SERVICE_DISABLED'), 'wrong-endpoint'],
    ['no key (403 unregistered callers)', 403, g(403, 'PERMISSION_DENIED', "Method doesn't allow unregistered callers (callers without established identity)."), 'no-key'],
    ['quota (429 RESOURCE_EXHAUSTED)', 429, g(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded'), 'quota'],
    ['unknown model (404)', 404, g(404, 'NOT_FOUND', 'models/x is not found for API version v1beta'), 'model-not-found'],
    ['billing/region (400 FAILED_PRECONDITION)', 400, g(400, 'FAILED_PRECONDITION', 'User location is not supported'), 'bad-request'],
    ['array-wrapped compat error', 400, `[${g(400, 'INVALID_ARGUMENT', 'API key not valid.', 'API_KEY_INVALID')}]`, 'bad-key'],
    ['prepay credits depleted (402)', 402, '{}', 'quota'],
    ['upstream down (503, plain text)', 503, 'Service Unavailable', 'server'],
    ['OpenAI insufficient_quota', 429, JSON.stringify({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }), 'quota']
  ])('%s', (_name, status, body, code) => {
    expect(mapHttpError(status as number, body as string, ctx).code).toBe(code)
  })

  it('scrubs keys and key-shaped strings from passthrough messages', () => {
    const e = mapHttpError(400, JSON.stringify({ error: { message: `bad header x-goog-api-key=${FAKE_KEYS.aq} and ${FAKE_KEYS.aiza}` } }), ctx)
    expect(e.message).not.toContain(FAKE_KEYS.aq)
    expect(e.message).not.toContain(FAKE_KEYS.aiza)
    expect(scrubSecrets(`token ${FAKE_KEYS.anthropic} / Bearer abc.def`, null)).not.toMatch(/sk-ant|abc\.def/)
  })

  it('every adapter keeps the key out of error messages even when the server echoes it', async () => {
    const kinds = ['gemini', 'vertex', 'openai', 'anthropic', 'openrouter', 'openai-compatible'] as const
    for (const kind of kinds) {
      const key = `${kind}-SECRET-KEY-0123456789`
      const f = fakeFetch(() => ({ status: 400, body: { error: { message: `your key ${key} is wrong (…${key.slice(-6)})` } } }))
      const c = conn({ kind, baseUrl: kind === 'openai-compatible' ? 'http://127.0.0.1:1234/v1' : null })
      const e = await rejection(createAdapters(f)[kind].analyze(req(c, key)))
      expect(e.message).not.toContain(key)
      expect(e.message).not.toContain(key.slice(-6))
    }
  })

  it('a per-request timeout surfaces as a timeout error', async () => {
    const f = fakeFetch(() => 'hang')
    const t = timeoutSignal(20)
    const e = await rejection(createAdapters(f).openai.analyze({ ...req(conn({ kind: 'openai' }), FAKE_KEYS.openai), signal: t.signal }))
    t.dispose()
    expect(e.code).toBe('timeout')
  })
})
