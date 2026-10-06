// Renderer-side helpers for the connected-AI features (docs/specs/ai-providers.md).
// Pure — unit-tested in __tests__/helpers.test.ts.

import { AI_PRESETS, type AiConnection, type AiReviewMeasurements } from '@shared/ai'
import type { CalibrationBaseline } from '@shared/posture'
import type { Settings } from '@shared/settings'
import type { PostureAssessment } from '@renderer/posture/assess'
import type { PostureFeatures } from '@renderer/posture/types'

/** The provider needs an API key for every request (AI_PRESETS[].keyRequired; main's KEY_REQUIRED). */
export function keyRequired(kind: AiConnection['kind']): boolean {
  return AI_PRESETS.find((p) => p.kind === kind)?.keyRequired ?? true
}

/**
 * A connection a request will actually reach — mirrors `isUsable` in src/main/ai/judge.ts:
 * enabled, a model set, a key saved where the provider needs one, a base URL for custom
 * servers. The single renderer-side predicate: everything that names "the" connection
 * (setup, Ask AI, the coach, the privacy chip) must agree with where data really goes.
 */
export function isUsableConnection(c: AiConnection): boolean {
  return (
    c.enabled &&
    typeof c.model === 'string' &&
    c.model.trim().length > 0 &&
    (!keyRequired(c.kind) || c.hasKey) &&
    (c.kind !== 'openai-compatible' || !!c.baseUrl)
  )
}

/** The connections a request would go to, in priority order (empty while AI is off). */
export function usableConnections(settings: Pick<Settings, 'ai'> | null): AiConnection[] {
  return settings?.ai.enabled ? settings.ai.connections.filter(isUsableConnection) : []
}

/** The connection a review or chat will try first, or null when none can be called. */
export function primaryAiConnection(settings: Settings | null): AiConnection | null {
  return usableConnections(settings)[0] ?? null
}

/**
 * AI features are usable: the master switch is on and at least one connection can be
 * called (key, model and server address present). Whether the key works is only known
 * after a request. Use this for the Ask AI button and the `on-device · AI: <label>` chip.
 */
export function aiAvailable(settings: Settings | null): boolean {
  return primaryAiConnection(settings) !== null
}

/**
 * AI is on and a connection is switched on, but none can be called yet (missing key,
 * model or server address) — "finish it in AI settings", not "turned off".
 */
export function aiNeedsSetup(settings: Settings | null): boolean {
  return !!settings?.ai.enabled && !aiAvailable(settings) && settings.ai.connections.some((c) => c.enabled)
}

/** Setup asks the connected model to confirm the posture before saving the baseline. */
export function aiReviewsSetup(settings: Settings | null): boolean {
  return aiAvailable(settings) && !!settings?.ai.useInSetup
}

const round1 = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10

/** Measurements for an on-demand check, from (time-smoothed) live features and their assessment. */
export function measurementsFromFeatures(f: PostureFeatures, a: PostureAssessment): AiReviewMeasurements {
  return {
    view: f.view.kind,
    neckFwdDeg: round1(f.neckFwd),
    trunkFwdDeg: round1(f.trunkFwd),
    headPitchDeg: round1(f.headPitch),
    shoulderTiltDeg: round1(f.shoulderTilt),
    headRollDeg: round1(f.headRollRel),
    trunkLatDeg: round1(f.trunkLat),
    localVerdict: a.allGood ? 'good' : 'adjust',
    localInstruction: a.allGood ? null : (a.primary?.instruction ?? null)
  }
}

/** Measurements for the setup review, from the captured baseline (judged good locally). */
export function measurementsFromBaseline(b: CalibrationBaseline): AiReviewMeasurements {
  return {
    view: b.view.kind,
    neckFwdDeg: round1(b.neckFwd),
    trunkFwdDeg: round1(b.trunkFwd),
    headPitchDeg: round1(b.headPitch),
    shoulderTiltDeg: round1(b.shoulderTilt),
    headRollDeg: round1(b.headRollRel),
    trunkLatDeg: round1(b.trunkLat),
    localVerdict: 'good',
    localInstruction: null
  }
}

/** One short line for a review that could not run, e.g. in setup. */
export function aiUnavailableNote(message: string): string {
  const m = message.trim().replace(/[.\s]+$/, '')
  return `AI check unavailable: ${m || 'no answer'} — used on-device judgment.`
}
