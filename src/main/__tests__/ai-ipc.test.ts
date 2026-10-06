import { describe, expect, it } from 'vitest'
import { AI_LIMITS, aiErrorMessage } from '../../shared/ai'
import { AiError } from '../ai/errors'
import { AI_DISABLED_MESSAGE, createAiService } from '../ai/service'
import { FAKE_KEYS, JPEG_B64, fakeBackend, fakeFetch, makeKeyStore, settingsHolder, type Reply } from '../ai/test-utils'
import { base64ByteLength, stripAiConnections, validateBaseUrl } from '../ai/validate'

function setup(opts: { enabled?: boolean; route?: (url: string, i: number) => Reply; available?: boolean; share?: 'sketch' | 'snapshot' } = {}) {
  const ks = makeKeyStore(fakeBackend({ available: opts.available ?? true }))
  const holder = settingsHolder(ks.keys, { ai: { enabled: opts.enabled ?? true, share: opts.share ?? 'sketch' } })
  const f = fakeFetch((c, i) => (opts.route ? opts.route(c.url, i) : { status: 500 }))
  let n = 0
  let clock = 1_000
  const svc = createAiService({
    getSettings: holder.get,
    updateSettings: holder.update,
    broadcast: holder.broadcast,
    keys: ks.keys,
    fetch: f,
    newId: () => `id-${++n}`,
    now: () => (clock += 10),
    isPaused: () => false,
    timeoutMs: 200
  })
  return { svc, holder, keys: ks.keys, file: ks.file, f }
}

const thrown = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(AiError)
    return (e as Error).message
  }
  throw new Error('expected a throw')
}

