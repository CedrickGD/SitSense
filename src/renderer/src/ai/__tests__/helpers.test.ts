import { describe, expect, it } from 'vitest'
import type { AiConnection } from '@shared/ai'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import { calibrate } from '@renderer/posture/__tests__/harness'
import { PoseSim, posture } from '@renderer/posture/__tests__/sim'
import {
  aiAvailable,
  aiNeedsSetup,
  aiReviewsSetup,
  aiUnavailableNote,
  isUsableConnection,
  measurementsFromBaseline,
  primaryAiConnection,
  usableConnections
} from '../helpers'

const conn = (id: string, enabled: boolean): AiConnection => ({
  id,
  kind: 'gemini',
  label: `Conn ${id}`,
  baseUrl: null,
  model: 'm',
  enabled,
  hasKey: true,
  keyHint: null,
  lastTest: null
})

const withAi = (enabled: boolean, useInSetup: boolean, connections: AiConnection[]): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  ai: { enabled, share: 'sketch', useInSetup, connections }
})

describe('AI availability', () => {
  it('needs the master switch and an enabled connection', () => {
    expect(aiAvailable(null)).toBe(false)
    expect(aiAvailable(withAi(false, true, [conn('a', true)]))).toBe(false)
    expect(aiAvailable(withAi(true, true, [conn('a', false)]))).toBe(false)
    expect(aiAvailable(withAi(true, true, [conn('a', false), conn('b', true)]))).toBe(true)
    expect(primaryAiConnection(withAi(true, true, [conn('a', false), conn('b', true)]))?.id).toBe('b')
  })
  it('setup review also needs useInSetup', () => {
    expect(aiReviewsSetup(withAi(true, false, [conn('a', true)]))).toBe(false)
    expect(aiReviewsSetup(withAi(true, true, [conn('a', true)]))).toBe(true)
  })

  // the connection named in setup / Ask AI must be the one that really receives the data
  it('skips a connection that cannot be called: the primary is the first usable one', () => {
    const keyless = { ...conn('g', true), label: 'Google Gemini', hasKey: false }
    const openai = { ...conn('o', true), kind: 'openai' as const, label: 'OpenAI', hasKey: true }
    const s = withAi(true, true, [keyless, openai])
    expect(primaryAiConnection(s)?.id).toBe('o')
    expect(usableConnections(s).map((c) => c.id)).toEqual(['o'])
    expect(aiAvailable(s)).toBe(true)
  })

  it('a keyless-only setup is not available — setup does not wait for a review that cannot run', () => {
    const s = withAi(true, true, [{ ...conn('g', true), hasKey: false }])
    expect(primaryAiConnection(s)).toBeNull()
    expect(aiAvailable(s)).toBe(false)
    expect(aiReviewsSetup(s)).toBe(false)
    expect(aiNeedsSetup(s)).toBe(true)
    expect(aiNeedsSetup(withAi(true, true, [conn('g', false)]))).toBe(false)
    expect(aiNeedsSetup(withAi(false, true, [{ ...conn('g', true), hasKey: false }]))).toBe(false)
    expect(aiNeedsSetup(withAi(true, true, [conn('g', true)]))).toBe(false)
  })

  it('needs a base URL for custom servers and a model for everyone; local servers need no key', () => {
    const custom = { ...conn('c', true), kind: 'openai-compatible' as const, hasKey: false }
    expect(isUsableConnection(custom)).toBe(false)
    expect(isUsableConnection({ ...custom, baseUrl: 'http://localhost:11434/v1' })).toBe(true)
    expect(isUsableConnection({ ...conn('a', true), model: '  ' })).toBe(false)
    expect(aiAvailable(withAi(true, true, [{ ...conn('a', true), model: '' }]))).toBe(false)
  })
})

describe('measurementsFromBaseline', () => {
  it('rounds the baseline and reports a good local verdict', () => {
    const sim = new PoseSim({ azimuth: 30, elevation: 15, distance: 1.1, roll: 0, hfov: 65, aspect: 16 / 9 })
    const b = calibrate(sim, posture())
    expect(b).not.toBeNull()
    const m = measurementsFromBaseline(b!)
    expect(m.localVerdict).toBe('good')
    expect(m.view).toBe(b!.view.kind)
    expect(m.neckFwdDeg).toBe(Math.round(b!.neckFwd * 10) / 10)
    for (const v of [m.neckFwdDeg, m.trunkFwdDeg, m.headPitchDeg, m.shoulderTiltDeg, m.headRollDeg, m.trunkLatDeg]) {
      expect(v === null || (Number.isFinite(v) && Math.abs(v) <= 360)).toBe(true)
    }
  })
})

describe('aiUnavailableNote', () => {
  it('is one plain line', () => {
    expect(aiUnavailableNote('Bad key.')).toBe('AI check unavailable: Bad key — used on-device judgment.')
  })
})
