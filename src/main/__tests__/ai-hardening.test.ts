// Regression tests for the AI backend review findings (response size cap, Google
// cross-endpoint probe, pause gate, key pruning, 400 classification, output budget,
// OpenRouter require_parameters).

import { describe, expect, it } from 'vitest'
import { AiError, mapHttpError } from '../ai/errors'
import { requestJson, MAX_ERROR_BYTES, MAX_LIST_BYTES, MAX_RESPONSE_BYTES } from '../ai/http'
import { createAdapters, type AnalyzeRequest } from '../ai/providers'
import { MAX_OUTPUT_TOKENS, defaultModel } from '../ai/providers/types'
import { createAiService, pruneOrphanKeys } from '../ai/service'
import { FAKE_KEYS, JPEG_B64, conn, fakeBackend, fakeFetch, makeKeyStore, settingsHolder, type Reply } from '../ai/test-utils'
import type { FetchLike } from '../ai/http'

const signal = (): AbortSignal => new AbortController().signal
const REVIEW = '{"verdict":"good","score":90,"summary":"Looks fine.","instructions":[]}'

function req(c = conn(), key: string | null = FAKE_KEYS.aq): AnalyzeRequest {
  return { conn: c, key, system: 'SYS', prompt: 'PROMPT', imageJpegB64: JPEG_B64, signal: signal() }
}

async function rejection(p: Promise<unknown>): Promise<AiError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(AiError)
    return e as AiError
  }
  throw new Error('expected a rejection')
}

/** A fetch whose response body is an endless chunked stream (no content-length). */
function endlessFetch(status: number): { fetch: FetchLike; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0
  let cancelled = false
  const chunk = new Uint8Array(64 * 1024).fill(0x20)
  const fetchImpl: FetchLike = async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) {
        pulled += chunk.byteLength
        ctl.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      }
    })
    return new Response(stream, { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fetchImpl, pulled: () => pulled, cancelled: () => cancelled }
}

const ctx = { kind: 'openai-compatible' as const, model: 'm', keySent: false, key: null, host: 'localhost:1' }

describe('response size cap (chunked responses)', () => {
  it('stops reading a chunked success body at the cap and cancels the stream', async () => {
    const e = endlessFetch(200)
    const err = await rejection(requestJson(e.fetch, { url: 'http://localhost:1/x', signal: signal(), ctx }))
    expect(err.code).toBe('unexpected')
    expect(err.message).toMatch(/unexpectedly large/)
    expect(e.cancelled()).toBe(true)
    expect(e.pulled()).toBeLessThan(MAX_RESPONSE_BYTES + 4 * 64 * 1024)
  })

  it('analyze calls use a small cap; model lists a larger one', () => {
    expect(MAX_RESPONSE_BYTES).toBeLessThanOrEqual(4_000_000)
    expect(MAX_LIST_BYTES).toBeGreaterThan(MAX_RESPONSE_BYTES)
  })

  it('honours a per-request maxBytes', async () => {
    const e = endlessFetch(200)
    await rejection(requestJson(e.fetch, { url: 'http://localhost:1/x', signal: signal(), ctx, maxBytes: 100_000 }))
    expect(e.pulled()).toBeLessThan(100_000 + 4 * 64 * 1024)
  })

  it('reads at most ~64 KB of an endless error body and still maps the status', async () => {
    const e = endlessFetch(500)
    const err = await rejection(requestJson(e.fetch, { url: 'http://localhost:1/x', signal: signal(), ctx }))
    expect(err.code).toBe('server')
    expect(e.cancelled()).toBe(true)
    expect(e.pulled()).toBeLessThan(MAX_ERROR_BYTES + 4 * 64 * 1024)
  })

  it('still parses a normal chunked body', async () => {
    const f: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(ctl) {
            ctl.enqueue(new TextEncoder().encode('{"data":'))
            ctl.enqueue(new TextEncoder().encode('[1,2,"ü"]}'))
            ctl.close()
          }
        }),
        { status: 200 }
      )
    expect(await requestJson(f, { url: 'http://localhost:1/x', signal: signal(), ctx })).toEqual({ data: [1, 2, 'ü'] })
  })

  it('keeps the content-length pre-check', async () => {
    const f = fakeFetch(() => ({ body: '{}', headers: { 'content-length': String(MAX_LIST_BYTES + 1) } }))
    const err = await rejection(requestJson(f, { url: 'http://localhost:1/x', signal: signal(), ctx, maxBytes: MAX_LIST_BYTES }))
    expect(err.message).toMatch(/unexpectedly large/)
  })
})