describe('aiSaveConnection', () => {
  it('creates a connection with preset defaults and stores the key encrypted', () => {
    const { svc, holder, keys } = setup()
    const s = svc.saveConnection({ kind: 'gemini' }, `  ${FAKE_KEYS.aq}  `)
    expect(s.ai.connections).toHaveLength(1)
    const c = s.ai.connections[0]
    expect(c).toMatchObject({ id: 'id-1', kind: 'gemini', label: 'Google Gemini', model: 'gemini-3.5-flash-lite', baseUrl: null, enabled: true, hasKey: true, lastTest: null })
    expect(c.keyHint).toBe(`…${FAKE_KEYS.aq.slice(-4)}`)
    expect(keys.getKey('id-1')).toBe(FAKE_KEYS.aq)
    expect(JSON.stringify(s)).not.toContain(FAKE_KEYS.aq)
    expect(holder.broadcasts).toHaveLength(1)
  })

  it('key: undefined/"" keep, null deletes, string replaces', () => {
    const { svc, keys } = setup()
    svc.saveConnection({ kind: 'openai' }, FAKE_KEYS.openai)
    svc.saveConnection({ id: 'id-1', label: 'Work' })
    svc.saveConnection({ id: 'id-1' }, '   ')
    expect(keys.getKey('id-1')).toBe(FAKE_KEYS.openai)
    svc.saveConnection({ id: 'id-1' }, 'sk-proj-REPLACEMENT-0000000000')
    expect(keys.getKey('id-1')).toBe('sk-proj-REPLACEMENT-0000000000')
    const s = svc.saveConnection({ id: 'id-1' }, null)
    expect(keys.hasKey('id-1')).toBe(false)
    expect(s.ai.connections[0]).toMatchObject({ label: 'Work', hasKey: false, keyHint: null })
  })

  it('ignores hasKey/keyHint/lastTest sent by the renderer', () => {
    const { svc } = setup()
    const s = svc.saveConnection({ kind: 'anthropic', hasKey: true, keyHint: '…EVIL', lastTest: { ok: true, at: 1, message: 'x', latencyMs: 1 } } as never)
    expect(s.ai.connections[0]).toMatchObject({ hasKey: false, keyHint: null, lastTest: null })
  })

  it('accepts local http and normalizes trailing slashes', () => {
    const { svc, holder } = setup()
    for (const url of ['http://localhost:11434/v1/', 'http://127.0.0.1:1234/v1', 'http://[::1]:20128/v1', 'https://gw.example.com/openai/v1//']) {
      svc.saveConnection({ kind: 'openai-compatible', baseUrl: url, label: 'L' })
    }
    expect(holder.get().ai.connections.map((c) => c.baseUrl)).toEqual([
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://[::1]:20128/v1',
      'https://gw.example.com/openai/v1'
    ])
    // the preset's own URL is stored as null so preset changes apply
    expect(svc.saveConnection({ kind: 'openai', baseUrl: 'https://api.openai.com/v1/' }).ai.connections[4].baseUrl).toBeNull()
    expect(validateBaseUrl('https://gw.example.com/openai/v1//')).toBe('https://gw.example.com/openai/v1')
    expect(validateBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1')
    expect(validateBaseUrl('  ')).toBeNull()
  })

  it.each([
    ['unknown kind', { kind: 'bard' }, undefined, /Unknown provider/],
    ['missing kind', { label: 'x' }, undefined, /Choose a provider/],
    ['remote http', { kind: 'openai-compatible', baseUrl: 'http://example.com/v1' }, undefined, /only allowed for localhost/],
    ['ftp', { kind: 'openai-compatible', baseUrl: 'ftp://localhost/v1' }, undefined, /https/],
    ['credentials in URL', { kind: 'openai-compatible', baseUrl: 'https://user:pw@example.com/v1' }, undefined, /username or password/],
    ['query in URL', { kind: 'openai-compatible', baseUrl: 'https://example.com/v1?key=abc' }, undefined, /\?/],
    ['not a URL', { kind: 'openai-compatible', baseUrl: 'localhost:11434' }, undefined, /full URL|https/],
    ['compatible without URL', { kind: 'openai-compatible' }, undefined, /base URL/],
    ['label too long', { kind: 'gemini', label: 'x'.repeat(AI_LIMITS.maxLabel + 1) }, undefined, /at most/],
    ['blank label', { kind: 'gemini', label: '   ' }, undefined, /Enter a name/],
    ['model with spaces', { kind: 'gemini', model: 'gemini 3' }, undefined, /spaces/],
    ['unknown id', { id: 'nope' }, undefined, /not found/],
    ['key with whitespace', { kind: 'gemini' }, 'AQ.abc def', /spaces/],
    ['key not a string', { kind: 'gemini' }, 42, /text/],
    ['not an object', 'gemini', undefined, /Invalid connection/]
  ])('rejects %s', (_n, input, key, re) => {
    const { svc, holder } = setup()
    const msg = thrown(() => svc.saveConnection(input, key))
    expect(msg).toMatch(re as RegExp)
    if (typeof key === 'string') expect(msg).not.toContain(key)
    expect(holder.get().ai.connections).toHaveLength(0)
  })

  it('enforces the connection limit', () => {
    const { svc } = setup()
    for (let i = 0; i < AI_LIMITS.maxConnections; i++) svc.saveConnection({ kind: 'openrouter' })
    expect(thrown(() => svc.saveConnection({ kind: 'openrouter' }))).toMatch(/at most/)
  })

  it('refuses to save a key without encryption — and creates nothing', () => {
    const { svc, holder, keys } = setup({ available: false })
    const msg = thrown(() => svc.saveConnection({ kind: 'gemini' }, FAKE_KEYS.aq))
    expect(msg).toMatch(/Secure key storage isn’t available/)
    expect(msg).not.toContain(FAKE_KEYS.aq)
    expect(holder.get().ai.connections).toHaveLength(0)
    expect(keys.hasKey('id-1')).toBe(false)
  })

  it('drops the stored key when the endpoint host changes, but not for Gemini ↔ Vertex', () => {
    const { svc, keys } = setup()
    svc.saveConnection({ kind: 'openai-compatible', baseUrl: 'https://gw.example.com/v1' }, 'gw-secret-0123456789')
    svc.saveConnection({ id: 'id-1', baseUrl: 'https://gw.example.com/v2' })
    expect(keys.hasKey('id-1')).toBe(true) // same origin
    const s = svc.saveConnection({ id: 'id-1', baseUrl: 'https://other.example.net/v1' })
    expect(keys.hasKey('id-1')).toBe(false)
    expect(s.ai.connections[0].hasKey).toBe(false)

    svc.saveConnection({ kind: 'gemini' }, FAKE_KEYS.aq)
    svc.saveConnection({ id: 'id-2', kind: 'vertex' })
    expect(keys.getKey('id-2')).toBe(FAKE_KEYS.aq)
    svc.saveConnection({ id: 'id-2', kind: 'openai' })
    expect(keys.hasKey('id-2')).toBe(false)
  })

  it('resets lastTest when the endpoint, model or key changes; keeps it for label/enabled edits', async () => {
    const { svc, holder } = setup({ route: () => ({ body: { models: [] } }) })
    svc.saveConnection({ kind: 'gemini' }, FAKE_KEYS.aq)
    await svc.testConnection('id-1')
    expect(holder.get().ai.connections[0].lastTest?.ok).toBe(true)
    svc.saveConnection({ id: 'id-1', label: 'Renamed', enabled: false })
    expect(holder.get().ai.connections[0].lastTest?.ok).toBe(true)
    svc.saveConnection({ id: 'id-1', model: 'gemini-3.8-flash' })
    expect(holder.get().ai.connections[0].lastTest).toBeNull()
  })
})

describe('aiRemoveConnection / aiMoveConnection', () => {
  it('remove deletes the key too; move swaps priority within bounds', () => {
    const { svc, keys, holder } = setup()
    svc.saveConnection({ kind: 'gemini', label: 'A' }, FAKE_KEYS.aq)
    svc.saveConnection({ kind: 'openai', label: 'B' }, FAKE_KEYS.openai)
    svc.saveConnection({ kind: 'anthropic', label: 'C' })
    const labels = (): string[] => holder.get().ai.connections.map((c) => c.label)
    svc.moveConnection('id-3', -1)
    expect(labels()).toEqual(['A', 'C', 'B'])
    svc.moveConnection('id-1', -1) // already first: no-op
    svc.moveConnection('id-2', 1) // already last: no-op
    expect(labels()).toEqual(['A', 'C', 'B'])
    expect(thrown(() => svc.moveConnection('id-1', 2))).toMatch(/-1 or 1/)
    svc.removeConnection('id-1')
    expect(labels()).toEqual(['C', 'B'])
    expect(keys.hasKey('id-1')).toBe(false)
    expect(keys.getKey('id-2')).toBe(FAKE_KEYS.openai)
  })
})

describe('aiTestConnection — Google probe', () => {
  const googleErr = (code: number, status: string, message: string, reason: string): Reply => ({
    status: code,
    body: { error: { code, message, status, details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } }
  })

  it('Gemini key on a Gemini connection: ok, lastTest recorded', async () => {
    const { svc, holder, f } = setup({ route: () => ({ body: { models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] } }) })
    svc.saveConnection({ kind: 'gemini' }, FAKE_KEYS.aq)
    const r = await svc.testConnection('id-1')
    expect(r).toMatchObject({ ok: true, message: 'Connected to the Gemini API.' })
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    expect(r.switchedKind).toBeUndefined()
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].headers['x-goog-api-key']).toBe(FAKE_KEYS.aq)
    expect(holder.get().ai.connections[0].lastTest).toMatchObject({ ok: true, message: 'Connected to the Gemini API.' })
  })

  it('Vertex express key on a Gemini connection: probes countTokens and switches the kind', async () => {
    const { svc, holder, f } = setup({
      route: (url) =>
        url.startsWith('https://generativelanguage.googleapis.com/')
          ? googleErr(403, 'PERMISSION_DENIED', 'Generative Language API has not been used in project 42 before or it is disabled.', 'SERVICE_DISABLED')
          : { body: { totalTokens: 1 } }
    })
    svc.saveConnection({ kind: 'gemini' }, FAKE_KEYS.aq)
    const n = holder.broadcasts.length
    const r = await svc.testConnection('id-1')
    expect(r).toMatchObject({ ok: true, message: 'This key works with Vertex AI — switched.', switchedKind: 'vertex' })
    expect(f.calls[1].url).toBe('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.5-flash-lite:countTokens')
    expect(f.calls[1].body).toEqual({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] })
    const c = holder.get().ai.connections[0]
    expect(c).toMatchObject({ kind: 'vertex', label: 'Google Vertex AI (express)', baseUrl: null, hasKey: true })
    expect(c.lastTest?.message).toBe('This key works with Vertex AI — switched.')
    expect(holder.broadcasts.length).toBe(n + 1)
  })

  it('AI Studio key on a Vertex connection switches to Gemini', async () => {
    const { svc, holder } = setup({
      route: (url) =>
        url.startsWith('https://aiplatform.googleapis.com/')
          ? googleErr(401, 'UNAUTHENTICATED', 'API keys are not supported by this API. Expected OAuth2 access token', 'CREDENTIALS_MISSING')
          : { body: { models: [] } }
    })
    svc.saveConnection({ kind: 'vertex', label: 'My Google' }, FAKE_KEYS.aq)
    const r = await svc.testConnection('id-1')
    expect(r.switchedKind).toBe('gemini')
    expect(r.message).toMatch(/works with the Gemini API — switched/)
    expect(holder.get().ai.connections[0]).toMatchObject({ kind: 'gemini', label: 'My Google' })
  })

  it('a key that works nowhere reports the first endpoint’s error and does not switch', async () => {
    const { svc, holder } = setup({
      route: () => googleErr(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID')
    })
    svc.saveConnection({ kind: 'gemini' }, FAKE_KEYS.aiza)
    const r = await svc.testConnection('id-1')
    expect(r).toMatchObject({ ok: false, latencyMs: null })
    expect(r.message).toMatch(/API key was rejected/)
    expect(r.message).not.toContain(FAKE_KEYS.aiza)
    expect(holder.get().ai.connections[0]).toMatchObject({ kind: 'gemini', lastTest: { ok: false } })
  })

  it('401 on both endpoints → bad key, no switch', async () => {
    const { svc, holder } = setup({ route: () => googleErr(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.', 'ACCESS_TOKEN_TYPE_UNSUPPORTED') })
    svc.saveConnection({ kind: 'gemini' }, FAKE_KEYS.aq)
    const r = await svc.testConnection('id-1')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/API key was rejected/)
    expect(holder.get().ai.connections[0].kind).toBe('gemini')
  })
})

describe('aiTestConnection / aiListModels guards', () => {
  it('makes zero requests while AI is off', async () => {
    const { svc, f } = setup({ enabled: false })
    svc.saveConnection({ kind: 'gemini' }, FAKE_KEYS.aq)
    expect(await svc.testConnection('id-1')).toEqual({ ok: false, message: AI_DISABLED_MESSAGE, latencyMs: null })
    expect(await svc.listModels('id-1')).toEqual({ ok: false, message: AI_DISABLED_MESSAGE })
    expect(f.calls).toHaveLength(0)
  })

  it('needs a key for keyed providers but not for local servers', async () => {
    const { svc, f } = setup({ route: () => ({ body: { object: 'list', data: [{ id: 'llava' }] } }) })
    svc.saveConnection({ kind: 'openai' })
    expect(await svc.testConnection('id-1')).toMatchObject({ ok: false, message: 'Add an API key first.' })
    expect(await svc.listModels('id-1')).toEqual({ ok: false, message: 'Add an API key first.' })
    expect(f.calls).toHaveLength(0)
    svc.saveConnection({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llava' })
    expect(await svc.testConnection('id-2')).toMatchObject({ ok: true, message: 'Connected.' })
    expect(await svc.listModels('id-2')).toEqual({ ok: true, models: ['llava'] })
    expect(await svc.testConnection('missing')).toMatchObject({ ok: false, message: 'Connection not found.' })
    expect(await svc.testConnection(42)).toMatchObject({ ok: false })
  })

  it('a hanging provider times out', async () => {
    const { svc } = setup({ route: () => 'hang' })
    svc.saveConnection({ kind: 'openai' }, FAKE_KEYS.openai)
    const r = await svc.testConnection('id-1')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/No answer within/)
  })

  it('cancelAll aborts requests in flight', async () => {
    const { svc } = setup({ route: () => 'hang' })
    svc.saveConnection({ kind: 'openai' }, FAKE_KEYS.openai)
    const p = svc.listModels('id-1')
    svc.cancelAll()
    expect(await p).toEqual({ ok: false, message: 'Cancelled.' })
  })

  it('a test of a replaced key that finishes late does not overwrite the new key’s result', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => (release = r))
    const okModels = { body: { object: 'list', data: [{ id: 'gpt-x' }] } }
    const ks = makeKeyStore(fakeBackend())
    const holder = settingsHolder(ks.keys, { ai: { enabled: true } })
    // the old key's request waits on the gate, then is rejected; the new key's passes
    const f = async (_url: string, init?: RequestInit): Promise<Response> => {
      const auth = String((init?.headers as Record<string, string>)?.authorization ?? '')
      if (auth.includes(FAKE_KEYS.openai)) {
        await gate
        return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }), { status: 401 })
      }
      return new Response(JSON.stringify(okModels.body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const svc = createAiService({
      getSettings: holder.get,
      updateSettings: holder.update,
      broadcast: holder.broadcast,
      keys: ks.keys,
      fetch: f,
      newId: () => 'id-1',
      isPaused: () => false,
      timeoutMs: 2000
    })
    svc.saveConnection({ kind: 'openai' }, FAKE_KEYS.openai)
    const oldTest = svc.testConnection('id-1')
    await new Promise((r) => setTimeout(r, 5))
    svc.saveConnection({ id: 'id-1' }, 'sk-proj-a-working-replacement-key-0123456789')
    expect(await svc.testConnection('id-1')).toMatchObject({ ok: true })
    expect(holder.get().ai.connections[0].lastTest?.ok).toBe(true)
    release!()
    expect(await oldTest).toMatchObject({ ok: false }) // still reported to its caller …
    expect(holder.get().ai.connections[0].lastTest?.ok).toBe(true) // … but not recorded
  })

  it('a newer Test supersedes an older one still running', async () => {
    let n = 0
    const { svc, holder } = setup({ route: () => (n++ === 0 ? 'hang' : { body: { object: 'list', data: [{ id: 'm' }] } }) })
    svc.saveConnection({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'm' })
    const first = svc.testConnection('id-1') // hangs until its 200 ms timeout
    expect(await svc.testConnection('id-1')).toMatchObject({ ok: true })
    expect(await first).toMatchObject({ ok: false, message: expect.stringMatching(/No answer within/) })
    expect(holder.get().ai.connections[0].lastTest?.ok).toBe(true)
  })

  it('a Test cancelled by switching AI off records nothing', async () => {
    const { svc, holder } = setup({ route: () => 'hang' })
    svc.saveConnection({ kind: 'openai' }, FAKE_KEYS.openai)
    const p = svc.testConnection('id-1')
    holder.update({ ai: { enabled: false } })
    svc.cancelAll()
    expect(await p).toMatchObject({ ok: false, message: 'Cancelled.' })
    expect(holder.get().ai.connections[0].lastTest).toBeNull()
  })
})

