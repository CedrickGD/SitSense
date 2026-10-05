import { describe, expect, it } from 'vitest'
import { AI_LIMITS, DEFAULT_AI_SETTINGS, type AiReviewRequest, type AiSettings } from '../../shared/ai'
import { AiError } from '../ai/errors'
import { SYSTEM_PROMPT, buildUserPrompt, extractJson, parseReview, runReview } from '../ai/judge'
import { createAdapters, type AdapterSet, type ProviderAdapter } from '../ai/providers'
import { JPEG_B64, conn, fakeFetch } from '../ai/test-utils'

const request = (patch: Partial<AiReviewRequest> = {}): AiReviewRequest => ({
  purpose: 'check',
  share: 'sketch',
  imageJpegB64: JPEG_B64,
  measurements: {
    view: 'side',
    neckFwdDeg: 21.34,
    trunkFwdDeg: null,
    headPitchDeg: 8,
    shoulderTiltDeg: null,
    headRollDeg: null,
    trunkLatDeg: null,
    localVerdict: 'adjust',
    localInstruction: 'Bring your head back over your shoulders'
  },
  ...patch
})

const good = '{"verdict":"good","score":88,"summary":"Nicely upright.","instructions":[]}'

describe('prompt', () => {
  it('system prompt carries the coaching rules and the JSON contract', () => {
    expect(SYSTEM_PROMPT).toMatch(/ergonomics coach/)
    expect(SYSTEM_PROMPT).toMatch(/ears roughly over the shoulders/)
    expect(SYSTEM_PROMPT).toContain('"verdict":"good"|"adjust"')
    expect(SYSTEM_PROMPT).toMatch(/never mention the image's left or right/)
  })

  it('user prompt includes share mode, purpose and measurements (null = not measurable)', () => {
    const sketch = buildUserPrompt(request())
    expect(sketch).toMatch(/pose drawing, not a photo/)
    expect(sketch).toMatch(/dashed line marks true vertical/)
    expect(sketch).toContain('camera view: side')
    expect(sketch).toContain('neck forward angle (ear ahead of shoulder): 21.3°')
    expect(sketch).toContain('trunk forward lean: not measurable from this view')
    expect(sketch).toContain('on-device verdict: adjust ("Bring your head back over your shoulders")')
    const snap = buildUserPrompt(request({ share: 'snapshot', purpose: 'setup' }))
    expect(snap).toMatch(/webcam snapshot/)
    expect(snap).toMatch(/saved as their reference/)
  })
})

describe('extractJson', () => {
  it.each([
    ['plain', good],
    ['fenced', `Here you go:\n\`\`\`json\n${good}\n\`\`\`\nHope that helps`],
    ['bare fence', `\`\`\`\n${good}\n\`\`\``],
    ['surrounding prose', `Sure! ${good} Let me know.`],
    ['think block', `<think>maybe {"verdict":"bad"}</think>${good}`],
    ['invalid brace first', `Note {not json} then ${good}`],
    ['braces inside strings', '{"verdict":"good","score":88,"summary":"Use a {lumbar} pillow \\" }","instructions":[]}']
  ])('%s', (_n, text) => {
    const o = extractJson(text) as Record<string, unknown>
    expect(o.verdict).toBe('good')
    expect(o.score).toBe(88)
  })

  it('returns undefined when there is no object', () => {
    expect(extractJson('no json here')).toBeUndefined()
    expect(extractJson('{"unterminated": ')).toBeUndefined()
  })
})

describe('parseReview', () => {
  it('clamps the score and truncates summary/instructions per AI_LIMITS', () => {
    const r = parseReview(
      JSON.stringify({
        verdict: 'ADJUST',
        score: 150.4,
        summary: 'x'.repeat(500),
        instructions: ['a'.repeat(300), 'Sit back', '', 7, 'Lower the screen', 'one too many']
      })
    )
    expect(r.verdict).toBe('adjust')
    expect(r.score).toBe(100)
    expect(r.summary.length).toBeLessThanOrEqual(AI_LIMITS.maxSummary)
    expect(r.instructions).toHaveLength(AI_LIMITS.maxInstructions)
    expect(r.instructions[0].length).toBeLessThanOrEqual(AI_LIMITS.maxInstruction)
    expect(r.instructions.slice(1)).toEqual(['Sit back', 'Lower the screen'])
    expect(parseReview('{"verdict":"good","score":-7,"summary":"ok","instructions":[]}').score).toBe(0)
    expect(parseReview('{"verdict":"good","score":"73","summary":"ok"}').score).toBe(73)
  })

  it.each([
    ['bad verdict', '{"verdict":"meh","score":50,"summary":"s","instructions":[]}'],
    ['no score', '{"verdict":"good","summary":"s","instructions":[]}'],
    ['NaN score', '{"verdict":"good","score":"high","summary":"s","instructions":[]}'],
    ['empty summary', '{"verdict":"good","score":50,"summary":"  ","instructions":[]}'],
    ['not json', 'I think you look great!']
  ])('rejects %s', (_n, text) => {
    expect(() => parseReview(text)).toThrow(AiError)
  })
})

function scripted(results: Record<string, () => Promise<string>>): AdapterSet & { order: string[] } {
  const order: string[] = []
  const base = createAdapters(fakeFetch(() => ({ status: 500 })))
  const wrap = (kind: keyof AdapterSet): ProviderAdapter => ({
    ...base[kind],
    analyze: (req) => {
      order.push(req.conn.id)
      expect(req.imageJpegB64).toBe(JPEG_B64)
      return results[req.conn.id]()
    }
  })
  const set = Object.fromEntries((Object.keys(base) as (keyof AdapterSet)[]).map((k) => [k, wrap(k)])) as AdapterSet
  return Object.assign(set, { order })
}

const settings = (patch: Partial<AiSettings> = {}): AiSettings => ({
  ...DEFAULT_AI_SETTINGS,
  enabled: true,
  connections: [
    conn({ id: 'a', label: 'Primary', kind: 'gemini' }),
    conn({ id: 'b', label: 'Disabled', kind: 'openai', enabled: false }),
    conn({ id: 'c', label: 'No key', kind: 'anthropic', hasKey: false }),
    conn({ id: 'd', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', hasKey: false, model: 'llava' })
  ],
  ...patch
})

const getKey = (id: string): string | null => (id === 'a' ? 'AQ.key-a-0123456789' : null)

describe('runReview', () => {
  it('uses the primary when it answers', async () => {
    const a = scripted({ a: async () => good, d: async () => good })
    const r = await runReview(settings(), request(), { adapters: a, getKey })
    expect(r).toEqual({ ok: true, connectionLabel: 'Primary', model: 'gemini-3.5-flash-lite', verdict: 'good', score: 88, summary: 'Nicely upright.', instructions: [] })
    expect(a.order).toEqual(['a'])
  })

  it('falls back in priority order, skipping disabled and keyless connections', async () => {
    const a = scripted({
      a: async () => {
        throw new AiError('quota', 'Rate limit or quota reached — try again later.', 429)
      },
      d: async () => `\`\`\`json\n${good}\n\`\`\``
    })
    const r = await runReview(settings(), request(), { adapters: a, getKey })
    expect(a.order).toEqual(['a', 'd'])
    expect(r.ok && r.connectionLabel).toBe('Local')
  })

  it('treats an invalid answer as a failure of that connection', async () => {
    const a = scripted({ a: async () => 'I cannot tell.', d: async () => good })
    const r = await runReview(settings(), request(), { adapters: a, getKey })
    expect(a.order).toEqual(['a', 'd'])
    expect(r.ok).toBe(true)
  })

  it('times out a hanging connection after timeoutMs and moves on', async () => {
    const a = scripted({ a: () => new Promise<string>(() => undefined), d: async () => good })
    const r = await runReview(settings(), request(), { adapters: a, getKey, timeoutMs: 30 })
    expect(r.ok && r.connectionLabel).toBe('Local')
  })

  it('reports every failure when all connections fail', async () => {
    const a = scripted({
      a: async () => {
        throw new AiError('bad-key', 'The API key was rejected — check that it was copied completely.', 401)
      },
      d: async () => {
        throw new AiError('network', 'Can’t reach localhost:11434 — is the server running?')
      }
    })
    const r = await runReview(settings(), request(), { adapters: a, getKey })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toMatch(/^All AI connections failed — /)
      expect(r.message).toContain('Primary: The API key was rejected')
      expect(r.message).toContain('Local: Can’t reach localhost:11434')
      expect(r.message).not.toContain('AQ.key-a')
    }
  })

  it('returns ok:false when AI is off or nothing is usable', async () => {
    const a = scripted({})
    expect(await runReview(settings({ enabled: false }), request(), { adapters: a, getKey })).toEqual({ ok: false, message: 'AI review is turned off.' })
    const none = await runReview(settings({ connections: [conn({ enabled: false })] }), request(), { adapters: a, getKey })
    expect(none.ok).toBe(false)
    const noModel = await runReview(settings({ connections: [conn({ model: '' })] }), request(), { adapters: a, getKey })
    expect(noModel.ok).toBe(false)
    expect(a.order).toEqual([])
  })

  it('stops when the master signal aborts', async () => {
    const ctl = new AbortController()
    const a = scripted({
      a: () => {
        setTimeout(() => ctl.abort(new AiError('cancelled', 'Cancelled.')), 5)
        return new Promise<string>(() => undefined)
      },
      d: async () => good
    })
    const r = await runReview(settings(), request(), { adapters: a, getKey, signal: ctl.signal })
    expect(r).toEqual({ ok: false, message: 'AI review was cancelled.' })
    expect(a.order).toEqual(['a'])
  })

  it('end-to-end through a real adapter with a fake fetch', async () => {
    const f = fakeFetch(() => ({ body: { candidates: [{ content: { parts: [{ text: 'Result:\n' + good }] } }] } }))
    const r = await runReview(settings({ connections: [conn({ id: 'a' })] }), request(), { adapters: createAdapters(f), getKey })
    expect(r.ok).toBe(true)
    const body = f.calls[0].body as any
    expect(body.systemInstruction.parts[0].text).toBe(SYSTEM_PROMPT)
    expect(body.contents[0].parts[1].text).toContain('neck forward angle')
  })
})
