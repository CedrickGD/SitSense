import { describe, expect, it } from 'vitest'
import { AI_PRESETS, type AiConnection } from '@shared/ai'
import type { CalibrationBaseline } from '@shared/posture'
import {
  aiStatus,
  connectionProblem,
  baseUrlAlwaysVisible,
  draftDiffers,
  draftForConnection,
  draftForPreset,
  draftPayload,
  findNewConnectionId,
  formatAgo,
  hasBaseUrlOverride,
  keyArgument,
  keyPrefixHint,
  modelSuggestions,
  presetById,
  presetForConnection,
  providerPhrase,
  recipientPhrases,
  saveDropsKey,
  setupLine,
  shareDisclosure,
  switchPreset,
  testStatus
} from '../ai-settings'

const conn = (over: Partial<AiConnection>): AiConnection => ({
  id: 'a',
  kind: 'gemini',
  label: 'Google Gemini',
  baseUrl: null,
  model: 'gemini-3.5-flash-lite',
  enabled: true,
  hasKey: true,
  keyHint: '…x2Ig',
  lastTest: null,
  ...over
})

describe('presetForConnection', () => {
  it('maps hosted kinds to their preset', () => {
    expect(presetForConnection({ kind: 'vertex', baseUrl: null }).id).toBe('vertex')
    expect(presetForConnection({ kind: 'anthropic', baseUrl: 'https://proxy.example.com/v1' }).id).toBe('anthropic')
  })
  it('matches OpenAI-compatible servers by URL, else Custom', () => {
    expect(presetForConnection({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1/' }).id).toBe('ollama')
    expect(presetForConnection({ kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' }).id).toBe('lmstudio')
    expect(presetForConnection({ kind: 'openai-compatible', baseUrl: 'https://llm.corp.example/v1' }).id).toBe('custom')
    expect(presetForConnection({ kind: 'openai-compatible', baseUrl: null }).id).toBe('custom')
  })
})

describe('base URL visibility', () => {
  it('is always shown for OpenAI-compatible presets only', () => {
    const visible = AI_PRESETS.filter(baseUrlAlwaysVisible).map((p) => p.id)
    expect(visible).toEqual(['ollama', 'lmstudio', 'custom'])
  })
})

describe('keyPrefixHint', () => {
  const gemini = presetById('gemini')
  const vertex = presetById('vertex')
  it('says nothing for short input', () => {
    expect(keyPrefixHint(gemini, 'AQ')).toBeNull()
  })
  it('explains Google auth keys without claiming an endpoint', () => {
    expect(keyPrefixHint(gemini, 'AQ.AbFAKEabc')).toMatch(/Gemini or Vertex/)
    expect(keyPrefixHint(vertex, 'AQ.AbFAKEabc')).toMatch(/Test finds out/)
  })
  it('flags AI Studio keys on Vertex and unknown Google prefixes', () => {
    expect(keyPrefixHint(vertex, 'AIzaSyD-abc')).toMatch(/AI Studio/)
    expect(keyPrefixHint(gemini, 'AIzaSyD-abc')).toMatch(/AI Studio/)
    expect(keyPrefixHint(gemini, 'sk-abcdef')).toMatch(/AQ\.|AIza/)
  })
  it('catches keys pasted under the wrong provider', () => {
    expect(keyPrefixHint(presetById('openai'), 'sk-ant-api03-x')).toMatch(/Anthropic/)
    expect(keyPrefixHint(presetById('anthropic'), 'sk-proj-x')).toMatch(/sk-ant-/)
    expect(keyPrefixHint(presetById('openrouter'), 'sk-or-v1-x')).toBeNull()
  })
  it('never echoes the key', () => {
    const key = 'AQ.secretSECRET123'
    for (const p of AI_PRESETS) expect(keyPrefixHint(p, key) ?? '').not.toContain('secret')
  })
})

describe('form drafts', () => {
  it('starts from the preset defaults', () => {
    expect(draftForPreset(presetById('gemini'))).toEqual({
      presetId: 'gemini',
      label: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-3.5-flash-lite'
    })
  })
  it('switching presets keeps a custom name but follows a default one', () => {
    const d = draftForPreset(presetById('gemini'))
    expect(switchPreset(d, presetById('openai')).label).toBe('OpenAI')
    expect(switchPreset({ ...d, label: 'Work key' }, presetById('openai')).label).toBe('Work key')
    expect(switchPreset(d, presetById('ollama'))).toMatchObject({ baseUrl: 'http://localhost:11434/v1', model: '' })
  })
  it('edits show the preset URL when none is stored', () => {
    expect(draftForConnection(conn({})).baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta')
  })
  it('builds the save payload', () => {
    const d = { presetId: 'custom', label: '  ', baseUrl: ' https://x.example/v1 ', model: ' m ' }
    expect(draftPayload(d, null)).toEqual({
      kind: 'openai-compatible',
      label: 'Custom (OpenAI-compatible)',
      baseUrl: 'https://x.example/v1',
      model: 'm'
    })
    expect(draftPayload(d, 'id1').id).toBe('id1')
  })
  it('maps the key action to the IPC key argument', () => {
    expect(keyArgument('keep', '')).toBeUndefined()
    expect(keyArgument('replace', '   ')).toBeUndefined()
    expect(keyArgument('replace', ' k ')).toBe('k')
    expect(keyArgument('keep', 'k')).toBe('k')
    expect(keyArgument('remove', 'k')).toBeNull()
  })
  it('knows when saving deletes the kept key (same rule as main: the origin changes)', () => {
    const gemini = conn({})
    const asDraft = (c: AiConnection, over: Partial<ReturnType<typeof draftForConnection>> = {}) => ({
      ...draftForConnection(c),
      ...over
    })
    // Google ↔ Google on Google's own URLs keeps it
    expect(saveDropsKey(gemini, switchPreset(asDraft(gemini), presetById('vertex')))).toBeNull()
    expect(saveDropsKey(gemini, switchPreset(asDraft(gemini), presetById('openai')))).toBe('provider')
    expect(saveDropsKey(gemini, asDraft(gemini))).toBeNull()
    expect(saveDropsKey(gemini, asDraft(gemini, { model: 'other', label: 'x' }))).toBeNull()
    // only the host or port of an OpenAI-compatible server changes
    const custom = conn({ kind: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', label: 'Mine' })
    expect(saveDropsKey(custom, asDraft(custom, { baseUrl: 'http://localhost:8081/v1' }))).toBe('address')
    expect(saveDropsKey(custom, asDraft(custom, { baseUrl: 'http://localhost:8080/v2/' }))).toBeNull()
    const ollama = conn({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })
    expect(saveDropsKey(ollama, asDraft(ollama, { baseUrl: 'http://127.0.0.1:11434/v1' }))).toBe('address')
    // a hosted provider moved behind a proxy (Advanced → Base URL)
    const openai = conn({ kind: 'openai', baseUrl: null })
    expect(saveDropsKey(openai, asDraft(openai, { baseUrl: 'https://proxy.corp.example/v1' }))).toBe('address')
    expect(saveDropsKey(openai, asDraft(openai, { baseUrl: 'https://api.openai.com/v1/' }))).toBeNull()
    // a proxied Gemini that goes back to Google's URL is a different host
    const proxied = conn({ baseUrl: 'https://proxy.corp.example/v1beta' })
    expect(saveDropsKey(proxied, asDraft(proxied, { baseUrl: '' }))).toBe('address')
    // an invalid URL fails in main before anything changes
    expect(saveDropsKey(custom, asDraft(custom, { baseUrl: 'not a url' }))).toBeNull()
  })
  it('knows when the draft differs from the saved connection', () => {
    const gemini = conn({})
    expect(draftDiffers(null, draftForConnection(gemini))).toBe(true)
    expect(draftDiffers(gemini, draftForConnection(gemini))).toBe(false)
    expect(draftDiffers(gemini, { ...draftForConnection(gemini), baseUrl: 'https://generativelanguage.googleapis.com/v1beta/' })).toBe(false)
    expect(draftDiffers(gemini, { ...draftForConnection(gemini), model: 'x' })).toBe(true)
    expect(draftDiffers(gemini, switchPreset(draftForConnection(gemini), presetById('vertex')))).toBe(true)
  })
  it('opens Advanced when a hosted provider has its own base URL', () => {
    expect(hasBaseUrlOverride(draftForConnection(conn({})))).toBe(false)
    expect(hasBaseUrlOverride(draftForConnection(conn({ kind: 'openai', baseUrl: 'https://proxy.corp.example/v1' })))).toBe(true)
    // OpenAI-compatible servers always show the field
    expect(hasBaseUrlOverride(draftForConnection(conn({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1' })))).toBe(false)
  })
})

describe('list helpers', () => {
  it('finds the id main assigned to a new connection', () => {
    const a = conn({ id: 'a' })
    expect(findNewConnectionId([a], [a, conn({ id: 'b' })])).toBe('b')
    expect(findNewConnectionId([a], [a])).toBeNull()
  })
  it('test status', () => {
    expect(testStatus(conn({}))).toBe('untested')
    expect(testStatus(conn({ lastTest: { ok: true, at: 1, message: '', latencyMs: 5 } }))).toBe('ok')
    expect(testStatus(conn({ lastTest: { ok: false, at: 1, message: 'bad key', latencyMs: null } }))).toBe('failed')
  })
  it('formats ages', () => {
    const now = 10_000_000_000
    expect(formatAgo(now - 10_000, now)).toBe('just now')
    expect(formatAgo(now - 4 * 60_000, now)).toBe('4 min ago')
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(formatAgo(now - 30 * 3_600_000, now)).toBe('yesterday')
    // English dates whatever the system locale (never "2. Okt.")
    expect(formatAgo(new Date(2026, 9, 2, 12).getTime(), new Date(2026, 9, 9, 12).getTime())).toBe('2 Oct')
  })
  it('merges model suggestions without duplicates', () => {
    expect(modelSuggestions(presetById('anthropic'), ['claude-sonnet-5-5', 'gpt-x', ''])).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'gpt-x'])
  })
})

describe('disclosure', () => {
  it('says who receives a review in plain words', () => {
    expect(providerPhrase({ kind: 'gemini', baseUrl: null })).toBe('Google Gemini')
    expect(providerPhrase({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })).toBe('Ollama on this computer')
    expect(providerPhrase({ kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })).toBe('LM Studio on this computer')
    expect(providerPhrase({ kind: 'openai-compatible', baseUrl: 'https://llm.corp.example/v1' })).toBe(
      'the server at llm.corp.example'
    )
  })
  it('never says a local gateway keeps the data on this computer', () => {
    expect(providerPhrase({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1' })).toBe(
      'the server on this computer, which may pass it on to other services'
    )
  })
  it('names the proxy when a hosted provider uses its own base URL', () => {
    expect(providerPhrase({ kind: 'openai', baseUrl: 'https://proxy.corp.example/v1' })).toBe(
      'OpenAI via the server at proxy.corp.example'
    )
    expect(providerPhrase({ kind: 'openai', baseUrl: 'https://api.openai.com/v1/' })).toBe('OpenAI')
  })
  it('lists every connection that is on, in order, without repeats', () => {
    const list = [
      conn({ id: 'a' }),
      conn({ id: 'b', kind: 'openrouter', enabled: false }),
      conn({ id: 'c', kind: 'openrouter' }),
      conn({ id: 'd' })
    ]
    expect(recipientPhrases(list)).toEqual(['Google Gemini', 'OpenRouter'])
  })
  it('never names a connection that is on but cannot be called', () => {
    const needKey = [conn({ id: 'a', hasKey: false }), conn({ id: 'b', kind: 'openrouter', hasKey: false })]
    expect(recipientPhrases(needKey)).toEqual([])
    const ollama = conn({ id: 'o', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', hasKey: false })
    expect(recipientPhrases([conn({ id: 'a', hasKey: false }), ollama])).toEqual(['Ollama on this computer'])
    expect(recipientPhrases([conn({ id: 'a', model: ' ' })])).toEqual([])
  })
  it('names the provider, its fallbacks and what leaves the device', () => {
    const sketch = shareDisclosure('sketch', 'Google Gemini')
    expect(sketch).toContain('Google Gemini')
    expect(sketch).toMatch(/no camera image/)
    expect(sketch).toMatch(/ask the coach/)
    expect(sketch).toMatch(/Check my posture/)
    expect(sketch).not.toMatch(/can’t answer/)
    expect(shareDisclosure('snapshot', null)).toMatch(/640 px.*your connected provider/)
    const chain = shareDisclosure('snapshot', ['Google Gemini', 'OpenRouter', 'Ollama on this computer'])
    expect(chain).toMatch(/to Google Gemini\. If that one can’t answer, the same goes to OpenRouter, then Ollama on this computer\./)
  })
})

describe('setupLine', () => {
  const base = { capturedAt: new Date(2026, 9, 2, 14, 20).getTime(), view: { kind: 'side' }, verified: true } as CalibrationBaseline
  it('describes when, from where and whether it was verified (ui-v3 §10.5)', () => {
    const l = setupLine(base, new Date(2026, 9, 2, 18, 0).getTime())
    expect(l.ago).toBe('Set up 3 h ago')
    expect(l.when).toMatch(/^today /)
    expect(l.view).toBe('Side view')
    expect(l.verified).toBe(true)
    expect(l.verdict).toBe('Verified by on-device AI')
    const forced = setupLine({ ...base, verified: false, view: { kind: 'front' } } as CalibrationBaseline, new Date(2026, 9, 3, 9, 0).getTime())
    expect(forced.ago).toBe('Set up yesterday')
    expect(forced.when).toMatch(/^yesterday /)
    expect(forced.view).toBe('Front view')
    expect(forced.verdict).toBe('Not verified')
    expect(setupLine(base, new Date(2026, 9, 5, 9, 0).getTime()).ago).toBe('Set up 3 days ago')
    expect(setupLine(base, new Date(2026, 9, 9, 9, 0).getTime()).when).toBe('2 Oct 2026, 14:20')
  })
})

describe('connectionProblem', () => {
  it('says what is missing before a connection can be used', () => {
    expect(connectionProblem(conn({}))).toBeNull()
    expect(connectionProblem(conn({ hasKey: false }))).toBe('Needs a key')
    expect(connectionProblem(conn({ model: ' ' }))).toBe('Needs a model')
    expect(connectionProblem(conn({ kind: 'openai-compatible', baseUrl: null, hasKey: false }))).toBe('Needs a server address')
    // Ollama needs no key
    expect(connectionProblem(conn({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', hasKey: false }))).toBeNull()
  })
})

describe('aiStatus', () => {
  const ok = { ok: true, at: 1, message: '', latencyMs: 10 }
  it('says when nothing can leave the device', () => {
    expect(aiStatus({ enabled: false, connections: [conn({})] })).toEqual({
      kind: 'off',
      text: 'Off — SitSense sends nothing to an AI model.'
    })
  })
  it('names the primary and counts the fallbacks', () => {
    const s = aiStatus({
      enabled: true,
      connections: [
        conn({ id: 'a', model: 'gemini-x', hasKey: true, lastTest: ok }),
        conn({ id: 'b', kind: 'openrouter', label: 'OpenRouter', model: 'm', hasKey: true }),
        conn({ id: 'c', kind: 'anthropic', label: 'Claude', model: 'm', hasKey: true, enabled: false })
      ]
    })
    expect(s.kind).toBe('ok')
    expect(s.text).toBe('On · Primary: Google Gemini (gemini-x) · 1 fallback')
  })
  it('names the connection really tried first, and warns when nothing works', () => {
    const failed = { ok: false, at: 1, message: 'bad key', latencyMs: null }
    const s = aiStatus({
      enabled: true,
      connections: [
        conn({ id: 'a', model: 'gemini-x', hasKey: false }),
        conn({ id: 'b', kind: 'openrouter', label: 'OpenRouter', model: 'm', hasKey: true, lastTest: ok })
      ]
    })
    expect(s.text).toBe('On · Primary: OpenRouter (m)')
    expect(
      aiStatus({
        enabled: true,
        connections: [conn({ model: 'x', lastTest: failed }), conn({ id: 'b', model: 'y', lastTest: failed })]
      }).kind
    ).toBe('broken')
    expect(aiStatus({ enabled: true, connections: [] }).kind).toBe('broken')
    expect(aiStatus({ enabled: true, connections: [conn({ model: 'x', hasKey: false })] }).text).toBe(
      'On, but no connection works yet'
    )
  })
})