describe('Google key probe stays on the configured endpoint', () => {
  const r401: Reply = { status: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } }

  it('a Gemini connection with a custom base URL never sends the key to Vertex', async () => {
    const f = fakeFetch(() => r401)
    const c = conn({ baseUrl: 'https://llm-gw.corp.example/v1beta' })
    const e = await rejection(createAdapters(f).gemini.test(c, FAKE_KEYS.aq, signal()))
    expect(e.code).toBe('bad-key')
    expect(f.calls.map((x) => new URL(x.url).host)).toEqual(['llm-gw.corp.example'])
  })

  it('a Vertex connection with a custom base URL never sends the key to the Gemini API', async () => {
    const f = fakeFetch(() => r401)
    const c = conn({ kind: 'vertex', baseUrl: 'https://vertex-proxy.corp.example/v1', model: 'gemini-3.5-flash-lite' })
    await rejection(createAdapters(f).vertex.test(c, FAKE_KEYS.aq, signal()))
    expect(f.calls.map((x) => new URL(x.url).host)).toEqual(['vertex-proxy.corp.example'])
  })

  it('the Vertex half of the probe uses a fixed Vertex model, not the Gemini connection’s model', async () => {
    const f = fakeFetch((c) => (c.url.includes('aiplatform') ? { body: { totalTokens: 1 } } : r401))
    const c = conn({ model: 'gemini-flash-latest' })
    const out = await createAdapters(f).gemini.test(c, FAKE_KEYS.aq, signal())
    expect(out.suggestedKind).toBe('vertex')
    expect(f.calls[1].url).toContain(`/publishers/google/models/${defaultModel('vertex')}:countTokens`)
    // the model differs from what was probed: say so
    expect(out.message).toContain('gemini-flash-latest')
  })
})

describe('reviewPosture respects pause', () => {
  const m = {
    view: 'front',
    neckFwdDeg: 10,
    trunkFwdDeg: null,
    headPitchDeg: null,
    shoulderTiltDeg: 1.5,
    headRollDeg: null,
    trunkLatDeg: null,
    localVerdict: 'good',
    localInstruction: null
  }
  const review = { purpose: 'check', share: 'sketch', imageJpegB64: JPEG_B64, measurements: m }

  it('makes no request while monitoring is paused', async () => {
    const ks = makeKeyStore(fakeBackend())
    const holder = settingsHolder(ks.keys, { ai: { enabled: true, share: 'sketch' } })
    const f = fakeFetch(() => ({ body: { choices: [{ message: { content: REVIEW }, finish_reason: 'stop' }] } }))
    let paused = true
    const svc = createAiService({
      getSettings: holder.get,
      updateSettings: holder.update,
      broadcast: holder.broadcast,
      keys: ks.keys,
      fetch: f,
      isPaused: () => paused,
      timeoutMs: 200
    })
    svc.saveConnection({ kind: 'openai-compatible', baseUrl: 'http://localhost:1/v1', model: 'm' })
    expect(await svc.reviewPosture(review)).toEqual({ ok: false, message: 'Monitoring is paused.' })
    expect(f.calls).toHaveLength(0)
    paused = false
    expect((await svc.reviewPosture(review)).ok).toBe(true)
    expect(f.calls).toHaveLength(1)
  })
})