describe('aiReviewPosture — one slot, released by cancelReview', () => {
  const m = { view: 'front', neckFwdDeg: 10, trunkFwdDeg: null, headPitchDeg: null, shoulderTiltDeg: null, headRollDeg: null, trunkLatDeg: null, localVerdict: 'good', localInstruction: null }
  const req = (requestId?: unknown) => ({ purpose: 'check', share: 'sketch', imageJpegB64: JPEG_B64, measurements: m, ...(requestId === undefined ? {} : { requestId }) })
  const answer = { body: { choices: [{ message: { content: '{"verdict":"good","score":90,"summary":"Upright.","instructions":[]}' } }] } }

  it('a stopped review frees the slot at once; its late cleanup does not free the next one', async () => {
    let n = 0
    const { svc } = setup({ route: () => (n++ === 0 ? 'hang' : answer) })
    svc.saveConnection({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llava' })
    const first = svc.reviewPosture(req('r1'))
    expect(await svc.reviewPosture(req('r2'))).toEqual({ ok: false, message: 'A review is already running.' })
    svc.cancelReview('other') // another id: no effect
    expect(await svc.reviewPosture(req('r2'))).toEqual({ ok: false, message: 'A review is already running.' })
    svc.cancelReview('r1')
    const second = svc.reviewPosture(req('r2')) // accepted right away
    expect(await first).toEqual({ ok: false, message: 'AI review was cancelled.' })
    // the cancelled review's cleanup ran — the second still holds the slot
    expect(await svc.reviewPosture(req('r3'))).toEqual({ ok: false, message: 'A review is already running.' })
    expect(await second).toMatchObject({ ok: true, verdict: 'good' })
  })

  it('validates the request id; a review without one still works', async () => {
    const { svc, f } = setup({ route: () => answer })
    svc.saveConnection({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llava' })
    expect(await svc.reviewPosture(req('bad id!'))).toMatchObject({ ok: false, message: 'Invalid request id.' })
    expect(await svc.reviewPosture(req(42))).toMatchObject({ ok: false })
    expect(f.calls).toHaveLength(0)
    expect(await svc.reviewPosture(req())).toMatchObject({ ok: true })
    svc.cancelReview(undefined)
    svc.cancelReview({})
  })
})

describe('aiReviewPosture validation', () => {
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
  const req = (patch: Record<string, unknown> = {}) => ({ purpose: 'setup', share: 'sketch', imageJpegB64: JPEG_B64, measurements: m, ...patch })
  const huge = '/9j/' + 'A'.repeat(Math.ceil(AI_LIMITS.maxImageBytes / 3) * 4)

  it.each([
    ['not an object', null, /Invalid review request/],
    ['bad purpose', req({ purpose: 'spy' }), /purpose/],
    ['bad share', req({ share: 'video' }), /share/],
    ['missing image', req({ imageJpegB64: undefined }), /missing/],
    ['data: prefix', req({ imageJpegB64: `data:image/jpeg;base64,${JPEG_B64}` }), /base64/],
    ['not base64', req({ imageJpegB64: '/9j/@@@@' }), /base64/],
    ['not a JPEG', req({ imageJpegB64: Buffer.from('\x89PNG\r\n\x1a\nxxxx').toString('base64') }), /JPEG/],
    ['oversized image', req({ imageJpegB64: huge }), /too large/],
    ['NaN measurement', req({ measurements: { ...m, neckFwdDeg: Number.NaN } }), /neckFwdDeg/],
    ['Infinity measurement', req({ measurements: { ...m, trunkLatDeg: Number.POSITIVE_INFINITY } }), /trunkLatDeg/],
    ['string measurement', req({ measurements: { ...m, headRollDeg: '3' } }), /headRollDeg/],
    ['bad view', req({ measurements: { ...m, view: 'top' } }), /view/],
    ['bad local verdict', req({ measurements: { ...m, localVerdict: 'meh' } }), /localVerdict/]
  ])('rejects %s', async (_n, r, re) => {
    const { svc, f } = setup()
    svc.saveConnection({ kind: 'openai-compatible', baseUrl: 'http://localhost:1/v1', model: 'm' })
    const out = await svc.reviewPosture(r)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toMatch(re as RegExp)
    expect(f.calls).toHaveLength(0)
  })

  it('accepts an image right at the size limit and rejects one byte over', () => {
    const at = AI_LIMITS.maxImageBytes - (AI_LIMITS.maxImageBytes % 3)
    expect(base64ByteLength('A'.repeat((at / 3) * 4))).toBe(at)
    expect(base64ByteLength('QQ==')).toBe(1)
    expect(base64ByteLength('QQ=')).toBe(-1)
  })

  it('refuses a share mode other than the user’s setting (privacy contract)', async () => {
    const { svc, f } = setup({ share: 'sketch', route: () => ({ body: { choices: [{ message: { content: '{}' } }] } }) })
    svc.saveConnection({ kind: 'openai-compatible', baseUrl: 'http://localhost:1/v1', model: 'm' })
    const out = await svc.reviewPosture(req({ share: 'snapshot' }))
    expect(out.ok).toBe(false)
    expect(f.calls).toHaveLength(0)
  })

  it('returns a validated review from the first working connection', async () => {
    const { svc, f } = setup({
      route: (url) =>
        url.includes('openai.com')
          ? { status: 429, body: { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } } }
          : { body: { choices: [{ message: { content: 'Here: {"verdict":"adjust","score":61,"summary":"Head forward.","instructions":["Pull your chin back"]}' } }] } }
    })
    svc.saveConnection({ kind: 'openai', label: 'OpenAI' }, FAKE_KEYS.openai)
    svc.saveConnection({ kind: 'openai-compatible', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llava' })
    const out = await svc.reviewPosture(req())
    expect(out).toEqual({ ok: true, connectionLabel: 'Ollama', model: 'llava', verdict: 'adjust', score: 61, summary: 'Head forward.', instructions: ['Pull your chin back'] })
    expect(f.calls.map((c) => new URL(c.url).host)).toEqual(['api.openai.com', 'localhost:11434'])
  })

  it('is off when AI is disabled', async () => {
    const { svc } = setup({ enabled: false })
    expect(await svc.reviewPosture(req())).toEqual({ ok: false, message: 'AI review is turned off.' })
  })
})

describe('generic settingsSet patches', () => {
  it('strip ai.connections but keep the other ai fields', () => {
    expect(stripAiConnections({ ai: { enabled: true, connections: [] }, onboarded: true })).toEqual({ ai: { enabled: true }, onboarded: true })
    expect(stripAiConnections({ ai: null, general: {} })).toEqual({ general: {} })
    expect(stripAiConnections({ ai: [] })).toEqual({})
    expect(stripAiConnections({ notifications: { sound: true } })).toEqual({ notifications: { sound: true } })
    expect(stripAiConnections(null)).toBeNull()
  })
})

describe('aiErrorMessage', () => {
  it('strips Electron’s remote-method prefix', () => {
    expect(aiErrorMessage(new Error("Error invoking remote method 'ai:save-connection': Error: Enter a name for this connection."))).toBe(
      'Enter a name for this connection.'
    )
    expect(aiErrorMessage('x')).toBe('x')
    expect(aiErrorMessage(undefined)).toBe('Something went wrong.')
  })
})