describe('orphaned keys are pruned', () => {
  it('drops keys whose connection is gone, only when settings were read from disk', () => {
    const { keys } = makeKeyStore()
    keys.setKey('keep', FAKE_KEYS.openai)
    keys.setKey('gone', FAKE_KEYS.anthropic)
    const holder = settingsHolder(keys, {
      ai: { connections: [{ id: 'keep', kind: 'openai', label: 'O', baseUrl: null, model: 'gpt-6-luna', enabled: true }] }
    })
    pruneOrphanKeys(keys, holder.get(), false)
    expect(keys.hasKey('gone')).toBe(true)
    pruneOrphanKeys(keys, holder.get(), true)
    expect(keys.hasKey('gone')).toBe(false)
    expect(keys.getKey('keep')).toBe(FAKE_KEYS.openai)
  })
})

describe('400 classification', () => {
  const okCtx = { kind: 'openai' as const, model: 'gpt-4.1', keySent: true, key: FAKE_KEYS.openai, host: 'api.openai.com' }

  it.each([
    [{ message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning_effort', code: 'unsupported_parameter' }],
    [{ message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.", type: 'invalid_request_error', param: 'response_format', code: null }],
    [{ message: "Unsupported value: 'reasoning_effort' does not support 'low' with this model.", type: 'invalid_request_error', param: 'reasoning_effort', code: 'unsupported_value' }],
    [{ message: 'output_config.format: structured outputs are not supported on this model.', type: 'invalid_request_error' }]
  ])('a rejected parameter is bad-request, not model-not-found (%#)', (error) => {
    expect(mapHttpError(400, JSON.stringify({ error }), okCtx).code).toBe('bad-request')
  })

  it('a missing model on a 400 is still model-not-found', () => {
    const body = { error: { message: 'The model `gpt-nope` does not exist or you do not have access to it.', type: 'invalid_request_error', param: null, code: 'model_not_found' } }
    expect(mapHttpError(400, JSON.stringify(body), okCtx).code).toBe('model-not-found')
    expect(mapHttpError(400, JSON.stringify({ error: { message: 'Invalid model name passed in model=foo' } }), okCtx).code).toBe('model-not-found')
  })

  it('the OpenAI ladder drops reasoning_effort on the real OpenAI wording', async () => {
    const f = fakeFetch((_c, i) =>
      i === 0
        ? {
            status: 400,
            body: { error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning_effort', code: 'unsupported_parameter' } }
          }
        : { body: { choices: [{ message: { content: REVIEW }, finish_reason: 'stop' }] } }
    )
    expect(await createAdapters(f).openai.analyze(req(conn({ kind: 'openai', model: 'gpt-4.1' }), FAKE_KEYS.openai))).toBe(REVIEW)
    expect(f.calls).toHaveLength(2)
    expect((f.calls[1].body as any).reasoning_effort).toBeUndefined()
  })

  it('the Anthropic ladder drops output_config when the model rejects it', async () => {
    const f = fakeFetch((_c, i) =>
      i === 0
        ? { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'output_config: not supported on this model.' } } }
        : { body: { content: [{ type: 'text', text: REVIEW }], stop_reason: 'end_turn' } }
    )
    expect(await createAdapters(f).anthropic.analyze(req(conn({ kind: 'anthropic', model: 'claude-haiku-4-5' }), FAKE_KEYS.anthropic))).toBe(REVIEW)
    expect(f.calls).toHaveLength(2)
    expect((f.calls[1].body as any).output_config).toBeUndefined()
  })
})

describe('output budget and truncation', () => {
  it('leaves headroom for thinking/reasoning tokens', () => {
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(2048)
  })

  it('asks for low thinking on Gemini "-latest" aliases and retries without it if rejected', async () => {
    const f = fakeFetch((_c, i) =>
      i === 0
        ? { status: 400, body: { error: { code: 400, message: 'Thinking level is not supported for this model.', status: 'INVALID_ARGUMENT' } } }
        : { body: { candidates: [{ content: { parts: [{ text: REVIEW }] }, finishReason: 'STOP' }] } }
    )
    expect(await createAdapters(f).gemini.analyze(req(conn({ model: 'gemini-flash-latest' })))).toBe(REVIEW)
    expect((f.calls[0].body as any).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' })
    expect((f.calls[1].body as any).generationConfig.thinkingConfig).toBeUndefined()
    expect((f.calls[1].body as any).generationConfig.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS)
  })

  it('Gemini MAX_TOKENS with no answer is reported as cut off', async () => {
    const f = fakeFetch(() => ({ body: { candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] }, finishReason: 'MAX_TOKENS' }] } }))
    const e = await rejection(createAdapters(f).gemini.analyze(req()))
    expect(e.message).toMatch(/cut off/)
  })

  it('Gemini MAX_TOKENS with partial JSON is reported as cut off', async () => {
    const f = fakeFetch(() => ({ body: { candidates: [{ content: { parts: [{ text: '{"verdict":"good","sco' }] }, finishReason: 'MAX_TOKENS' }] } }))
    expect((await rejection(createAdapters(f).gemini.analyze(req()))).message).toMatch(/cut off/)
  })

  it('chat finish_reason "length" is reported as cut off', async () => {
    const f = fakeFetch(() => ({ body: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } }))
    const e = await rejection(createAdapters(f).openai.analyze(req(conn({ kind: 'openai', model: 'gpt-6-luna' }), FAKE_KEYS.openai)))
    expect(e.message).toMatch(/cut off/)
    expect(f.calls).toHaveLength(1)
  })

  it('Anthropic stop_reason "max_tokens" is reported as cut off', async () => {
    const f = fakeFetch(() => ({ body: { content: [{ type: 'thinking', thinking: '' }], stop_reason: 'max_tokens' } }))
    const e = await rejection(createAdapters(f).anthropic.analyze(req(conn({ kind: 'anthropic', model: 'claude-sonnet-5-5' }), FAKE_KEYS.anthropic)))
    expect(e.message).toMatch(/cut off/)
  })

  it('a complete answer that happens to end at the limit is still returned', async () => {
    const f = fakeFetch(() => ({ body: { choices: [{ message: { content: REVIEW }, finish_reason: 'length' }] } }))
    expect(await createAdapters(f).openai.analyze(req(conn({ kind: 'openai', model: 'gpt-6-luna' }), FAKE_KEYS.openai))).toBe(REVIEW)
  })
})

describe('OpenRouter require_parameters', () => {
  const ok: Reply = { body: { choices: [{ message: { content: REVIEW }, finish_reason: 'stop' }] } }

  it('requires providers to honour json_schema on the first step only', async () => {
    const f = fakeFetch(() => ok)
    await createAdapters(f).openrouter.analyze(req(conn({ kind: 'openrouter', model: 'google/gemini-3.5-flash-lite' }), FAKE_KEYS.openrouter))
    expect((f.calls[0].body as any).provider).toEqual({ require_parameters: true })
  })

  it.each([404, 503])('falls back without require_parameters when no endpoint supports it (%i)', async (status) => {
    const f = fakeFetch((_c, i) =>
      i === 0 ? { status, body: { error: { message: 'No endpoints found that can handle the requested parameters.', code: status } } } : ok
    )
    await createAdapters(f).openrouter.analyze(req(conn({ kind: 'openrouter', model: 'some/model' }), FAKE_KEYS.openrouter))
    expect(f.calls).toHaveLength(2)
    expect((f.calls[1].body as any).provider).toBeUndefined()
    expect((f.calls[1].body as any).response_format).toEqual({ type: 'json_object' })
  })

  it('stops on auth errors', async () => {
    const f = fakeFetch(() => ({ status: 401, body: { error: { message: 'No auth credentials found', code: 401 } } }))
    await rejection(createAdapters(f).openrouter.analyze(req(conn({ kind: 'openrouter' }), FAKE_KEYS.openrouter)))
    expect(f.calls).toHaveLength(1)
  })
})
